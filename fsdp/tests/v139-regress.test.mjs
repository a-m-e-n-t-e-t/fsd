// Регрессионные тесты v1.3.9: конфликты, дублирование действий, затирание данных
//  1. fix(): суффикс « (N)» вычищается ДО сравнения со списком пользователя,
//     список пользователя нормализуется тем же правилом (раньше «ff_1.zip»
//     в БД не матчился с «ff_1 (1).zip» на диске → file_p обнулялся →
//     вечные перекачки и дубли файлов « (2)», « (3)»...)
//  2. markErrorRecord: транзитный 404 не затирает статус скачанной истории
//     (completed ≠ not_found), need_upd гарантирует перепроверку
//  3. add_sl: file_p из JSON-импорта (noDownload) не теряется, если в БД
//     поля нет (раньше ветка «new file» перезаписывала его пустым exist)
//  4. startQueue: повторный run во время прогона отклоняется — очередь не
//     перезаписывается, index_sl не сбрасывается, хвост не теряется
//  5. resume прокачивает персистентную очередь загрузок из storage
//  6. update_settings: настройки не пишутся в storage дважды
//  7. сводка прогона содержит счётчики БД и загрузок (вместо шума add_sl)
'use strict';
import 'fake-indexeddb/auto';
import { ChromeMock } from './chrome-mock.mjs';

const chromeMock = new ChromeMock();
globalThis.chrome = chromeMock;
chromeMock.storage.local._seed('fsd_settings', {
    MAX_CONCURRENT_DOWNLOADS: 1,
    API_REQUEST_DELAY_MS: 40,
    API_429_BASE_DELAY_MS: 15000,
    API_429_MAX_DELAY_MS: 120000,
    DOWNLOAD_TIMEOUT_MS: 300000,
    PROCESS_NEXT_DELAY_MS: 40,
    AUTO_CHECK_INTERVAL_HOURS: 24,
    AUTO_CHECK_ENABLED: false,
    MIN_FILE_SIZE_BYTES: 1024,
    VALIDATE_FILE_SIGNATURE: true,
    LOG_LEVEL: 'info',
    MAX_LOG_ENTRIES: 200,
    KEEPALIVE_PERIOD_MIN: 0.5,
});

// Мок fetch: режимы success (уникальный url_fh по id истории) / notfound / blocked
let fetchMode = 'success';
globalThis.fetch = (url) => {
    const s = String(url);
    if (fetchMode === 'blocked') return new Promise(() => {}); // имитация зависшего запроса
    if (fetchMode === 'notfound') {
        return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({ error: 1 }) });
    }
    const m = s.match(/\/s\/(\d+)\//);
    const id = m ? m[1] : 'x';
    return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
            err: 0,
            epub_url: `/cache/epub/${id}/story-${id}.epub`,
            meta: { status: 'completed', updated: '2026-11-01T00:00:00' },
        }),
    });
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

async function getRec(key) {
    const db = await getDB();
    return db.get(STORE_NAME, key);
}
const stateRaw = () => chromeMock.storage.local._raw('fsd_state') || {};
const queueRaw = () => chromeMock.storage.local._raw('fsd_queue_arr') || [];

// === 1. fix(): нормализация суффикса ДО сравнения со списком ===
console.log('\n[1] fix(): « (N)»-суффиксы в списке пользователя матчатся с БД');
{
    const db = await getDB();
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/333/', name: 'ff_333',
        date_upd: '2026-01-01T00:00:00.000Z', s_status: 'old',
        url_fh: '', file_p: 'ff_333.zip', id_f: '', hash_f: '', need_upd: false,
    });
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/444/', name: 'ff_444',
        date_upd: '2026-01-02T00:00:00.000Z', s_status: 'old',
        url_fh: '', file_p: 'ff_444.zip', id_f: '', hash_f: '', need_upd: false,
    });
    // пользователь выбрал файл «ff_333 (1).zip» — это та же история ff_333
    await chromeMock.runtime.sendMessage({ type_mess: 'fix', arr_file_p: ['ff_333 (1).zip'] });
    const cleared = await waitFor('fix: файл вне списка очищен', async () => {
        const r = await getRec('https://www.fanfiction.net/s/444/');
        return !!(r && r.file_p === '');
    });
    const r333 = await getRec('https://www.fanfiction.net/s/333/');
    check('fix: «ff_333.zip» в БД сматчен с «ff_333 (1).zip» пользователя — file_p сохранён',
        cleared && !!(r333 && r333.file_p === 'ff_333.zip'));
    check('fix: файл, реально отсутствующий у пользователя, очищен', cleared);
}

// === 2. markErrorRecord: 404 не затирает статус скачанной истории ===
console.log('\n[2] транзитный 404: статус скачанной истории не затирается');
{
    fetchMode = 'notfound';
    const db = await getDB();
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/555/', name: 'ff_555',
        date_upd: '2026-11-20T00:00:00.000Z', s_status: 'completed',
        url_fh: 'https://fichub.net/cache/html/555zip', file_p: 'ff_555.zip',
        id_f: 9, hash_f: 'x', need_upd: true,
    });
    await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 1 });
    await waitFor('прогон [2] завершён', () => stateRaw().fsd_status === 'free');
    const r555 = await getRec('https://www.fanfiction.net/s/555/');
    check('404: статус скачанной истории не затёрт (completed, а не not_found)',
        !!(r555 && r555.s_status === 'completed' && r555.file_p === 'ff_555.zip'));
    check('404: need_upd=true — перепроверка в следующем прогоне состоится',
        !!(r555 && r555.need_upd === true));
    fetchMode = 'success';
}

// === 3. add_sl: file_p из импорта не теряется ===
console.log('\n[3] JSON-импорт: file_p сохраняется при существующей записи без файла');
{
    const db = await getDB();
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/666/', name: 'ff_666',
        date_upd: '2026-05-05T00:00:00.000Z', s_status: 'old',
        url_fh: 'https://fichub.net/cache/html/666zip', file_p: '',
        id_f: '', hash_f: '', need_upd: false,
    });
    await chromeMock.runtime.sendMessage({
        type_mess: 'add_url', fs: 2, noDownload: true,
        exp_rec: {
            url_s: 'https://www.fanfiction.net/s/666/',
            url_fh: 'https://fichub.net/cache/html/666zip',
            s_status: 'old', date_upd: '2026-05-05T00:00:00.000Z',
            file_p: 'backup_666.zip',
        },
    });
    const ok = await waitFor('666: file_p из импорта записан', async () => {
        const r = await getRec('https://www.fanfiction.net/s/666/');
        return !!(r && r.file_p === 'backup_666.zip');
    });
    check('импорт: file_p из бэкапа не потерян (раньше перезаписывался пустым)',
        ok);
    check('импорт: без перекачки (noDownload)', chromeMock.downloads._downloadCalls.length === 0);
}

// === 4. startQueue: повторный run во время прогона отклоняется ===
console.log('\n[4] startQueue guard: очередь не перезаписывается повторным run');
{
    fetchMode = 'blocked'; // первый URL прогона висит вечно
    const db = await getDB();
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/777/', name: 'ff_777',
        date_upd: '2026-06-01T00:00:00.000Z', s_status: 'old',
        url_fh: '', file_p: '', id_f: '', hash_f: '', need_upd: true,
    });
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/888/', name: 'ff_888',
        date_upd: '2026-06-02T00:00:00.000Z', s_status: 'old',
        url_fh: '', file_p: '', id_f: '', hash_f: '', need_upd: true,
    });
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/999/', name: 'ff_999',
        date_upd: '2026-06-03T00:00:00.000Z', s_status: 'completed',
        url_fh: 'https://fichub.net/cache/html/999zip', file_p: 'ff_999.zip',
        id_f: 5, hash_f: '', need_upd: false,
    });
    await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 1 });
    await waitFor('прогон начался (work, очередь сохранена)', () =>
        stateRaw().fsd_status === 'work' && queueRaw().length > 0);
    const lenBefore = queueRaw().length;
    // повторный запуск (аудит по всей БД выбрал бы больше записей и сбросил index_sl)
    await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 0 });
    const rejected = await waitFor('отказ залогирован', () =>
        (chromeMock.storage.local._raw('fsd_log') || [])
            .some(e => String(e.message || '').includes('startQueue отклонён')));
    await new Promise(r => setTimeout(r, 300));
    check('guard: очередь прогона не перезаписана (длина прежняя)',
        rejected && queueRaw().length === lenBefore);
    check('guard: прогон продолжает работать (work)', stateRaw().fsd_status === 'work');
    await chromeMock.runtime.sendMessage({ type_mess: 'stop' });
    await new Promise(r => setTimeout(r, 300));
    check('stop: состояние очищено', chromeMock.storage.local._raw('fsd_state') === undefined);
    fetchMode = 'success';
}

// === 5. очередь загрузок: enqueue → запись в storage → pump ===
console.log('\n[5] очередь загрузок персистится и прокачивается');
{
    const db = await getDB();
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/123/', name: 'ff_123',
        date_upd: '2026-07-01T00:00:00.000Z', s_status: 'old',
        url_fh: 'https://fichub.net/cache/html/123zip', file_p: '',
        id_f: '', hash_f: '', need_upd: false,
    });
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/456/', name: 'ff_456',
        date_upd: '2026-07-02T00:00:00.000Z', s_status: 'old',
        url_fh: 'https://fichub.net/cache/html/456zip', file_p: '',
        id_f: '', hash_f: '', need_upd: false,
    });
    const lastDlId = () => chromeMock.downloads._downloadCalls[chromeMock.downloads._downloadCalls.length - 1].id;
    // первый add_url: занимает единственный слот загрузки
    await chromeMock.runtime.sendMessage({
        type_mess: 'add_url', fs: 2,
        exp_rec: { url_s: 'https://www.fanfiction.net/s/123/', url_fh: 'https://fichub.net/cache/html/123zip', s_status: 'old', date_upd: '2026-07-01' },
    });
    const started1 = await waitFor('загрузка 123 началась', () =>
        chromeMock.downloads._downloadCalls.some(c => c.url === 'https://fichub.net/cache/html/123zip'));
    const dl123 = lastDlId();
    const item123 = chromeMock.downloads._items.get(dl123);
    if (item123) item123._noAutoComplete = true; // держим слот занятым
    // второй add_url: слот занят → enqueue → очередь обязана попасть в storage
    await chromeMock.runtime.sendMessage({
        type_mess: 'add_url', fs: 2,
        exp_rec: { url_s: 'https://www.fanfiction.net/s/456/', url_fh: 'https://fichub.net/cache/html/456zip', s_status: 'old', date_upd: '2026-07-02' },
    });
    const persisted = await waitFor('enqueue записан в storage', () =>
        (chromeMock.storage.local._raw('fsd_download_queue') || []).length === 1);
    check('очередь: enqueue записан в storage (не теряется при смерти SW)',
        started1 && persisted);
    // завершаем первую загрузку вручную → pump обязан запустить вторую из очереди
    if (item123) {
        item123.state = 'complete';
        item123.filename = '/home/user/Downloads/123zip.zip';
        item123.mime = 'application/zip';
        item123.fileSize = 10252;
        item123.bytesReceived = 10252;
    }
    chromeMock.downloads._fireChanged({ id: dl123, state: { current: 'complete' } });
    const started2 = await waitFor('загрузка 456 из очереди началась', () =>
        chromeMock.downloads._downloadCalls.some(c => c.url === 'https://fichub.net/cache/html/456zip'));
    const okDone = await waitFor('запись 456 обновлена', async () => {
        const r = await getRec('https://www.fanfiction.net/s/456/');
        return !!(r && r.file_p === '456zip.zip');
    });
    check('очередь: pump запустил отложенную загрузку после освобождения слота',
        started2 && okDone);
}

// === 6. update_settings: без повторной записи в storage ===
console.log('\n[6] update_settings: одна запись, без двойного save');
{
    let settingsWrites = 0;
    const listener = (changes) => { if (changes.fsd_settings) settingsWrites++; };
    chromeMock.storage.onChanged.addListener(listener);
    // «страница options» сохранила настройки сама
    const saved = await shared.saveSettings({ MAX_CONCURRENT_DOWNLOADS: 2 });
    await new Promise(r => setTimeout(r, 50));
    const before = settingsWrites;
    await chromeMock.runtime.sendMessage({ type_mess: 'update_settings', settings: saved });
    await new Promise(r => setTimeout(r, 300));
    chromeMock.storage.onChanged.removeListener(listener);
    check('update_settings: повторной записи fsd_settings нет', settingsWrites === before);
    const resp = await chromeMock.runtime.sendMessage({ type_mess: 'get_settings' });
    check('update_settings: кэш фона синхронизирован (MAX_CONCURRENT_DOWNLOADS=2)',
        !!(resp && resp.settings && resp.settings.MAX_CONCURRENT_DOWNLOADS === 2));
}

// === 7. сводка прогона со счётчиками БД и загрузок ===
console.log('\n[7] сводка прогона: обновлено в БД / загрузок');
{
    const db = await getDB();
    await db.put(STORE_NAME, {
        url_s: 'https://www.fanfiction.net/s/234/', name: 'ff_234',
        date_upd: '2026-02-02T00:00:00.000Z', s_status: 'old',
        url_fh: '', file_p: '', id_f: '', hash_f: '', need_upd: true,
    });
    await chromeMock.runtime.sendMessage({ type_mess: 'run', regim: 1 });
    await waitFor('прогон [7] завершён', () => stateRaw().fsd_status === 'free');
    const hasSummary = await waitFor('сводка с «обновлено в БД» в логе', () =>
        (chromeMock.storage.local._raw('fsd_log') || [])
            .some(e => String(e.message || '').includes('проверка завершена: обработано')
                && String(e.message || '').includes('обновлено в БД')));
    check('сводка: содержит счётчик обновлений БД', hasSummary);
    const sumEntry = (chromeMock.storage.local._raw('fsd_log') || [])
        .filter(e => String(e.message || '').includes('обновлено в БД')).pop();
    check('сводка: содержит счётчик загрузок',
        !!(sumEntry && sumEntry.message.includes('загрузок')));
}

console.log(`\nРегрессионные тесты v1.3.9 (конфликты/затирание данных): ${passed} ok, ${failed} FAIL`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
