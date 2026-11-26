// Тесты оптимизаций v1.3.4 (background):
//  1. Общий onAlarm-листенер: 429 + Retry-After → alarm-задержка разрешается
//     срабатыванием alarm (без временного листенера на каждое ожидание)
//  2. Дедуп download-очереди через Set: повторный enqueue не растит очередь
//  3. Таймаут-загрузки: зависший элемент отменяется, вычищается из истории
//     и освобождает слот concurrency (раньше слот утекал навсегда)
//  4. Fail-fast постоянных ошибок загрузки (SERVER_BAD_CONTENT) — без
//     бессмысленных 20 попыток resume
//  4b. Разделение ошибок v1.3.5: FILE_NOT_FOUND → not_found, а не timeout;
//      метрики total_urls_timeout / total_urls_not_found считаются отдельно
//  5. Невалидный файл: запись вычищается из истории загрузок Chrome
//  6. fix(): батч-puts, нормализация ключей/дат, Set-фильтр arr_file_p
'use strict';
import 'fake-indexeddb/auto';
import { ChromeMock } from './chrome-mock.mjs';

const chromeMock = new ChromeMock();
globalThis.chrome = chromeMock;
chromeMock.storage.local._seed('fsd_settings', {
    MAX_CONCURRENT_DOWNLOADS: 1, // один слот — чтобы дедуп/утечка слота были видны
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

// Мок fetch: для KEY777 первый вызов — 429 + Retry-After: 30 (alarm-путь
// smartDelay, т.к. 30000 >= ALARM_MIN_DELAY_MS), второй — успех.
// Прочие URL не участвуют: add_url с exp_rec не ходит в API.
let fetchCount = 0;
globalThis.fetch = async (url) => {
    const s = String(url);
    if (!s.includes('777')) {
        throw new Error('неожиданный fetch в тесте: ' + url);
    }
    fetchCount++;
    if (fetchCount === 1) {
        return {
            ok: false, status: 429,
            headers: { get: (h) => (h === 'Retry-After' ? '30' : null) },
            json: async () => ({}),
        };
    }
    return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({
            err: 0,
            html_url: '/cache/html/777zip?cv=1&eh=xx',
            info: 'Story\nStatus: ongoing\nUpdated: 2026-01-15\n',
            meta: { status: 'ongoing', updated: '2026-01-15T10:00:00' },
        }),
    };
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

await waitFor('init() завершён', async () => (await shared.loadMetrics()).sw_restarts >= 1);

const dl = () => chromeMock.downloads._downloadCalls.length;

async function getRec(key) {
    const db = await getDB();
    return db.get(STORE_NAME, key);
}

function lastDlId() {
    return chromeMock.downloads._downloadCalls[dl() - 1].id;
}

function blockAutoComplete(id) {
    const item = chromeMock.downloads._items.get(id);
    if (item) item._noAutoComplete = true;
    return item;
}

// === 1. Общий onAlarm-листенер: 429 → alarm-задержка → успех ===
console.log('\n[1] 429 + Retry-After: alarm-задержка через общий листенер');
const KEY777 = 'https://www.fanfiction.net/s/777/';
await chromeMock.runtime.sendMessage({
    type_mess: 'add_urls',
    arr: [{ url_s: 'https://www.fanfiction.net/s/777/1/Some-Story' }],
    noDownload: true,
});
await waitFor('запись 777 в БД', async () => !!(await getRec(KEY777)));
await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 1 });
await waitFor('alarm-задержка 429 создана', () =>
    [...chromeMock.alarms._map.keys()].some(n => n.startsWith('fsd_api_backoff_429_')));
{
    const backoffName = [...chromeMock.alarms._map.keys()]
        .find(n => n.startsWith('fsd_api_backoff_429_'));
    check('429: alarm-задержка создана (вместо короткого setTimeout)', !!backoffName);
    // эмулируем срабатывание alarm — общий листенер должен разрешить ожидание
    await chromeMock.alarms.fire(backoffName);
    const okDone = await waitFor('после alarm — повторный запрос и загрузка', async () => {
        const r = await getRec(KEY777);
        return !!(r && r.file_p === '777zip.zip' && r.s_status === 'ongoing');
    });
    check('429: общий onAlarm-листенер разрешил ожидание (fetch повторился)',
        okDone && fetchCount === 2);
    check('429: файл скачан, статус из meta', okDone);
    await shared.flushMetrics();
    const m = chromeMock.storage.local._raw('fsd_metrics');
    check('429: total_429_received = 1', m.total_429_received === 1);
}

// === 2. Дедуп download-очереди через Set ===
console.log('\n[2] дедуп очереди загрузок (Set, O(1))');
const KEY666 = 'https://www.fanfiction.net/s/666/';
const URL_FH666 = 'https://fichub.net/cache/html/666zip';
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: 'https://www.fanfiction.net/s/666/1/Story', url_fh: URL_FH666, s_status: 'old', date_upd: '2026-06-01' },
});
await waitFor('первая загрузка 666 началась', () => dl() === 2);
const dl666a = lastDlId();
blockAutoComplete(dl666a); // держим слот занятым (лимит = 1)
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: 'https://www.fanfiction.net/s/666/1/Story', url_fh: URL_FH666, s_status: 'old', date_upd: '2026-06-02' },
});
await waitFor('первый enqueue записан', () =>
    (chromeMock.storage.local._raw('fsd_download_queue') || []).length === 1);
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: 'https://www.fanfiction.net/s/666/1/Story', url_fh: URL_FH666, s_status: 'old', date_upd: '2026-06-02' },
});
await new Promise(r => setTimeout(r, 200));
check('дедуп: повторный enqueue не растит очередь (Set)',
    (chromeMock.storage.local._raw('fsd_download_queue') || []).length === 1);
{
    // завершаем первую загрузку вручную — очередь должна прокачаться ровно одной
    const item = chromeMock.downloads._items.get(dl666a);
    item.state = 'complete';
    item.filename = '/home/user/Downloads/666zip.zip';
    item.mime = 'application/zip';
    item.fileSize = 10252;
    item.bytesReceived = 10252;
    chromeMock.downloads._fireChanged({ id: dl666a, state: { current: 'complete' } });
    await waitFor('вторая загрузка из очереди началась', () => dl() === 3);
    const dl666b = lastDlId();
    const okDone = await waitFor('вторая загрузка завершена', async () => {
        const r = await getRec(KEY666);
        return !!(r && r.id_f === dl666b && r.file_p === '666zip.zip');
    });
    check('очередь: прокачана ровно одна запись (дубль отброшен)', okDone);
    check('очередь: хранилище очереди опустело',
        JSON.stringify(chromeMock.storage.local._raw('fsd_download_queue')) === '[]');
}

// === 3. Таймаут загрузки: отмена зависшего элемента + освобождение слота ===
console.log('\n[3] таймаут-загрузки: cancel + erase + свободный слот');
const KEY888 = 'https://www.fanfiction.net/s/888/';
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: 'https://www.fanfiction.net/s/888/1/Story', url_fh: 'https://fichub.net/cache/html/888zip', s_status: 'old', date_upd: '2026-08-01' },
});
await waitFor('загрузка 888 началась', () => dl() === 4);
const dl888 = lastDlId();
blockAutoComplete(dl888); // зависла: state остаётся in_progress
await waitFor('таймаут-alarm создан', () =>
    [...chromeMock.alarms._map.keys()].some(n => n.startsWith('fsd_dl_timeout_https://www.fanfiction.net/s/888/')));
{
    const timeoutName = [...chromeMock.alarms._map.keys()]
        .find(n => n.startsWith('fsd_dl_timeout_https://www.fanfiction.net/s/888/'));
    await chromeMock.alarms.fire(timeoutName);
    const item = chromeMock.downloads._items.get(dl888);
    check('таймаут: зависшая загрузка отменена (state=canceled)',
        item && item.state === 'canceled');
    check('таймаут: запись вычищена из истории загрузок Chrome',
        chromeMock.downloads._erased.has(dl888));
    const r = await getRec(KEY888);
    check('таймаут: статус записи сохранён, file_p сброшен для перекачки',
        r && r.s_status === 'old' && r.file_p === '');
}

// === 4. Fail-fast постоянных ошибок + свободный слот после таймаута ===
console.log('\n[4] fail-fast SERVER_BAD_CONTENT + слот освобождён');
const KEY999 = 'https://www.fanfiction.net/s/999/';
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: 'https://www.fanfiction.net/s/999/1/Story', url_fh: 'https://fichub.net/cache/html/999zip', s_status: 'old', date_upd: '2026-09-01' },
});
{
    // слот должен был освободиться после таймаута — загрузка стартует сразу,
    // а не уходит в очередь (иначе waitFor не дождётся dl() === 5)
    const started = await waitFor('загрузка 999 стартовала сразу (слот свободен)', () => dl() === 5);
    check('слот: после таймаута concurrency-слот освобождён', started);
    const dl999 = lastDlId();
    blockAutoComplete(dl999);
    const item = chromeMock.downloads._items.get(dl999);
    item.state = 'interrupted';
    chromeMock.downloads._fireChanged({
        id: dl999,
        state: { current: 'interrupted' },
        error: { current: 'SERVER_BAD_CONTENT' },
    });
    await waitFor('запись 999 помечена timeout', async () => {
        const r = await getRec(KEY999);
        return !!(r && r.s_status === 'timeout');
    });
    const hasResumeAlarm = [...chromeMock.alarms._map.keys()]
        .some(n => n.startsWith('fsd_resume_dl_'));
    check('fail-fast: resume-alarm НЕ создан для постоянной ошибки', !hasResumeAlarm);
    check('fail-fast: оборванная запись вычищена из истории',
        chromeMock.downloads._erased.has(dl999));
    await shared.flushMetrics();
    const m = chromeMock.storage.local._raw('fsd_metrics');
    check('fail-fast: total_downloads_interrupted = 1', m.total_downloads_interrupted === 1);
    // v1.3.5: SERVER_BAD_CONTENT — это таймаут-подобная сбойная ошибка, в not_found не попадает
    check('разделение: SERVER_BAD_CONTENT → total_urls_timeout = 1', m.total_urls_timeout === 1);
    check('разделение: SERVER_BAD_CONTENT → total_urls_not_found = 0', m.total_urls_not_found === 0);
}

// === 4b. Разделение ошибок: FILE_NOT_FOUND → not_found (v1.3.5) ===
console.log('\n[4b] FILE_NOT_FOUND: метрика not_found, статус not_found');
const KEY778 = 'https://www.fanfiction.net/s/778/';
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: 'https://www.fanfiction.net/s/778/1/Story', url_fh: 'https://fichub.net/cache/html/778zip', s_status: 'old', date_upd: '2026-09-01' },
});
{
    const started = await waitFor('загрузка 778 стартовала', () => dl() === 6);
    check('notfound: загрузка стартовала', started);
    const dl778 = lastDlId();
    blockAutoComplete(dl778);
    const item = chromeMock.downloads._items.get(dl778);
    item.state = 'interrupted';
    chromeMock.downloads._fireChanged({
        id: dl778,
        state: { current: 'interrupted' },
        error: { current: 'FILE_NOT_FOUND' },
    });
    await waitFor('запись 778 помечена not_found', async () => {
        const r = await getRec(KEY778);
        return !!(r && r.s_status === 'not_found');
    });
    const hasResumeAlarm = [...chromeMock.alarms._map.keys()]
        .some(n => n.startsWith('fsd_resume_dl_'));
    check('notfound: resume-alarm НЕ создан для FILE_NOT_FOUND', !hasResumeAlarm);
    await shared.flushMetrics();
    const m = chromeMock.storage.local._raw('fsd_metrics');
    check('разделение: FILE_NOT_FOUND → total_urls_not_found = 1', m.total_urls_not_found === 1);
    check('разделение: FILE_NOT_FOUND не растит total_urls_timeout', m.total_urls_timeout === 1);
}

// === 5. Невалидный файл: erase из истории загрузок ===
console.log('\n[5] невалидный файл: удаление записи из истории');
const KEY121 = 'https://www.fanfiction.net/s/121/';
chromeMock.downloads._nextMime = 'image/png';
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url', fs: 2,
    exp_rec: { url_s: 'https://www.fanfiction.net/s/121/1/Story', url_fh: 'https://fichub.net/cache/html/121zip', s_status: 'old', date_upd: '2026-10-01' },
});
await waitFor('загрузка 121 началась и обработана', async () => {
    const r = await getRec(KEY121);
    return !!(r && r.s_status === 'invalid');
});
{
    const dl121 = lastDlId();
    const item = chromeMock.downloads._items.get(dl121);
    check('invalid: файл удалён с диска (removeFile)', item && item.removed === true);
    check('invalid: запись вычищена из истории загрузок Chrome',
        chromeMock.downloads._erased.has(dl121));
    await shared.flushMetrics();
    const m = chromeMock.storage.local._raw('fsd_metrics');
    check('invalid: total_invalid_files = 1', m.total_invalid_files === 1);
}

// === 6. fix(): батч-puts, нормализация, Set-фильтр ===
console.log('\n[6] fix(): нормализация + Set-фильтр arr_file_p');
{
    const db = await getDB();
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/111/2/Story-Name?x=1',
        name: 'wrong', date_upd: new Date('2026-01-01T00:00:00Z'),
        s_status: 'completed', url_fh: '', file_p: '', id_f: '',
    });
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/222/1/Other-Name',
        name: 'ff_222', date_upd: '2026-02-02T00:00:00.000Z',
        s_status: 'old', url_fh: '', file_p: 'C:\\Downloads\\ff_222.zip', id_f: 7,
    });
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/333/',
        name: 'ff_333', date_upd: '2026-03-03T00:00:00.000Z',
        s_status: 'old', url_fh: '', file_p: 'ff_333 (1).zip', id_f: '',
    });
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/444/',
        name: 'ff_444', date_upd: '2026-04-04T00:00:00.000Z',
        s_status: 'old', url_fh: '', file_p: 'ff_dup.zip', id_f: '',
    });
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/555/',
        name: 'ff_555', date_upd: '2026-05-05T00:00:00.000Z',
        s_status: 'old', url_fh: '', file_p: 'ff_dup (1).zip', id_f: '',
    });
}
await chromeMock.runtime.sendMessage({ type_mess: 'fix', arr_file_p: [] });
await waitFor('fix: ключ 111 нормализован', async () => {
    const r = await getRec('https://www.fanfiction.net/s/111/');
    return !!(r && r.name === 'ff_111');
});
{
    const db = await getDB();
    const r1 = await db.get(STORE_NAME, 'https://www.fanfiction.net/s/111/');
    const r1old = await db.get(STORE_NAME, 'https://www.fanfiction.net/s/111/2/Story-Name?x=1');
    const r2 = await getRec('https://www.fanfiction.net/s/222/');
    const r3 = await getRec('https://www.fanfiction.net/s/333/');
    const r4 = await getRec('https://www.fanfiction.net/s/444/');
    const r5 = await getRec('https://www.fanfiction.net/s/555/');
    check('fix: ключ нормализован, старый ключ удалён', !!r1 && r1old === undefined);
    check('fix: name пересобран из url (ff_111)', r1 && r1.name === 'ff_111');
    check('fix: date_upd Date → ISO-строка',
        r1 && r1.date_upd === '2026-01-01T00:00:00.000Z');
    check('fix: file_p → базовое имя пути, id_f сохранён',
        r2 && r2.file_p === 'ff_222.zip' && r2.id_f === 7);
    check('fix: суффикс " (N)" вычищен', r3 && r3.file_p === 'ff_333.zip');
    check('fix: дубликаты file_p очищены у обеих записей',
        r4 && r4.file_p === '' && r5 && r5.file_p === '');
}
// второй прогон с непустым списком файлов — фильтр через Set
{
    const db = await getDB();
    const r3 = await db.get(STORE_NAME, 'https://www.fanfiction.net/s/333/');
    r3.file_p = 'ff_333 (1).zip';
    await db.put(STORE_NAME, r3);
}
await chromeMock.runtime.sendMessage({ type_mess: 'fix', arr_file_p: ['ff_222.zip'] });
{
    const cleared = await waitFor('fix2: файл вне списка очищен', async () => {
        const r = await getRec('https://www.fanfiction.net/s/333/');
        return !!(r && r.file_p === '');
    });
    const r2 = await getRec('https://www.fanfiction.net/s/222/');
    check('fix+Set: файл вне списка пользователя очищен', cleared);
    check('fix+Set: файл из списка пользователя сохранён',
        r2 && r2.file_p === 'ff_222.zip');
}

console.log(`\nОптимизации v1.3.4: ${passed} ok, ${failed} FAIL`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
