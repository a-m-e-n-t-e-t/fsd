'use strict';
import { STORE_NAME, getDB, formatDate } from './fsd_shared.js';

function escapeCsv(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function formatTimestamp(date) {
    if (!date) return 0;
    if (typeof date === 'number') return date < 0 ? 0 : date;
    const d = date instanceof Date ? date : new Date(date);
    return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
}

function name_and_author(value) {
    const result = { name_s: '', author_s: '' };
    if (!value || typeof value !== 'string') return result;

    let s = value;
    let arr_temp = s.split('-');
    if (arr_temp.length > 1)
        s = arr_temp.slice(0, -1).join('-');

    arr_temp = s.split('_by_');
    if (arr_temp.length >= 2) {
        result.author_s = arr_temp[arr_temp.length - 1];
        s = arr_temp.slice(0, -1).join('_by_');
    }

    result.name_s = s.replace(/_/g, ' ').trim();
    result.author_s = result.author_s.replace(/_/g, ' ').trim();
    return result;
}

function downloadBlob(content, filename, mimeType) {
    if (!content) {
        console.warn('save: пустой контент для', filename);
        return;
    }
    const blob = new Blob([content], { type: mimeType });
    const fileURL = URL.createObjectURL(blob);
    const file_link = document.createElement('a');
    file_link.href = fileURL;
    file_link.download = filename;
    document.body.appendChild(file_link);
    file_link.click();
    setTimeout(() => {
        if (file_link.parentNode)
            document.body.removeChild(file_link);
        URL.revokeObjectURL(fileURL);
    }, 5000);
}

const CSV_HEADERS = ['url', 'title', 'description', 'collections', 'notes', 'tags', 'date_created', 'date_modified'];

function recordToCsvRow(r) {
    const na = name_and_author(r.file_p);
    const ts = formatTimestamp(r.date_upd);
    const fieldMap = {
        url: escapeCsv(r.url_s),
        title: escapeCsv(na.name_s || r.name || ''),
        description: escapeCsv(r.name || ''),
        collections: escapeCsv(na.author_s || ''),
        notes: escapeCsv(r.url_fh || ''),
        tags: escapeCsv(r.s_status || ''),
        date_created: ts,
        date_modified: ts,
    };
    return CSV_HEADERS.map(h => fieldMap[h]).join(',');
}

chrome.runtime.onMessage.addListener(function (mess) {
    (async function () {
        const validTypes = ['sl_file', 'dl_file', 'JSON_file', 'csv_file'];
        if (!validTypes.includes(mess.type_mess)) return;

        try {
            const db = await getDB();
            const allRecords = await db.getAll(STORE_NAME);

            if (!allRecords || allRecords.length === 0) {
                console.warn('save: база данных пуста');
                downloadBlob('Нет данных', 'empty.txt', 'text/plain');
                return;
            }

            switch (mess.type_mess) {
            case 'sl_file': {
                const urls = allRecords.filter(r => r.url_s).map(r => r.url_s);
                downloadBlob(urls.join('\r\n'), 'sl.txt', 'text/plain');
                break;
            }
            case 'dl_file': {
                const urls = allRecords.filter(r => r.url_fh).map(r => r.url_fh);
                downloadBlob(urls.join('\r\n'), 'dl.txt', 'text/plain');
                break;
            }
            case 'JSON_file': {
                downloadBlob(JSON.stringify(allRecords, (key, val) => {
                    if (val instanceof Date) return val.toISOString();
                    return val;
                }, 2), 'export.json', 'application/json');
                break;
            }
            case 'csv_file': {
                const rows = [CSV_HEADERS.join(',')];
                for (const r of allRecords)
                    rows.push(recordToCsvRow(r));
                downloadBlob(rows.join('\r\n'), 'export.csv', 'text/csv');
                break;
            }
            }
        } catch (error) {
            console.error('save: ошибка:', error);
        }
    })();
    return true;
});
