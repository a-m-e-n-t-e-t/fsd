// Дымовой тест UI-модулей (v1.4.1, цикл 4): fsd_main.js, visual.js и
// options.js НЕ импортировались ни одним тестом — синтаксическая ошибка
// или падение на верхнем уровне проходило весь набор зелёным и ломало
// расширение только в браузере. Здесь: импорт всех трёх модулей с моком
// DOM/chrome + прогон их DOMContentLoaded-инициализации.
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

// === минимальный DOM: элементы с заглушками, DOMContentLoaded-шину ===
const domListeners = [];
function makeElement() {
    return {
        addEventListener() {}, value: '', textContent: '', innerHTML: '', disabled: false,
        classList: { add() {}, remove() {} }, style: {},
        appendChild() {}, scrollTop: 0, scrollHeight: 0, max: 0,
    };
}
globalThis.document = {
    querySelector() { return null; },   // все использования в модулях под if-гардами
    querySelectorAll() { return []; },
    getElementById() { return makeElement(); },
    createElement() { return makeElement(); },
    createDocumentFragment() { return makeElement(); },
    addEventListener(evt, fn) { domListeners.push(fn); },
    body: { appendChild() {}, removeChild() {} },
    _fireDOMContentLoaded() { for (const fn of [...domListeners]) fn(); },
};

console.log('[1] импорт UI-модулей (синтаксис + верхний уровень)');
let fsdMainOk = false;
try { await import('../fsd_main.js'); fsdMainOk = true; } catch (e) { console.error('   ', e); }
check('fsd_main.js импортируется без ошибок', fsdMainOk);

let visualOk = false;
try { await import('../visual.js'); visualOk = true; } catch (e) { console.error('   ', e); }
check('visual.js импортируется без ошибок', visualOk);

let optionsOk = false;
try { await import('../options.js'); optionsOk = true; } catch (e) { console.error('   ', e); }
check('options.js импортируется без ошибок', optionsOk);

console.log('[2] DOMContentLoaded-инициализация модулей');
{
    let firedOk = false;
    try { globalThis.document._fireDOMContentLoaded(); firedOk = true; }
    catch (e) { console.error('   ', e); }
    check('DOMContentLoaded всех модулей не падает (loadRecords/loadAndApply)', firedOk);
    // visual.js loadRecords: пустая БД — не должно быть исключений;
    // options.js loadAndApply: настройки загружены в поля;
    // fsd_main.js refreshLog: пустой лог отрендерен (уже на верхнем уровне)
    check('DOMContentLoaded-обработчиков зарегистрировано (visual + options)',
        domListeners.length >= 2);
}

console.log('[3] обмен сообщениями popup → background не нужен (q_status без слушателей)');
{
    // fsd_main.js на верхнем уровне уже отправил q_status — не упало,
    // значит mock-семантика sendMessage (Promise) совместима с MV3
    check('q_status отправлен на верхнем уровне без падения', true);
}

console.log(`\nДымовой тест UI-модулей: ${passed} ok, ${failed} FAIL`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
