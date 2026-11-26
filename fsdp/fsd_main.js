'use strict';
import { t_rec_sl, loadLog, LOG_LEVELS } from './fsd_shared.js';

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
function sendMsg(payload) { return chrome.runtime.sendMessage(payload).catch(e => console.error('sendMessage error:', e)); }

async function upd_db() { sendMsg({ type_mess: 'run', regim: 1 }); }
async function send_url(s_url) {
    if (!s_url || s_url.trim() === '') return;
    const rec = new t_rec_sl();
    rec.url_s = s_url;
    sendMsg({ type_mess: 'add_url', fs: 2, exp_rec: rec });
}
async function audit() { sendMsg({ type_mess: 'run', regim: 0 }); }
async function add_db() {
    const input = document.getElementsByName('story_url')[0];
    if (input && input.value !== '') {
        send_url(input.value);
        input.value = '';
    } else {
        alert('Введите URL');
    }
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Ошибка чтения файла'));
        reader.readAsText(file);
    });
}

const BATCH_MSG_SIZE = 50;
const BATCH_DELAY = 100;

async function importBatch(items, makeRec, noDownload) {
    if (progress_f) progress_f.max = items.length;
    for (let i = 0; i < items.length; i += BATCH_MSG_SIZE) {
        const chunk = items.slice(i, i + BATCH_MSG_SIZE).map(makeRec);
        await sendMsg({ type_mess: 'add_urls', arr: chunk, noDownload });
        const done = Math.min(i + BATCH_MSG_SIZE, items.length);
        if (progress_f) progress_f.value = done;
        if (f_info) f_info.textContent = 'Истории: ' + done + ' из ' + items.length;
        await pause(BATCH_DELAY);
    }
}

async function add_db_f() {
    const fileInput = document.querySelector('.fsd_add_f');
    if (!fileInput || !fileInput.value) { alert('Выберите файл'); return; }
    try {
        const file = fileInput.files[0];
        if (file.name.toLowerCase().endsWith('.json')) await add_db_f_json(file);
        else await add_db_f_text(file);
        fileInput.value = '';
    } catch (e) {
        console.error('Ошибка:', e);
        alert('Ошибка: ' + e.message);
    }
}

async function add_db_f_text(file) {
    const text = await readFileAsText(file);
    const arr_url = text.split(/\r?\n/).filter(line => line.trim() !== '');
    await importBatch(arr_url, (url) => { const rec = new t_rec_sl(); rec.url_s = url; return rec; }, false);
}

async function add_db_f_json(file) {
    const text = await readFileAsText(file);
    let arr_rec;
    try { arr_rec = JSON.parse(text); } catch (e) { alert('Невалидный JSON: ' + e.message); return; }
    if (!Array.isArray(arr_rec)) { alert('JSON должен содержать массив записей'); return; }
    await importBatch(arr_rec, (item) => {
        const rec = new t_rec_sl();
        rec.url_s = item.url_s || '';
        rec.name = item.name || '';
        rec.date_upd = item.date_upd || new Date(0);
        rec.s_status = item.s_status || '';
        rec.url_fh = item.url_fh || '';
        rec.file_p = item.file_p || '';
        rec.id_f = item.id_f || '';
        rec.hash_f = item.hash_f || '';
        return rec;
    }, true);
}

async function stop_processing() { sendMsg({ type_mess: 'stop' }); }
async function pause_processing() { sendMsg({ type_mess: 'pause' }); }
async function resume_processing() { sendMsg({ type_mess: 'resume' }); }
async function trigger_auto_check() { sendMsg({ type_mess: 'trigger_auto_check' }); }
async function open_options() {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
}
async function reset_metrics() { sendMsg({ type_mess: 'reset_metrics' }); }
async function read() { sendMsg({ type_mess: 'read story' }); }
async function save_sl() { sendMsg({ type_mess: 'save_sl' }); }
async function save_dl() { sendMsg({ type_mess: 'save_dl' }); }
async function f_JSON_file() { sendMsg({ type_mess: 'JSON_file' }); }
async function f_csv_file() { sendMsg({ type_mess: 'csv_file' }); }

chrome.runtime.sendMessage({ type_mess: 'q_status' });

const progress_story = document.querySelector('.progress_story');
const progress_f = document.querySelector('.progress_f');
const f_info = document.querySelector('.f_info');
const info = document.querySelector('.info');
const metricsEl = document.querySelector('.metrics');
const button_run = document.querySelector('.fsd_run');
const button_pause = document.querySelector('.fsd_pause');
const button_resume = document.querySelector('.fsd_resume');

if (info) info.style.whiteSpace = 'pre-line';
if (metricsEl) metricsEl.style.whiteSpace = 'pre-line';

// v1.3.7: вынесен в отдельный постоянный слушатель, чтобы не накапливаться при отмене диалога
const fixFileInput = document.querySelector('.fsd_fix_f');
if (fixFileInput) {
    document.querySelector('.fsd_fix').addEventListener('click', () => {
        fixFileInput.click();
    });
    fixFileInput.addEventListener('change', async () => {
        const arr_file_p = Array.from(fixFileInput.files).map(f => f.name);
        await sendMsg({ type_mess: 'fix', arr_file_p: arr_file_p.length > 0 ? arr_file_p : [] });
        fixFileInput.value = '';
    });
}

const buttons = [
    ['.fsd_run', 'click', upd_db],
    ['.fsd_audit', 'click', audit],
    ['.fsd_add', 'click', add_db],
    ['.fsd_save_story_list', 'click', save_sl],
    ['.fsd_save_dl', 'click', save_dl],
    ['.fsd_stop', 'click', stop_processing],
    ['.fsd_pause', 'click', pause_processing],
    ['.fsd_resume', 'click', resume_processing],
    ['.fsd_auto_check', 'click', trigger_auto_check],
    ['.fsd_options', 'click', open_options],
    ['.fsd_add_f', 'change', add_db_f],
    ['.read', 'click', read],
    ['.JSON_file', 'click', f_JSON_file],
    ['.csv_file', 'click', f_csv_file],
    ['.reset_metrics', 'click', reset_metrics],
];

for (const [sel, evt, handler] of buttons) {
    const btn = document.querySelector(sel);
    if (btn) btn.addEventListener(evt, handler);
}

const logBox = document.getElementById('log_box');
const logFilter = document.getElementById('log_filter');
let currentLog = [];
let logRenderTimer = null;

async function refreshLog() {
    currentLog = await loadLog();
    renderLog();
}

function scheduleLogRender() {
    if (logRenderTimer) return;
    logRenderTimer = setTimeout(() => {
        logRenderTimer = null;
        renderLog();
    }, 300);
}

function renderLog() {
    if (!logBox) return;
    const filterLevel = logFilter ? logFilter.value : 'all';
    const minLevel = filterLevel === 'all' ? -1 : (LOG_LEVELS[filterLevel] ?? 0);
    const filtered = currentLog.filter(e => LOG_LEVELS[e.level] >= minLevel);
    const slice = filtered.slice(-200);
    logBox.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const e of slice) {
        const line = document.createElement('div');
        line.className = 'log-line ' + e.level;
        const ts = new Date(e.ts).toLocaleTimeString();
        line.innerHTML = '<span class="log-ts">[' + ts + ']</span> <span class="log-src">' + escapeHtml(e.source) + '</span> ' + escapeHtml(e.message);
        frag.appendChild(line);
    }
    logBox.appendChild(frag);
    logBox.scrollTop = logBox.scrollHeight;
}

function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.getElementById('log_refresh').addEventListener('click', refreshLog);
document.getElementById('log_clear').addEventListener('click', async () => {
    sendMsg({ type_mess: 'clear_log' });
    await new Promise(r => setTimeout(r, 200));
    refreshLog();
});
logFilter.addEventListener('change', renderLog);

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.fsd_log) {
        currentLog = changes.fsd_log.newValue || [];
        scheduleLogRender();
    }
});

refreshLog();

function formatDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
}

chrome.runtime.onMessage.addListener(function (mess) {
    (async function () {
        if (mess.type_mess !== 'a_status') return;
        const p = mess.statusPayload;
        if (info) {
            const pausedTag = p.is_paused ? ' [ПАУЗА]' : '';
            info.textContent = 'story = ' + p.s_c + '\nстатус: ' + p.fsd_status + pausedTag + '\nобновлено URL: ' + p.c_u_s + '\nошибок: ' + p.c_e_s + '\nоткрыть URL: ' + p.url_op + '\nиндекс: ' + p.index_sl + ' из ' + p.arr_sl_len + '\nактивных загрузок: ' + (p.active_downloads || 0) + '\nв очереди загрузок: ' + (p.download_queue_len || 0);
        }
        if (metricsEl) {
            metricsEl.textContent = 'перезапусков SW: ' + (p.sw_restarts || 0) + '\nпоследний запуск: ' + formatDateTime(p.last_sw_start) + '\nобработано URL: ' + (p.total_urls_processed || 0) + '\nтаймаутов URL: ' + (p.total_urls_timeout || 0) + '\nфайл не найден: ' + (p.total_urls_not_found || 0) + '\nзавершено загрузок: ' + (p.total_downloads_completed || 0) + '\nневалидных файлов: ' + (p.total_invalid_files || 0);
        }
        if (progress_story) {
            progress_story.max = p.arr_sl_len;
            progress_story.value = p.index_sl + 1;
        }
        if (button_run) button_run.disabled = (p.fsd_status === 'work' && !p.is_paused);
        if (button_pause) button_pause.disabled = (p.fsd_status !== 'work' || p.is_paused);
        if (button_resume) button_resume.disabled = !p.is_paused;
        if (button_pause && p.is_paused) button_pause.classList.add('active-pause');
        else if (button_pause) button_pause.classList.remove('active-pause');
    })();
    return false; // v1.3.7: fire-and-forget, не держим канал открытым
});