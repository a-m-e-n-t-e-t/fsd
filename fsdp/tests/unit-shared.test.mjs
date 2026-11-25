// Юнит-тесты fsd_shared.js (без background)
'use strict';
import 'fake-indexeddb/auto';
import { ChromeMock } from './chrome-mock.mjs';

globalThis.chrome = new ChromeMock();

const shared = await import('../fsd_shared.js');

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log('  ok  ' + name); }
    else { failed++; console.error('  FAIL ' + name); }
}

// === normalize ===
check('normalize: fanfiction с query и главой',
    shared.normalize('https://www.fanfiction.net/s/14064024/3/Some-Name?x=1') === 'https://www.fanfiction.net/s/14064024/');
check('normalize: ao3',
    shared.normalize('https://archiveofourown.org/works/12345/chapters/678#end') === 'https://archiveofourown.org/works/12345/');
check('normalize: spacebattles thread',
    shared.normalize('https://forums.spacebattles.com/threads/some-story.123456/page-7?posted=1') === 'https://forums.spacebattles.com/threads/123456/');
check('normalize: пустой URL → \'\'', shared.normalize('') === '');
check('normalize: мусор → \'\'', shared.normalize('not a url') === '');

// === buildFileName ===
check('buildFileName: ff', shared.buildFileName('https://www.fanfiction.net/s/14064024/1') === 'ff_14064024');
check('buildFileName: ao3', shared.buildFileName('https://archiveofourown.org/works/12345') === 'ao3_12345');

// === resolveStatus ===
check('resolveStatus: ongoing давний → old',
    shared.resolveStatus('ongoing', '2000-01-01') === 'old');
check('resolveStatus: ongoing свежий → ongoing',
    shared.resolveStatus('ongoing', new Date().toISOString()) === 'ongoing');
check('resolveStatus: completed не меняется',
    shared.resolveStatus('completed', '2000-01-01') === 'completed');

// === validateDownloadedFile ===
const S = shared.SETTINGS_DEFAULTS;
check('validate: epub+zip валиден',
    shared.validateDownloadedFile({ mime: 'application/epub+zip', fileSize: 10000 }, S).valid === true);
check('validate: zip валиден (html-история отдаётся zip)',
    shared.validateDownloadedFile({ mime: 'application/zip', fileSize: 10000 }, S).valid === true);
check('validate: text/html невалиден для epub',
    shared.validateDownloadedFile({ mime: 'text/html', fileSize: 10000 }, S).valid === false);
check('validate: text/html валиден при expectHtml',
    shared.validateDownloadedFile({ mime: 'text/html', fileSize: 10000 }, S, { expectHtml: true }).valid === true);
check('validate: маленький файл невалиден',
    shared.validateDownloadedFile({ mime: 'application/zip', fileSize: 100 }, S).valid === false);
check('validate: неизвестный mime невалиден (раньше всегда true из-за бага)',
    shared.validateDownloadedFile({ mime: 'application/x-msdownload', fileSize: 10000 }, S).valid === false);
check('validate: пустой mime валиден',
    shared.validateDownloadedFile({ mime: '', fileSize: 10000 }, S).valid === true);
check('validate: mime с charset валиден',
    shared.validateDownloadedFile({ mime: 'application/epub+zip; charset=binary', fileSize: 10000 }, S).valid === true);
check('validate: x-zip-compressed валиден (Windows Chrome, баг v1.3.2)',
    shared.validateDownloadedFile({ mime: 'application/x-zip-compressed', fileSize: 10000 }, S).valid === true);
check('validate: x-zip-compressed валиден при expectHtml (html-история = zip)',
    shared.validateDownloadedFile({ mime: 'application/x-zip-compressed', fileSize: 10000 }, S, { expectHtml: true }).valid === true);
check('validate: x-zip валиден',
    shared.validateDownloadedFile({ mime: 'application/x-zip', fileSize: 10000 }, S).valid === true);
check('validate: x-zip-compressed с charset валиден',
    shared.validateDownloadedFile({ mime: 'application/x-zip-compressed; charset=binary', fileSize: 10000 }, S).valid === true);

// === settings ===
const saved = await shared.saveSettings({ MAX_CONCURRENT_DOWNLOADS: 'мусор', API_REQUEST_DELAY_MS: -5, LOG_LEVEL: 77 });
check('settings: некорректные значения заменяются дефолтами',
    saved.MAX_CONCURRENT_DOWNLOADS === 3 && saved.API_REQUEST_DELAY_MS === 5000 && saved.LOG_LEVEL === 'info');
check('settings: кэш обновлён', shared.getCachedSettings().API_REQUEST_DELAY_MS === 5000);
const saved2 = await shared.saveSettings({ API_REQUEST_DELAY_MS: 1234 });
check('settings: корректное значение сохраняется', saved2.API_REQUEST_DELAY_MS === 1234);
await shared.saveSettings({ API_REQUEST_DELAY_MS: 5000 });

// === log queue ===
shared.log('info', 'test', 'сообщение 1');
shared.log('info', 'test', 'сообщение 2');
shared.log('debug', 'test', 'скрытое debug-сообщение (фильтр info)');
await new Promise(r => setTimeout(r, 700)); // ждём flush
await shared.flushLog();
const logArr = await shared.loadLog();
check('log: обе info-записи дошли (нет потерь от гонок)',
    logArr.filter(e => e.message === 'сообщение 1').length === 1
    && logArr.filter(e => e.message === 'сообщение 2').length === 1);
check('log: debug отфильтрован уровнем info',
    logArr.every(e => e.message !== 'скрытое debug-сообщение (фильтр info)'));

// === metrics cache ===
await shared.updateMetrics(m => { m.total_urls_processed++; return m; });
await shared.updateMetrics(m => { m.total_urls_processed++; return m; });
const m1 = await shared.loadMetrics();
check('metrics: кэш аккумулирует инкременты', m1.total_urls_processed === 2);
await shared.flushMetrics();
const m2 = await shared.loadMetrics();
check('metrics: flush пишет на диск', m2.total_urls_processed === 2);

// === fetch state: одиночный ключ ===
await shared.saveFetchState('https://a', { attempt: 3 });
check('fetchState: чтение того же URL', (await shared.loadFetchState('https://a')).attempt === 3);
check('fetchState: чужой URL → null', await shared.loadFetchState('https://b') === null);
await shared.saveFetchState('https://a', null);
check('fetchState: удаление', await shared.loadFetchState('https://a') === null);

// === t_monitor ===
const mon = new shared.t_monitor();
mon.arr_sl = ['u1', 'u2', 'u3'];
const json = mon.toJSON();
check('t_monitor.toJSON: без arr_sl (компактная запись)', !('arr_sl' in json) && json.arr_sl === undefined);
const restored = shared.t_monitor.fromJSON({ ...json, arr_sl: ['u1', 'u2', 'u3'] });
check('t_monitor.fromJSON: очередь восстановлена', restored.arr_sl.length === 3);
const legacy = shared.t_monitor.fromJSON({ arr_tab: [1, 2], is_paused: undefined });
check('t_monitor.fromJSON: legacy arr_tab удалён, is_paused=false',
    legacy.arr_tab === undefined && legacy.is_paused === false);

// === monitor state: раздельное хранение очереди ===
const mon2 = new shared.t_monitor();
mon2.arr_sl = ['x', 'y'];
mon2.fsd_status = 'work';
await shared.saveMonitorState(mon2);
await shared.saveQueueArr(mon2.arr_sl);
const loaded = await shared.loadMonitorState();
check('loadMonitorState: состояние + очередь из отдельных ключей',
    loaded.fsd_status === 'work' && loaded.arr_sl.length === 2);
check('loadMonitorState: fsd_state в storage не содержит arr_sl',
    !chrome.storage.local._raw('fsd_state').arr_sl);

// старый формат: очередь внутри fsd_state
await chrome.storage.local.remove('fsd_queue_arr');
await chrome.storage.local.set({ fsd_state: { fsd_status: 'work', arr_sl: ['legacy1'] } });
const loadedLegacy = await shared.loadMonitorState();
check('loadMonitorState: миграция старого формата (arr_sl внутри fsd_state)',
    loadedLegacy.arr_sl.length === 1 && loadedLegacy.arr_sl[0] === 'legacy1');

console.log(`\nЮнит-тесты: ${passed} ok, ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
