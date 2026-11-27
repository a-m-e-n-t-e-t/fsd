// Регрессионные тесты v1.4.0: разделение доменов статусов (история/попытка)
//  1. Миграция pre-v1.4.0 БД: смешанные s_status расщепляются в s_att,
//     'old' разворачивается в 'ongoing', file_p выводит s_att='ok',
//     need_upd пересчитывается из нового домена попытки
//  2. Матрица покрытия ТРЁХ списков проверки обновлений:
//     «Загрузить» (run regim=1), «проверить все» (run regim=0),
//     автопроверка (alarm fsd_auto_check) — ни одна запись не теряется
//  3. Живой путь: touch (t_att) без перекачки; invalid→ok; ошибки API
//     не трогают статус истории; эвристика 'old' больше не хранится
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

const DATE_FRESH = new Date(Date.now() - 86400000).toISOString(); // вчера
const DATE_STALE = '2020-06-01T00:00:00.000Z';                     // > 5 лет
const DATE_EPOCH = '1970-01-01T00:00:00.000Z';                     // неизвестна

// Мок fetch: считает опрошенные URL; 14002 — ongoing (свежая), 14003 —
// completed с прежней (давней) датой, 14009 — 404, остальные — completed.
// html_url детерминирован из id истории.
const fetchedUrls = [];
globalThis.fetch = async (url) => {
    const s = String(url);
    const decoded = (() => { try { return decodeURIComponent(s); } catch (e) { return s; } })();
    const id = (decoded.match(/\/s\/(\d+)/) || [])[1] || '';
    fetchedUrls.push(decoded);
    if (id === '14009') {
        return {
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ err: 1, msg: 'unable to find fic' }),
        };
    }
    const status = id === '14002' ? 'ongoing' : 'completed';
    const updated = id === '14003' ? DATE_STALE : DATE_FRESH;
    return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
            err: 0,
            html_url: `/cache/html/${id}zip`,
            info: 'Story\nStatus: ' + status + '\nUpdated: ' + updated + '\n',
            meta: { status, updated },
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

// === Сеем pre-v1.4.0 БД ДО импорта background (как после старой версии) ===
const shared = await import('../fsd_shared.js');
const { STORE_NAME, getDB } = shared;
const U = (id) => `https://www.fanfiction.net/s/${id}/`;
const FH = (id) => `https://fichub.net/cache/html/${id}zip`;
const SEEDS = [
    // A: completed + файл + fh — эталон «всё хорошо», ничего не делать
    { key: '14001', s_status: 'completed', url_fh: true, file_p: 'x', date: DATE_FRESH, need_upd: false },
    // B: ongoing + файл + свежая дата — автопроверка обязана её видеть
    { key: '14002', s_status: 'ongoing', url_fh: true, file_p: 'x', date: DATE_FRESH, need_upd: false },
    // C: 'old' + файл — эвристика упразднена: разворачивается в ongoing(заброшенную)
    { key: '14003', s_status: 'old', url_fh: true, file_p: 'x', date: DATE_STALE, need_upd: false },
    // D/E: смешанные статусы попытки в s_status (до v1.4.0)
    { key: '14004', s_status: 'not_found', url_fh: false, file_p: '', date: DATE_STALE, need_upd: true },
    { key: '14005', s_status: 'timeout', url_fh: false, file_p: '', date: DATE_STALE, need_upd: true },
    // F: invalid — не переспрашивается «Загрузить», но «проверить все» берёт
    { key: '14006', s_status: 'invalid', url_fh: true, file_p: '', date: DATE_FRESH, need_upd: false },
    // G: импорт без попытки — need_upd должен стать true (перепроверить)
    { key: '14007', s_status: 'completed', url_fh: false, file_p: '', date: DATE_FRESH, need_upd: false },
    // H: ongoing с неизвестной датой — перестраховаться (need_upd true)
    { key: '14008', s_status: 'ongoing', url_fh: true, file_p: 'x', date: DATE_EPOCH, need_upd: false },
    // I: completed + файл — 404 API не должен затереть статус истории
    { key: '14009', s_status: 'completed', url_fh: true, file_p: 'x', date: DATE_FRESH, need_upd: false },
];
{
    const db = await getDB();
    for (const s of SEEDS) {
        await db.put(STORE_NAME, {
            url_s: U(s.key), name: 'ff_' + s.key,
            date_upd: s.date,
            s_status: s.s_status,
            url_fh: s.url_fh ? FH(s.key) : '',
            file_p: s.file_p ? `${s.key}zip.zip` : '',
            id_f: '', hash_f: '',
            ...(s.need_upd === undefined ? {} : { need_upd: s.need_upd }),
        });
    }
}

// Импорт background → init() → миграция расщепления
await import('../fsd_background.js');
await waitFor('init() завершён', async () => (await shared.loadMetrics()).sw_restarts >= 1);

const dl = () => chromeMock.downloads._downloadCalls.length;
async function getRec(id) {
    const db = await getDB();
    return db.get(STORE_NAME, U(id));
}
async function waitIdle(desc) {
    return waitFor(desc, () => {
        const st = chromeMock.storage.local._raw('fsd_state') || {};
        const q = chromeMock.storage.local._raw('fsd_queue_arr');
        return st.fsd_status === 'free' && (!q || q.length === 0);
    });
}
// Прогон стартует асинхронно (create_arr_sl сканирует БД) — сначала ждём
// статуса 'work', иначе waitIdle проходит до старта и фазы наезжают друг на друга
async function waitRun(desc) {
    const started = await waitFor(desc + ': прогон начался', () =>
        (chromeMock.storage.local._raw('fsd_state') || {}).fsd_status === 'work', 5000);
    if (!started) return false;
    return waitIdle(desc + ': прогон завершён');
}

// === 1. Миграция ===
console.log('\n[1] миграция v1.4.0: расщепление смешанных статусов');
{
    const A = await getRec('14001'), B = await getRec('14002'), C = await getRec('14003');
    const D = await getRec('14004'), E = await getRec('14005'), F = await getRec('14006');
    const G = await getRec('14007'), H = await getRec('14008'), I = await getRec('14009');
    check('мигр: A completed+файл → s_att=ok, need_upd=false',
        A && A.s_status === 'completed' && A.s_att === 'ok' && A.need_upd === false);
    check('мигр: B ongoing свежая → s_att=ok, need_upd ПЕРЕСЧИТАН в true',
        B && B.s_status === 'ongoing' && B.s_att === 'ok' && B.need_upd === true);
    check('мигр: C legacy old → ongoing (заброшенность теперь выводится из даты)',
        C && C.s_status === 'ongoing' && C.s_att === 'ok' && C.need_upd === false);
    check('мигр: D not_found → s_att, статус истории очищен',
        D && D.s_status === '' && D.s_att === 'not_found' && D.need_upd === true);
    check('мигр: E timeout → s_att',
        E && E.s_status === '' && E.s_att === 'timeout' && E.need_upd === true);
    check('мигр: F invalid → s_att, need_upd=false (не дёргать API)',
        F && F.s_status === '' && F.s_att === 'invalid' && F.need_upd === false);
    check('мигр: G без попытки → s_att=\'\', need_upd ПЕРЕСЧИТАН в true',
        G && G.s_status === 'completed' && G.s_att === '' && G.need_upd === true);
    check('мигр: H ongoing без даты → need_upd=true (перестраховаться)',
        H && H.s_att === 'ok' && H.need_upd === true);
    check('мигр: I не тронут (s_att=ok, need_upd=false)',
        I && I.s_status === 'completed' && I.s_att === 'ok' && I.need_upd === false);
    let tAttOk = true;
    for (const s of SEEDS) { const r = await getRec(s.key); if (!(r && r.t_att === 0)) tAttOk = false; }
    check('мигр: t_att=0 у всех записей', tAttOk);
    const db = await getDB();
    let noOld = true, count = 0;
    for (const v of await db.getAll(STORE_NAME)) { count++; if (v.s_status === 'old') noOld = false; }
    check('мигр: статуса \'old\' больше не существует в БД', noOld);
}

// === 2. «Загрузить» (regim 1) ===
console.log('\n[2] список «Загрузить» (run regim=1): покрытие по домену попытки');
fetchedUrls.length = 0;
await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 1 });
await waitRun('[2] «Загрузить»');
{
    const set = new Set(fetchedUrls.map(u => (u.match(/\/s\/(\d+)\//) || [])[1]));
    // ожидааем: B (need_upd=true), D и E (нет url_fh), G (need_upd=true), H (need_upd=true)
    const expected = new Set(['14002', '14004', '14005', '14007', '14008']);
    const got = [...set].sort().join(',');
    check('«Загрузить»: выбраны B,D,E,G,H — ровно 5',
        set.size === 5 && [...expected].every(k => set.has(k)) && got === [...expected].sort().join(','));
    check('«Загрузить»: A (всё хорошо) не тронута', !set.has('14001'));
    check('«Загрузить»: C (заброшенная ongoing) не теребится', !set.has('14003'));
    check('«Загрузить»: F (invalid) не переспрашивается', !set.has('14006'));
    check('«Загрузить»: I (completed+файл) не тронута', !set.has('14009'));
    check('«Загрузить»: загрузки только для D,E,G (новый url) и H (новая дата)',
        dl() === 4);
    const B = await getRec('14002');
    check('«Загрузить»: B — живой ответ без изменений: touch t_att, БЕЗ перекачки',
        B && B.t_att > 0 && B.file_p === '14002zip.zip' && B.s_att === 'ok');
    const F = await getRec('14006');
    check('«Загрузить»: F осталась invalid', F && F.s_att === 'invalid');
}

// === 3. «Проверить все» (regim 0) ===
console.log('\n[3] список «Проверить все» (run regim=0): полное покрытие');
await new Promise(r => setTimeout(r, 30)); // t_att гарантированно изменится
const tAttB1 = (await getRec('14002')).t_att;
fetchedUrls.length = 0;
await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 0 });
await waitRun('[3] «проверить все»');
{
    const set = new Set(fetchedUrls.map(u => (u.match(/\/s\/(\d+)\//) || [])[1]));
    check('«все»: опрошены ВСЕ 9 записей (включая invalid и C)', set.size === 9);
    const F = await getRec('14006');
    check('«все»: F invalid→ok после успешной загрузки, need_upd пересчитан',
        F && F.s_att === 'ok' && F.file_p === '14006zip.zip' && F.need_upd === false);
    const I = await getRec('14009');
    check('«все»: 404 API НЕ затёр статус истории I (главный инвариант v1.4.0)',
        I && I.s_status === 'completed' && I.s_att === 'not_found' && I.need_upd === true);
    const B = await getRec('14002');
    check('«все»: повторный touch обновил t_att',
        B && B.t_att > tAttB1);
    // A,C,D,E,G,H — по 1 fetch; I — 404 без загрузки; F — 1 загрузка
    check('«все»: суммарно 5 загрузок (D,E,G,H + F)', dl() === 5);
}

// === 4. Автопроверка (alarm fsd_auto_check) ===
console.log('\n[4] автопроверка: только активные ongoing');
fetchedUrls.length = 0;
await chromeMock.alarms.fire('fsd_auto_check');
{
    // прогон автопроверки стартует из alarm-обработчика — дождаться через очередь
    await waitRun('[4] автопроверка');
}
{
    const set = new Set(fetchedUrls.map(u => (u.match(/\/s\/(\d+)\//) || [])[1]));
    check('авто: выбрана ТОЛЬКО активная ongoing B', set.size === 1 && set.has('14002'));
    check('авто: заброшенная ongoing C (дата 2020) пропущена', !set.has('14003'));
    check('авто: completed / invalid / not_found пропущены',
        !set.has('14001') && !set.has('14004') && !set.has('14005') && !set.has('14006'));
    check('авто: без новых загрузок', dl() === 5);
}

// === 5. Инвариант БД после всех трёх прогонов ===
console.log('\n[5] итоговые инварианты БД');
{
    const db = await getDB();
    let all = await db.getAll(STORE_NAME);
    check('итог: 9 записей, ни одна не потерялась', all.length === 9);
    check('итог: ни в одной записи нет статуса \'old\'',
        !all.some(v => v.s_status === 'old'));
    check('итог: ни у одной записи s_status не смешан с доменом попытки',
        !all.some(v => ['timeout', 'not_found', 'invalid', 'old'].includes(v.s_status)));
}

console.log(`\nРегрессионные тесты v1.4.0 (разделение доменов статусов): ${passed} ok, ${failed} FAIL`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
