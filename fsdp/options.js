'use strict';
import { SETTINGS_DEFAULTS, loadSettings, saveSettings } from './fsd_shared.js';

// Карта для преобразования между settings (мс) и UI (мин/сек)
const UI_TRANSFORMS = {
    DOWNLOAD_TIMEOUT_MS: { uiField: 'DOWNLOAD_TIMEOUT_MS_MIN', toUI: v => v / 60000,    fromUI: v => v * 60000 },
    PROCESS_NEXT_DELAY_MS: { uiField: 'PROCESS_NEXT_DELAY_MS_SEC', toUI: v => v / 1000, fromUI: v => v * 1000 },
    API_REQUEST_DELAY_MS: { uiField: 'API_REQUEST_DELAY_MS_SEC',   toUI: v => v / 1000,  fromUI: v => v * 1000 },
    API_429_BASE_DELAY_MS: { uiField: 'API_429_BASE_DELAY_MS_SEC', toUI: v => v / 1000,  fromUI: v => v * 1000 },
    API_429_MAX_DELAY_MS: { uiField: 'API_429_MAX_DELAY_MS_SEC',   toUI: v => v / 1000,  fromUI: v => v * 1000 },
};

const BOOLEAN_KEYS = new Set(['AUTO_CHECK_ENABLED', 'VALIDATE_FILE_SIGNATURE']);

function showStatus(msg, kind) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status-line' + (kind ? ' ' + kind : '');
}

async function loadAndApply() {
    const settings = await loadSettings();
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
        const transform = UI_TRANSFORMS[key];
        const uiField = transform ? transform.uiField : key;
        const el = document.getElementById(uiField);
        if (!el) continue;
        const value = transform ? transform.toUI(settings[key]) : settings[key];
        if (BOOLEAN_KEYS.has(key)) {
            el.value = String(value);
        } else {
            el.value = value;
        }
    }
    showStatus('Текущие настройки загружены');
}

async function collectAndSave() {
    const newSettings = {};
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
        const transform = UI_TRANSFORMS[key];
        const uiField = transform ? transform.uiField : key;
        const el = document.getElementById(uiField);
        if (!el) continue;
        let val = el.value;
        if (BOOLEAN_KEYS.has(key)) {
            newSettings[key] = val === 'true';
        } else {
            const num = Number(val);
            if (isNaN(num)) {
                showStatus('Некорректное значение для ' + key, 'error');
                return;
            }
            newSettings[key] = transform ? transform.fromUI(num) : num;
        }
    }
    try {
        const saved = await saveSettings(newSettings);
        // Сообщаем background, что настройки изменились (для пересоздания alarms)
        try {
            await chrome.runtime.sendMessage({ type_mess: 'update_settings', settings: saved });
        } catch (e) {
            console.warn('sendMessage update_settings error:', e);
        }
        showStatus('Сохранено. Часть изменений вступит в силу со следующей обработкой.', 'ok');
    } catch (e) {
        showStatus('Ошибка сохранения: ' + e.message, 'error');
    }
}

async function resetToDefaults() {
    if (!confirm('Сбросить все настройки к значениям по умолчанию?')) return;
    try {
        const saved = await saveSettings(SETTINGS_DEFAULTS);
        try {
            await chrome.runtime.sendMessage({ type_mess: 'update_settings', settings: saved });
        } catch (e) {
            console.warn('sendMessage update_settings error:', e);
        }
        await loadAndApply();
        showStatus('Сброшено к дефолтам', 'ok');
    } catch (e) {
        showStatus('Ошибка сброса: ' + e.message, 'error');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadAndApply();
    document.getElementById('save').addEventListener('click', collectAndSave);
    document.getElementById('reset').addEventListener('click', resetToDefaults);
});
