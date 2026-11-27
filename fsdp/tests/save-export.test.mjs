// Тесты экспорта save.js (до v1.4.1 файл не был покрыт тестами вообще).
// v1.4.0 добавила в CSV колонку attempt_status — регрессионная защита:
//   - CSV: заголовок, разделение доменов (tags=история, attempt_status=попытка),
//     экранирование запятых/кавычек, даты в epoch-секундах
//   - sl.txt: только url_s всех записей (CRLF)
//   - dl.txt: только непустые url_fh
//   - JSON: s_att/t_att/need_upd присутствуют, date_upd — ISO-строка
'use strict';
import 'fake-indexeddb/auto';
import { ChromeMock } from './chrome-mock.mjs';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log('  ok  ' + name); }
    else { failed++; console.error('  FAIL ' + name); }
}

const chromeMock = new ChromeMock();
globalThis.chrome = chromeMock;

// === минимальный DOM для downloadBlob (Blob есть в Node 18+) ===
const downloads = []; // { id, blob, filename }
let blobSeq = 0;
globalThis.URL.createObjectURL = (blob) => {
    const id = 'blob:fake-' + (++blobSeq);
    downloads.push({ id, blob, filename: null });
    return id;
};
globalThis.URL.revokeObjectURL = () => {};
const fakeBody = {
    children: [],
    appendChild(el) { el.parentNode = fakeBody; this.children.push(el); },
    removeChild(el) { el.parentNode = null; },
};
globalThis.document = {
    body: fakeBody,
    createElement(tag) {
        return {
            tagName: String(tag).toUpperCase(), href: '', download: '', parentNode: null,
            click() {
                const entry = downloads.find(d => d.id === this.href);
                if (entry) entry.filename = this.download;
            },
        };
    },
};

const shared = await import('../fsd_shared.js');
const { STORE_NAME, getDB } = shared;

// === посев БД: 3 записи — все экспортные классы ===
const TS1 = Math.floor(new Date('2026-11-20T10:00:00.000Z').getTime() / 1000);
const TS2 = Math.floor(new Date('2020-01-02T03:04:05.000Z').getTime() / 1000);
const TS3 = Math.floor(new Date('2026-11-01T00:00:00.000Z').getTime() / 1000);
{
    const db = await getDB();
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/123/', name: 'ff_123',
        date_upd: '2026-11-20T10:00:00.000Z', s_status: 'ongoing',
        s_att: 'ok', t_att: 1764000000000,
        url_fh: 'https://fichub.net/cache/html/123zip',
        file_p: 'Elsewhere_by_Author-jal7hfax.epub',
        id_f: 7, hash_f: 'abc', need_upd: false,
    });
    await db.put(STORE_NAME, {
        url_s: 'https://forums.spacebattles.com/threads/271115/', name: 'sb_271115',
        date_upd: '2020-01-02T03:04:05.000Z', s_status: 'completed',
        s_att: 'timeout', t_att: 0,
        url_fh: '', file_p: '', id_f: '', hash_f: '', need_upd: true,
    });
    await db.put(STORE_NAME, {
        url_s: 'https://archiveofourown.org/works/9/', name: 'ao3_9',
        date_upd: '2026-11-01T00:00:00.000Z', s_status: 'ongoing',
        s_att: '', t_att: 0, // v1.4.0: попытки ещё не было — пустой домен попытки
        url_fh: '', file_p: 'My,Story_by_Author-xyz.epub',
        id_f: '', hash_f: '', need_upd: true,
    });
}

await import('../save.js'); // регистрирует слушатель onMessage

async function runExport(type_mess) {
    downloads.length = 0;
    await chromeMock.runtime.sendMessage({ type_mess });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (downloads.length > 0 && downloads.every(d => d.filename)) return downloads;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('экспорт не завершился: ' + type_mess);
}

console.log('[1] CSV-экспорт (v1.4.0: колонка attempt_status)');
{
    const [file] = await runExport('csv_file');
    check('csv: имя файла export.csv', file.filename === 'export.csv');
    check('csv: MIME text/csv', file.blob.type === 'text/csv');
    const lines = (await file.blob.text()).split('\r\n');
    check('csv: строк = заголовок + 3 записи', lines.length === 4);
    check('csv: заголовок — attempt_status между tags и датами',
        lines[0] === 'url,title,description,collections,notes,tags,attempt_status,date_created,date_modified');
    // первая колонка (URL) не содержит запятых — безопасный ключ для разбора
    const byUrl = {};
    for (const row of lines.slice(1)) byUrl[row.slice(0, row.indexOf(','))] = row;
    check('csv: ffn — домены разделены (tags=ongoing, attempt_status=ok)',
        byUrl['https://www.fanfiction.net/s/123/'] ===
        ['https://www.fanfiction.net/s/123/', 'Elsewhere', 'ff_123', 'Author',
            'https://fichub.net/cache/html/123zip', 'ongoing', 'ok', TS1, TS1].join(','));
    check('csv: sb — статус попытки в attempt_status, титул из name (file_p пуст)',
        byUrl['https://forums.spacebattles.com/threads/271115/'] ===
        ['https://forums.spacebattles.com/threads/271115/', 'sb_271115', 'sb_271115', '', '',
            'completed', 'timeout', TS2, TS2].join(','));
    check('csv: ao3 — запятая в названии экранирована кавычками, пустой домен попытки',
        byUrl['https://archiveofourown.org/works/9/'] ===
        ['https://archiveofourown.org/works/9/', '"My,Story"', 'ao3_9', 'Author', '',
            'ongoing', '', TS3, TS3].join(','));
}

console.log('[2] sl.txt — ссылки историй');
{
    const [file] = await runExport('sl_file');
    check('sl: имя файла sl.txt', file.filename === 'sl.txt');
    const text = await file.blob.text();
    const set = new Set(text.split('\r\n').filter(Boolean));
    check('sl: все 3 url_s, CRLF-разделители',
        set.size === 3 && set.has('https://www.fanfiction.net/s/123/')
        && set.has('https://forums.spacebattles.com/threads/271115/')
        && set.has('https://archiveofourown.org/works/9/'));
    check('sl: url_fh не попали', !text.includes('fichub.net'));
}

console.log('[3] dl.txt — ссылки загрузок');
{
    const [file] = await runExport('dl_file');
    const text = await file.blob.text();
    const set = new Set(text.split('\r\n').filter(Boolean));
    check('dl: только непустые url_fh (1 шт.)',
        set.size === 1 && set.has('https://fichub.net/cache/html/123zip'));
}

console.log('[4] JSON-экспорт — поля v1.4.0');
{
    const [file] = await runExport('JSON_file');
    const arr = JSON.parse(await file.blob.text());
    check('json: 3 записи', Array.isArray(arr) && arr.length === 3);
    const ffn = arr.find(r => r.url_s === 'https://www.fanfiction.net/s/123/');
    check('json: s_att/t_att/need_upd присутствуют',
        ffn && ffn.s_att === 'ok' && ffn.t_att === 1764000000000 && ffn.need_upd === false);
    check('json: date_upd — ISO-строка (не Date-объект)',
        typeof ffn.date_upd === 'string' && ffn.date_upd.endsWith('Z'));
    const ao3 = arr.find(r => r.url_s === 'https://archiveofourown.org/works/9/');
    check('json: пустой домен попытки сохранён', ao3 && ao3.s_att === '' && ao3.t_att === 0);
}

console.log(`\nЭкспорт (save.js): ${passed} ok, ${failed} FAIL`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
