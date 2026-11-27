// Тесты синхронизации UI с данными настроек (v1.4.1, цикл 3):
//   [1]–[2] options.html: min/max каждого числового input'а должны совпадать
//        с SETTINGS_LIMITS — UI раньше позволял значения, которые бэкенд
//        молча отсекал (7 расхождений, починены в цикле 2). Регрессия.
//   [3]   все ключи SETTINGS_DEFAULTS покрыты элементами UI.
//   [4]   visual.html: набор data-field полей = RECORD_FIELDS в visual.js
//        (v1.4.0 добавила s_att/t_att — рассинхрон = невидимые поля в UI).
'use strict';
import { readFileSync } from 'node:fs';
import { SETTINGS_LIMITS, SETTINGS_DEFAULTS } from '../fsd_shared.js';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log('  ok  ' + name); }
    else { failed++; console.error('  FAIL ' + name); }
}

const optionsHtml = readFileSync(new URL('../options.html', import.meta.url), 'utf-8');
const visualHtml = readFileSync(new URL('../visual.html', import.meta.url), 'utf-8');
const visualJs = readFileSync(new URL('../visual.js', import.meta.url), 'utf-8');

// id input'а → { ключ настройки, делитель перевода в UI-единицы }
const NUMERIC_UI = {
    MAX_CONCURRENT_DOWNLOADS: { key: 'MAX_CONCURRENT_DOWNLOADS', div: 1 },
    DOWNLOAD_TIMEOUT_MS_MIN: { key: 'DOWNLOAD_TIMEOUT_MS', div: 60000 },
    PROCESS_NEXT_DELAY_MS_SEC: { key: 'PROCESS_NEXT_DELAY_MS', div: 1000 },
    API_REQUEST_DELAY_MS_SEC: { key: 'API_REQUEST_DELAY_MS', div: 1000 },
    API_429_BASE_DELAY_MS_SEC: { key: 'API_429_BASE_DELAY_MS', div: 1000 },
    API_429_MAX_DELAY_MS_SEC: { key: 'API_429_MAX_DELAY_MS', div: 1000 },
    AUTO_CHECK_INTERVAL_HOURS: { key: 'AUTO_CHECK_INTERVAL_HOURS', div: 1 },
    MIN_FILE_SIZE_BYTES: { key: 'MIN_FILE_SIZE_BYTES', div: 1 },
    MAX_LOG_ENTRIES: { key: 'MAX_LOG_ENTRIES', div: 1 },
    KEEPALIVE_PERIOD_MIN: { key: 'KEEPALIVE_PERIOD_MIN', div: 1 },
};
const NON_NUMERIC_UI = ['AUTO_CHECK_ENABLED', 'VALIDATE_FILE_SIGNATURE', 'LOG_LEVEL'];

function inputTag(id) {
    const m = optionsHtml.match(new RegExp('<input[^>]*\\bid="' + id + '"[^>]*>'));
    return m ? m[0] : null;
}
function attr(tag, name) {
    const m = tag.match(new RegExp('\\b' + name + '="([^"]+)"'));
    return m ? m[1] : null;
}

console.log('[1] числовые диапазоны UI совпадают с SETTINGS_LIMITS');
for (const [id, { key, div }] of Object.entries(NUMERIC_UI)) {
    const tag = inputTag(id);
    check(id + ': input присутствует', !!tag);
    if (!tag) continue;
    const limits = SETTINGS_LIMITS[key];
    const uiMin = Number(attr(tag, 'min'));
    const uiMax = Number(attr(tag, 'max'));
    check(id + ': min=' + uiMin + ' = лимиту ' + (limits.min / div), uiMin === limits.min / div);
    check(id + ': max=' + uiMax + ' = лимиту ' + (limits.max / div), uiMax === limits.max / div);
    const defUi = SETTINGS_DEFAULTS[key] / div;
    check(id + ': дефолт (' + defUi + ') внутри диапазона UI',
        defUi >= uiMin && defUi <= uiMax);
}

console.log('[2] boolean/select ключи представлены в UI');
for (const key of NON_NUMERIC_UI) {
    check(key + ': элемент присутствует', new RegExp('\\bid="' + key + '"').test(optionsHtml));
}

console.log('[3] каждый ключ настроек покрыт UI');
{
    const covered = new Set([
        ...Object.values(NUMERIC_UI).map(v => v.key),
        ...NON_NUMERIC_UI,
    ]);
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
        check('настройка ' + key + ' имеет элемент UI', covered.has(key));
    }
    check('нет лишних элементов UI сверх настроек (числовые)',
        Object.keys(NUMERIC_UI).length + NON_NUMERIC_UI.length === Object.keys(SETTINGS_DEFAULTS).length);
}

console.log('[4] visual: поля записи в HTML = RECORD_FIELDS в JS');
{
    const htmlFields = [...visualHtml.matchAll(/data-field="([^"]+)"/g)].map(m => m[1]);
    const arrMatch = visualJs.match(/const RECORD_FIELDS = \[([^\]]+)\]/);
    check('visual.js: RECORD_FIELDS найден', !!arrMatch);
    const jsFields = arrMatch
        ? arrMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        : [];
    check('visual: наборы полей идентичны (' + htmlFields.length + ' шт.)',
        htmlFields.length === jsFields.length &&
        htmlFields.every((f, i) => f === jsFields[i]));
    check('visual: поля v1.4.0 (s_att, t_att) отображаются',
        htmlFields.includes('s_att') && htmlFields.includes('t_att'));
}

console.log(`\nUI-синхронизация: ${passed} ok, ${failed} FAIL`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
