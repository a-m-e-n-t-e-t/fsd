'use strict';
import {
    FICHUB_HOST,
    STORE_NAME,
    MAX_RESUME_ATTEMPTS,
    t_rec_sl,
    t_monitor,
    parseDate,
    normalize,
    buildFileName,
    resolveStatus,
    getDB,
    saveMonitorState,
    loadMonitorState,
    saveQueueArr,
    saveRuntimeState,
    loadRuntimeState,
    saveFetchState,
    loadFetchState,
    clearAllFetchStates,
    saveDownloadQueue,
    loadDownloadQueue,
    clearDownloadQueue,
    loadMetrics,
    updateMetrics,
    saveMetrics,
    flushMetrics,
    DEFAULT_METRICS,
    clearAllState,
    loadSettings,
    getCachedSettings,
    refreshSettingsCache,
    saveSettings,
    log,
    flushLog,
    clearLog,
    validateDownloadedFile,
} from './fsd_shared.js';

// ============================================================================
// КОНСТАНТЫ
// Все длительности и лимиты берём из settings (с дефолтами).
// Глобальные геттеры используют кэш, который обновляется при изменении settings.
// ============================================================================
function S() { return getCachedSettings(); }

// Константы (не настраиваемые — структурные)
const STATUS_BATCH = 100;
// v1.3.2: 'invalid' убран — записи с невалидным файлом больше не попадают
// в очередь при каждой проверке (вечная перекачка). Реанимация старых
// 'invalid'-записей — разовая миграция resetInvalidStatuses() при обновлении.
const NEEDS_UPDATE_STATUSES = new Set(['ongoing', 'timeout', 'not_found', '']);
const PATH_SEPARATOR_REGEX = /[/\\]/;
const CLEAN_NUMBER_SUFFIX_REGEX = /\s*\(\d+\)/g;

const FICHUB_API_BASE = 'https://fichub.net/api/v0/epub?q=';
const API_MAX_RETRIES = 60;
const API_DEFAULT_RETRY_DELAY_SEC = 5;
const API_NETWORK_ERROR_DELAY_MS = 5000;
// v1.3.2: таймаут одного запроса к API — зависший fetch раньше держал
// обработку URL до срабатывания STUCK- watchdog'а (5 минут)
const API_FETCH_TIMEOUT_MS = 60 * 1000;
// v1.3.1: постоянные клиентские ошибки — ретраи бессмысленны (fail-fast)
const API_FATAL_STATUSES = new Set([400, 401, 403, 404, 405, 410]);
const DATE_REGEX = /Updated:\s*(?:<[^>]+>)*(\d{4}-\d{2}-\d{2})/;
const STATUS_REGEX = /Status:\s*(?:<[^>]+>)*([^<\r\n]+)/i;

const STUCK_PROCESSING_THRESHOLD_MS = 5 * 60 * 1000;

// Имена chrome.alarms
const ALARM_KEEPALIVE = 'fsd_keepalive';
const ALARM_PROCESS_NEXT = 'fsd_process_next';
const ALARM_DOWNLOAD_TIMEOUT_PREFIX = 'fsd_dl_timeout_';
const ALARM_API_BACKOFF_PREFIX = 'fsd_api_backoff_';
const ALARM_RESUME_DL_PREFIX = 'fsd_resume_dl_';
const ALARM_AUTO_CHECK = 'fsd_auto_check';
// v1.3.1: ALARM_DOWNLOAD_QUEUE удалён — alarm с таким именем никогда не создавался (мёртвый код)

const ALARM_MIN_DELAY_MS = 25000;
// KEEPALIVE_PERIOD_MIN берётся из settings через S().KEEPALIVE_PERIOD_MIN

// ============================================================================
// СОСТОЯНИЕ
// ============================================================================
let fsd_monitor = new t_monitor();
let is_processing = false;
let is_cancelled = false;
let pending_process_next = false;
let nextTimeoutId = null;
let currentlyProcessingUrl = null;
let currentlyProcessingStartedAt = 0;
let processAlarmActive = false;   // v1.3.1: backup-alarm создаётся один раз на сессию
let keepaliveActive = false;      // v1.3.1: keepalive только при активной работе

const downloadResumeAttempts = new Map();   // downloadId → attempts
const pendingDownloadTimeouts = new Set(); // normalizedUrl
const activeDownloadUrls = new Set();      // url_fh — для лимита concurrency

let _dlQueueCache = null; // v1.3.1: кэш download-очереди в памяти

// ============================================================================
// ХЕЛПЕРЫ
// ============================================================================
function shortDelay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function alarmDelay(name, delayMs) {
    return new Promise((resolve) => {
        const handler = (alarm) => {
            if (alarm.name === name) {
                chrome.alarms.onAlarm.removeListener(handler);
                resolve();
            }
        };
        chrome.alarms.onAlarm.addListener(handler);
        chrome.alarms.create(name, {
            delayInMinutes: Math.max(delayMs / 60000, 0.5),
        });
    });
}

async function smartDelay(delayMs, alarmName) {
    if (delayMs < ALARM_MIN_DELAY_MS) {
        await shortDelay(delayMs);
        return { kind: 'timeout' };
    }
    if (is_cancelled) return { kind: 'cancelled' };
    if (!alarmName) {
        alarmName = ALARM_API_BACKOFF_PREFIX + Math.random().toString(36).slice(2);
    }
    await alarmDelay(alarmName, delayMs);
    return { kind: 'alarm', name: alarmName };
}

// ============================================================================
// PERSIST / RESTORE СОСТОЯНИЯ
// ============================================================================
async function persistRuntimeState() {
    const state = {
        is_processing,
        is_cancelled,
        pending_process_next,
        currentlyProcessingUrl,
        currentlyProcessingStartedAt,
        downloadResumeAttempts: Array.from(downloadResumeAttempts.entries()),
        pendingDownloadTimeouts: Array.from(pendingDownloadTimeouts),
        activeDownloadUrls: Array.from(activeDownloadUrls),
        savedAt: Date.now(),
    };
    await saveRuntimeState(state);
}

async function restoreRuntimeState() {
    const state = await loadRuntimeState();
    if (!state) return;

    is_processing = !!state.is_processing;
    is_cancelled = !!state.is_cancelled;
    pending_process_next = !!state.pending_process_next;
    currentlyProcessingUrl = state.currentlyProcessingUrl || null;
    currentlyProcessingStartedAt = state.currentlyProcessingStartedAt || 0;

    downloadResumeAttempts.clear();
    if (Array.isArray(state.downloadResumeAttempts)) {
        for (const [k, v] of state.downloadResumeAttempts) {
            downloadResumeAttempts.set(k, v);
        }
    }

    pendingDownloadTimeouts.clear();
    if (Array.isArray(state.pendingDownloadTimeouts)) {
        for (const url of state.pendingDownloadTimeouts) {
            pendingDownloadTimeouts.add(url);
        }
    }

    activeDownloadUrls.clear();
    if (Array.isArray(state.activeDownloadUrls)) {
        for (const url of state.activeDownloadUrls) {
            activeDownloadUrls.add(url);
        }
    }
}

async function restoreAllState() {
    const saved = await loadMonitorState();
    if (saved) {
        fsd_monitor = t_monitor.fromJSON(saved);
        console.log('состояние восстановлено, index_sl:', fsd_monitor.index_sl,
            'arr_sl.length:', fsd_monitor.arr_sl.length,
            'fsd_status:', fsd_monitor.fsd_status,
            'is_paused:', fsd_monitor.is_paused);
    }
    await restoreRuntimeState();
    console.log('runtime-состояние восстановлено: is_processing=', is_processing,
        'is_cancelled=', is_cancelled,
        'currentlyProcessingUrl=', currentlyProcessingUrl,
        'pendingDownloadTimeouts=', pendingDownloadTimeouts.size,
        'activeDownloadUrls=', activeDownloadUrls.size);
}

// v1.3.1: пишет только компактные поля монитора (без arr_sl) + runtime.
// Очередь пишется отдельно через saveQueueArr при построении.
async function persistAllState() {
    await saveMonitorState(fsd_monitor);
    await persistRuntimeState();
}

// ============================================================================
// WATCHDOG ЗАГРУЗОК ЧЕРЕЗ chrome.alarms
// ============================================================================
async function startDownloadTimeout(url_s) {
    const normalizedUrl = normalize(url_s);
    if (!normalizedUrl) return;
    if (pendingDownloadTimeouts.has(normalizedUrl)) {
        await chrome.alarms.clear(ALARM_DOWNLOAD_TIMEOUT_PREFIX + normalizedUrl);
    }
    pendingDownloadTimeouts.add(normalizedUrl);
    await chrome.alarms.create(ALARM_DOWNLOAD_TIMEOUT_PREFIX + normalizedUrl, {
        delayInMinutes: S().DOWNLOAD_TIMEOUT_MS / 60000,
    });
}

async function closePendingDownload(url_s) {
    const normalizedUrl = normalize(url_s);
    if (!normalizedUrl) return;
    pendingDownloadTimeouts.delete(normalizedUrl);
    await chrome.alarms.clear(ALARM_DOWNLOAD_TIMEOUT_PREFIX + normalizedUrl);
}

// ============================================================================
// DB ХЕЛПЕРЫ
// ============================================================================
// v1.3.1: date_upd всегда пишем ISO-строкой. Раньше в сторе лежали и Date,
// и строки — индекс by_date_upd сортировал их вперемешку по типам.
async function putRecord(rec) {
    if (rec && rec.date_upd instanceof Date) {
        rec.date_upd = rec.date_upd.toISOString();
    }
    const db = await getDB();
    await db.put(STORE_NAME, rec);
}

async function getRecord(url_s) {
    if (!url_s || typeof url_s !== 'string') return new t_rec_sl();
    const db = await getDB();
    return (await db.get(STORE_NAME, url_s)) || new t_rec_sl();
}

async function getRecordByDownloadUrl(url_fh) {
    const db = await getDB();
    return await db.getFromIndex(STORE_NAME, 'by_url_fh', url_fh);
}

async function countRecord() {
    const db = await getDB();
    return await db.count(STORE_NAME);
}

// ============================================================================
// ОТПРАВКА СТАТУСА В UI
// v1.3.1: БЕЗ persistAllState — состояние пишется явно в местах изменения,
// а не при каждом показе статуса (раньше каждое сообщение UI переписывало
// весь монитор вместе с очередью).
// ============================================================================
function sendStatus() {
    (async () => {
        try {
            const metrics = await loadMetrics();
            const downloadQueue = await getDownloadQueue();
            chrome.runtime.sendMessage({
                type_mess: 'a_status',
                statusPayload: {
                    arr_sl_len: fsd_monitor.arr_sl.length,
                    arr_tab_len: 0,
                    index_sl: fsd_monitor.index_sl,
                    c_u_s: fsd_monitor.c_u_s,
                    c_e_s: fsd_monitor.c_e_s,
                    fsd_status: fsd_monitor.fsd_status,
                    url_op: fsd_monitor.url_op,
                    s_c: fsd_monitor.s_c,
                    is_paused: fsd_monitor.is_paused,
                    active_downloads: activeDownloadUrls.size,
                    download_queue_len: downloadQueue.length,
                    sw_restarts: metrics.sw_restarts,
                    last_sw_start: metrics.last_sw_start,
                    total_urls_processed: metrics.total_urls_processed,
                    total_urls_timeout: metrics.total_urls_timeout,
                    total_downloads_completed: metrics.total_downloads_completed,
                    total_invalid_files: metrics.total_invalid_files,
                },
            }).catch(() => {});
        } catch (e) {
            console.warn('sendStatus error:', e);
        }
    })();
    manageKeepalive();
}

// ============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ЗАПИСЕЙ
// ============================================================================
function audit_fields(v) {
    if (v === undefined || v === null) return '';
    return v;
}

const RECORD_FIELDS = ['url_s', 'name', 's_status', 'date_upd', 'url_fh', 'file_p', 'id_f', 'hash_f'];
function recordsDiffer(a, b) {
    return RECORD_FIELDS.some(f => a[f] !== b[f]);
}

// v1.3.1: ИСПРАВЛЕНА СИНТАКСИЧЕСКАЯ ОШИБКА, из-за которой весь SW не грузился:
// было `url= url.split('?').[0];` → SyntaxError: Unexpected token '['
function fixUrl(url) {
    if (!url || typeof url !== 'string') return '';
    url = url.split('?')[0];
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return 'https://fichub.net' + url;
    return 'https://fichub.net/' + url;
}

function extractUrls(res) {
    const urls = {};
    if (res.epub_url && res.epub_url.length) urls.epub = fixUrl(res.epub_url);
    if (res.html_url && res.html_url.length) urls.html = fixUrl(res.html_url);
    if (res.mobi_url && res.mobi_url.length) urls.mobi = fixUrl(res.mobi_url);
    if (res.pdf_url && res.pdf_url.length) urls.pdf = fixUrl(res.pdf_url);
    if (!res.urls) return urls;
    const types = ['epub', 'html', 'mobi', 'pdf'];
    for (let i = 0; i < types.length; ++i) {
        if (res.urls[types[i]]) {
            urls[types[i]] = fixUrl(res.urls[types[i]]);
        }
    }
    return urls;
}

// ============================================================================
// STATE MACHINE ДЛЯ fetchEpubApi
// Состояние шага сохраняется в storage, чтобы после restart SW продолжить
// с того же места. v1.3.1: стейт пишется только при ИЗМЕНЕНИИ (раньше —
// в начале каждой итерации, даже без изменений).
// ============================================================================
async function fetchEpubApi(url_s) {
    let state = await loadFetchState(url_s);
    if (!state) {
        state = {
            attempt: 0,
            backoff_429_ms: S().API_429_BASE_DELAY_MS,
            started_at: Date.now(),
        };
    } else {
        console.log('fetchEpubApi: возобновление с попытки', state.attempt,
            'для', url_s, '(backoff_429 =', state.backoff_429_ms, 'мс)');
    }

    while (state.attempt < API_MAX_RETRIES) {
        if (is_cancelled) {
            await saveFetchState(url_s, null);
            return { ok: false, status: 'cancelled' };
        }

        let resp;
        try {
            resp = await fetch(FICHUB_API_BASE + encodeURIComponent(url_s), {
                signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
            });
        } catch (e) {
            console.warn('fetchEpubApi: сетевая ошибка, попытка', state.attempt + 1, e);
            state.attempt++;
            await saveFetchState(url_s, state);
            await shortDelay(API_NETWORK_ERROR_DELAY_MS);
            continue;
        }

        if (resp.status === 429) {
            await updateMetrics(m => { m.total_429_received++; return m; });

            const retryAfterHeader = resp.headers.get('Retry-After');
            let delayMs;
            if (retryAfterHeader) {
                delayMs = (Number(retryAfterHeader) * 1000) || state.backoff_429_ms;
            } else {
                delayMs = state.backoff_429_ms;
            }
            console.warn('fetchEpubApi: HTTP 429, ждём', (delayMs / 1000).toFixed(1),
                'сек, попытка', state.attempt + 1);

            if (is_cancelled) {
                await saveFetchState(url_s, null);
                return { ok: false, status: 'cancelled' };
            }
            // Сохраняем state ДО задержки — если SW умрёт, при restart продолжим
            state.attempt++;
            state.backoff_429_ms = Math.min(state.backoff_429_ms * 2, S().API_429_MAX_DELAY_MS);
            await saveFetchState(url_s, state);
            await smartDelay(delayMs, ALARM_API_BACKOFF_PREFIX + '429_' + state.attempt);
            continue;
        }

        // v1.3.1: постоянные клиентские ошибки не ретраим (раньше 404 мучил
        // сервер 60 попыток × 5 сек)
        if (API_FATAL_STATUSES.has(resp.status)) {
            console.warn('fetchEpubApi: HTTP', resp.status, '— постоянная ошибка, ретраи не нужны');
            await saveFetchState(url_s, null);
            return { ok: false, status: 'not_found' };
        }

        if (!resp.ok) {
            console.warn('fetchEpubApi: HTTP', resp.status, 'попытка', state.attempt + 1);
            state.attempt++;
            await saveFetchState(url_s, state);
            await shortDelay(API_NETWORK_ERROR_DELAY_MS);
            continue;
        }

        let res;
        try {
            res = await resp.json();
        } catch (e) {
            console.warn('fetchEpubApi: ответ не JSON, попытка', state.attempt + 1);
            state.attempt++;
            await saveFetchState(url_s, state);
            await shortDelay(API_NETWORK_ERROR_DELAY_MS);
            continue;
        }

        if (!res) {
            console.warn('fetchEpubApi: пустой ответ');
            state.attempt++;
            await saveFetchState(url_s, state);
            await shortDelay(API_NETWORK_ERROR_DELAY_MS);
            continue;
        }

        if ('retry_after' in res) {
            const delaySec = Number(res.retry_after) || API_DEFAULT_RETRY_DELAY_SEC;
            console.log('fetchEpubApi: retry_after', delaySec,
                'сек, попытка', state.attempt + 1, 'error:', res.error || res.err || 0);
            if (is_cancelled) {
                await saveFetchState(url_s, null);
                return { ok: false, status: 'cancelled' };
            }
            state.attempt++;
            await saveFetchState(url_s, state);
            await smartDelay(delaySec * 1000, ALARM_API_BACKOFF_PREFIX + 'retry_' + state.attempt);
            continue;
        }

        const hasError = ('error' in res && res.error != 0) || ('err' in res && res.err != 0);
        if (hasError) {
            const upstreamFail = res.upstream === true;
            const status = upstreamFail ? 'timeout' : 'not_found';
            console.warn('fetchEpubApi: ошибка', res.msg || res.error,
                '| upstream:', upstreamFail, '| ret:', res.ret, '→', status);
            await saveFetchState(url_s, null);
            return { ok: false, status, res };
        }

        const urls = extractUrls(res);
        if (Object.keys(urls).length > 0) {
            // v1.3.1: берём структурированные meta из ответа API вместо
            // regex-парсинга текста info (fallback на regex оставлен для
            // старых ответов без meta)
            let s_status = '';
            let r_date = new Date(0);

            if (res.meta) {
                if (typeof res.meta.status === 'string' && res.meta.status.trim() !== '') {
                    s_status = res.meta.status.trim();
                }
                if (res.meta.updated) {
                    const d = parseDate(res.meta.updated);
                    if (d.getTime() !== 0) r_date = d;
                }
            }

            if (s_status === '' && r_date.getTime() === 0) {
                const infoText = res.info || '';
                const m = infoText.match(DATE_REGEX);
                if (m && m[1]) {
                    const parts = m[1].split('-');
                    if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
                        r_date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
                    }
                }
                const m2 = infoText.match(STATUS_REGEX);
                if (m2 && m2[1]) {
                    s_status = m2[1].replace(/<[^>]+>/g, '').trim();
                }
            }

            // v1.3.2: hash из ответа API (проверено: равен md5 сгенерированного
            // файла). url_fh после fixUrl не содержит ?h=/eh= и не меняется,
            // поэтому hash — единственный детектор изменений при той же дате/url.
            // v1.3.3: при регенерации серверного кэша md5 меняется без изменения
            // контента — перекачка по hash ограничена (см. add_sl)
            const hash_f = (res.hashes && (res.hashes.epub || res.hashes.html)) || '';
            console.log('fetchEpubApi: успех, url_fh =', urls.html || urls.epub);
            await saveFetchState(url_s, null);
            return {
                ok: true,
                url_fh: urls.html || urls.epub || '',
                urls,
                s_status,
                date_upd: r_date.toISOString(),
                hash_f,
            };
        }

        console.log('fetchEpubApi: нет ссылок, попытка', state.attempt);
        state.attempt++;
        await saveFetchState(url_s, state);
        await shortDelay(S().API_REQUEST_DELAY_MS);
    }

    await saveFetchState(url_s, null);
    return { ok: false, status: 'timeout' };
}

// ============================================================================
// ОБРАБОТКА ОДНОГО URL
// ============================================================================
async function processUrl(url_s) {
    currentlyProcessingUrl = url_s;
    currentlyProcessingStartedAt = Date.now();
    await persistRuntimeState();

    fsd_monitor.url_op = url_s;
    sendStatus();

    try {
        const result = await fetchEpubApi(url_s);

        if (is_cancelled) return;

        if (!result.ok) {
            fsd_monitor.c_e_s++; // v1.3.1: счётчик ошибок снова осмысленный
            await add_sl({
                url_s: url_s,
                url_fh: '',
                s_status: result.status,
                date_upd: new Date(0).toISOString(),
                file_p: '',
                id_f: '',
            }, true);
            if (result.status === 'timeout') {
                await updateMetrics(m => { m.total_urls_timeout++; return m; });
            }
        } else {
            await add_sl({
                url_s: url_s,
                url_fh: result.url_fh,
                s_status: result.s_status,
                date_upd: result.date_upd,
                file_p: '',
                id_f: '',
                hash_f: result.hash_f || '',
            }, false);
        }

        await updateMetrics(m => {
            m.total_urls_processed++;
            const dur = currentlyProcessingStartedAt
                ? (Date.now() - currentlyProcessingStartedAt) : 0;
            m.processing_time_ms_total += dur;
            m.processing_count++;
            if (!Array.isArray(m.recent_processing_times_ms)) {
                m.recent_processing_times_ms = [];
            }
            m.recent_processing_times_ms.push(dur);
            return m;
        });
    } catch (e) {
        if (is_cancelled) return;
        console.error('processUrl error:', e);
        fsd_monitor.c_e_s++;
        await add_sl({
            url_s: url_s,
            url_fh: '',
            s_status: 'timeout',
            date_upd: new Date(0).toISOString(),
            file_p: '',
            id_f: '',
        }, true);
        await updateMetrics(m => { m.total_urls_timeout++; return m; });
    }

    currentlyProcessingUrl = null;
    currentlyProcessingStartedAt = 0;
    await persistRuntimeState();

    if (fsd_monitor.flag_dwd) {
        return; // ждём завершения загрузки
    }
    await shortDelay(S().API_REQUEST_DELAY_MS);
    scheduleNext();
}

// ============================================================================
// fix() — нормализация всех записей в БД
// ============================================================================
async function fix(arr_file_p = []) {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const keyChanges = [];
    const fieldChanges = [];
    let del_file_p = 0;
    const filePCounts = new Map();
    const entries = [];

    for await (const cursor of tx.store) {
        if (!cursor.value) continue;
        const original = cursor.value;
        const oldKey = cursor.primaryKey;
        const record_sl = new t_rec_sl();
        record_sl.url_s = audit_fields(original.url_s);
        if (record_sl.url_s !== '') record_sl.url_s = normalize(record_sl.url_s);
        record_sl.name = audit_fields(original.name);
        const s_name = buildFileName(record_sl.url_s);
        if (record_sl.name !== s_name) record_sl.name = s_name;
        // v1.3.1: нормализуем дату в ISO-строку (единый формат в индексе)
        record_sl.date_upd = parseDate(original.date_upd).toISOString();
        record_sl.s_status = resolveStatus(audit_fields(original.s_status), record_sl.date_upd);
        record_sl.url_fh = audit_fields(original.url_fh);
        record_sl.file_p = audit_fields(original.file_p);
        if (record_sl.file_p !== '') {
            const baseName = record_sl.file_p.split(PATH_SEPARATOR_REGEX).pop();
            if (baseName !== record_sl.file_p) record_sl.file_p = baseName;
        }
        if (arr_file_p.length > 0) {
            if (record_sl.file_p !== '' && !arr_file_p.includes(record_sl.file_p)) {
                record_sl.file_p = '';
                del_file_p++;
            }
        }
        const cleanedName = record_sl.file_p.replace(CLEAN_NUMBER_SUFFIX_REGEX, '');
        if (cleanedName !== record_sl.file_p) record_sl.file_p = cleanedName;
        record_sl.id_f = original.id_f || '';
        record_sl.hash_f = audit_fields(original.hash_f); // v1.3.2: сохраняем hash при нормализации
        if (record_sl.file_p !== '') {
            filePCounts.set(record_sl.file_p, (filePCounts.get(record_sl.file_p) || 0) + 1);
        }
        entries.push({ oldKey, record: record_sl, original });
    }

    for (const { oldKey, record: record_sl, original } of entries) {
        if (record_sl.file_p !== '' && (filePCounts.get(record_sl.file_p) || 0) > 1) {
            record_sl.file_p = '';
            del_file_p++;
        }
        const upd_key = oldKey !== record_sl.url_s;
        if (upd_key) {
            keyChanges.push({ oldKey, record: record_sl });
        } else if (recordsDiffer(record_sl, original)) {
            fieldChanges.push(record_sl);
        }
    }

    for (const record of fieldChanges) {
        await tx.store.put(record);
    }
    for (const change of keyChanges) {
        try {
            const exist_new = await tx.store.get(change.record.url_s);
            if (exist_new) {
                const merged = new t_rec_sl();
                merged.url_s = change.record.url_s;
                const d_old = parseDate(change.record.date_upd);
                const d_new = parseDate(exist_new.date_upd);
                merged.date_upd = (d_old > d_new ? d_old : d_new).toISOString();
                merged.name = change.record.name || exist_new.name;
                merged.s_status = change.record.s_status || exist_new.s_status;
                merged.url_fh = change.record.url_fh || exist_new.url_fh;
                merged.file_p = change.record.file_p || exist_new.file_p;
                merged.id_f = change.record.id_f || exist_new.id_f;
                await tx.store.put(merged);
                await tx.store.delete(change.oldKey);
            } else {
                await tx.store.put(change.record);
                await tx.store.delete(change.oldKey);
            }
        } catch (e) {
            console.error('fix: ошибка обновления ключа:', change.oldKey, e);
        }
    }
    await tx.done;
    fsd_monitor.s_c = await countRecord();
    console.log('fix: готово. обновлено полей:', fieldChanges.length,
        'ключей:', keyChanges.length,
        'дубликатов file_p очищено:', del_file_p);
}

// ============================================================================
// create_arr_sl — формирование очереди URL
// ============================================================================
async function create_arr_sl(regim) {
    const db = await getDB();
    const array_sl = [];
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.store.index('by_date_upd');
    for await (const cursor of index) {
        const v = cursor.value;
        if (!v) continue;
        if (regim === 0) {
            array_sl.push(v.url_s);
        } else if (regim === 1) {
            // v1.3.2: 'invalid' автоматически не переспрашиваем — только
            // вручную (add_url) или полным аудитом (regim=0)
            const needsUpdate = !v.url_fh
                || (!v.file_p && v.s_status !== 'invalid')
                || NEEDS_UPDATE_STATUSES.has(v.s_status);
            if (needsUpdate) {
                array_sl.push(v.url_s);
            }
        }
        if (array_sl.length % STATUS_BATCH === 0) {
            fsd_monitor.fsd_status = 'load ' + array_sl.length;
            sendStatus(); // v1.3.1: без персиста — построение больше не пишет storage
        }
    }
    await tx.done;
    console.log('create_arr_sl: выбрано записей:', array_sl.length);
    return array_sl;
}

// ============================================================================
// startQueue — единая точка запуска обработки (run и auto-check)
// ============================================================================
async function startQueue(array_sl) {
    is_cancelled = false;
    fsd_monitor.is_paused = false;
    fsd_monitor.arr_sl = array_sl;
    fsd_monitor.fsd_status = 'work';
    fsd_monitor.index_sl = -1;
    currentlyProcessingUrl = null;
    currentlyProcessingStartedAt = 0;
    is_processing = false;
    pending_process_next = false;
    await saveQueueArr(array_sl); // очередь пишется ОДИН раз при построении
    await persistAllState();
    ensureProcessNextAlarm();
    sendStatus();
    process_next();
}

// ============================================================================
// process_next — основной цикл обработки очереди
// ============================================================================
async function process_next() {
    // Пауза: ничего не делаем, состояние сохраняется. ScheduleNext не вызывается.
    if (fsd_monitor.is_paused) {
        console.log('process_next: пауза активна, ожидаем resume');
        is_processing = false;
        await persistAllState();
        return;
    }

    if (is_processing) {
        pending_process_next = true;
        await persistRuntimeState();
        return;
    }
    is_processing = true;
    pending_process_next = false;
    clearScheduleNext();
    try {
        if (!fsd_monitor.arr_sl || fsd_monitor.arr_sl.length === 0) {
            fsd_monitor.fsd_status = 'free';
            fsd_monitor.index_sl = -1;
            sendStatus();
            return;
        }
        fsd_monitor.index_sl++;
        if (fsd_monitor.index_sl < fsd_monitor.arr_sl.length) {
            sendStatus();
            await processUrl(fsd_monitor.arr_sl[fsd_monitor.index_sl]);
        } else {
            fsd_monitor.fsd_status = 'free';
            fsd_monitor.index_sl = -1;
            fsd_monitor.arr_sl = [];
            await saveQueueArr([]); // v1.3.1: очередь очищается и в storage
            sendStatus();
            console.log('обработка завершена');
        }
    } catch (e) {
        console.error('process_next error:', e);
    } finally {
        is_processing = false;
        currentlyProcessingUrl = null;
        currentlyProcessingStartedAt = 0;
        await persistAllState();
        if (pending_process_next && !fsd_monitor.is_paused) {
            pending_process_next = false;
            await persistRuntimeState();
            process_next();
        }
    }
}

// ============================================================================
// scheduleNext — планирует следующий process_next
// v1.3.1: backup-alarm создаётся один раз на сессию обработки
// (раньше clear+create делались каждые PROCESS_NEXT_DELAY_MS).
// ============================================================================
function scheduleNext() {
    if (fsd_monitor.flag_dwd) return;        // ждём завершения загрузки
    if (fsd_monitor.is_paused) return;       // пауза — не планируем
    if (nextTimeoutId) clearTimeout(nextTimeoutId);
    nextTimeoutId = setTimeout(() => {
        nextTimeoutId = null;
        process_next();
    }, S().PROCESS_NEXT_DELAY_MS);
}

function ensureProcessNextAlarm() {
    if (processAlarmActive) return;
    processAlarmActive = true;
    chrome.alarms.create(ALARM_PROCESS_NEXT, { delayInMinutes: 0.5 });
}

function clearScheduleNext() {
    if (nextTimeoutId) {
        clearTimeout(nextTimeoutId);
        nextTimeoutId = null;
    }
    processAlarmActive = false;
    chrome.alarms.clear(ALARM_PROCESS_NEXT).catch(() => {});
}

// ============================================================================
// finishDownloadStep — вызывается после завершения или таймаута загрузки
// ============================================================================
function finishDownloadStep() {
    if (fsd_monitor.flag_dwd) {
        fsd_monitor.flag_dwd = false;
        // После загрузки проверяем очередь: возможно, есть ещё ожидающие загрузки.
        pumpDownloadQueue();
        process_next();
    }
}

// ============================================================================
// DOWNLOAD QUEUE — ограничиваем число одновременных загрузок
// v1.3.1: очередь кэшируется в памяти; в storage пишется одним батчем,
// а не load-all/save-all на каждый элемент.
// ============================================================================
async function getDownloadQueue() {
    if (_dlQueueCache) return _dlQueueCache;
    _dlQueueCache = await loadDownloadQueue();
    return _dlQueueCache;
}

async function flushDownloadQueue() {
    if (_dlQueueCache) {
        await saveDownloadQueue(_dlQueueCache);
    }
}

async function enqueueDownload(url_s, url_fh) {
    const queue = await getDownloadQueue();
    // Не добавляем дубликаты
    if (queue.some(item => item.url_s === url_s)) return;
    queue.push({ url_s, url_fh, enqueued_at: Date.now() });
    // на диск сбросит flushDownloadQueue (один вызов на батч)
}

async function pumpDownloadQueue() {
    if (fsd_monitor.is_paused) {
        await flushDownloadQueue();
        return;
    }
    const queue = await getDownloadQueue();
    let started = 0;
    while (queue.length > 0 && activeDownloadUrls.size < S().MAX_CONCURRENT_DOWNLOADS) {
        const item = queue.shift();
        started++;
        // Запускаем загрузку (в обход лимита, т.к. мы только что освободили слот)
        await startDownloadInternal(item.url_s, item.url_fh, { persist: false });
    }
    await flushDownloadQueue(); // одна запись на батч, а не на каждый элемент
    if (started > 0) await persistRuntimeState();
}

async function startDownloadInternal(url_s, url_fh, opts) {
    if (activeDownloadUrls.has(url_fh)) {
        console.log('startDownloadInternal: уже активна, пропуск:', url_fh);
        return;
    }
    activeDownloadUrls.add(url_fh);
    // v1.3.1: watchdog-таймаут привязан к реальному СТАРТУ загрузки.
    // Раньше alarm создавался в add_sl — элементы, стоящие в очереди,
    // могли «истечь» ещё до начала скачивания.
    await startDownloadTimeout(url_s);
    if (!opts || opts.persist !== false) {
        await persistRuntimeState();
    }

    chrome.downloads.download({
        url: url_fh,
        saveAs: false,
        conflictAction: 'overwrite',
    }, function (downloadId) {
        if (chrome.runtime.lastError) {
            console.log('ошибка загрузки:', chrome.runtime.lastError.message);
            activeDownloadUrls.delete(url_fh);
            closePendingDownload(url_s);
            persistRuntimeState();
            // Не finishDownloadStep — иначе сбросит flag_dwd другого URL.
            // Просто пробуем следующий из очереди.
            pumpDownloadQueue();
        } else {
            console.log(fsd_monitor.c_u_s + 1, ' загрузка началась, id:', downloadId);
            updateMetrics(m => { m.total_downloads_started++; return m; });
        }
    });
}

// ============================================================================
// add_sl — добавление/обновление записи
// v1.3.1: убран chrome.downloads.search перед каждой загрузкой (дубли уже
// отслеживаются в activeDownloadUrls) и countRecord на каждый вызов
// (счётчик обновляется вызывающими сторонами один раз на операцию).
// ============================================================================
async function add_sl(exp_rec, noDownload = false) {
    const record_sl = new t_rec_sl();
    record_sl.url_s = normalize(exp_rec.url_s || '');
    if (record_sl.url_s === '') {
        console.warn('add_sl: пустой URL, пропуск');
        fsd_monitor.flag_dwd = false;
        return;
    }

    const parsed_date = parseDate(exp_rec.date_upd);
    record_sl.date_upd = parsed_date.toISOString(); // v1.3.1: единый формат дат
    record_sl.s_status = resolveStatus(exp_rec.s_status || '', parsed_date);
    record_sl.url_fh = exp_rec.url_fh || '';
    record_sl.name = buildFileName(record_sl.url_s);
    record_sl.file_p = exp_rec.file_p || '';
    record_sl.id_f = exp_rec.id_f || '';
    record_sl.hash_f = exp_rec.hash_f || '';

    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const exist_rec = (await tx.store.get(record_sl.url_s)) || new t_rec_sl();
    const exist_date = parseDate(exist_rec.date_upd);

    // v1.3.2: изменение hash (первый hash — только сохраняем, без перекачки).
    // v1.3.3: hash = md5 файла — меняется и при регенерации серверного кэша
    // без изменения контента, поэтому перекачка ограничена (ветка hashChanged)
    const hashChanged = record_sl.hash_f !== ''
        && exist_rec.hash_f !== ''
        && record_sl.hash_f !== exist_rec.hash_f;
    const hashNew = record_sl.hash_f !== '' && exist_rec.hash_f === '';

    const reasons = [];
    if (parsed_date > exist_date) reasons.push('новая дата');
    if (record_sl.url_fh !== '' && record_sl.url_fh !== exist_rec.url_fh) reasons.push('новый url_fh');
    if (hashChanged) reasons.push('изменился hash контента');
    if (hashNew) reasons.push('первый hash');
    if (exist_rec.file_p === '') reasons.push('нет file_p');
    if (record_sl.s_status !== exist_rec.s_status) {
        reasons.push('статус: ' + exist_rec.s_status + ' → ' + record_sl.s_status);
    }
    const needsUpdate = reasons.length > 0;
    if (needsUpdate) {
        console.log('add_sl: обновление для', record_sl.url_s, '— причины:', reasons.join(', '));
    }
    if (!needsUpdate) {
        await tx.done;
        fsd_monitor.flag_dwd = false;
        return;
    }

    let needDownload = false;
    if (noDownload && exist_date.getTime() === 0) {
        console.log('upd db');
    } else if (parsed_date > exist_date) {
        if (!noDownload) {
            record_sl.file_p = '';
            record_sl.id_f = '';
            needDownload = true;
        }
        console.log('new date');
    } else if (record_sl.url_fh !== '' && record_sl.url_fh !== exist_rec.url_fh) {
        if (!noDownload) {
            record_sl.file_p = '';
            record_sl.id_f = '';
            needDownload = true;
        }
        console.log('new url');
    } else if (hashChanged) {
        // v1.3.3: hash = md5 файла; при регенерации серверного кэша он меняется
        // без изменения контента. Перекачиваем только ongoing-истории (реальное
        // обновление) или записи без файла; для old/complete с валидным файлом
        // молча запоминаем новый hash, не трогая существующий файл.
        const silentHashUpdate = record_sl.s_status !== 'ongoing' && exist_rec.file_p !== '';
        if (!noDownload && !silentHashUpdate) {
            record_sl.file_p = '';
            record_sl.id_f = '';
            needDownload = true;
            console.log('new hash — перекачка');
        } else {
            record_sl.file_p = exist_rec.file_p || '';
            record_sl.id_f = exist_rec.id_f || '';
            console.log('new hash — без перекачки',
                silentHashUpdate ? '(не ongoing, файл есть)' : '');
        }
    } else if (record_sl.s_status !== exist_rec.s_status) {
        record_sl.file_p = exist_rec.file_p || '';
        record_sl.id_f = exist_rec.id_f || '';
        // v1.3.2: статус изменился, а файла нет — скачиваем (реанимация
        // записей со сброшенным 'invalid' за один проход проверки)
        needDownload = !noDownload && (exist_rec.file_p === '');
        console.log('new status');
    } else {
        record_sl.file_p = exist_rec.file_p || '';
        record_sl.id_f = exist_rec.id_f || '';
        needDownload = !noDownload && (exist_rec.file_p === '');
        console.log('new file');
    }

    await tx.store.put(record_sl);
    await tx.done;

    if (record_sl.url_fh !== '' && needDownload) {
        console.log('add_sl: нужна загрузка, url =', record_sl.url_fh);
        if (activeDownloadUrls.size >= S().MAX_CONCURRENT_DOWNLOADS) {
            // Превышен лимит — ставим в очередь
            console.log('add_sl: лимит загрузок (', activeDownloadUrls.size,
                '), ставим в очередь:', record_sl.url_fh);
            await enqueueDownload(record_sl.url_s, record_sl.url_fh);
        } else {
            await startDownloadInternal(record_sl.url_s, record_sl.url_fh);
        }
        fsd_monitor.flag_dwd = true;
    } else {
        fsd_monitor.flag_dwd = false;
    }
}

// ============================================================================
// ОБРАБОТЧИКИ chrome.downloads.onChanged
// ============================================================================
async function handleDownloadComplete(delta, dwd) {
    const downloadItem = dwd[0];
    const rec = await getRecordByDownloadUrl(downloadItem.url);
    downloadResumeAttempts.delete(delta.id);
    activeDownloadUrls.delete(downloadItem.url);

    // v1.3.1: валидация переписана — text/html допустим только для HTML-историй
    // (html_url у fichub имеет вид /cache/html/<id>; файл приходит как zip)
    let validation = { valid: true };
    if (rec) {
        const expectHtml = !!(rec.url_fh && rec.url_fh.includes('/cache/html/'));
        validation = validateDownloadedFile(downloadItem, S(), { expectHtml });
    }

    if (rec) {
        if (!validation.valid) {
            // Файл невалиден — помечаем запись и удаляем файл
            log('warn', 'bg', 'валидация не пройдена для ' + rec.url_s + ': ' + validation.reason, validation);
            rec.s_status = 'invalid';
            await putRecord(rec);
            await closePendingDownload(rec.url_s);
            try {
                // v1.3.1: убран некорректный второй аргумент false вместо callback
                await chrome.downloads.removeFile(delta.id);
            } catch (e) {
                log('debug', 'bg', 'не удалось удалить невалидный файл', e);
            }
            fsd_monitor.c_e_s++;
            // v1.3.1: честная метрика вместо total_urls_timeout
            await updateMetrics(m => { m.total_invalid_files++; return m; });
        } else {
            const fullPath = downloadItem.filename || '';
            rec.file_p = fullPath.split(/[/\\]/).pop();
            rec.id_f = delta.id;
            await putRecord(rec);
            await closePendingDownload(rec.url_s);
            fsd_monitor.c_u_s++;
            await updateMetrics(m => { m.total_downloads_completed++; return m; });
            log('info', 'bg', 'загрузка завершена: ' + (rec.file_p || rec.url_s));
        }
    }
    // v1.3.2: completed инкрементируется только для валидных файлов —
    // раньше каждая отбракованная загрузка тоже считалась «завершённой»
    await persistRuntimeState();
    // v1.3.1: убрана 5-сек sleep в обработчике (держала SW живым;
    // pacing обеспечивает scheduleNext)
    finishDownloadStep();
}

async function handleDownloadInterrupted(delta, dwd) {
    const attempts = (downloadResumeAttempts.get(delta.id) || 0) + 1;
    downloadResumeAttempts.set(delta.id, attempts);
    await updateMetrics(m => {
        m.total_downloads_interrupted++;
        m.total_resume_attempts++;
        return m;
    });
    await persistRuntimeState();

    if (attempts > MAX_RESUME_ATTEMPTS) {
        console.error('превышен лимит resume для:', delta.id);
        downloadResumeAttempts.delete(delta.id);
        activeDownloadUrls.delete(dwd[0].url);
        const rec = await getRecordByDownloadUrl(dwd[0].url);
        if (rec) {
            rec.s_status = 'timeout';
            await putRecord(rec);
            await closePendingDownload(rec.url_s);
        }
        await persistRuntimeState();
        finishDownloadStep();
        return;
    }

    console.log('перезапуск загрузки, попытка', attempts, 'id:', delta.id);
    // v1.3.1: resume ТОЛЬКО через chrome.alarms — обработка в главном
    // onAlarm-листенере переживает смерть SW. Раньше обработчик висел на
    // замыкании текущего экземпляра SW и терялся при рестарте.
    await chrome.alarms.create(ALARM_RESUME_DL_PREFIX + delta.id, { delayInMinutes: 0.5 });
}

// v1.3.1: выделенная функция повторного запуска загрузки — вызывается из
// главного onAlarm-обработчика (работает и после рестарта SW).
async function resumeDownload(downloadId) {
    try {
        await chrome.downloads.cancel(downloadId);
    } catch (e) {
        // уже завершена/отменена — не критично
    }
    const dwd = await chrome.downloads.search({ id: downloadId });
    if (!Array.isArray(dwd) || dwd.length === 0) return;

    const url = dwd[0].url;
    const attempts = downloadResumeAttempts.get(downloadId) || 1;
    const rec = await getRecordByDownloadUrl(url);
    downloadResumeAttempts.delete(downloadId);
    activeDownloadUrls.delete(url);

    if (!rec || !rec.url_fh) {
        finishDownloadStep();
        return;
    }
    chrome.downloads.download({
        url: rec.url_fh,
        saveAs: false,
        conflictAction: 'overwrite',
    }, function (newDownloadId) {
        if (chrome.runtime.lastError) {
            console.log('ошибка повторной загрузки:', chrome.runtime.lastError.message);
            finishDownloadStep();
        } else {
            rec.id_f = newDownloadId;
            putRecord(rec).catch(e => console.error('updateRecord:', e));
            downloadResumeAttempts.set(newDownloadId, attempts);
            activeDownloadUrls.add(rec.url_fh);
            updateMetrics(m => { m.total_downloads_started++; return m; });
            persistRuntimeState();
        }
    });
}

chrome.downloads.onChanged.addListener(async function (delta) {
    if (!delta.state) return;
    const dwd = await chrome.downloads.search({ id: delta.id });
    if (!Array.isArray(dwd) || dwd.length === 0) return;
    try {
        const host = new URL(dwd[0].url).hostname;
        if (host !== FICHUB_HOST) return;
        if (delta.state.current === 'complete') {
            await handleDownloadComplete(delta, dwd);
        } else if (delta.state.current === 'interrupted') {
            await handleDownloadInterrupted(delta, dwd);
        }
    } catch (e) {
        console.log('не удалось разобрать URL:', e);
    }
});

// ============================================================================
// ВОССТАНОВЛЕНИЕ АКТИВНЫХ ЗАГРУЗОК ПОСЛЕ ПЕРЕЗАПУСКА SW
// v1.3.1: search только in_progress (раньше выгружалась вся история
// загрузок браузера — потенциально десятки тысяч записей).
// ============================================================================
async function reattachPendingDownloads() {
    try {
        const downloads = await chrome.downloads.search({ state: 'in_progress' });
        let reattached = 0;
        for (const d of downloads) {
            try {
                const host = new URL(d.url).hostname;
                if (host !== FICHUB_HOST) continue;
                const rec = await getRecordByDownloadUrl(d.url);
                if (!rec || !rec.url_s) continue;
                const normalizedUrl = normalize(rec.url_s);
                if (pendingDownloadTimeouts.has(normalizedUrl)) {
                    await chrome.alarms.clear(ALARM_DOWNLOAD_TIMEOUT_PREFIX + normalizedUrl);
                } else {
                    pendingDownloadTimeouts.add(normalizedUrl);
                }
                activeDownloadUrls.add(d.url);
                const elapsed = d.startTime ? (Date.now() - d.startTime) : 0;
                const remaining = Math.max(S().DOWNLOAD_TIMEOUT_MS - elapsed, 60000);
                await chrome.alarms.create(ALARM_DOWNLOAD_TIMEOUT_PREFIX + normalizedUrl, {
                    delayInMinutes: Math.max(remaining / 60000, 1),
                });
                reattached++;
            } catch (e) {
                // skip invalid downloads
            }
        }
        if (reattached > 0) {
            console.log('reattachPendingDownloads: переподключено загрузок:', reattached);
            await persistRuntimeState();
        }
    } catch (e) {
        console.warn('reattachPendingDownloads error:', e);
    }
}

// ============================================================================
// RESUME ЛОГИКА ПРИ ЗАПУСКЕ SW
// ============================================================================
async function resumeProcessingIfNeeded() {
    // Шаг 1: если SW умер во время обработки URL — помечаем как timeout
    if (currentlyProcessingUrl) {
        console.warn('resumeProcessingIfNeeded: SW прерван при обработке URL, помечаем как timeout:',
            currentlyProcessingUrl);
        try {
            await add_sl({
                url_s: currentlyProcessingUrl,
                url_fh: '',
                s_status: 'timeout',
                date_upd: new Date(0).toISOString(),
                file_p: '',
                id_f: '',
            }, true);
            await saveFetchState(currentlyProcessingUrl, null);
        } catch (e) {
            console.error('resumeProcessingIfNeeded: ошибка пометки timeout:', e);
        }
        currentlyProcessingUrl = null;
        currentlyProcessingStartedAt = 0;
        is_processing = false;
        fsd_monitor.flag_dwd = false;
        await updateMetrics(m => { m.total_urls_timeout++; return m; });
    }

    // Шаг 2: реаттачим активные загрузки
    await reattachPendingDownloads();

    // Шаг 3: чистим потерянные api-backoff alarms
    const alarms = await chrome.alarms.getAll();
    for (const a of alarms) {
        if (a.name.startsWith(ALARM_API_BACKOFF_PREFIX)) {
            await chrome.alarms.clear(a.name);
        }
    }

    // Шаг 4: продолжаем обработку если не на паузе и не отменено
    if (is_cancelled) {
        console.log('resumeProcessingIfNeeded: is_cancelled=true, обработка не возобновляется');
        return;
    }

    if (fsd_monitor.is_paused) {
        console.log('resumeProcessingIfNeeded: is_paused=true, обработка приостановлена');
        return;
    }

    if (fsd_monitor.fsd_status === 'work' && fsd_monitor.arr_sl && fsd_monitor.arr_sl.length > 0) {
        is_processing = false;
        pending_process_next = false;
        console.log('resumeProcessingIfNeeded: возобновление обработки, index_sl=',
            fsd_monitor.index_sl, 'из', fsd_monitor.arr_sl.length - 1);
        ensureProcessNextAlarm();
        process_next();
    } else if (fsd_monitor.flag_dwd) {
        console.log('resumeProcessingIfNeeded: ожидаем завершения активной загрузки');
    } else {
        console.log('resumeProcessingIfNeeded: активной обработки нет');
    }

    // Шаг 5: запускаем очередь загрузок (если что-то накопилось)
    await pumpDownloadQueue();
}

// ============================================================================
// AUTO-CHECK: периодическая проверка обновлений ongoing-историй
// ============================================================================
async function runAutoCheck() {
    const settings = S();
    if (!settings.AUTO_CHECK_ENABLED) {
        log('debug', 'bg', 'auto-check: отключён в настройках');
        return;
    }
    if (fsd_monitor.fsd_status === 'work' || is_processing) {
        log('info', 'bg', 'auto-check: уже идёт обработка, пропускаем');
        return;
    }
    if (fsd_monitor.is_paused) {
        log('info', 'bg', 'auto-check: пауза активна, пропускаем');
        return;
    }
    try {
        // Создаём очередь только из ongoing-историй
        const db = await getDB();
        const array_sl = [];
        const tx = db.transaction(STORE_NAME, 'readonly');
        const index = tx.store.index('by_date_upd');
        for await (const cursor of index) {
            const v = cursor.value;
            if (!v) continue;
            if (v.s_status === 'ongoing') {
                array_sl.push(v.url_s);
            }
        }
        await tx.done;
        log('info', 'bg', 'auto-check: выбрано ongoing-историй: ' + array_sl.length);
        if (array_sl.length === 0) return;
        await startQueue(array_sl);
    } catch (e) {
        log('error', 'bg', 'auto-check: ошибка', e);
    }
}

// Настройка auto-check alarm'а в зависимости от settings
async function setupAutoCheckAlarm() {
    await chrome.alarms.clear(ALARM_AUTO_CHECK);
    const settings = S();
    if (!settings.AUTO_CHECK_ENABLED) {
        log('debug', 'bg', 'auto-check: отключён, alarm не создаётся');
        return;
    }
    const hours = settings.AUTO_CHECK_INTERVAL_HOURS || 24;
    if (hours <= 0) {
        log('debug', 'bg', 'auto-check: interval <= 0, alarm не создаётся');
        return;
    }
    const periodMinutes = hours * 60;
    await chrome.alarms.create(ALARM_AUTO_CHECK, {
        periodInMinutes: Math.max(periodMinutes, 1),
    });
    log('info', 'bg', 'auto-check: alarm установлен, interval=' + hours + 'ч');
}

// ============================================================================
// KEEPALIVE (v1.3.1 — только при активной работе)
// Раньше alarm будил SW каждые 30 секунд даже в полном простое: каждая
// побудка гоняла init() с updateMetrics (запись) и downloads.search({})
// по всей истории. Теперь alarm живёт только пока есть работа.
// ============================================================================
function hasActiveWork() {
    return fsd_monitor.fsd_status === 'work' || activeDownloadUrls.size > 0;
}

async function manageKeepalive() {
    try {
        if (hasActiveWork()) {
            if (!keepaliveActive) {
                keepaliveActive = true;
                await chrome.alarms.create(ALARM_KEEPALIVE, {
                    periodInMinutes: Math.max(S().KEEPALIVE_PERIOD_MIN, 0.5),
                });
            }
        } else if (keepaliveActive) {
            keepaliveActive = false;
            await chrome.alarms.clear(ALARM_KEEPALIVE);
        }
    } catch (e) {
        console.warn('manageKeepalive error:', e);
    }
}

// ============================================================================
// МИГРАЦИЯ ДАННЫХ (v1.3.1)
// Старые записи хранили date_upd как Date — в IDB значения разных типов
// сортируются отдельно, и порядок индекса by_date_upd был некорректен.
// Одноразовый проход нормализует все Date в ISO-строки.
// ============================================================================
async function normalizeDatesIfNeeded() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        let converted = 0;
        for await (const cursor of tx.store) {
            const v = cursor.value;
            if (v && v.date_upd instanceof Date) {
                v.date_upd = v.date_upd.toISOString();
                await cursor.update(v);
                converted++;
            }
        }
        await tx.done;
        if (converted > 0) {
            console.log('миграция date_upd → ISO: преобразовано записей:', converted);
        }
    } catch (e) {
        console.warn('миграция date_upd error:', e);
    }
}

// ============================================================================
// МИГРАЦИЯ (v1.3.2): разовая реанимация записей 'invalid'
// До v1.3.1 валидация браковала html-файлы fichub (файл приходит как
// application/zip) — записи получали s_status='invalid' и перекачивались
// бесконечно. Валидация уже исправлена; при обновлении расширения один раз
// сбрасываем статус, чтобы следующая проверка («Обновить БД», regim=1)
// скачала корректные файлы и восстановила настоящий статус историй.
// ============================================================================
async function resetInvalidStatuses() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        let reset = 0;
        for await (const cursor of tx.store) {
            const v = cursor.value;
            if (v && v.s_status === 'invalid') {
                v.s_status = '';
                await cursor.update(v);
                reset++;
            }
        }
        await tx.done;
        if (reset > 0) {
            log('info', 'bg', 'миграция: сброшен статус invalid у записей: ' + reset);
        }
    } catch (e) {
        console.warn('resetInvalidStatuses error:', e);
    }
}

// ============================================================================
// chrome.alarms.onAlarm — ГЛАВНАЯ ТОЧКА ВОЗОБНОВЛЕНИЯ SW ПОСЛЕ TERMINATION
// ============================================================================
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_KEEPALIVE) {
        // v1.3.1: в простое — гасим keepalive и выходим
        if (!hasActiveWork()) {
            await manageKeepalive();
            return;
        }
        // Проверяем застрявшую обработку
        if (currentlyProcessingUrl && currentlyProcessingStartedAt
            && (Date.now() - currentlyProcessingStartedAt) > STUCK_PROCESSING_THRESHOLD_MS) {
            console.warn('KEEPALIVE: обнаружена застрявшая обработка, помечаем как timeout:',
                currentlyProcessingUrl);
            try {
                await add_sl({
                    url_s: currentlyProcessingUrl,
                    url_fh: '',
                    s_status: 'timeout',
                    date_upd: new Date(0).toISOString(),
                    file_p: '',
                    id_f: '',
                }, true);
                await saveFetchState(currentlyProcessingUrl, null);
            } catch (e) {
                console.error('KEEPALIVE: ошибка пометки timeout:', e);
            }
            currentlyProcessingUrl = null;
            currentlyProcessingStartedAt = 0;
            is_processing = false;
            fsd_monitor.flag_dwd = false;
            await updateMetrics(m => { m.total_urls_timeout++; return m; });
            await persistRuntimeState();
            if (!fsd_monitor.is_paused) process_next();
        }
        // Подстраховка: если обработка не идёт, но в очереди есть URL
        if (!is_processing
            && !is_cancelled
            && !fsd_monitor.is_paused
            && !fsd_monitor.flag_dwd
            && fsd_monitor.fsd_status === 'work'
            && fsd_monitor.arr_sl
            && fsd_monitor.arr_sl.length > 0
            && fsd_monitor.index_sl < fsd_monitor.arr_sl.length - 1) {
            console.log('KEEPALIVE: обнаружен простой обработки, продолжаем');
            process_next();
        }
        // Прокачиваем download-очередь
        await pumpDownloadQueue();
        return;
    }

    if (alarm.name === ALARM_PROCESS_NEXT) {
        processAlarmActive = false;
        if (!nextTimeoutId && !is_processing && !fsd_monitor.flag_dwd && !fsd_monitor.is_paused) {
            console.log('ALARM PROCESS_NEXT: backup-возобновление обработки');
            process_next();
        }
        // если работа продолжается — перевзводим backup на случай смерти SW
        if (fsd_monitor.fsd_status === 'work' && !fsd_monitor.is_paused) {
            ensureProcessNextAlarm();
        }
        return;
    }

    if (alarm.name === ALARM_AUTO_CHECK) {
        log('info', 'bg', 'auto-check: запуск фоновой проверки ongoing-историй');
        runAutoCheck();
        return;
    }

    // v1.3.1: resume прерванных загрузок обрабатывается здесь (переживает
    // рестарт SW; раньше обработчик терялся вместе с замыканием)
    if (alarm.name.startsWith(ALARM_RESUME_DL_PREFIX)) {
        const id = Number(alarm.name.slice(ALARM_RESUME_DL_PREFIX.length));
        if (Number.isFinite(id)) {
            await resumeDownload(id);
        }
        return;
    }

    if (alarm.name.startsWith(ALARM_DOWNLOAD_TIMEOUT_PREFIX)) {
        const url = alarm.name.slice(ALARM_DOWNLOAD_TIMEOUT_PREFIX.length);
        if (pendingDownloadTimeouts.has(url)) {
            console.warn('таймаут загрузки (alarm):', url);
            pendingDownloadTimeouts.delete(url);
            await persistRuntimeState();
            finishDownloadStep();
        }
        return;
    }
});

// ============================================================================
// ОБРАБОТЧИК СООБЩЕНИЙ ОТ UI
// v1.3.1: канал ответа держится открытым только для get_settings.
// Раньше каждый fire-and-forget запрос держал порт открытым до конца
// асинхронной обработки.
// ============================================================================
chrome.runtime.onMessage.addListener(function (mess, sender, sendResponse) {
    if (!mess || !mess.type_mess) return false;

    if (mess.type_mess === 'get_settings') {
        sendResponse({ ok: true, settings: S() });
        return false; // ответ отправлен синхронно
    }

    (async function () {
        try {
            switch (mess.type_mess) {
            case 'q_status':
                sendStatus();
                break;
            case 'run':
                await startQueue(await create_arr_sl(mess.regim));
                break;
            case 'add_url':
                await handleAddUrl(mess);
                break;
            case 'add_urls':
                await handleAddUrls(mess);
                break;
            case 'pause':
                fsd_monitor.is_paused = true;
                clearScheduleNext();
                await persistAllState();
                sendStatus();
                console.log('pause: обработка приостановлена пользователем');
                break;
            case 'resume':
                fsd_monitor.is_paused = false;
                await persistAllState();
                sendStatus();
                console.log('resume: обработка возобновлена пользователем');
                ensureProcessNextAlarm();
                if (!is_processing) process_next();
                await pumpDownloadQueue();
                break;
            case 'stop':
                is_cancelled = true;
                fsd_monitor = new t_monitor();
                is_processing = false;
                pending_process_next = false;
                currentlyProcessingUrl = null;
                currentlyProcessingStartedAt = 0;
                downloadResumeAttempts.clear();
                pendingDownloadTimeouts.clear();
                activeDownloadUrls.clear();
                _dlQueueCache = null;
                clearScheduleNext();
                keepaliveActive = false;
                {
                    const alarms = await chrome.alarms.getAll();
                    for (const a of alarms) {
                        if (a.name.startsWith('fsd_')) {
                            await chrome.alarms.clear(a.name);
                        }
                    }
                }
                await clearAllState();
                sendStatus();
                break;
            case 'fix':
                await fix(mess.arr_file_p);
                sendStatus();
                break;
            case 'read story':
                chrome.tabs.create({
                    url: chrome.runtime.getURL('visual.html'),
                    active: false,
                });
                break;
            case 'save_sl':
            case 'save_dl':
            case 'JSON_file':
            case 'csv_file': {
                    const msgType = {
                        save_sl: 'sl_file',
                        save_dl: 'dl_file',
                        JSON_file: 'JSON_file',
                        csv_file: 'csv_file',
                    }[mess.type_mess];
                    chrome.tabs.create({
                        url: chrome.runtime.getURL('save.html'),
                        active: false,
                    }, function (tab) {
                        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
                            if (tabId === tab.id && info.status === 'complete') {
                                chrome.tabs.onUpdated.removeListener(listener);
                                chrome.tabs.sendMessage(tab.id, { type_mess: msgType });
                            }
                        });
                    });
                    break;
                }
            case 'reset_metrics':
                await saveMetrics({ ...DEFAULT_METRICS });
                sendStatus();
                log('info', 'bg', 'метрики сброшены');
                break;
            case 'update_settings':
                if (mess.settings && typeof mess.settings === 'object') {
                    await saveSettings(mess.settings);
                    // Кэш обновится автоматически через storage.onChanged listener
                    await setupAutoCheckAlarm();
                    // v1.3.1: keepalive пересоздаётся только если он нужен,
                    // с новым периодом
                    keepaliveActive = false;
                    await manageKeepalive();
                    sendStatus();
                    log('info', 'bg', 'настройки обновлены');
                }
                break;
            case 'clear_log':
                await clearLog();
                log('info', 'bg', 'лог очищен пользователем');
                break;
            case 'trigger_auto_check':
                log('info', 'bg', 'auto-check: ручной запуск');
                runAutoCheck();
                break;
            default:
                console.log('неизвестное сообщение:', mess.type_mess);
                break;
            }
        } catch (e) {
            console.error('Ошибка в обработчике сообщений:', e);
            log('error', 'bg', 'onMessage error', e);
            fsd_monitor.flag_dwd = false;
            scheduleNext();
        }
        sendStatus();
    })();
    return false; // fire-and-forget: порт не держим
});

// ============================================================================
// handleAddUrl — добавление одного URL из UI
// v1.3.1: ветка fs===1 (данные от контент-скрипта) удалена вместе с самим
// осиротевшим контент-скриптом fsd_content.js.
// ============================================================================
async function handleAddUrl(mess) {
    let exp = mess.exp_rec;
    if (!exp || !exp.url_s) {
        if (mess.url_s && mess.url_s !== '') {
            exp = {
                url_s: mess.url_s,
                url_f: mess.url_f || '',
                s_status: mess.s_status || '',
                date_upd: mess.date_upd || new Date(0).toISOString(),
            };
        } else {
            console.warn('add_url: нет данных');
            fsd_monitor.flag_dwd = false;
            await persistRuntimeState();
            scheduleNext();
            return;
        }
    }

    await add_sl(exp, mess.noDownload || false);
    fsd_monitor.s_c = await countRecord();
    await flushDownloadQueue();
    await persistAllState();
    scheduleNext();
}

// ============================================================================
// handleAddUrls — батч-импорт (v1.3.1)
// Раньше UI слал одно сообщение на каждый URL, и каждый проходил полный цикл
// (транзакция IDB + персист состояния + статус). Теперь один цикл на батч.
// ============================================================================
async function handleAddUrls(mess) {
    const arr = Array.isArray(mess.arr) ? mess.arr : [];
    let processed = 0;
    for (const exp of arr) {
        if (!exp || !exp.url_s) continue;
        await add_sl(exp, mess.noDownload || false);
        processed++;
    }
    fsd_monitor.s_c = await countRecord();
    await flushDownloadQueue();
    await persistAllState();
    log('info', 'bg', 'add_urls: обработано записей: ' + processed);
    scheduleNext();
}

// ============================================================================
// ХУКИ ЖИЗНЕННОГО ЦИКЛА БРАУЗЕРА
// ============================================================================
chrome.runtime.onStartup.addListener(async () => {
    console.log('onStartup: браузер запущен, инициализация SW');
    await init();
});

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('onInstalled:', details.reason);
    // v1.3.2: разовая реанимация записей, побитых старой валидацией
    if (details.reason === 'update' || details.reason === 'install') {
        await resetInvalidStatuses();
    }
    await init();
});

// ============================================================================
// ТОЧКА ВХОДА SW
// ============================================================================
let initialized = false;
async function init() {
    if (initialized) {
        // onStartup и onInstalled могут сработать после инициализации модуля
        return;
    }
    initialized = true;
    try {
        // Сначала загружаем настройки, потом всё остальное (зависит от S())
        await refreshSettingsCache();
        log('info', 'bg', 'SW init start, settings loaded');
        await restoreAllState();
        await setupAutoCheckAlarm();
        await normalizeDatesIfNeeded();
        // Учитываем старт SW в метриках (кэш + отложенный сброс — без
        // немедленной записи на диск)
        await updateMetrics(m => {
            m.sw_restarts++;
            m.last_sw_start = Date.now();
            return m;
        });
        await resumeProcessingIfNeeded();
        // v1.3.1: keepalive создаётся только если есть активная работа
        await manageKeepalive();
        log('info', 'bg', 'SW инициализирован');
    } catch (e) {
        log('error', 'bg', 'SW init error', e);
        console.error('SW init error:', e);
    }
}

// Запускаем init() при первом старте SW (не считая onStartup/onInstalled)
init();