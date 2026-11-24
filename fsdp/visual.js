'use strict';
import { STORE_NAME, t_rec_sl, getDB, formatDate } from './fsd_shared.js';

let sl_list = [];
let sl_i = 0;
let filtered_list = null; // Отфильтрованный список после поиска
let currentRecord = new t_rec_sl();
const RECORD_FIELDS = ['url_s', 'name', 'date_upd', 's_status', 'url_fh', 'file_p', 'id_f'];

// Активный список (filtered_list если задан, иначе sl_list)
function activeList() {
    return filtered_list !== null ? filtered_list : sl_list;
}

async function loadRecords() {
    try {
        const db = await getDB();
        sl_list = await db.getAllKeys(STORE_NAME);
        // Сбрасываем фильтр при перезагрузке
        filtered_list = null;
        sl_i = 0;

        if (sl_list.length > 0) {
            await show_rec(sl_list[sl_i]);
        } else {
            const posInfo = document.querySelector('.position-info');
            if (posInfo)
                posInfo.textContent = 'Нет записей';
            updateNavButtons();
        }
        updateSearchInfo();
    } catch (error) {
        console.error('Ошибка при загрузке записей:', error);
    }
}

async function show_rec(url) {
    try {
        const db = await getDB();
        currentRecord = (await db.get(STORE_NAME, url)) || new t_rec_sl();
        const list = activeList();
        const posInfo = document.querySelector('.position-info');
        if (posInfo) {
            const filterTag = filtered_list !== null ? ' (отфильтровано)' : '';
            posInfo.textContent = 'Запись ' + (sl_i + 1) + ' из ' + list.length + filterTag;
        }
        for (const field of RECORD_FIELDS) {
            const el = document.querySelector(`[data-field="${field}"]`);
            if (!el) continue;
            el.textContent = field === 'date_upd' ? formatDate(currentRecord[field]) : (currentRecord[field] || '—');
        }
        updateNavButtons();
    } catch (e) {
        console.error('show_rec error:', e);
    }
}

function updateNavButtons() {
    const list = activeList();
    const btnPrev = document.querySelector('.prev-button');
    const btnNext = document.querySelector('.next-button');
    if (btnPrev) btnPrev.disabled = (sl_i <= 0);
    if (btnNext) btnNext.disabled = (sl_i >= list.length - 1);
}

async function next_sl() {
    const list = activeList();
    if (sl_i < list.length - 1) {
        sl_i++;
        await show_rec(list[sl_i]);
    }
}

async function prev_sl() {
    if (sl_i > 0) {
        sl_i--;
        await show_rec(activeList()[sl_i]);
    }
}

async function open_sl() {
    if (!currentRecord || !currentRecord.url_s) {
        alert('Нет URL для открытия');
        return;
    }
    try {
        new URL(currentRecord.url_s);
        chrome.tabs.create({ url: currentRecord.url_s, active: true });
    } catch (e) {
        alert('Неверный URL');
    }
}

async function open_file() {
    if (!currentRecord || !currentRecord.id_f) {
        alert('Файл ещё не загружен или ID отсутствует');
        return;
    }
    try {
        await chrome.downloads.open(currentRecord.id_f);
    } catch (e) {
        alert('Не удалось открыть файл: ' + e.message);
    }
}

// === ПОИСК ===
async function performSearch() {
    const query = (document.getElementById('search_input').value || '').trim().toLowerCase();
    if (!query) {
        filtered_list = null;
        sl_i = 0;
        if (sl_list.length > 0) await show_rec(sl_list[0]);
        else {
            const posInfo = document.querySelector('.position-info');
            if (posInfo) posInfo.textContent = 'Нет записей';
        }
        updateSearchInfo();
        return;
    }
    try {
        const db = await getDB();
        const all = await db.getAll(STORE_NAME);
        filtered_list = all
            .filter(r => r && (
                (r.url_s && r.url_s.toLowerCase().includes(query))
                || (r.name && r.name.toLowerCase().includes(query))
                || (r.file_p && r.file_p.toLowerCase().includes(query))
            ))
            .map(r => r.url_s);
        sl_i = 0;
        if (filtered_list.length > 0) {
            await show_rec(filtered_list[0]);
        } else {
            const posInfo = document.querySelector('.position-info');
            if (posInfo) posInfo.textContent = 'Ничего не найдено по запросу: ' + query;
            updateNavButtons();
        }
        updateSearchInfo();
    } catch (e) {
        console.error('search error:', e);
    }
}

function updateSearchInfo() {
    // Доп.информация о фильтре (если потребуется)
}

async function clearSearch() {
    document.getElementById('search_input').value = '';
    filtered_list = null;
    sl_i = 0;
    if (sl_list.length > 0) {
        await show_rec(sl_list[0]);
    } else {
        const posInfo = document.querySelector('.position-info');
        if (posInfo) posInfo.textContent = 'Нет записей';
        updateNavButtons();
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadRecords();
        const btnNext = document.querySelector('.next-button');
        const btnPrev = document.querySelector('.prev-button');
        const btnOpenSl = document.querySelector('.open_sl');
        const btnOpenFile = document.querySelector('.open_file');
        if (btnNext)
            btnNext.addEventListener('click', next_sl);
        if (btnPrev)
            btnPrev.addEventListener('click', prev_sl);
        if (btnOpenSl)
            btnOpenSl.addEventListener('click', open_sl);
        if (btnOpenFile)
            btnOpenFile.addEventListener('click', open_file);

        const searchBtn = document.getElementById('search_btn');
        const searchClear = document.getElementById('search_clear');
        const searchInput = document.getElementById('search_input');
        if (searchBtn) searchBtn.addEventListener('click', performSearch);
        if (searchClear) searchClear.addEventListener('click', clearSearch);
        if (searchInput) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') performSearch();
            });
        }
    } catch (e) {
        console.error('DOMContentLoaded error:', e);
    }
});
