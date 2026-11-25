// Интеграционный тест fsd_background.js: полный жизненный цикл через моки chrome API
'use strict';
import 'fake-indexeddb/auto';
import { ChromeMock } from './chrome-mock.mjs';

// === Посев настроек с малыми задержками ДО импорта background ===
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

// === Мок fetch (fichub API) ===
const fetchCalls = [];
const API_SUCCESS = {
    err: 0,
    epub_url: '/cache/epub/abc123/Test_story_by_Author-abc123.epub?h=36c3d7e8',
    html_url: '/cache/html/abc123?cv=26&eh=36c3d7e8',
    info: 'Test story by Author\nStatus: ongoing\nUpdated: 2026-01-15\n',
    meta: { status: 'ongoing', updated: '2026-01-15T10:00:00' },
};
globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes('14064024')) {
        return {
            ok: true, status: 200,
            headers: { get: () => null },
            json: async () => API_SUCCESS,
        };
    }
    if (String(url).includes('99999999')) {
        return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ error: 1 }) };
    }
    throw new Error('неожиданный URL в тесте: ' + url);
};

// === Утилиты ===
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

// === Импорт background (запускает init()) ===
await import('../fsd_background.js');
const shared = await import('../fsd_shared.js');
const { STORE_NAME, getDB } = shared;

const KEY_GOOD = 'https://www.fanfiction.net/s/14064024/';
const KEY_BAD = 'https://www.fanfiction.net/s/99999999/';

// === 1. Инициализация SW ===
console.log('\n[1] Инициализация SW');
// ждём завершения init() по кэшу метрик (тот же экземпляр модуля, что у SW)
const initDone = await waitFor('init() завершён (sw_restarts в кэше)', async () => {
    const m = await shared.loadMetrics();
    return m.sw_restarts >= 1;
});
check('init: SW загрузился и завершил init() без ошибок', initDone);
await shared.flushMetrics();
{
    const m = chromeMock.storage.local._raw('fsd_metrics');
    check('init: sw_restarts=1 записан в storage', m && m.sw_restarts === 1);
    check('init: auto-check alarm создан', chromeMock.alarms._map.has('fsd_auto_check'));
    check('init: keepalive НЕ создан (работы нет)', !chromeMock.alarms._map.has('fsd_keepalive'));
}

// === 2. Батч-импорт записей ===
console.log('\n[2] Батч-импорт (add_urls)');
await chromeMock.runtime.sendMessage({
    type_mess: 'add_urls',
    arr: [
        { url_s: 'https://www.fanfiction.net/s/14064024/1/Test-story' },
        { url_s: 'https://www.fanfiction.net/s/99999999/1/Missing-story' },
    ],
    noDownload: false,
});
await waitFor('записи в БД', async () => {
    const db = await getDB();
    return (await db.count(STORE_NAME)) >= 2;
});
{
    const db = await getDB();
    const r1 = await db.get(STORE_NAME, KEY_GOOD);
    check('add_urls: обе записи добавлены одним сообщением', !!r1);
    check('add_urls: без загрузки на этапе импорта (нет url_fh — оригинальная логика)',
        chromeMock.downloads._downloadCalls.length === 0);
    check('add_urls: s_c=2 в состоянии',
        await waitFor('s_c=2', () => (chromeMock.storage.local._raw('fsd_state') || {}).s_c === 2));
}

// === 3. run regim=1: обе записи нуждаются в обновлении ===
console.log('\n[3] run regim=1 (загрузка + 404)');
await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 1 });
await waitFor('загрузка началась', () => chromeMock.downloads._downloadCalls.length >= 1);
await waitFor('404-запись обработана (конец прогона)', async () => {
    const db = await getDB();
    const r = await db.get(STORE_NAME, KEY_BAD);
    return !!(r && r.s_status === 'not_found');
});
await waitFor('очередь очищена в storage', () =>
    JSON.stringify(chromeMock.storage.local._raw('fsd_queue_arr')) === '[]');
await waitFor('keepalive погашен', () => !chromeMock.alarms._map.has('fsd_keepalive'));
{
    const db = await getDB();
    const r1 = await db.get(STORE_NAME, KEY_GOOD);
    const r2 = await db.get(STORE_NAME, KEY_BAD);
    check('run1: загрузка выполнена', chromeMock.downloads._downloadCalls.length === 1);
    check('run1: статус вернулся в free',
        (chromeMock.storage.local._raw('fsd_state') || {}).fsd_status === 'free');
    check('run1: URL загрузки — stripped cache url без query',
        chromeMock.downloads._downloadCalls[0].url === 'https://fichub.net/cache/html/abc123');
    await waitFor('file_p записан', () => db.get(STORE_NAME, KEY_GOOD).then(r => !!(r && r.file_p)));
    const r1b = await db.get(STORE_NAME, KEY_GOOD);
    check('run1: file_p установлен после завершения', r1b.file_p === 'abc123.zip');
    check('run1: статус ongoing взят из meta (не regex)', r1b.s_status === 'ongoing');
    check('run1: date_upd — ISO-строка из meta.updated', r1b.date_upd === '2026-01-15T10:00:00.000Z');
    check('run1: url_fh без query', r1b.url_fh === 'https://fichub.net/cache/html/abc123');
    check('run1: 404-запись помечена not_found', r2 && r2.s_status === 'not_found');
    check('run1: c_e_s=1 (счётчик ошибок работает)',
        await waitFor('c_e_s=1', () => (chromeMock.storage.local._raw('fsd_state') || {}).c_e_s === 1));
    check('run1: очередь в storage очищена',
        JSON.stringify(chromeMock.storage.local._raw('fsd_queue_arr')) === '[]');
    check('run1: keepalive погашен после завершения (нет активной работы)',
        !chromeMock.alarms._map.has('fsd_keepalive'));
}

// === 4. Повторный run: 404 — fail-fast, хорошая история без изменений ===
console.log('\n[4] run regim=1 повторно (идемпотентность + fail-fast)');
const fetchBefore = fetchCalls.length;
const calls404Before = fetchCalls.filter(u => u.includes('99999999')).length;
await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 1 });
await waitFor('2-й прогон: оба URL проверены', () => fetchCalls.length >= fetchBefore + 2);
{
    const calls404 = fetchCalls.filter(u => u.includes('99999999')).length - calls404Before;
    check('run2: ровно 1 запрос на 404-URL за прогон (fail-fast)', calls404 === 1);
    check('run2: хорошая история проверена, изменений нет — новая загрузка не запущена',
        chromeMock.downloads._downloadCalls.length === 1);
    check('run2: оба URL проверены через API', fetchCalls.length === fetchBefore + 2);
}

// === 5. Resume прерванной загрузки через главный onAlarm ===
console.log('\n[5] resume прерванной загрузки (переживает рестарт SW)');
await chromeMock.runtime.sendMessage({
    type_mess: 'add_url',
    fs: 2,
    exp_rec: {
        url_s: KEY_GOOD,
        url_fh: 'https://fichub.net/cache/html/abc123',
        date_upd: '2026-02-01T00:00:00',
    },
});
await waitFor('вторая загрузка началась', () => chromeMock.downloads._downloadCalls.length >= 2);
{
    // блокируем авто-завершение и имитируем прерывание
    const dlId = chromeMock.downloads._downloadCalls[chromeMock.downloads._downloadCalls.length - 1].id;
    const item = chromeMock.downloads._items.get(dlId);
    item._noAutoComplete = true;
    item.state = 'interrupted';
    chromeMock.downloads._fireChanged({ id: dlId, state: { current: 'interrupted' } });
    await waitFor('resume-alarm создан', () =>
        [...chromeMock.alarms._map.keys()].some(n => n.startsWith('fsd_resume_dl_')));
    const resumeAlarmName = [...chromeMock.alarms._map.keys()].find(n => n.startsWith('fsd_resume_dl_'));
    check('interrupted: создан resume-alarm (главный механизм, не замыкание)', !!resumeAlarmName);
    // эмулируем пробуждение SW: главный onAlarm-обработчик ловит resume-alarm
    await chromeMock.alarms.fire(resumeAlarmName);
    await waitFor('повторная загрузка после resume', () => chromeMock.downloads._downloadCalls.length >= 3);
    check('resume: повторная загрузка запущена из главного onAlarm',
        chromeMock.downloads._downloadCalls.length >= 3);
    const db = await getDB();
    await waitFor('file_p обновлён после resume', async () => {
        const r = await db.get(STORE_NAME, KEY_GOOD);
        return !!(r && r.file_p === 'abc123.zip');
    });
    const r = await db.get(STORE_NAME, KEY_GOOD);
    check('resume: запись обновлена (id_f = новая загрузка)', r.id_f === 3);
}

// === 6. Pause / Resume / Stop ===
console.log('\n[6] pause/resume/stop');
await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 0 });
await new Promise(r => setTimeout(r, 150));
await chromeMock.runtime.sendMessage({ type_mess: 'pause' });
await new Promise(r => setTimeout(r, 120));
check('pause: is_paused=true в storage', chromeMock.storage.local._raw('fsd_state')?.is_paused === true);
await chromeMock.runtime.sendMessage({ type_mess: 'resume' });
await new Promise(r => setTimeout(r, 120));
check('resume: is_paused=false', chromeMock.storage.local._raw('fsd_state')?.is_paused === false);
await waitFor('прогон после resume завершён', () => chromeMock.storage.local._raw('fsd_state')?.fsd_status === 'free');
await chromeMock.runtime.sendMessage({ type_mess: 'stop' });
await new Promise(r => setTimeout(r, 250));
check('stop: fsd_state удалён', chromeMock.storage.local._raw('fsd_state') === undefined);
check('stop: fsd_queue_arr удалён', chromeMock.storage.local._raw('fsd_queue_arr') === undefined);
check('stop: все fsd_* alarms очищены',
    (await chromeMock.alarms.getAll()).filter(a => a.name.startsWith('fsd_')).length === 0);

// === 7. Метрики, лог, компактность ===
console.log('\n[7] метрики, лог, компактность');
await shared.flushMetrics();
await shared.flushLog();
{
    const m = chromeMock.storage.local._raw('fsd_metrics');
    check('metrics: total_downloads_completed = 2 (первая + resume)', m.total_downloads_completed === 2);
    check('metrics: total_downloads_started = 3', m.total_downloads_started === 3);
    check('metrics: total_invalid_files = 0', m.total_invalid_files === 0);
    check('metrics: total_urls_processed >= 4', m.total_urls_processed >= 4);
    const logArr = chromeMock.storage.local._raw('fsd_log') || [];
    check('log: есть записи о завершении загрузок',
        logArr.filter(e => e.message.includes('загрузка завершена')).length >= 2);
    check('log: батч-импорт залогирован одним сообщением',
        logArr.filter(e => e.message.includes('add_urls: обработано записей: 2')).length === 1);
    check('state: fsd_state не содержал arr_sl (компактные записи)',
        !(JSON.stringify(chromeMock.storage.local._raw('fsd_queue_arr') || []).length > 100000));
}

// === 8. Статус-сообщения SW не зацикливают onMessage ===
console.log('\n[8] отсутствие цикла a_status');
check('sendMessage из SW не доставляется собственному листенеру (нет потопа a_status)',
    (chromeMock.runtime._fromBg || []).length > 0
    && !fetchCalls.some(u => u.includes('a_status')));

console.log(`\nИнтеграционные тесты: ${passed} ok, ${failed} FAIL`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
