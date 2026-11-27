// Регрессионный тест fsd_background.js v1.3.3 (полный цикл через моки chrome API):
//  v1.4.0: статус 'old' больше не существует — фикстуры посылают его как
//  legacy-вход (проверка расщепления), а «заброшенность» выводится из даты:
//  DATE_OLD (>5 лет) = заброшенная ongoing, DATE_RECENT = активная ongoing.
//  1. Windows-сценарий: zip от fichub приходит как application/x-zip-compressed
//     (баг из лога пользователя: unexpected_mime → invalid → вечная перекачка)
//  2. silentHashUpdate: hash изменился, но заброшенная ongoing + файл есть → БЕЗ перекачки
//  3. заброшенная ongoing + файла нет → перекачка по hash
//  4. активная ongoing + hash изменился → перекачка (реальное обновление)
//  5. noDownload-импорт + изменившийся hash → без загрузки, файл не тронут
//  6. негативный контроль: неизвестный MIME по-прежнему отбраковывается
'use strict';
import 'fake-indexeddb/auto';
import { ChromeMock } from './chrome-mock.mjs';

const chromeMock = new ChromeMock();
globalThis.chrome = chromeMock;
chromeMock.storage.local._seed('fsd_settings', {
    MAX_CONCURRENT_DOWNLOADS: 3,
    API_REQUEST_DELAY_MS: 40,
    API_429_BASE_DELAY_MS: 15000,
    API_429_MAX_DELAY_MS: 120000,
    DOWNLOAD_TIMEOUT_MS: 300000,
    PROCESS_NEXT_DELAY_MS: 40,
    AUTO_CHECK_INTERVAL_HOURS: 24,
    AUTO_CHECK_ENABLED: true,
    MIN_FILE_SIZE_BYTES: 1024,
    VALIDATE_FILE_SIGNATURE: true,
    LOG_LEVEL: 'info',
    MAX_LOG_ENTRIES: 200,
    KEEPALIVE_PERIOD_MIN: 0.5,
});

// add_url с exp_rec не ходит в API; любой fetch — ошибка теста
globalThis.fetch = async (url) => {
    throw new Error('неожиданный fetch в тесте: ' + url);
};

async function waitFor(desc, predicate, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        let v;
        try { v = await predicate(); } catch (e) { v = false; }
        if (v) return true;
        await new Promise(r => setTimeout(r, 10));
    }
    console.error('  TIMEOUT: ' + desc);
    return false;
}

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log('  ok  ' + name); }
    else { failed++; console.error('  FAIL ' + name); }
}

process.on('unhandledRejection', (e) => {
    console.error('  UNHANDLED REJECTION:', e);
    failed++;
});

await import('../fsd_background.js');
const shared = await import('../fsd_shared.js');
const { STORE_NAME, getDB } = shared;

// перехват console.log фонового скрипта (ветки add_sl пишут в консоль)
const consoleLines = [];
const origLog = console.log;
console.log = (...a) => { consoleLines.push(a.join(' ')); origLog(...a); };

const KEY1 = 'https://www.fanfiction.net/s/14064024/';
const KEY2 = 'https://www.fanfiction.net/s/2090653/';
const URL_FH1 = 'https://fichub.net/cache/html/abc123';
const URL_FH2 = 'https://fichub.net/cache/html/def456';
const DATE_OLD = '2020-06-01T00:00:00';
const DATE_RECENT = new Date(Date.now() - 4 * 86400000).toISOString(); // ongoing не «постареет» (< 5 лет)

await waitFor('init() завершён', async () => (await shared.loadMetrics()).sw_restarts >= 1);
const dl = () => chromeMock.downloads._downloadCalls.length;

async function getRec(key) {
    const db = await getDB();
    return db.get(STORE_NAME, key);
}

// === 1. Windows-сценарий: application/x-zip-compressed ===
console.log('\n[1] Windows Chrome: html-загрузка с mime application/x-zip-compressed');
chromeMock.downloads._nextMime = 'application/x-zip-compressed';
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: KEY1, url_fh: URL_FH1, s_status: 'old', date_upd: DATE_OLD, hash_f: 'h1' },
});
await waitFor('загрузка завершена', async () => {
    const r = await getRec(KEY1);
    return !!(r && r.file_p);
});
{
    const r = await getRec(KEY1);
    check('win: загрузка выполнена', dl() === 1);
    check('win: файл принят (file_p установлен)', r && r.file_p === 'abc123.zip');
    check('win: id_f привязан', r && r.id_f === 1);
    check('win: запись НЕ помечена invalid (главный баг v1.3.2; v1.4.0: домен попытки)',
        r && r.s_att === 'ok' && r.s_status === 'ongoing');
    check('win: hash из API сохранён', r && r.hash_f === 'h1');
    await shared.flushMetrics();
    const m = chromeMock.storage.local._raw('fsd_metrics');
    check('win: total_invalid_files = 0', m.total_invalid_files === 0);
    check('win: total_downloads_completed = 1', m.total_downloads_completed === 1);
    const logArr = chromeMock.storage.local._raw('fsd_log') || [];
    check('win: в логе нет «валидация не пройдена»',
        !logArr.some(e => e.message.includes('валидация не пройдена')));
}

// === 2. silentHashUpdate: заброшенная ongoing (legacy 'old') + файл есть, hash изменился ===
console.log('\n[2] hash изменился, заброшенная ongoing + файл есть → без перекачки (v1.3.3 + v1.4.0)');
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: KEY1, url_fh: URL_FH1, s_status: 'old', date_upd: DATE_OLD, hash_f: 'h2' },
});
await new Promise(r => setTimeout(r, 300)); // даём время на случайную лишнюю загрузку
{
    const r = await getRec(KEY1);
    check('silent: новой загрузки НЕТ', dl() === 1);
    check('silent: файл не тронут (file_p прежний)', r && r.file_p === 'abc123.zip');
    check('silent: id_f прежний', r && r.id_f === 1);
    check('silent: новый hash запомнен', r && r.hash_f === 'h2');
    check('silent: s_status прежний (заброшенная ongoing, а не invalid-пинг-понг)',
        r && r.s_status === 'ongoing' && r.s_att === 'ok');
    check('silent: в консоли — «new hash — без перекачки»',
        consoleLines.some(l => l.includes('new hash — без перекачки')));
}

// === 3. заброшенная ongoing + файла нет → перекачка по hash ===
console.log('\n[3] hash изменился, заброшенная ongoing, файл потерян → перекачка');
{
    const db = await getDB();
    const rec = await db.get(STORE_NAME, KEY1);
    rec.file_p = '';
    rec.id_f = '';
    await db.put(STORE_NAME, rec);
}
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: KEY1, url_fh: URL_FH1, s_status: 'old', date_upd: DATE_OLD, hash_f: 'h3' },
});
await waitFor('перекачка завершена', async () => {
    const r = await getRec(KEY1);
    return !!(r && r.file_p === 'abc123.zip' && r.hash_f === 'h3');
});
{
    const r = await getRec(KEY1);
    check('нет файла: перекачка запущена', dl() === 2);
    check('нет файла: файл восстановлен', r && r.file_p === 'abc123.zip');
    check('нет файла: hash обновлён', r && r.hash_f === 'h3');
}

// === 4. ongoing: hash изменился → перекачка (реальное обновление) ===
console.log('\n[4] ongoing + новый hash → перекачка');
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: KEY1, url_fh: URL_FH1, s_status: 'ongoing', date_upd: DATE_RECENT, hash_f: 'h4' },
});
await waitFor('загрузка по новой дате завершена', async () => {
    const r = await getRec(KEY1);
    return !!(r && r.s_status === 'ongoing' && r.hash_f === 'h4' && r.file_p === 'abc123.zip');
});
{
    const r = await getRec(KEY1);
    check('ongoing: статус и hash обновлены', r && r.s_status === 'ongoing' && r.hash_f === 'h4');
}
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: KEY1, url_fh: URL_FH1, s_status: 'ongoing', date_upd: DATE_RECENT, hash_f: 'h5' },
});
await waitFor('перекачка по hash завершена', async () => {
    const r = await getRec(KEY1);
    return !!(r && r.hash_f === 'h5' && r.id_f === 4);
});
{
    const r = await getRec(KEY1);
    check('ongoing+hash: перекачка запущена', dl() === 4);
    check('ongoing+hash: файл перезаписан (id_f = новая загрузка)', r && r.id_f === 4);
    check('ongoing+hash: hash обновлён', r && r.hash_f === 'h5');
    check('ongoing+hash: в консоли — «new hash — перекачка»',
        consoleLines.some(l => l.includes('new hash — перекачка')));
}

// === 5. noDownload-импорт: ongoing + новый hash → без загрузки, файл не тронут ===
console.log('\n[5] noDownload-импорт с изменившимся hash');
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2, noDownload: true,
    exp_rec: { url_s: KEY1, url_fh: URL_FH1, s_status: 'ongoing', date_upd: DATE_RECENT, hash_f: 'h6' },
});
await new Promise(r => setTimeout(r, 300));
{
    const r = await getRec(KEY1);
    check('noDownload: загрузок не прибавилось', dl() === 4);
    check('noDownload: файл не тронут', r && r.file_p === 'abc123.zip');
    check('noDownload: hash всё равно запомнен', r && r.hash_f === 'h6');
}

// === 6. Негативный контроль: неизвестный MIME отбраковывается ===
console.log('\n[6] контроль: image/png по-прежнему invalid (валидация не отключена)');
chromeMock.downloads._nextMime = 'image/png';
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: KEY2, url_fh: URL_FH2, s_status: 'old', date_upd: DATE_OLD, hash_f: 'k1' },
});
await waitFor('невалидная загрузка обработана', async () => {
    const r = await getRec(KEY2);
    return !!(r && r.s_att === 'invalid');
});
{
    const r = await getRec(KEY2);
    // в невалидном пути id_f записи не проставляется — берём id последней загрузки
    const badId = chromeMock.downloads._downloadCalls[dl() - 1].id;
    const item = chromeMock.downloads._items.get(badId);
    check('контроль: загрузка выполнена', dl() === 5);
    check('контроль: запись помечена s_att=invalid, статус истории не тронут (v1.4.0)',
        r && r.s_att === 'invalid' && r.s_status === 'ongoing' && r.need_upd === false);
    check('контроль: невалидный файл удалён с диска', item && item.removed === true);
    await shared.flushMetrics();
    await shared.flushLog(); // log() пишет пачками с задержкой — принудительный сброс
    const m = chromeMock.storage.local._raw('fsd_metrics');
    check('контроль: total_invalid_files = 1', m.total_invalid_files === 1);
    check('контроль: completed не растёт для мусора (всё ещё 4)',
        m.total_downloads_completed === 4);
    const logArr = chromeMock.storage.local._raw('fsd_log') || [];
    // details пишутся только в консоль; в storage-лог причина — в самом message
    check('контроль: причина — unexpected_mime',
        logArr.some(e => e.message.includes('валидация не пройдена')
            && e.message.includes('unexpected_mime')));
}

console.log(`\nРегрессионные тесты v1.3.3 (background): ${passed} ok, ${failed} FAIL`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
