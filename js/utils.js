// js/utils.js

// 1. Аналог document.getElementById
const $ = (id) => document.getElementById(id);

// 2. Создание DOM-элемента с классами
function el(tag, className = '') {
    const elem = document.createElement(tag);
    if (className) elem.className = className;
    return elem;
}

// 3. Асинхронная пауза
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 4. Обновление статуса в шапке
function setStatus(msg) {
    const statusEl = $('status');
    if (statusEl) statusEl.textContent = msg;
    console.log('[Status]', msg);
}

// 5. Очистка текста от Markdown-разметки
function plain(text) {
    return text.replace(/\*\*/g, '').replace(/\*/g, '').trim();
}

// 6. Проверка наличия букв в строке
function hasLetters(str) {
    return /[a-zA-Zа-яА-ЯёЁ]/.test(str);
}

// 7. Экранирование спецсимволов для Markdown
function escapeMd(str) {
    return str.replace(/([*_`\\])/g, '\\$1');
}

// 8. Измерение ширины текста
const _measureCtx = document.createElement('canvas').getContext('2d');
function measure(text, size, bold, italic) {
    _measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px system-ui, Arial, sans-serif`;
    return _measureCtx.measureText(text).width;
}

// 9. Генерация ключа шрифта
function fontKey(bold, italic) {
    return (bold ? 'b' : '') + (italic ? 'i' : '') || 'normal';
}

// 10. Разбор текста на сегменты
function parseRuns(text, baseBold, baseItalic) {
    return [{ t: text, b: baseBold, i: baseItalic }];
}

// ==========================================
// ГЕОМЕТРИЧЕСКИЕ ФУНКЦИИ (ИСПРАВЛЕНИЕ ОШИБОК)
// ==========================================

// Перевод из PDF-координат в экранные (px)
function toPx(pg, rect, scale = state.viewScale) {
    const s = scale;
    const view = pg.view;
    return {
        left: (rect.x0 - view[0]) * s,
        top: (view[3] - rect.top) * s,
        width: (rect.x1 - rect.x0) * s,
        height: (rect.top - rect.bottom) * s
    };
}

// Перевод из экранных (px) в PDF-координаты
function toPdf(pg, rect, scale = state.viewScale) {
    const s = scale;
    const view = pg.view;
    return {
        x0: view[0] + rect.left / s,
        x1: view[0] + (rect.left + rect.width) / s,
        top: view[3] - rect.top / s,
        bottom: view[3] - (rect.top + rect.height) / s
    };
}

// Объединение двух PDF-прямоугольников
function union(a, b) {
    return {
        x0: Math.min(a.x0, b.x0),
        x1: Math.max(a.x1, b.x1),
        top: Math.max(a.top, b.top),
        bottom: Math.min(a.bottom, b.bottom)
    };
}

// Объединение двух экранных прямоугольников (для core.js)
function unionPx(a, b) {
    const right = Math.max(a.left + a.width, b.left + b.width);
    const bottom = Math.max(a.top + a.height, b.top + b.height);
    return {
        left: Math.min(a.left, b.left),
        top: Math.min(a.top, b.top),
        width: right - Math.min(a.left, b.left),
        height: bottom - Math.min(a.top, b.top)
    };
}

// Пересечение двух PDF-прямоугольников (clip)
function clipRect(r, clip) {
    return {
        x0: Math.max(r.x0, clip.x0),
        x1: Math.min(r.x1, clip.x1),
        top: Math.min(r.top, clip.top),
        bottom: Math.max(r.bottom, clip.bottom)
    };
}

// Внутренний отступ (inset) прямоугольника
function inset(r, dx, dy) {
    return { x0: r.x0 + dx, x1: r.x1 - dx, top: r.top - dy, bottom: r.bottom + dy };
}

// Пересекаются ли прямоугольники по оси X
function overlapX(a, b) {
    return a.x0 < b.x1 && a.x1 > b.x0;
}

// Пересекаются ли прямоугольники по оси Y
function overlapY(a, b) {
    return a.bottom < b.top && a.top > b.bottom;
}

// Находятся ли два экранных прямоугольника близко друг к другу (для core.js)
function nearPx(a, b, gap) {
    const aRight = a.left + a.width;
    const aBottom = a.top + a.height;
    const bRight = b.left + b.width;
    const bBottom = b.top + b.height;

    const distX = Math.max(0, Math.max(a.left, b.left) - Math.min(aRight, bRight));
    const distY = Math.max(0, Math.max(a.top, b.top) - Math.min(aBottom, bBottom));

    return distX <= gap && distY <= gap;
}

// Установка стилей прямоугольника для DOM-элемента
function setRect(elem, r) {
    elem.style.left = r.left + 'px';
    elem.style.top = r.top + 'px';
    elem.style.width = r.width + 'px';
    elem.style.height = r.height + 'px';
}

// Преобразование цвета [R, G, B] в CSS-строку
function rgbCss(c, fallback) {
    if (!c) c = fallback;
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// ==========================================
// ЗАГРУЗКА ШРИФТОВ (ИСПРАВЛЕН URL)
// ==========================================
async function loadFonts() {
    if (state.fonts && state.fonts['normal']) return;

    setStatus('Загрузка шрифтов...');
    try {
        // Используем стабильный Raw GitHub URL для шрифта с поддержкой кириллицы
        const fontUrl = 'https://raw.githubusercontent.com/googlefonts/roboto/main/src/hinted/Roboto-Regular.ttf';
        const res = await fetch(fontUrl);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();

        state.fonts = {
            'normal': { buf, name: 'Roboto-Regular' },
            'b': { buf, name: 'Roboto-Bold' },
            'i': { buf, name: 'Roboto-Italic' },
            'bi': { buf, name: 'Roboto-BoldItalic' }
        };
    } catch (e) {
        console.warn('Не удалось загрузить шрифт. Сохранение кириллицы может не работать.', e);
        const emptyBuf = new ArrayBuffer(0);
        state.fonts = {
            'normal': { buf: emptyBuf }, 'b': { buf: emptyBuf },
            'i': { buf: emptyBuf }, 'bi': { buf: emptyBuf }
        };
    }
}

// ==========================================
// НАСТРОЙКА PDF.JS WORKER (ИСПРАВЛЕНИЕ ПРЕДУПРЕЖДЕНИЯ)
// ==========================================
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ==========================================
// ЗАГЛУШКИ INDEXEDDB
// ==========================================
async function idbPrefix(store, prefix) { return []; }
async function idbPutMany(store, entries) { console.log('DB Save (mock):', store, entries.length); }
async function idbGetMany(store, keys) { return keys.map(() => null); }
async function idbDeletePrefix(store, prefix) { console.log('DB Delete (mock):', store, prefix); }

// ==========================================
// ГЛОБАЛЬНОЕ СОСТОЯНИЕ И КОНСТАНТЫ
// ==========================================
if (typeof state === 'undefined') {
    window.state = {
        pages: [], pdf: null, file: null, docKey: '', current: 1, viewScale: 1.4,
        byOrig: new Map(), byId: new Map(), active: null, tm: new Map(),
        fonts: {}, asc: 0.8, desc: 0.2, drawMode: false
    };
}

window.A_SCALE = 2.0;
window.MIN_FONT_RATIO = 0.6;
window.MIN_FONT_RATIO_TABLE = 0.7;
window.CAPTION_RE = /^(рис\.|figure|fig\.|таблица|table)/i;
window.ANALYSIS_VERSION = '1.0';