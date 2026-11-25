'use strict';
import { openDB } from './libs/idb.js';

export const FIVE_YEARS_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;
export const FICHUB_HOST = 'fichub.net';
export const FICHUB_BASE = 'https://fichub.net/?b=1&q=';
export const DB_NAME = 'fsd_db';
export const DB_VERSION = 1;
export const STORE_NAME = 'story_list';
export const MAX_RESUME_ATTEMPTS = 20;

// === Ключи в chrome.storage ===
export const STORAGE_KEY_MONITOR = 'fsd_state';
export const STORAGE_KEY_QUEUE = 'fsd_queue_arr';        // v1.3.1: очередь хранится отдельно от состояния
export const STORAGE_KEY_RUNTIME = 'fsd_runtime_state';
export const STORAGE_KEY_FETCH_STATE = 'fsd_fetch_state';
export const STORAGE_KEY_DOWNLOAD_QUEUE = 'fsd_download_queue';
export const STORAGE_KEY_METRICS = 'fsd_metrics';
export const STORAGE_KEY_SETTINGS = 'fsd_settings';
export const STORAGE_KEY_LOG = 'fsd_log';

// === Дефолтные настройки (v1.3.1) ===
export const SETTINGS_DEFAULTS = {
    MAX_CONCURRENT_DOWNLOADS: 3,
    API_REQUEST_DELAY_MS: 5000,
    API_429_BASE_DELAY_MS: 15000,
    API_429_MAX_DELAY_MS: 120000,
    DOWNLOAD_TIMEOUT_MS: 5 * 60 * 1000,
    PROCESS_NEXT_DELAY_MS: 2000,
    AUTO_CHECK_INTERVAL_HOURS: 24,
    AUTO_CHECK_ENABLED: true,
    MIN_FILE_SIZE_BYTES: 1024,
    VALIDATE_FILE_SIGNATURE: true,
    LOG_LEVEL: 'info',
    MAX_LOG_ENTRIES: 200,
    KEEPALIVE_PERIOD_MIN: 0.5,
};

// === Уровни логирования ===
export const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export class t_rec_sl {
    constructor() {
        this.url_s = '';
        this.name = '';
        this.date_upd = new Date(0);
        this.s_status = '';
        this.url_fh = '';
        this.file_p = '';
        this.id_f = '';
        this.hash_f = ''; // v1.3.2: md5 файла из ответа API (hashes.epub); v1.3.3: перекачка по hash — только ongoing/без файла
    }
}

export class t_monitor {
    constructor() {
        this.arr_sl = [];
        this.index_sl = -1;
        this.c_u_s = 0;
        this.c_e_s = 0;
        this.fsd_status = 'free';
        this.url_op = '';
        this.s_c = 0;
        this.flag_dwd = false;
        this.is_paused = false;
    }

    // v1.3.1: arr_sl НЕ входит в toJSON — очередь пишется отдельным ключом
    // только при построении. Запись состояния на каждый шаг стала O(1)
    // вместо O(размер очереди).
    toJSON() {
        return {
            index_sl: this.index_sl,
            c_u_s: this.c_u_s,
            c_e_s: this.c_e_s,
            fsd_status: this.fsd_status,
            url_op: this.url_op,
            s_c: this.s_c,
            flag_dwd: this.flag_dwd,
            is_paused: this.is_paused,
        };
    }

    static fromJSON(obj) {
        const m = new t_monitor();
        if (!obj) return m;
        Object.assign(m, obj);
        delete m.arr_tab; // legacy-поле старых версий
        if (!Array.isArray(m.arr_sl)) m.arr_sl = [];
        if (typeof m.is_paused !== 'boolean') m.is_paused = false;
        return m;
    }
}

export function parseDate(value) {
    if (!value) return new Date(0);
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? new Date(0) : d;
}

const HOST_RULES = {
    'www.fanfiction.net': (parts) => {
        if (parts.length < 5) return null;
        parts[5] = '';
        parts.length = 6;
        return parts;
    },
    'archiveofourown.org': (parts) => {
        if (parts.length < 5) return null;
        parts[5] = '';
        parts.length = 6;
        return parts;
    },
    'forums.sufficientvelocity.com': (parts) => {
        if (parts.length < 5) return null;
        const temp = parts[4].split('.');
        parts[4] = temp[temp.length - 1];
        parts[5] = '';
        parts.length = 6;
        return parts;
    },
    'forums.spacebattles.com': (parts) => {
        if (parts.length < 5) return null;
        const temp = parts[4].split('.');
        parts[4] = temp[temp.length - 1];
        parts[5] = '';
        parts.length = 6;
        return parts;
    },
};

export function normalize(url_s) {
    if (!url_s || typeof url_s !== 'string' || url_s.trim() === '')
        return '';
    const url = url_s.split('?')[0].split('#')[0];
    const parts = url.split('/');
    if (parts.length < 3) return '';
    parts[0] = 'https:';
    if (parts.length > 3 && parts[parts.length - 1] === '') {
        parts.pop();
    }
    const rule = HOST_RULES[parts[2]];
    if (rule) {
        const result = rule(parts);
        if (!result) return '';
        return result.join('/');
    }
    return parts.join('/');
}

const FILE_PREFIXES = {
    'archiveofourown.org': 'ao3_',
    'www.fanfiction.net': 'ff_',
    'forums.spacebattles.com': 'sb_',
    'forums.sufficientvelocity.com': 'sv_',
};

export function buildFileName(url_s) {
    if (!url_s) return '';
    const parts = url_s.split('/');
    if (parts.length < 5) return '';
    const prefix = FILE_PREFIXES[parts[2]];
    if (!prefix) return '';
    return prefix + parts[4];
}

export function resolveStatus(s_status, date_upd) {
    if (s_status === 'ongoing') {
        const parsed = parseDate(date_upd);
        if ((Date.now() - Number(parsed)) > FIVE_YEARS_MS)
            return 'old';
    }
    return s_status;
}

export function formatDate(date) {
    if (!date) return '—';
    const d = date instanceof Date ? date : new Date(date);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

let _dbPromise = null;

export async function getDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
            let sl;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                sl = db.createObjectStore(STORE_NAME, { keyPath: 'url_s' });
            } else {
                sl = db.objectStore(STORE_NAME);
            }
            const indexes = [['by_id_f', 'id_f'], ['by_url_fh', 'url_fh'], ['by_date_upd', 'date_upd']];
            for (const [name, key] of indexes) {
                if (!sl.indexNames.contains(name)) {
                    sl.createIndex(name, key, { unique: false });
                }
            }
        },
        blocked() {
            console.warn('IndexedDB: соединение заблокировано');
            _dbPromise = null;
        },
        terminated() {
            console.warn('IndexedDB: соединение закрыто');
            _dbPromise = null;
        },
    });
    return _dbPromise;
}

// ============================================================================
// СОСТОЯНИЕ МОНИТОРА + ОЧЕРЕДЬ (v1.3.1)
// Раньше весь arr_sl сериализовался при каждом изменении состояния — на каждый
// шаг обработки писались сотни КБ. Теперь: компактное состояние — на каждом
// шаге, очередь arr_sl — одним ключом только при построении.
// ============================================================================
export async function saveMonitorState(monitor) {
    try {
        await chrome.storage.local.set({ [STORAGE_KEY_MONITOR]: monitor.toJSON() });
    } catch (e) {
        console.warn('saveMonitorState error:', e);
    }
}

export async function saveQueueArr(arr) {
    try {
        await chrome.storage.local.set({ [STORAGE_KEY_QUEUE]: arr || [] });
    } catch (e) {
        console.warn('saveQueueArr error:', e);
    }
}

export async function loadMonitorState() {
    let mon = null;
    let qArr;
    try {
        const result = await chrome.storage.local.get([STORAGE_KEY_MONITOR, STORAGE_KEY_QUEUE]);
        mon = result[STORAGE_KEY_MONITOR] || null;
        qArr = result[STORAGE_KEY_QUEUE];
    } catch (e) {
        console.warn('loadMonitorState error:', e);
        return null;
    }
    if (!mon) return null;
    if (!Array.isArray(qArr)) {
        // старый формат: очередь лежала внутри fsd_state
        qArr = Array.isArray(mon.arr_sl) ? mon.arr_sl : [];
    }
    mon.arr_sl = qArr;
    return mon;
}

export async function clearMonitorState() {
    try {
        await chrome.storage.local.remove([STORAGE_KEY_MONITOR, STORAGE_KEY_QUEUE]);
    } catch (e) {
        console.warn('clearMonitorState error:', e);
    }
}

// ============================================================================
// RUNTIME-ФЛАГИ SW
// ============================================================================
export async function saveRuntimeState(state) {
    try {
        await chrome.storage.local.set({ [STORAGE_KEY_RUNTIME]: state });
    } catch (e) {
        console.warn('saveRuntimeState error:', e);
    }
}

export async function loadRuntimeState() {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY_RUNTIME);
        return result[STORAGE_KEY_RUNTIME] || null;
    } catch (e) {
        console.warn('loadRuntimeState error:', e);
        return null;
    }
}

// ============================================================================
// STATE MACHINE ДЛЯ fetchEpubApi (v1.3.1 — упрощено)
// URL обрабатывается строго по одному, поэтому достаточно хранить состояние
// только ТЕКУЩЕГО URL под одним ключом. Раньше на каждое изменение читалась и
// писалась карта состояний всех URL.
// Формат: { url_s, state } либо отсутствие ключа.
// ============================================================================
export async function saveFetchState(url_s, state) {
    try {
        if (!state) {
            const result = await chrome.storage.local.get(STORAGE_KEY_FETCH_STATE);
            const cur = result[STORAGE_KEY_FETCH_STATE];
            if (cur && cur.url_s === url_s) {
                await chrome.storage.local.remove(STORAGE_KEY_FETCH_STATE);
            }
            return;
        }
        await chrome.storage.local.set({ [STORAGE_KEY_FETCH_STATE]: { url_s, state } });
    } catch (e) {
        console.warn('saveFetchState error:', e);
    }
}

export async function loadFetchState(url_s) {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY_FETCH_STATE);
        const cur = result[STORAGE_KEY_FETCH_STATE];
        return (cur && cur.url_s === url_s) ? cur.state : null;
    } catch (e) {
        console.warn('loadFetchState error:', e);
        return null;
    }
}

export async function clearAllFetchStates() {
    try {
        await chrome.storage.local.remove(STORAGE_KEY_FETCH_STATE);
    } catch (e) {
        console.warn('clearAllFetchStates error:', e);
    }
}

// ============================================================================
// DOWNLOAD QUEUE (хранилище; кэш в памяти — в background)
// ============================================================================
export async function saveDownloadQueue(queue) {
    try {
        await chrome.storage.local.set({ [STORAGE_KEY_DOWNLOAD_QUEUE]: queue });
    } catch (e) {
        console.warn('saveDownloadQueue error:', e);
    }
}

export async function loadDownloadQueue() {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY_DOWNLOAD_QUEUE);
        return result[STORAGE_KEY_DOWNLOAD_QUEUE] || [];
    } catch (e) {
        console.warn('loadDownloadQueue error:', e);
        return [];
    }
}

export async function clearDownloadQueue() {
    try {
        await chrome.storage.local.remove(STORAGE_KEY_DOWNLOAD_QUEUE);
    } catch (e) {
        console.warn('clearDownloadQueue error:', e);
    }
}

// ============================================================================
// METRICS (v1.3.1 — кэш в памяти + отложенный сброс)
// Раньше каждый инкремент делал полный load+save через storage (по два
// JSON.stringify на вызов). Теперь — мутация кэша и не более одной записи
// в METRICS_FLUSH_DELAY_MS.
// ============================================================================
export const DEFAULT_METRICS = {
    sw_restarts: 0,
    last_sw_start: 0,
    total_urls_processed: 0,
    total_urls_timeout: 0,
    total_downloads_started: 0,
    total_downloads_completed: 0,
    total_downloads_interrupted: 0,
    total_invalid_files: 0,
    total_429_received: 0,
    total_resume_attempts: 0,
    processing_time_ms_total: 0,
    processing_count: 0,
    recent_processing_times_ms: [],
};

const MAX_RECENT_TIMES = 50;
const METRICS_FLUSH_DELAY_MS = 3000;

let _metricsCache = null;
let _metricsFlushTimer = null;

export async function loadMetrics() {
    if (_metricsCache) return _metricsCache;
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY_METRICS);
        _metricsCache = { ...DEFAULT_METRICS, ...(result[STORAGE_KEY_METRICS] || {}) };
    } catch (e) {
        console.warn('loadMetrics error:', e);
        _metricsCache = { ...DEFAULT_METRICS };
    }
    return _metricsCache;
}

export async function saveMetrics(metrics) {
    _metricsCache = metrics;
    try {
        await chrome.storage.local.set({ [STORAGE_KEY_METRICS]: metrics });
    } catch (e) {
        console.warn('saveMetrics error:', e);
    }
}

export async function updateMetrics(updater) {
    const m = await loadMetrics();
    const updated = updater(m) || m;
    if (Array.isArray(updated.recent_processing_times_ms)
        && updated.recent_processing_times_ms.length > MAX_RECENT_TIMES) {
        updated.recent_processing_times_ms = updated.recent_processing_times_ms.slice(-MAX_RECENT_TIMES);
    }
    _metricsCache = updated;
    if (!_metricsFlushTimer) {
        _metricsFlushTimer = setTimeout(() => {
            _metricsFlushTimer = null;
            flushMetrics();
        }, METRICS_FLUSH_DELAY_MS);
    }
    return updated;
}

// Принудительный сброс кэша метрик на диск (по таймеру и вручную).
export async function flushMetrics() {
    if (_metricsFlushTimer) {
        clearTimeout(_metricsFlushTimer);
        _metricsFlushTimer = null;
    }
    if (!_metricsCache) return;
    try {
        await chrome.storage.local.set({ [STORAGE_KEY_METRICS]: _metricsCache });
    } catch (e) {
        console.warn('flushMetrics error:', e);
    }
}

// ============================================================================
// Полный сброс состояния — используется в 'stop'
// ============================================================================
export async function clearAllState() {
    await clearMonitorState();
    try {
        await chrome.storage.local.remove(STORAGE_KEY_RUNTIME);
    } catch (e) { /* ignore */ }
    await clearAllFetchStates();
    await clearDownloadQueue();
    // Метрики и лог НЕ сбрасываем при stop — они хранят историческую статистику.
}

// ============================================================================
// НАСТРОЙКИ (settings)
// ============================================================================
let _settingsCache = null;

export async function loadSettings() {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
        const stored = result[STORAGE_KEY_SETTINGS] || {};
        const merged = { ...SETTINGS_DEFAULTS, ...stored };
        _settingsCache = merged;
        return merged;
    } catch (e) {
        console.warn('loadSettings error:', e);
        return { ...SETTINGS_DEFAULTS };
    }
}

export async function saveSettings(settings) {
    const merged = { ...SETTINGS_DEFAULTS, ...settings };
    // Валидируем: только известные ключи и корректные типы
    const valid = {};
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
        if (key in merged) {
            const def = SETTINGS_DEFAULTS[key];
            const val = merged[key];
            const defType = typeof def;
            const valType = typeof val;
            if (defType === 'number') {
                if (valType === 'number' && !isNaN(val) && val >= 0) {
                    valid[key] = val;
                } else {
                    valid[key] = def;
                }
            } else if (defType === 'boolean') {
                valid[key] = valType === 'boolean' ? val : def;
            } else if (defType === 'string') {
                valid[key] = valType === 'string' ? val : def;
            } else {
                valid[key] = def;
            }
        }
    }
    _settingsCache = valid;
    await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: valid });
    return valid;
}

export function getCachedSettings() {
    return _settingsCache || SETTINGS_DEFAULTS;
}

export async function refreshSettingsCache() {
    _settingsCache = await loadSettings();
    return _settingsCache;
}

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[STORAGE_KEY_SETTINGS]) {
            const newValue = changes[STORAGE_KEY_SETTINGS].newValue;
            if (newValue) {
                _settingsCache = { ...SETTINGS_DEFAULTS, ...newValue };
            }
        }
    });
}

// ============================================================================
// ЛОГИРОВАНИЕ (v1.3.1 — очередь в памяти + один flush на интервал)
// Раньше каждая запись делала read-modify-write всего массива (200 записей),
// а параллельные вызовы теряли записи из-за гонок. Теперь записи
// накапливаются и пишутся одним батчем.
// ============================================================================
const LOG_FLUSH_DELAY_MS = 500;
let _logQueue = [];
let _logTimer = null;
let _logWriting = false;

export function log(level, source, message, details) {
    // Fire-and-forget — чтобы не блокировать вызывающий код
    (async () => {
        try {
            const settings = _settingsCache || SETTINGS_DEFAULTS;
            const configuredLevel = settings.LOG_LEVEL || 'info';
            if (LOG_LEVELS[level] < LOG_LEVELS[configuredLevel]) return;

            // Дублируем в console для DevTools
            const consoleMethod = level === 'debug' ? 'log' : level;
            if (typeof console !== 'undefined' && console[consoleMethod]) {
                const prefix = '[' + source + ']';
                if (details !== undefined) {
                    console[consoleMethod](prefix, message, details);
                } else {
                    console[consoleMethod](prefix, message);
                }
            }

            _logQueue.push({
                ts: Date.now(),
                level,
                source: String(source || ''),
                message: String(message || ''),
            });
            if (!_logTimer && !_logWriting) {
                _logTimer = setTimeout(() => {
                    _logTimer = null;
                    flushLog();
                }, LOG_FLUSH_DELAY_MS);
            }
        } catch (e) {
            // Не падаем, если логирование не сработало
        }
    })();
}

export async function flushLog() {
    if (_logTimer) {
        clearTimeout(_logTimer);
        _logTimer = null;
    }
    if (_logWriting || _logQueue.length === 0) return;
    _logWriting = true;
    const batch = _logQueue;
    _logQueue = [];
    try {
        const settings = _settingsCache || SETTINGS_DEFAULTS;
        const max = settings.MAX_LOG_ENTRIES || 200;
        const result = await chrome.storage.local.get(STORAGE_KEY_LOG);
        const arr = result[STORAGE_KEY_LOG] || [];
        for (const e of batch) arr.push(e);
        if (arr.length > max) arr.splice(0, arr.length - max);
        await chrome.storage.local.set({ [STORAGE_KEY_LOG]: arr });
    } catch (e) {
        if (typeof console !== 'undefined') console.error('log flush error:', e);
    } finally {
        _logWriting = false;
        if (_logQueue.length > 0 && !_logTimer) {
            _logTimer = setTimeout(() => {
                _logTimer = null;
                flushLog();
            }, LOG_FLUSH_DELAY_MS);
        }
    }
}

export async function loadLog() {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY_LOG);
        return result[STORAGE_KEY_LOG] || [];
    } catch (e) {
        console.warn('loadLog error:', e);
        return [];
    }
}

export async function clearLog() {
    _logQueue = [];
    if (_logTimer) {
        clearTimeout(_logTimer);
        _logTimer = null;
    }
    try {
        await chrome.storage.local.remove(STORAGE_KEY_LOG);
    } catch (e) {
        console.warn('clearLog error:', e);
    }
}

// ============================================================================
// ВАЛИДАЦИЯ СКАЧАННЫХ ФАЙЛОВ (v1.3.1 — переписана)
// Раньше пустая строка '' в списке разрешённых MIME делала проверку
// всегда истинной (мёртвая логика). Теперь:
//   - text/html = error-страница, недопустим, если только мы не ждём
//     HTML-историю (opts.expectHtml; fichub отдаёт html_url — это zip-архив);
//   - известные MIME книжных форматов — точно перечислены;
//   - пустой MIME — допускается (fichub иногда не отдаёт Content-Type).
// v1.3.3: + application/x-zip-compressed и application/x-zip — Chrome на
// Windows обозначает zip-файлы fichub (/cache/html/ и др.) именно так;
// без них валидатор браковал ВСЕ html-загрузки → записи становились
// 'invalid' и перекачивались бесконечно.
// Возвращает { valid: boolean, reason: string }.
// ============================================================================
const ALLOWED_MIME_EXACT = [
    'application/epub+zip',
    'application/pdf',
    'application/zip',
    'application/x-zip-compressed',
    'application/x-zip',
    'application/x-mobipocket-ebook',
    'application/octet-stream',
];
// v1.3.4: точное сравнение через Set — O(1) вместо линейного поиска
// (вариант с суффиксом «; charset=...» проверяется линейно, он редкий)
const ALLOWED_MIME_SET = new Set(ALLOWED_MIME_EXACT);

export function validateDownloadedFile(downloadItem, settings, opts) {
    const s = settings || _settingsCache || SETTINGS_DEFAULTS;
    const expectHtml = !!(opts && opts.expectHtml);

    if (!downloadItem || typeof downloadItem !== 'object') {
        return { valid: false, reason: 'no_download_item' };
    }

    const fileSize = downloadItem.fileSize || downloadItem.bytesReceived || 0;
    const minSize = s.MIN_FILE_SIZE_BYTES || 1024;
    if (fileSize > 0 && fileSize < minSize) {
        return { valid: false, reason: 'file_too_small', fileSize };
    }

    if (s.VALIDATE_FILE_SIGNATURE) {
        const mime = (downloadItem.mime || '').toLowerCase();
        if (mime.startsWith('text/html')) {
            return expectHtml
                ? { valid: true }
                : { valid: false, reason: 'html_instead_of_file', mime };
        }
        if (mime) {
            const known = ALLOWED_MIME_SET.has(mime)
                || ALLOWED_MIME_EXACT.some(m => mime.startsWith(m + ';'));
            if (!known) {
                return { valid: false, reason: 'unexpected_mime', mime };
            }
        }
    }

    return { valid: true };
}