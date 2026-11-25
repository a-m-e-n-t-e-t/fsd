// Мок chrome.* API для интеграционного тестирования service worker в Node
'use strict';

export class StorageArea {
    constructor(onChangedHub) {
        this._d = new Map();
        this._hub = onChangedHub;
    }
    async get(keys) {
        if (keys === null || keys === undefined) {
            return structuredClone(Object.fromEntries(this._d));
        }
        let keyArr;
        let defaults = null;
        if (typeof keys === 'string') keyArr = [keys];
        else if (Array.isArray(keys)) keyArr = keys;
        else { defaults = keys; keyArr = Object.keys(keys); }
        const out = {};
        for (const k of keyArr) {
            if (this._d.has(k)) out[k] = structuredClone(this._d.get(k));
            else if (defaults && defaults[k] !== undefined) out[k] = structuredClone(defaults[k]);
        }
        return out;
    }
    async set(items) {
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
            changes[k] = {
                oldValue: this._d.has(k) ? structuredClone(this._d.get(k)) : undefined,
                newValue: structuredClone(v),
            };
            this._d.set(k, structuredClone(v));
        }
        this._hub.fire(changes);
    }
    async remove(keys) {
        const arr = typeof keys === 'string' ? [keys] : keys;
        const changes = {};
        for (const k of arr) {
            changes[k] = { oldValue: this._d.has(k) ? structuredClone(this._d.get(k)) : undefined, newValue: undefined };
            this._d.delete(k);
        }
        this._hub.fire(changes);
    }
    async clear() { this._d.clear(); this._hub.fire({}); }
    _seed(k, v) { this._d.set(k, structuredClone(v)); } // посев без событий
    _raw(k) { return this._d.get(k); }
}

export class ChromeMock {
    constructor() {
        const storageListeners = [];
        this.storage = {
            onChanged: {
                addListener: (fn) => storageListeners.push(fn),
                removeListener: (fn) => { const i = storageListeners.indexOf(fn); if (i >= 0) storageListeners.splice(i, 1); },
                fire: (changes) => { for (const fn of [...storageListeners]) { try { fn(changes, 'local'); } catch (e) { console.error('storage.onChanged listener error:', e); } } },
            },
        };
        this.storage.local = new StorageArea(this.storage.onChanged);

        const alarmListeners = [];
        this.alarms = {
            _map: new Map(),
            async create(name, info) { this._map.set(name, { name, ...info }); },
            async clear(name) { return this._map.delete(name); },
            async getAll() { return [...this._map.values()]; },
            onAlarm: {
                addListener: (fn) => alarmListeners.push(fn),
                removeListener: (fn) => { const i = alarmListeners.indexOf(fn); if (i >= 0) alarmListeners.splice(i, 1); },
            },
            async fire(name) { for (const fn of [...alarmListeners]) { try { await fn({ name }); } catch (e) { console.error('onAlarm listener error:', e); } } },
        };

        const dlListeners = [];
        this.downloads = {
            _items: new Map(),
            _nextId: 0,
            _downloadCalls: [],
            // v1.3.4: множество стёртых из истории id (search их больше не видит,
            // но объекты остаются в _items — тесты могут проверить removeFile)
            _erased: new Set(),
            // v1.3.3-тест: одноразовый MIME следующей завершённой загрузки
            // (по умолчанию 'application/zip' — как сервер fichub; тесты
            // Windows-сценария подменяют на 'application/x-zip-compressed')
            _nextMime: null,
            download(options, callback) {
                const id = ++this._nextId;
                const item = {
                    id, url: options.url, state: 'in_progress',
                    filename: '', mime: '', fileSize: 0, bytesReceived: 0,
                    startTime: new Date(),
                    _noAutoComplete: false,
                };
                this._items.set(id, item);
                this._downloadCalls.push({ id, url: options.url });
                // авто-завершение загрузки через 80 мс (тест может успеть прервать)
                setTimeout(() => {
                    if (item.state !== 'in_progress' || item._noAutoComplete) return;
                    item.state = 'complete';
                    const base = options.url.split('/').pop() || 'file';
                    item.filename = '/home/user/Downloads/' + base + '.zip';
                    item.mime = this._nextMime || 'application/zip';
                    this._nextMime = null; // одноразовый: следующая загрузка — снова дефолт
                    item.fileSize = 10252;
                    item.bytesReceived = 10252;
                    this._fireChanged({ id, state: { current: 'complete' } });
                }, 80);
                queueMicrotask(() => callback(id));
            },
            async search(q) {
                let arr = [...this._items.values()].filter(i => !this._erased.has(i.id));
                if (q) {
                    if (q.id !== undefined) arr = arr.filter(i => i.id === q.id);
                    if (q.state) arr = arr.filter(i => i.state === q.state);
                    if (q.url) arr = arr.filter(i => i.url === q.url);
                }
                return structuredClone(arr);
            },
            async removeFile(id) { const it = this._items.get(id); if (it) it.removed = true; },
            async cancel(id) { const it = this._items.get(id); if (it && it.state === 'in_progress') it.state = 'canceled'; },
            // v1.3.4: как в Chrome — удаляет записи из истории (из search),
            // объект в _items помечается и остаётся для проверок тестов
            async erase(q) {
                const erased = [];
                for (const it of this._items.values()) {
                    if (this._erased.has(it.id)) continue;
                    if (q.id !== undefined && it.id !== q.id) continue;
                    if (q.url && it.url !== q.url) continue;
                    if (q.state && it.state !== q.state) continue;
                    this._erased.add(it.id);
                    erased.push(it.id);
                }
                return erased;
            },
            async open() {},
            onChanged: {
                addListener: (fn) => dlListeners.push(fn),
                removeListener: (fn) => { const i = dlListeners.indexOf(fn); if (i >= 0) dlListeners.splice(i, 1); },
            },
            _fireChanged(delta) { for (const fn of [...dlListeners]) { try { fn(delta); } catch (e) { console.error('downloads.onChanged listener error:', e); } } },
        };

        const msgListeners = [];
        this.runtime = {
            lastError: undefined,
            onMessage: {
                addListener: (fn) => msgListeners.push(fn),
                removeListener: (fn) => { const i = msgListeners.indexOf(fn); if (i >= 0) msgListeners.splice(i, 1); },
            },
            async sendMessage(msg) {
                // Эмуляция семантики Chrome: сообщения, отправленные из того же
                // контекста (service worker), не доставляются его собственному
                // onMessage-листенеру.
                const stack = new Error().stack || '';
                if (stack.includes('fsd_background.js')) {
                    (this._fromBg ||= []).push(msg);
                    return undefined;
                }
                let response;
                let responded = false;
                const sendResponse = (v) => { responded = true; response = v; };
                for (const fn of [...msgListeners]) {
                    fn(msg, {}, sendResponse);
                }
                return responded ? response : undefined;
            },
            getURL: (p) => 'chrome-extension://test/' + p,
            openOptionsPage: async () => {},
            onStartup: { addListener() {} },
            onInstalled: { addListener() {} },
        };

        this.tabs = {
            _nextId: 0,
            _created: [],
            _sent: [],
            async create(opts, cb) {
                const tab = { id: ++this._nextId, ...opts };
                this._created.push(tab);
                if (cb) queueMicrotask(() => cb(tab));
                return tab;
            },
            async sendMessage(id, msg) { this._sent.push({ id, msg }); },
            onUpdated: { addListener() {}, removeListener() {} },
        };
    }
}
