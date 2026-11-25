// Тест миграции: старые записи с date_upd типа Date конвертируются в ISO-строки
'use strict';
import 'fake-indexeddb/auto';
import { ChromeMock } from './chrome-mock.mjs';

globalThis.chrome = new ChromeMock();
globalThis.fetch = async () => { throw new Error('fetch не должен вызываться в этом тесте'); };

// Сеем запись СТАРОГО формата (Date-объект в date_upd) ДО импорта background
const shared = await import('../fsd_shared.js');
const { STORE_NAME, getDB, loadMetrics } = shared;
{
    const db = await getDB();
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/777/',
        name: 'ff_777',
        date_upd: new Date('2023-05-10T00:00:00Z'), // старый формат — Date
        s_status: 'completed',
        url_fh: '',
        file_p: '',
        id_f: '',
    });
}

// Импорт background → init() → normalizeDatesIfNeeded()
await import('../fsd_background.js');

let passed = 0, failed = 0;
const check = (name, cond) => {
    if (cond) { passed++; console.log('  ok  ' + name); }
    else { failed++; console.error('  FAIL ' + name); }
};

const start = Date.now();
let rec = null;
while (Date.now() - start < 8000) {
    const db = await getDB();
    rec = await db.get(STORE_NAME, 'https://www.fanfiction.net/s/777/');
    if (rec && typeof rec.date_upd === 'string') break;
    await new Promise(r => setTimeout(r, 20));
}

check('миграция: date_upd преобразован из Date в ISO-строку',
    rec && typeof rec.date_upd === 'string' && rec.date_upd === '2023-05-10T00:00:00.000Z');
check('миграция: прочие поля не тронуты', rec && rec.name === 'ff_777' && rec.s_status === 'completed');

console.log(`\nМиграция: ${passed} ok, ${failed} FAIL`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
