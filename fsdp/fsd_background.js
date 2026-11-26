'use strict';
import {
    FICHUB_HOST, STORE_NAME, MAX_RESUME_ATTEMPTS, FIVE_YEARS_MS,
    t_rec_sl, t_monitor, parseDate, normalize, buildFileName,
    resolveStatus, computeNeedUpd, getDB, saveMonitorState, loadMonitorState,
    saveQueueArr, saveRuntimeState, loadRuntimeState, saveFetchState,
    loadFetchState, clearAllFetchStates, saveDownloadQueue, loadDownloadQueue,
    clearDownloadQueue, loadMetrics, updateMetrics, saveMetrics, flushMetrics,
    DEFAULT_METRICS, clearAllState, loadSettings, getCachedSettings,
    refreshSettingsCache, saveSettings, log, flushLog, clearLog,
    validateDownloadedFile,
} from './fsd_shared.js';

function S() { return getCachedSettings(); }

const STATUS_BATCH = 100;
const PATH_SEPARATOR_REGEX = /[\/\\]/;
const CLEAN_NUMBER_SUFFIX_REGEX = /\s*\(\d+\)/g;
const FICHUB_API_BASE = 'https://fichub.net/api/v0/epub?q=';
const API_MAX_RETRIES = 60;
const API_DEFAULT_RETRY_DELAY_SEC = 5;
const API_NETWORK_ERROR_DELAY_MS = 5000;
const API_FETCH_TIMEOUT_MS = 60 * 1000;
const API_FATAL_STATUSES = new Set([400, 401, 403, 404, 405, 410]);
const PERMANENT_DL_ERRORS = new Set(['SERVER_BAD_CONTENT', 'SERVER_FAILED', 'SERVER_UNAUTHORIZED', 'SERVER_CERT_PROBLEM', 'SERVER_FORBIDDEN', 'USER_CANCELED']);
const DATE_REGEX = /Updated:\s*(?:<[^>]+>)\s*(\d{4}-\d{2}-\d{2})/;
const STATUS_REGEX = /Status:\s*(?:<[^>]+>)*([^<\r\n]+)/i;
const STUCK_PROCESSING_THRESHOLD_MS = 5 * 60 * 1000;

const ALARM_KEEPALIVE = 'fsd_keepalive';
const ALARM_PROCESS_NEXT = 'fsd_process_next';
const ALARM_DOWNLOAD_TIMEOUT_PREFIX = 'fsd_dl_timeout_';
const ALARM_API_BACKOFF_PREFIX = 'fsd_api_backoff_';
const ALARM_RESUME_DL_PREFIX = 'fsd_resume_dl_';
const ALARM_AUTO_CHECK = 'fsd_auto_check';
const ALARM_MIN_DELAY_MS = 30000; // v1.3.7: поднят до 30с для соответствия минимуму Chrome

let fsd_monitor = new t_monitor();
let is_processing = false;
let is_cancelled = false;
let pending_process_next = false;
let nextTimeoutId = null;
let currentlyProcessingUrl = null;
let currentlyProcessingStartedAt = 0;
let processAlarmActive = false;
let keepaliveActive = false;
const downloadResumeAttempts = new Map();
const pendingDownloadTimeouts = new Set();
const activeDownloadUrls = new Set();
let _dlQueueCache = null;
let _dlQueueUrls = new Set();

function shortDelay(ms) { return new Promise(r => setTimeout(r, ms)); }

const pendingAlarmWaits = new Map();
chrome.alarms.onAlarm.addListener((alarm) => {
    const resolve = pendingAlarmWaits.get(alarm.name);
    if (resolve) {
        pendingAlarmWaits.delete(alarm.name);
        resolve();
    }
});

function alarmDelay(name, delayMs) {
    return new Promise((resolve) => {
        pendingAlarmWaits.set(name, resolve);
        chrome.alarms.create(name, { delayInMinutes: Math.max(delayMs / 60000, 0.5) });
    });
}

async function smartDelay(delayMs, alarmName) {
    if (delayMs < ALARM_MIN_DELAY_MS) {
        await shortDelay(delayMs);
        return { kind: 'timeout' };
    }
    if (is_cancelled) return { kind: 'cancelled' };
    if (!alarmName) alarmName = ALARM_API_BACKOFF_PREFIX + Math.random().toString(36).slice(2);
    await alarmDelay(alarmName, delayMs);
    if (is_cancelled) return { kind: 'cancelled' };
    return { kind: 'alarm', name: alarmName };
}

async function persistRuntimeState() {
    const state = {
        is_processing, is_cancelled, pending_process_next, currentlyProcessingUrl,
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
        for (const [k, v] of state.downloadResumeAttempts) downloadResumeAttempts.set(k, v);
    }
    pendingDownloadTimeouts.clear();
    if (Array.isArray(state.pendingDownloadTimeouts)) {
        for (const url of state.pendingDownloadTimeouts) pendingDownloadTimeouts.add(url);
    }
    activeDownloadUrls.clear();
    if (Array.isArray(state.activeDownloadUrls)) {
        for (const url of state.activeDownloadUrls) activeDownloadUrls.add(url);
    }
}

async function restoreAllState() {
    const saved = await loadMonitorState();
    if (saved) {
        fsd_monitor = t_monitor.fromJSON(saved);
        console.log('состояние восстановлено, index_sl:', fsd_monitor.index_sl, 'arr_sl.length:', fsd_monitor.arr_sl.length, 'fsd_status:', fsd_monitor.fsd_status, 'is_paused:', fsd_monitor.is_paused);
    }
    await restoreRuntimeState();
}

async function persistAllState() {
    await saveMonitorState(fsd_monitor);
    await persistRuntimeState();
}

async function startDownloadTimeout(url_s) {
    const normalizedUrl = normalize(url_s);
    if (!normalizedUrl) return;
    if (pendingDownloadTimeouts.has(normalizedUrl)) {
        await chrome.alarms.clear(ALARM_DOWNLOAD_TIMEOUT_PREFIX + normalizedUrl);
    }
    pendingDownloadTimeouts.add(normalizedUrl);
    await chrome.alarms.create(ALARM_DOWNLOAD_TIMEOUT_PREFIX + normalizedUrl, { delayInMinutes: S().DOWNLOAD_TIMEOUT_MS / 60000 });
}

async function closePendingDownload(url_s) {
    const normalizedUrl = normalize(url_s);
    if (!normalizedUrl) return;
    pendingDownloadTimeouts.delete(normalizedUrl);
    await chrome.alarms.clear(ALARM_DOWNLOAD_TIMEOUT_PREFIX + normalizedUrl);
}

async function putRecord(rec) {
    if (rec && rec.date_upd instanceof Date) rec.date_upd = rec.date_upd.toISOString();
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

function sendStatus() {
    (async () => {
        try {
            const metrics = await loadMetrics();
            const downloadQueue = await getDownloadQueue();
            chrome.runtime.sendMessage({
                type_mess: 'a_status',
                statusPayload: {
                    arr_sl_len: fsd_monitor.arr_sl.length, arr_tab_len: 0, index_sl: fsd_monitor.index_sl,
                    c_u_s: fsd_monitor.c_u_s, c_e_s: fsd_monitor.c_e_s, fsd_status: fsd_monitor.fsd_status,
                    url_op: fsd_monitor.url_op, s_c: fsd_monitor.s_c, is_paused: fsd_monitor.is_paused,
                    active_downloads: activeDownloadUrls.size, download_queue_len: downloadQueue.length,
                    sw_restarts: metrics.sw_restarts, last_sw_start: metrics.last_sw_start,
                    total_urls_processed: metrics.total_urls_processed, total_urls_timeout: metrics.total_urls_timeout,
                    total_urls_not_found: metrics.total_urls_not_found, total_downloads_completed: metrics.total_downloads_completed,
                    total_invalid_files: metrics.total_invalid_files,
                },
            }).catch(() => {});
        } catch (e) { console.warn('sendStatus error:', e); }
    })();
    manageKeepalive();
}

function audit_fields(v) { if (v === undefined || v === null) return ''; return v; }
const RECORD_FIELDS = ['url_s', 'name', 's_status', 'date_upd', 'url_fh', 'file_p', 'id_f', 'hash_f', 'need_upd'];

function recordsDiffer(a, b) {
    return RECORD_FIELDS.some(f => a[f] !== b[f]);
}

function fixUrl(url) {
    if (!url || typeof url !== 'string') return '';
    url = url.split('?')[0];
    if (url.startsWith('http://') || url.startsWith('https://')) {
        try {
            const parsed = new URL(url);
            if (parsed.hostname !== FICHUB_HOST) return ''; // v1.3.7: защита от произвольных доменов
            return url;
        } catch (e) { return ''; }
    }
    if (url.startsWith('/')) return 'https://' + FICHUB_HOST + url;
    return 'https://' + FICHUB_HOST + '/' + url;
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
        if (res.urls[types[i]]) urls[types[i]] = fixUrl(res.urls[types[i]]);
    }
    return urls;
}

async function fetchEpubApi(url_s) {
    let state = await loadFetchState(url_s);
    if (!state) {
        state = { attempt: 0, backoff_429_ms: S().API_429_BASE_DELAY_MS, started_at: Date.now() };
    } else {
        console.log('fetchEpubApi: возобновление с попытки', state.attempt, 'для', url_s, '(backoff_429 =', state.backoff_429_ms, 'мс)');
    }
    while (state.attempt < API_MAX_RETRIES) {
        if (is_cancelled) { await saveFetchState(url_s, null); return { ok: false, status: 'cancelled' }; }
        let resp;
        try {
            resp = await fetch(FICHUB_API_BASE + encodeURIComponent(url_s), { signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS) });
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
            let delayMs = retryAfterHeader ? (Number(retryAfterHeader) * 1000) || state.backoff_429_ms : state.backoff_429_ms;
            console.warn('fetchEpubApi: HTTP 429, ждём', (delayMs / 1000).toFixed(1), 'сек, попытка', state.attempt + 1);
            if (is_cancelled) { await saveFetchState(url_s, null); return { ok: false, status: 'cancelled' }; }
            state.attempt++;
            state.backoff_429_ms = Math.min(state.backoff_429_ms * 2, S().API_429_MAX_DELAY_MS);
            await saveFetchState(url_s, state);
            const delayRes = await smartDelay(delayMs, ALARM_API_BACKOFF_PREFIX + '429_' + state.attempt);
            if (delayRes.kind === 'cancelled') { await saveFetchState(url_s, null); return { ok: false, status: 'cancelled' }; }
            continue;
        }
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
        try { res = await resp.json(); } catch (e) {
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
            console.log('fetchEpubApi: retry_after', delaySec, 'сек, попытка', state.attempt + 1, 'error:', res.error || res.err || 0);
            if (is_cancelled) { await saveFetchState(url_s, null); return { ok: false, status: 'cancelled' }; }
            state.attempt++;
            await saveFetchState(url_s, state);
            const delayRes2 = await smartDelay(delaySec * 1000, ALARM_API_BACKOFF_PREFIX + 'retry_' + state.attempt);
            if (delayRes2.kind === 'cancelled') { await saveFetchState(url_s, null); return { ok: false, status: 'cancelled' }; }
            continue;
        }
        const hasError = ('error' in res && res.error != 0) || ('err' in res && res.err != 0);
        if (hasError) {
            const upstreamFail = res.upstream === true;
            const status = upstreamFail ? 'timeout' : 'not_found';
            console.warn('fetchEpubApi: ошибка', res.msg || res.error, '| upstream:', upstreamFail, '| ret:', res.ret, '→', status);
            await saveFetchState(url_s, null);
            return { ok: false, status, res };
        }
        const urls = extractUrls(res);
        if (Object.keys(urls).length > 0) {
            let s_status = '';
            let r_date = new Date(0);
            if (res.meta) {
                if (typeof res.meta.status === 'string' && res.meta.status.trim() !== '') s_status = res.meta.status.trim();
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
                if (m2 && m2[1]) s_status = m2[1].replace(/<[^>]+>/g, '').trim();
            }
            const hash_f = (res.hashes && (res.hashes.epub || res.hashes.html)) || '';
            console.log('fetchEpubApi: успех, url_fh =', urls.html || urls.epub);
            await saveFetchState(url_s, null);
            return { ok: true, url_fh: urls.html || urls.epub || '', urls, s_status, date_upd: r_date.toISOString(), hash_f };
        }
        console.log('fetchEpubApi: нет ссылок, попытка', state.attempt + 1);
        state.attempt++;
        await saveFetchState(url_s, state);
        await shortDelay(S().API_REQUEST_DELAY_MS);
    }
    await saveFetchState(url_s, null);
    return { ok: false, status: 'timeout' };
}

// v1.3.7: хелпер для пометки ошибки без затирания даты и статуса
async function markErrorRecord(url_s, isNotFound) {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    let rec = await tx.store.get(url_s);
    if (!rec) {
        rec = new t_rec_sl();
        rec.url_s = normalize(url_s);
    }
    rec.need_upd = true;
    if (isNotFound) rec.s_status = 'not_found';
    await tx.store.put(rec);
    await tx.done;
}

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
            fsd_monitor.c_e_s++;
            await markErrorRecord(url_s, result.status === 'not_found');
            if (result.status === 'timeout') await updateMetrics(m => { m.total_urls_timeout++; return m; });
            else if (result.status === 'not_found') await updateMetrics(m => { m.total_urls_not_found++; return m; });
        } else {
            await add_sl({
                url_s: url_s, url_fh: result.url_fh, s_status: result.s_status,
                date_upd: result.date_upd, file_p: '', id_f: '', hash_f: result.hash_f || '',
            }, false, true);
        }
        await updateMetrics(m => {
            m.total_urls_processed++;
            const dur = currentlyProcessingStartedAt ? (Date.now() - currentlyProcessingStartedAt) : 0;
            m.processing_time_ms_total += dur;
            m.processing_count++;
            if (!Array.isArray(m.recent_processing_times_ms)) m.recent_processing_times_ms = [];
            m.recent_processing_times_ms.push(dur);
            return m;
        });
    } catch (e) {
        if (is_cancelled) return;
        console.error('processUrl error:', e);
        fsd_monitor.c_e_s++;
        await markErrorRecord(url_s, false);
        await updateMetrics(m => { m.total_urls_timeout++; return m; });
    }
    currentlyProcessingUrl = null;
    currentlyProcessingStartedAt = 0;
    await persistRuntimeState();
    if (fsd_monitor.flag_dwd) return;
    await shortDelay(S().API_REQUEST_DELAY_MS);
    scheduleNext();
}

async function fix(arr_file_p = []) {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const keyChanges = [], fieldChanges = [];
    let del_file_p = 0;
    const filePCounts = new Map();
    const entries = [];
    const arrFilePSet = arr_file_p.length > 0 ? new Set(arr_file_p) : null;
    
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
        record_sl.date_upd = parseDate(original.date_upd).toISOString();
        record_sl.s_status = resolveStatus(audit_fields(original.s_status), record_sl.date_upd);
        record_sl.url_fh = audit_fields(original.url_fh);
        record_sl.file_p = audit_fields(original.file_p);
        if (record_sl.file_p !== '') {
            const baseName = record_sl.file_p.split(PATH_SEPARATOR_REGEX).pop();
            if (baseName !== record_sl.file_p) record_sl.file_p = baseName;
        }
        if (arrFilePSet) {
            if (record_sl.file_p !== '' && !arrFilePSet.has(record_sl.file_p)) {
                record_sl.file_p = '';
                del_file_p++;
            }
        }
        const cleanedName = record_sl.file_p.replace(CLEAN_NUMBER_SUFFIX_REGEX, '');
        if (cleanedName !== record_sl.file_p) record_sl.file_p = cleanedName;
        record_sl.id_f = original.id_f || '';
        record_sl.hash_f = audit_fields(original.hash_f);
        record_sl.need_upd = typeof original.need_upd === 'boolean' ? original.need_upd : computeNeedUpd(record_sl.s_status, record_sl.date_upd);
        
        if (record_sl.file_p !== '') filePCounts.set(record_sl.file_p, (filePCounts.get(record_sl.file_p) || 0) + 1);
        entries.push({ oldKey, record: record_sl, original });
    }
    
    for (const { oldKey, record: record_sl, original } of entries) {
        if (record_sl.file_p !== '' && (filePCounts.get(record_sl.file_p) || 0) > 1) {
            record_sl.file_p = '';
            del_file_p++;
        }
        const upd_key = oldKey !== record_sl.url_s;
        if (upd_key) keyChanges.push({ oldKey, record: record_sl });
        else if (recordsDiffer(record_sl, original)) fieldChanges.push(record_sl);
    }
    
    for (const record of fieldChanges) tx.store.put(record).catch(() => {});
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
                merged.need_upd = change.record.need_upd || exist_new.need_upd || false;
                await tx.store.put(merged);
                await tx.store.delete(change.oldKey);
            } else {
                await tx.store.put(change.record);
                await tx.store.delete(change.oldKey);
            }
        } catch (e) { console.error('fix: ошибка обновления ключа:', change.oldKey, e); }
    }
    await tx.done;
    fsd_monitor.s_c = await countRecord();
    console.log('fix: готово. обновлено полей:', fieldChanges.length, 'ключей:', keyChanges.length, 'дубликатов file_p очищено:', del_file_p);
}

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
            const needsUpdate = !v.url_fh || (!v.file_p && v.s_status !== 'invalid') || v.need_upd === true;
            if (needsUpdate) array_sl.push(v.url_s);
        }
        if (array_sl.length % STATUS_BATCH === 0) {
            fsd_monitor.fsd_status = 'load ' + array_sl.length;
            sendStatus();
        }
    }
    await tx.done;
    console.log('create_arr_sl: выбрано записей:', array_sl.length);
    return array_sl;
}

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
    await saveQueueArr(array_sl);
    await persistAllState();
    ensureProcessNextAlarm();
    sendStatus();
    process_next();
}

async function process_next() {
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
            await saveQueueArr([]);
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

function scheduleNext() {
    if (fsd_monitor.flag_dwd || fsd_monitor.is_paused) return;
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
    if (nextTimeoutId) { clearTimeout(nextTimeoutId); nextTimeoutId = null; }
    processAlarmActive = false;
    chrome.alarms.clear(ALARM_PROCESS_NEXT).catch(() => {});
}

function finishDownloadStep() {
    if (fsd_monitor.flag_dwd) {
        fsd_monitor.flag_dwd = false;
        pumpDownloadQueue();
        process_next();
    }
}

async function getDownloadQueue() {
    if (_dlQueueCache) return _dlQueueCache;
    _dlQueueCache = await loadDownloadQueue();
    _dlQueueUrls = new Set(_dlQueueCache.map(item => item.url_s));
    return _dlQueueCache;
}

async function flushDownloadQueue() {
    if (_dlQueueCache) await saveDownloadQueue(_dlQueueCache);
}

async function enqueueDownload(url_s, url_fh) {
    const queue = await getDownloadQueue();
    if (_dlQueueUrls.has(url_s)) return;
    _dlQueueUrls.add(url_s);
    queue.push({ url_s, url_fh, enqueued_at: Date.now() });
}

async function pumpDownloadQueue() {
    if (fsd_monitor.is_paused) { await flushDownloadQueue(); return; }
    const queue = await getDownloadQueue();
    let started = 0;
    while (queue.length > 0 && activeDownloadUrls.size < S().MAX_CONCURRENT_DOWNLOADS) {
        const item = queue.shift();
        _dlQueueUrls.delete(item.url_s);
        started++;
        await startDownloadInternal(item.url_s, item.url_fh, { persist: false });
    }
    await flushDownloadQueue();
    if (started > 0) await persistRuntimeState();
}

async function startDownloadInternal(url_s, url_fh, opts) {
    if (activeDownloadUrls.has(url_fh)) {
        console.log('startDownloadInternal: уже активна, пропуск:', url_fh);
        return;
    }
    activeDownloadUrls.add(url_fh);
    await startDownloadTimeout(url_s);
    if (!opts || opts.persist !== false) await persistRuntimeState();
    
    chrome.downloads.download({ url: url_fh, saveAs: false, conflictAction: 'overwrite' }, function (downloadId) {
        if (chrome.runtime.lastError) {
            console.log('ошибка загрузки:', chrome.runtime.lastError.message);
            activeDownloadUrls.delete(url_fh);
            closePendingDownload(url_s);
            persistRuntimeState();
            if (activeDownloadUrls.size === 0) {
                fsd_monitor.flag_dwd = false;
                scheduleNext();
            }
            pumpDownloadQueue();
        } else {
            console.log(fsd_monitor.c_u_s + 1, ' загрузка началась, id:', downloadId);
            updateMetrics(m => { m.total_downloads_started++; return m; });
        }
    });
}

async function add_sl(exp_rec, noDownload = false, noStatusResolve = false) {
    const record_sl = new t_rec_sl();
    record_sl.url_s = normalize(exp_rec.url_s || '');
    if (record_sl.url_s === '') {
        console.warn('add_sl: пустой URL, пропуск');
        fsd_monitor.flag_dwd = false;
        return;
    }
    const parsed_date = parseDate(exp_rec.date_upd);
    record_sl.date_upd = parsed_date.toISOString();
    record_sl.s_status = noStatusResolve ? (exp_rec.s_status || '') : resolveStatus(exp_rec.s_status || '', parsed_date);
    record_sl.url_fh = exp_rec.url_fh || '';
    record_sl.name = buildFileName(record_sl.url_s);
    record_sl.file_p = exp_rec.file_p || '';
    record_sl.id_f = exp_rec.id_f || '';
    record_sl.hash_f = exp_rec.hash_f || '';
    record_sl.need_upd = computeNeedUpd(record_sl.s_status, record_sl.date_upd); // v1.3.7

    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const exist_rec = (await tx.store.get(record_sl.url_s)) || new t_rec_sl();
    const exist_date = parseDate(exist_rec.date_upd);
    
    const hashChanged = record_sl.hash_f !== '' && exist_rec.hash_f !== '' && record_sl.hash_f !== exist_rec.hash_f;
    const hashNew = record_sl.hash_f !== '' && exist_rec.hash_f === '';
    const reasons = [];
    
    if (parsed_date > exist_date) reasons.push('новая дата');
    if (record_sl.url_fh !== '' && record_sl.url_fh !== exist_rec.url_fh) reasons.push('новый url_fh');
    if (hashChanged) reasons.push('изменился hash контента');
    if (hashNew) reasons.push('первый hash');
    if (exist_rec.file_p === '') reasons.push('нет file_p');
    if (record_sl.s_status !== exist_rec.s_status) reasons.push('статус: ' + exist_rec.s_status + ' → ' + record_sl.s_status);
    if (record_sl.need_upd !== !!exist_rec.need_upd) reasons.push('need_upd: ' + !!exist_rec.need_upd + ' → ' + record_sl.need_upd);

    const needsUpdate = reasons.length > 0;
    if (needsUpdate) console.log('add_sl: обновление для', record_sl.url_s, '— причины:', reasons.join(', '));
    
    if (!needsUpdate) {
        await tx.done;
        fsd_monitor.flag_dwd = false;
        return;
    }
    
    let needDownload = false;
    if (noDownload && exist_date.getTime() === 0) {
        console.log('upd db');
    } else if (parsed_date > exist_date) {
        if (!noDownload) { record_sl.file_p = ''; record_sl.id_f = ''; needDownload = true; }
        console.log('new date');
    } else if (record_sl.url_fh !== '' && record_sl.url_fh !== exist_rec.url_fh) {
        if (!noDownload) { record_sl.file_p = ''; record_sl.id_f = ''; needDownload = true; }
        console.log('new url');
    } else if (hashChanged) {
        const silentHashUpdate = record_sl.s_status !== 'ongoing' && exist_rec.file_p !== '';
        if (!noDownload && !silentHashUpdate) {
            record_sl.file_p = ''; record_sl.id_f = ''; needDownload = true;
            console.log('new hash — перекачка');
        } else {
            record_sl.file_p = exist_rec.file_p || ''; record_sl.id_f = exist_rec.id_f || '';
            console.log('new hash — без перекачки', silentHashUpdate ? '(не ongoing, файл есть)' : '');
        }
    } else if (record_sl.s_status !== exist_rec.s_status) {
        record_sl.file_p = exist_rec.file_p || ''; record_sl.id_f = exist_rec.id_f || '';
        needDownload = !noDownload && (exist_rec.file_p === '');
        console.log('new status');
    } else {
        record_sl.file_p = exist_rec.file_p || ''; record_sl.id_f = exist_rec.id_f || '';
        needDownload = !noDownload && (exist_rec.file_p === '');
        console.log('new file');
    }
    
    await tx.store.put(record_sl);
    await tx.done;
    
    if (record_sl.url_fh !== '' && needDownload) {
        console.log('add_sl: нужна загрузка, url =', record_sl.url_fh);
        if (activeDownloadUrls.size >= S().MAX_CONCURRENT_DOWNLOADS) {
            console.log('add_sl: лимит загрузок, ставим в очередь:', record_sl.url_fh);
            await enqueueDownload(record_sl.url_s, record_sl.url_fh);
        } else {
            await startDownloadInternal(record_sl.url_s, record_sl.url_fh);
        }
        fsd_monitor.flag_dwd = true;
    } else {
        fsd_monitor.flag_dwd = false;
    }
}

async function handleDownloadComplete(delta, dwd) {
    const downloadItem = dwd[0];
    const rec = await getRecordByDownloadUrl(downloadItem.url);
    downloadResumeAttempts.delete(delta.id);
    activeDownloadUrls.delete(downloadItem.url);
    
    let validation = { valid: true };
    if (rec) {
        const expectHtml = !!(rec.url_fh && rec.url_fh.includes('/cache/html/'));
        validation = validateDownloadedFile(downloadItem, S(), { expectHtml });
    }
    
    if (rec) {
        if (!validation.valid) {
            log('warn', 'bg', 'валидация не пройдена для ' + rec.url_s + ': ' + validation.reason, validation);
            rec.s_status = 'invalid';
            rec.need_upd = false; // v1.3.7: invalid не должен переспрашиваться
            await putRecord(rec);
            await closePendingDownload(rec.url_s);
            try { await chrome.downloads.removeFile(delta.id); } catch (e) { log('debug', 'bg', 'не удалось удалить невалидный файл', e); }
            try { await chrome.downloads.erase({ id: delta.id }); } catch (e) { log('debug', 'bg', 'не удалось удалить запись из истории загрузок', e); }
            fsd_monitor.c_e_s++;
            await updateMetrics(m => { m.total_invalid_files++; return m; });
        } else {
            const fullPath = downloadItem.filename || '';
            rec.file_p = fullPath.split(PATH_SEPARATOR_REGEX).pop();
            rec.id_f = delta.id;
            await putRecord(rec);
            await closePendingDownload(rec.url_s);
            fsd_monitor.c_u_s++;
            await updateMetrics(m => { m.total_downloads_completed++; return m; });
            log('info', 'bg', 'загрузка завершена: ' + (rec.file_p || rec.url_s));
        }
    }
    await persistRuntimeState();
    finishDownloadStep();
}

async function handleDownloadInterrupted(delta, dwd) {
    const attempts = (downloadResumeAttempts.get(delta.id) || 0) + 1;
    downloadResumeAttempts.set(delta.id, attempts);
    await updateMetrics(m => { m.total_downloads_interrupted++; m.total_resume_attempts++; return m; });
    await persistRuntimeState();
    
    const errorCode = delta.error && delta.error.current;
    const permanentError = errorCode && PERMANENT_DL_ERRORS.has(errorCode);
    const notFoundError = errorCode === 'FILE_NOT_FOUND';
    
    if (permanentError || notFoundError || attempts > MAX_RESUME_ATTEMPTS) {
        console.error(permanentError || notFoundError ? 'постоянная ошибка загрузки (' + errorCode + '), resume не нужен:' : 'превышен лимит resume для:', delta.id);
        downloadResumeAttempts.delete(delta.id);
        activeDownloadUrls.delete(dwd[0].url);
        const rec = await getRecordByDownloadUrl(dwd[0].url);
        if (rec) {
            rec.s_status = notFoundError ? 'not_found' : 'timeout';
            rec.need_upd = true; // v1.3.7: ошибка загрузки — перепроверить
            await putRecord(rec);
            await closePendingDownload(rec.url_s);
        }
        await updateMetrics(m => { if (notFoundError) m.total_urls_not_found++; else m.total_urls_timeout++; return m; });
        try { await chrome.downloads.erase({ id: delta.id }); } catch (e) { log('debug', 'bg', 'не удалось удалить запись из истории загрузок', e); }
        await persistRuntimeState();
        finishDownloadStep();
        return;
    }
    
    console.log('перезапуск загрузки, попытка', attempts, 'id:', delta.id);
    await chrome.alarms.create(ALARM_RESUME_DL_PREFIX + delta.id, { delayInMinutes: 0.5 });
}

async function resumeDownload(downloadId) {
    try { await chrome.downloads.cancel(downloadId); } catch (e) { /* уже завершена/отменена */ }
    const dwd = await chrome.downloads.search({ id: downloadId });
    if (!Array.isArray(dwd) || dwd.length === 0) return;
    const url = dwd[0].url;
    const attempts = downloadResumeAttempts.get(downloadId) || 1;
    const rec = await getRecordByDownloadUrl(url);
    downloadResumeAttempts.delete(downloadId);
    activeDownloadUrls.delete(url);
    
    if (!rec || !rec.url_fh) { finishDownloadStep(); return; }
    
    await startDownloadTimeout(rec.url_s); // v1.3.7: свежий watchdog
    chrome.downloads.download({ url: rec.url_fh, saveAs: false, conflictAction: 'overwrite' }, function (newDownloadId) {
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
        if (delta.state.current === 'complete') await handleDownloadComplete(delta, dwd);
        else if (delta.state.current === 'interrupted') await handleDownloadInterrupted(delta, dwd);
    } catch (e) { console.log('не удалось разобрать URL:', e); }
});

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
                // v1.3.7: исправлен NaN при вычислении elapsed
                const elapsed = d.startTime ? (Date.now() - new Date(d.startTime).getTime()) : 0;
                const remaining = Math.max(S().DOWNLOAD_TIMEOUT_MS - elapsed, 60000);
                await chrome.alarms.create(ALARM_DOWNLOAD_TIMEOUT_PREFIX + normalizedUrl, { delayInMinutes: Math.max(remaining / 60000, 1) });
                reattached++;
            } catch (e) { /* skip invalid downloads */ }
        }
        if (reattached > 0) {
            console.log('reattachPendingDownloads: переподключено загрузок:', reattached);
            await persistRuntimeState();
        }
    } catch (e) { console.warn('reattachPendingDownloads error:', e); }
}

async function resumeProcessingIfNeeded() {
    if (currentlyProcessingUrl) {
        console.warn('resumeProcessingIfNeeded: SW прерван при обработке URL, помечаем как timeout:', currentlyProcessingUrl);
        try {
            await markErrorRecord(currentlyProcessingUrl, false);
            await saveFetchState(currentlyProcessingUrl, null);
        } catch (e) { console.error('resumeProcessingIfNeeded: ошибка пометки timeout:', e); }
        currentlyProcessingUrl = null;
        currentlyProcessingStartedAt = 0;
        is_processing = false;
        fsd_monitor.flag_dwd = false;
        await updateMetrics(m => { m.total_urls_timeout++; return m; });
    }
    await reattachPendingDownloads();
    const alarms = await chrome.alarms.getAll();
    await Promise.all(alarms.filter(a => a.name.startsWith(ALARM_API_BACKOFF_PREFIX)).map(a => chrome.alarms.clear(a.name)));
    
    if (is_cancelled || fsd_monitor.is_paused) return;
    
    if (fsd_monitor.fsd_status === 'work' && fsd_monitor.arr_sl && fsd_monitor.arr_sl.length > 0) {
        is_processing = false;
        pending_process_next = false;
        console.log('resumeProcessingIfNeeded: возобновление обработки, index_sl=', fsd_monitor.index_sl, 'из', fsd_monitor.arr_sl.length - 1);
        ensureProcessNextAlarm();
        process_next();
    } else if (fsd_monitor.flag_dwd) {
        console.log('resumeProcessingIfNeeded: ожидаем завершения активной загрузки');
    } else {
        console.log('resumeProcessingIfNeeded: активной обработки нет');
    }
    await pumpDownloadQueue();
}

async function runAutoCheck() {
    const settings = S();
    if (!settings.AUTO_CHECK_ENABLED || fsd_monitor.fsd_status === 'work' || is_processing || fsd_monitor.is_paused) return;
    try {
        const db = await getDB();
        const array_sl = [];
        const tx = db.transaction(STORE_NAME, 'readonly');
        const index = tx.store.index('by_date_upd');
        const cutoff = new Date(Date.now() - FIVE_YEARS_MS).toISOString();
        // v1.3.7: lowerBound('') вместо new Date(0) для корректной работы со строковыми ключами
        for await (const cursor of index.lowerBound('')) {
            const v = cursor.value;
            if (!v) continue;
            if (!v.date_upd || v.date_upd > cutoff) break;
            if (v.s_status === 'old' || v.s_status === 'ongoing') array_sl.push(v.url_s);
        }
        await tx.done;
        log('info', 'bg', 'auto-check: выбрано старых незакрытых историй: ' + array_sl.length);
        if (array_sl.length === 0) return;
        await startQueue(array_sl);
    } catch (e) { log('error', 'bg', 'auto-check: ошибка', e); }
}

async function setupAutoCheckAlarm() {
    await chrome.alarms.clear(ALARM_AUTO_CHECK);
    const settings = S();
    if (!settings.AUTO_CHECK_ENABLED) return;
    const hours = settings.AUTO_CHECK_INTERVAL_HOURS || 24;
    if (hours <= 0) return;
    const periodMinutes = hours * 60;
    await chrome.alarms.create(ALARM_AUTO_CHECK, { periodInMinutes: Math.max(periodMinutes, 1) });
    log('info', 'bg', 'auto-check: alarm установлен, interval=' + hours + 'ч');
}

function hasActiveWork() { return fsd_monitor.fsd_status === 'work' || activeDownloadUrls.size > 0; }

async function manageKeepalive() {
    try {
        if (hasActiveWork()) {
            if (!keepaliveActive) {
                keepaliveActive = true;
                await chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: Math.max(S().KEEPALIVE_PERIOD_MIN, 0.5) });
            }
        } else if (keepaliveActive) {
            keepaliveActive = false;
            await chrome.alarms.clear(ALARM_KEEPALIVE);
        }
    } catch (e) { console.warn('manageKeepalive error:', e); }
}

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
        if (converted > 0) console.log('миграция date_upd → ISO: преобразовано записей:', converted);
    } catch (e) { console.warn('миграция date_upd error:', e); }
}

async function resetInvalidStatuses() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        let reset = 0;
        for await (const cursor of tx.store) {
            const v = cursor.value;
            if (v && v.s_status === 'invalid') {
                v.s_status = '';
                v.need_upd = true; // v1.3.7: пометить для перепроверки
                await cursor.update(v);
                reset++;
            }
        }
        await tx.done;
        if (reset > 0) log('info', 'bg', 'миграция: сброшен статус invalid у записей: ' + reset);
    } catch (e) { console.warn('resetInvalidStatuses error:', e); }
}

async function restoreOldStatuses() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        let restored = 0;
        for await (const cursor of tx.store) {
            const v = cursor.value;
            if (!v) continue;
            const resolved = resolveStatus(v.s_status || '', v.date_upd);
            if (resolved !== v.s_status) {
                v.s_status = resolved;
                await cursor.update(v);
                restored++;
            }
        }
        await tx.done;
        if (restored > 0) log('info', 'bg', 'миграция: восстановлен статус old у записей: ' + restored);
    } catch (e) { console.warn('restoreOldStatuses error:', e); }
}

const NEED_UPD_MIGRATED_KEY = 'fsd_need_upd_migrated';
async function migrateNeedUpdIfNeeded() {
    try {
        const res = await chrome.storage.local.get(NEED_UPD_MIGRATED_KEY);
        if (res[NEED_UPD_MIGRATED_KEY]) return;
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        let updated = 0;
        for await (const cursor of tx.store) {
            const v = cursor.value;
            if (v && typeof v.need_upd !== 'boolean') {
                v.need_upd = computeNeedUpd(v.s_status, v.date_upd);
                await cursor.update(v);
                updated++;
            }
        }
        await tx.done;
        await chrome.storage.local.set({ [NEED_UPD_MIGRATED_KEY]: true });
        console.log('migrateNeedUpd: обновлено записей:', updated);
    } catch (e) { console.warn('migrateNeedUpd error:', e); }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_KEEPALIVE) {
        if (!hasActiveWork()) { await manageKeepalive(); return; }
        if (currentlyProcessingUrl && currentlyProcessingStartedAt && (Date.now() - currentlyProcessingStartedAt) > STUCK_PROCESSING_THRESHOLD_MS) {
            console.warn('KEEPALIVE: обнаружена застрявшая обработка, помечаем как timeout:', currentlyProcessingUrl);
            try {
                await markErrorRecord(currentlyProcessingUrl, false);
                await saveFetchState(currentlyProcessingUrl, null);
            } catch (e) { console.error('KEEPALIVE: ошибка пометки timeout:', e); }
            currentlyProcessingUrl = null;
            currentlyProcessingStartedAt = 0;
            is_processing = false;
            fsd_monitor.flag_dwd = false;
            await updateMetrics(m => { m.total_urls_timeout++; return m; });
            await persistRuntimeState();
            if (!fsd_monitor.is_paused) process_next();
        }
        if (!is_processing && !is_cancelled && !fsd_monitor.is_paused && !fsd_monitor.flag_dwd && fsd_monitor.fsd_status === 'work' && fsd_monitor.arr_sl && fsd_monitor.arr_sl.length > 0 && fsd_monitor.index_sl < fsd_monitor.arr_sl.length - 1) {
            console.log('KEEPALIVE: обнаружен простой обработки, продолжаем');
            process_next();
        }
        await pumpDownloadQueue();
        return;
    }
    if (alarm.name === ALARM_PROCESS_NEXT) {
        processAlarmActive = false;
        if (!nextTimeoutId && !is_processing && !fsd_monitor.flag_dwd && !fsd_monitor.is_paused) {
            console.log('ALARM PROCESS_NEXT: backup-возобновление обработки');
            process_next();
        }
        if (fsd_monitor.fsd_status === 'work' && !fsd_monitor.is_paused) ensureProcessNextAlarm();
        return;
    }
    if (alarm.name === ALARM_AUTO_CHECK) {
        log('info', 'bg', 'auto-check: запуск фоновой проверки ongoing-историй');
        runAutoCheck();
        return;
    }
    if (alarm.name.startsWith(ALARM_RESUME_DL_PREFIX)) {
        const id = Number(alarm.name.slice(ALARM_RESUME_DL_PREFIX.length));
        if (Number.isFinite(id)) await resumeDownload(id);
        return;
    }
    if (alarm.name.startsWith(ALARM_DOWNLOAD_TIMEOUT_PREFIX)) {
        const url = alarm.name.slice(ALARM_DOWNLOAD_TIMEOUT_PREFIX.length);
        if (pendingDownloadTimeouts.has(url)) {
            console.warn('таймаут загрузки (alarm):', url);
            pendingDownloadTimeouts.delete(url);
            try {
                const rec = await getRecord(url);
                if (rec && rec.url_fh) {
                    activeDownloadUrls.delete(rec.url_fh);
                    const stalled = await chrome.downloads.search({ url: rec.url_fh, state: 'in_progress' });
                    for (const d of stalled) {
                        downloadResumeAttempts.delete(d.id);
                        try { await chrome.downloads.cancel(d.id); } catch (e) { /* уже неактивна */ }
                        try { await chrome.downloads.erase({ id: d.id }); } catch (e) { /* не критично */ }
                    }
                }
            } catch (e) { console.warn('таймаут: не удалось расчистить зависшие загрузки:', e); }
            await persistRuntimeState();
            finishDownloadStep();
        }
        return;
    }
});

chrome.runtime.onMessage.addListener(function (mess, sender, sendResponse) {
    if (!mess || !mess.type_mess) return false;
    if (mess.type_mess === 'get_settings') {
        sendResponse({ ok: true, settings: S() });
        return false;
    }
    (async function () {
        try {
            switch (mess.type_mess) {
                case 'q_status': sendStatus(); break;
                case 'run': await startQueue(await create_arr_sl(mess.regim)); break;
                case 'add_url': await handleAddUrl(mess); break;
                case 'add_urls': await handleAddUrls(mess); break;
                case 'pause':
                    fsd_monitor.is_paused = true;
                    clearScheduleNext();
                    await persistAllState();
                    sendStatus();
                    break;
                case 'resume':
                    fsd_monitor.is_paused = false;
                    await persistAllState();
                    sendStatus();
                    ensureProcessNextAlarm();
                    if (!is_processing) process_next();
                    await pumpDownloadQueue();
                    break;
                case 'stop':
                    is_cancelled = true;
                    // v1.3.7: разрешаем все висящие ожидания, чтобы fetchEpubApi мог завершиться
                    for (const [name, resolve] of pendingAlarmWaits.entries()) {
                        resolve({ kind: 'cancelled' });
                        pendingAlarmWaits.delete(name);
                    }
                    fsd_monitor = new t_monitor();
                    is_processing = false;
                    pending_process_next = false;
                    currentlyProcessingUrl = null;
                    currentlyProcessingStartedAt = 0;
                    downloadResumeAttempts.clear();
                    pendingDownloadTimeouts.clear();
                    activeDownloadUrls.clear();
                    _dlQueueCache = null;
                    _dlQueueUrls.clear();
                    clearScheduleNext();
                    keepaliveActive = false;
                    {
                        const alarms = await chrome.alarms.getAll();
                        await Promise.all(alarms.filter(a => a.name.startsWith('fsd_')).map(a => chrome.alarms.clear(a.name)));
                    }
                    await clearAllState();
                    sendStatus();
                    break;
                case 'fix': await fix(mess.arr_file_p); sendStatus(); break;
                case 'read story':
                    chrome.tabs.create({ url: chrome.runtime.getURL('visual.html'), active: false });
                    break;
                case 'save_sl': case 'save_dl': case 'JSON_file': case 'csv_file': {
                    const msgType = { save_sl: 'sl_file', save_dl: 'dl_file', JSON_file: 'JSON_file', csv_file: 'csv_file' }[mess.type_mess];
                    chrome.tabs.create({ url: chrome.runtime.getURL('save.html'), active: false }, function (tab) {
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
                        await setupAutoCheckAlarm();
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
                default: console.log('неизвестное сообщение:', mess.type_mess); break;
            }
        } catch (e) {
            console.error('Ошибка в обработчике сообщений:', e);
            log('error', 'bg', 'onMessage error', e);
            fsd_monitor.flag_dwd = false;
            scheduleNext();
        }
        sendStatus();
    })();
    return false;
});

async function handleAddUrl(mess) {
    let exp = mess.exp_rec;
    if (!exp || !exp.url_s) {
        if (mess.url_s && mess.url_s !== '') {
            exp = { url_s: mess.url_s, url_fh: mess.url_f || '', s_status: mess.s_status || '', date_upd: mess.date_upd || new Date(0).toISOString() };
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

chrome.runtime.onStartup.addListener(async () => { console.log('onStartup: браузер запущен, инициализация SW'); await init(); });
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('onInstalled:', details.reason);
    if (details.reason === 'update' || details.reason === 'install') await resetInvalidStatuses();
    await init();
});

let initialized = false;
async function init() {
    if (initialized) return;
    initialized = true;
    try {
        await refreshSettingsCache();
        log('info', 'bg', 'SW init start, settings loaded');
        await restoreAllState();
        await setupAutoCheckAlarm();
        await normalizeDatesIfNeeded();
        await restoreOldStatuses();
        await migrateNeedUpdIfNeeded(); // v1.3.7
        await updateMetrics(m => { m.sw_restarts++; m.last_sw_start = Date.now(); return m; });
        await resumeProcessingIfNeeded();
        await manageKeepalive();
        log('info', 'bg', 'SW инициализирован');
    } catch (e) {
        log('error', 'bg', 'SW init error', e);
        console.error('SW init error:', e);
    }
}
init();