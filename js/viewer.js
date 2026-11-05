let observer = null;

function showTab(name) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    ['text', 'images', 'tables'].forEach((t) => ($(t + 'Pane').hidden = t !== name));
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));

// ---------- виртуальный просмотр: рисуем только видимые страницы ----------
function buildViewer(pageN) {
    state.pages.forEach(unmountPage);
    const v = $('viewer');
    v.innerHTML = '';
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((ents) => {
        for (const e of ents) {
            const pg = state.pages[+e.target.dataset.n - 1];
            if (e.isIntersecting) mountPage(pg); else unmountPage(pg);
        }
    }, { root: v, rootMargin: '1500px 0px' });
    const s = state.viewScale;
    for (const pg of state.pages) {
        const p = el('div', 'page');
        p.dataset.n = pg.n;
        p.style.width = (pg.view[2] - pg.view[0]) * s + 'px';
        p.style.height = (pg.view[3] - pg.view[1]) * s + 'px';
        const num = el('div', 'page-num'); num.textContent = pg.n; p.appendChild(num);
        p.addEventListener('mousedown', (e) => startManualDraw(e, pg));
        v.appendChild(p);
        pg.el = p; pg.mounted = null;
        observer.observe(p);
    }
    if (pageN) gotoPage(pageN);
}

async function mountPage(pg) {
    if (pg.mounted) return;
    const m = (pg.mounted = { cancelled: false, task: null, rendered: false });
    const layer = el('div', 'layer');
    pg.el.appendChild(layer);
    m.layer = layer;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = el('canvas');
    canvas.width = Math.floor(parseFloat(pg.el.style.width) * dpr);
    canvas.height = Math.floor(parseFloat(pg.el.style.height) * dpr);
    layer.appendChild(canvas);
    m.canvas = canvas; m.dpr = dpr;
    try {
        const page = await state.pdf.getPage(pg.n);
        if (m.cancelled) return;
        m.task = page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: state.viewScale * dpr, rotation: 0 }) });
        await m.task.promise;
    } catch (e) { if (m.cancelled) return; console.warn(e); }
    if (m.cancelled) return;
    m.rendered = true;
    fitPage(pg);
    pg.tables.forEach((t) => createTableDom(t, pg));
    pg.images.forEach((o) => createImgDom(o, pg));
    pg.blocks.forEach((b) => createTextDom(b, pg));
    renderPageOverlays(pg, true);
    if (state.current === pg.n) renderImageList(pg);
}

function unmountPage(pg) {
    const m = pg.mounted;
    if (!m) return;
    m.cancelled = true;
    try { m.task && m.task.cancel(); } catch (e) { /* ignore */ }
    m.layer.remove();
    pg.mounted = null;
    pg.blocks.forEach((b) => { b.hl = b.ov = null; });
    pg.images.forEach((o) => { o.hl = o.ov = null; });
    pg.tables.forEach((t) => { t.el = null; });
}

function renderPageOverlays(pg, skipFit) {
    if (!skipFit) fitPage(pg);
    pg.tables.forEach((t) => renderTableOverlay(t, pg));
    pg.blocks.forEach((b) => { renderTextOverlay(b); updateItem(b); });
}

// ---------- навигация ----------
let scrollRaf = 0;
$('viewer').addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrent(); });
});
function updateCurrent() {
    if (!state.pages.length) return;
    const v = $('viewer'), y = v.scrollTop + v.clientHeight * 0.3;
    let lo = 0, hi = state.pages.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (state.pages[mid].el.offsetTop <= y) lo = mid; else hi = mid - 1; }
    if (lo + 1 !== state.current) { state.current = lo + 1; $('pageInput').value = state.current; renderSidebar(); }
}
function gotoPage(n) {
    n = Math.max(1, Math.min(state.pages.length, n | 0));
    const pg = state.pages[n - 1];
    if (!pg) return;
    $('viewer').scrollTop = pg.el.offsetTop - 10;
    state.current = n;
    $('pageInput').value = n;
    renderSidebar();
}

// ---------- текст на странице ----------
function createTextDom(b, pg) {
    const ov = el('div', 'ov-text'); ov.style.display = 'none';
    const hl = el('div', 'hl text' + (b.tableId != null ? ' cell' : ''));
    pg.mounted.layer.append(ov, hl);
    b.ov = ov; b.hl = hl;
    hl.addEventListener('mousedown', (e) => onHlMouseDown(e, b));
    hl.addEventListener('click', () => focusItem(b));
    if (state.active === b) { hl.classList.add('active'); addHandles(b); }
}

function renderTextOverlay(b) {
    if (!b.hl) return;
    const pg = state.pages[b.n - 1], s = state.viewScale;
    const cover = toPx(pg, coverOf(b));
    setRect(b.hl, toPx(pg, union(b.origRect, b.box)));
    const L = b.layout;
    if (!L) { b.ov.style.display = 'none'; return; }

    setRect(b.ov, cover);
    b.ov.style.display = 'block';

    // ИСПРАВЛЕНИЕ: Для ячеек таблицы делаем подложку гарантированно непрозрачной
    if (b.tableId != null) {
        if (b.bg) {
            // Если цвет фона определен, используем его с 98% непрозрачности для перекрытия оригинала
            b.ov.style.background = `rgba(${b.bg[0]}, ${b.bg[1]}, ${b.bg[2]}, 0.98)`;
        } else {
            // Если фон не определен, чистый белый
            b.ov.style.background = '#ffffff';
        }
        b.ov.style.zIndex = '15'; // Четко выше линий таблицы
    } else {
        // Для обычного текста оставляем как было
        b.ov.style.background = rgbCss(b.bg, [255, 255, 255]);
    }

    b.ov.innerHTML = '';
    const r = toPx(pg, b.box), W = b.box.x1 - b.box.x0, color = rgbCss(b.color, [0, 0, 0]);
    const offY = b.valign === 'middle' ? Math.max(0, (b.box.top - b.box.bottom - L.height) / 2) : 0;

    L.lines.forEach((ln, i) => {
        const dx = b.align === 'center' ? (W - ln.width) / 2 : b.align === 'right' ? W - ln.width : 0;
        for (const it of ln.items) {
            const sp = el('span', 'ov-run');
            sp.textContent = it.t;
            Object.assign(sp.style, {
                left: r.left - cover.left + (dx + it.x) * s + 'px',
                top: r.top - cover.top + (offY + i * L.lh) * s + 'px',
                fontSize: L.size * s + 'px',
                lineHeight: L.lh * s + 'px',
                fontWeight: it.b ? '700' : '400',
                fontStyle: it.i ? 'italic' : 'normal',
                color,
            });
            b.ov.appendChild(sp);
        }
    });
}

function refreshBlock(b) {
    const pg = state.pages[b.n - 1];
    if (b.tableId != null) {
        const t = pg.tables.find((x) => x.id === b.tableId);
        fitTable(t, pg);
        renderTableOverlay(t, pg);
        pg.blocks.filter((x) => x.tableId === t.id).forEach((x) => { renderTextOverlay(x); updateItem(x); });
    } else { fitBlock(b, pg); renderTextOverlay(b); updateItem(b); }
}

// ---------- таблицы на странице ----------
function createTableDom(t, pg) {
    const e = el('div', 'ov-table'); e.style.display = 'none';
    pg.mounted.layer.appendChild(e);
    t.el = e;
}
function renderTableOverlay(t, pg) {
    if (!t.el) return;
    if (!t.redraw) { t.el.style.display = 'none'; return; }

    const s = state.viewScale, R = toPx(pg, inset(t.bbox, -2));
    setRect(t.el, R);
    t.el.style.display = 'block';

    // ИСПРАВЛЕНИЕ: Добавляем сплошной фон под всю таблицу, если она перерисовывается
    // Это действует как "ластик" для оригинального содержимого таблицы перед отрисовкой линий
    t.el.style.backgroundColor = t.bg ? `rgb(${t.bg[0]}, ${t.bg[1]}, ${t.bg[2]})` : '#ffffff';

    const X = (x) => (x - pg.view[0]) * s - R.left, Y = (y) => (pg.view[3] - y) * s - R.top;
    const lines = [...t.h.map((h) => [h.x0, h.y, h.x1, h.y]), ...t.v.map((v) => [v.x, v.y0, v.x, v.y1])];

    // Добавляем z-index:10 для SVG, чтобы линии были поверх фона таблицы, но под текстом (z-index:15)
    t.el.innerHTML = `<svg width="${R.width}" height="${R.height}" style="position:absolute; top:0; left:0; z-index:10;">` +
        lines.map(([x1, y1, x2, y2]) =>
            `<line x1="${X(x1)}" y1="${Y(y1)}" x2="${X(x2)}" y2="${Y(y2)}" stroke="#000" stroke-width="${0.75 * s}"/>`).join('') +
        '</svg>';
}
function flashRect(pg, rect) {
    if (!pg.mounted) return;
    const f = el('div', 'flash');
    setRect(f, toPx(pg, rect));
    pg.mounted.layer.appendChild(f);
    setTimeout(() => f.remove(), 1600);
}

// ---------- картинки на странице ----------
function initImage(o, pg) {
    Object.assign(o, { type: 'img', n: pg.n, newBlob: o.newBlob || null, newSrc: o.newSrc || null });
}
function createImgDom(o, pg) {
    const im = el('img', 'ov-img'); im.style.display = 'none';
    const hl = el('div', 'hl img' + (o.wholePage ? ' whole' : ''));
    pg.mounted.layer.append(im, hl);
    o.ov = im; o.hl = hl;
    placeImage(o);
    if (o.newSrc) { im.src = o.newSrc; im.style.display = 'block'; }
    hl.addEventListener('mousedown', (e) => onHlMouseDown(e, o));
    hl.addEventListener('click', () => focusItem(o));
    if (state.active === o) { hl.classList.add('active'); addHandles(o); }
}
function placeImage(o) {
    if (!o.hl) return;
    const r = toPx(state.pages[o.n - 1], o);
    setRect(o.hl, r); setRect(o.ov, r);
}
function makeThumb(pg, o) {
    const m = pg.mounted;
    if (!m || !m.rendered) return '';
    const r = toPx(pg, o), d = m.dpr;
    const c = el('canvas'), k = Math.min(1, 200 / Math.max(1, r.width));
    c.width = Math.max(1, r.width * k); c.height = Math.max(1, r.height * k);
    c.getContext('2d').drawImage(m.canvas, r.left * d, r.top * d, r.width * d, r.height * d, 0, 0, c.width, c.height);
    return c.toDataURL();
}
function removeImage(pg, o) {
    o.hl && o.hl.remove(); o.ov && o.ov.remove();
    pg.images = pg.images.filter((x) => x !== o);
    if (state.active === o) state.active = null;
}
function saveImg(o, deleted) {
    const key = state.docKey + '|' + o.id;
    const v = deleted
        ? (o.manual ? undefined : { deleted: true, id: o.id, n: o.n })
        : { n: o.n, id: o.id, x0: o.x0, x1: o.x1, top: o.top, bottom: o.bottom, kind: o.kind, manual: !!o.manual, wholePage: !!o.wholePage, blob: o.newBlob || null };
    idbPutMany('imgs', [[key, v]]).catch(console.error);
}

// ---------- ручное выделение ----------
function setDrawMode(on) {
    state.drawMode = on;
    $('viewer').classList.toggle('drawing', on);
    $('drawBtn').classList.toggle('on', on);
    $('drawBtn').textContent = on ? 'Обведите область...' : '✚ Выделить вручную';
}
$('drawBtn').onclick = () => setDrawMode(!state.drawMode);

function startManualDraw(e, pg) {
    if (!state.drawMode || !pg.mounted) return;
    e.preventDefault();
    const base = pg.el.getBoundingClientRect(), sx = e.clientX - base.left, sy = e.clientY - base.top;
    const box = el('div', 'draw-box');
    pg.el.appendChild(box);
    let r = null;
    const move = (ev) => {
        const x = ev.clientX - base.left, y = ev.clientY - base.top;
        r = { left: Math.min(sx, x), top: Math.min(sy, y), width: Math.abs(x - sx), height: Math.abs(y - sy) };
        setRect(box, r);
    };
    const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        box.remove(); setDrawMode(false);
        if (r && r.width > 10 && r.height > 10) {
            const o = { id: `p${pg.n}m${Date.now()}`, ...toPdf(pg, r), kind: 'Выделено вручную', manual: true };
            initImage(o, pg);
            pg.images.push(o);
            if (pg.mounted) createImgDom(o, pg);
            saveImg(o);
            renderImageList(pg);
            focusItem(o);
        }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
}

// ---------- рамки и маркеры ----------
const getRectPdf = (o) => (o.type === 'text' ? union(o.origRect, o.box) : { x0: o.x0, x1: o.x1, top: o.top, bottom: o.bottom });
function applyRect(o, r) {
    if (o.type === 'text') { o.box = r; o.manualBox = true; refreshBlock(o); saveEdit(o); }
    else {
        Object.assign(o, r);
        placeImage(o);
        if (!o.newSrc && o.thumbEl) o.thumbEl.src = makeThumb(state.pages[o.n - 1], o);
        saveImg(o);
    }
}
function addHandles(o) {
    document.querySelectorAll('.handle').forEach((h) => h.remove());
    if (o.wholePage || !o.hl) return;
    for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        const h = el('div', 'handle h-' + d);
        h.addEventListener('mousedown', (e) => startDrag(e, o, d));
        o.hl.appendChild(h);
    }
}
function onHlMouseDown(e, o) { if (state.active === o && e.target === o.hl && !o.wholePage) startDrag(e, o, 'move'); }
function startDrag(e, o, mode) {
    e.preventDefault(); e.stopPropagation();
    const pg = state.pages[o.n - 1], start = toPx(pg, getRectPdf(o)), sx = e.clientX, sy = e.clientY;
    let cur = null;
    const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        let { left, top, width, height } = start;
        if (mode === 'move') { left += dx; top += dy; }
        else {
            if (mode.includes('w')) { left += dx; width -= dx; }
            if (mode.includes('e')) width += dx;
            if (mode.includes('n')) { top += dy; height -= dy; }
            if (mode.includes('s')) height += dy;
        }
        if (width < 8 || height < 8) return;
        cur = { left, top, width, height };
        setRect(o.hl, cur);
    };
    const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (cur) applyRect(o, toPdf(pg, cur));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
}

function focusItem(o, fromSidebar) {
    if (o.n !== state.current) gotoPage(o.n);
    if (state.active && state.active !== o) {
        state.active.hl && state.active.hl.classList.remove('active');
        state.active.item && state.active.item.classList.remove('active');
    }
    document.querySelectorAll('.handle').forEach((h) => h.remove());
    state.active = o;
    o.item && o.item.classList.add('active');
    if (o.hl) { o.hl.classList.add('active'); addHandles(o); }
    showTab(o.type === 'img' ? 'images' : 'text');
    if (fromSidebar) o.hl && o.hl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else if (o.item) { o.item.scrollIntoView({ block: 'center', behavior: 'smooth' }); o.ta && o.ta.focus({ preventScroll: true }); }
}

// ---------- сохранение правок блоков ----------
const pendingEdits = new Map();
let editTimer = null;
function editOf(b) {
    const e = {};
    if (b.manualText) { e.text = b.text; e.manualText = true; }
    if (b.fontSize) e.fontSize = b.fontSize;
    if (b.manualBox) { e.manualBox = true; e.box = b.box; }
    if (b.bold !== b.bold0) e.bold = b.bold;
    if (b.italic !== b.italic0) e.italic = b.italic;
    if (b.align !== b.align0) e.align = b.align;
    return Object.keys(e).length ? e : undefined;
}
function queueEdit(key, value) {
    pendingEdits.set(key, value);
    clearTimeout(editTimer);
    editTimer = setTimeout(flushEdits, 700);
}
function flushEdits() {
    const entries = [...pendingEdits.entries()];
    pendingEdits.clear();
    idbPutMany('edits', entries).catch(console.error);
}
const saveEdit = (b) => queueEdit(state.docKey + '|' + b.id, editOf(b));
const saveTable = (t, pg) => queueEdit(`${state.docKey}|tbl:${pg.n}:${t.id}`, { redraw: !!t.redraw, uniform: t.uniform !== false });

function revertBlock(b) {
    resetBlockRuntime(b);
    b.manualText = true; // чтобы перевод не перезаписал
    if (b.fontInput) b.fontInput.value = '';
    if (b.alignSel) b.alignSel.value = b.align;
    refreshBlock(b); saveEdit(b);
}

// ---------- Sidebar (только текущая страница) ----------
let sidebarPage = null;
const rowsFor = (t) => Math.max(2, Math.ceil(t.length / 50));

function renderSidebar() {
    const pg = state.pages[state.current - 1];
    if (!pg) return;
    if (sidebarPage && sidebarPage !== pg) sidebarPage.blocks.forEach((b) => { b.item = b.ta = null; });
    sidebarPage = pg;
    renderTextList(pg); renderImageList(pg); renderTableList(pg);
}

function renderTextList(pg) {
    const list = $('textList');
    list.innerHTML = '';
    $('textCount').textContent = `(${pg.blocks.length})`;
    for (const b of pg.blocks) {
        const item = el('div', 'item');
        const ta = el('textarea');
        ta.value = b.text; ta.rows = rowsFor(b.text);
        ta.oninput = () => { b.text = ta.value; b.manualText = true; refreshBlock(b); saveEdit(b); };
        ta.onfocus = () => { if (state.active !== b) focusItem(b, true); };

        const tools = el('div', 'tools');
        const btn = (label, title, fn, cls) => { const x = el('button', cls); x.textContent = label; x.title = title; x.onclick = fn; tools.appendChild(x); return x; };
        btn('🌐', 'Перевести блок', () => translateOne(b));
        btn('↺', 'Вернуть оригинал', () => revertBlock(b));
        const bB = btn('B', 'Жирный (базовый стиль блока)', () => { b.bold = !b.bold; refreshBlock(b); saveEdit(b); }, 'st b');
        const bI = btn('I', 'Курсив (базовый стиль блока)', () => { b.italic = !b.italic; refreshBlock(b); saveEdit(b); }, 'st i');
        const al = el('select');
        [['left', 'Влево'], ['center', 'Центр'], ['right', 'Вправо']].forEach(([v, t]) => { const o = el('option'); o.value = v; o.textContent = t; al.appendChild(o); });
        al.value = b.align;
        al.onchange = () => { b.align = al.value; refreshBlock(b); saveEdit(b); };
        tools.appendChild(al);
        const fi = el('input');
        fi.type = 'number'; fi.step = '0.25'; fi.min = '3'; fi.placeholder = 'авто'; fi.title = 'Размер шрифта, pt';
        fi.value = b.fontSize || '';
        fi.onchange = () => { b.fontSize = parseFloat(fi.value) || null; refreshBlock(b); saveEdit(b); };
        tools.appendChild(fi);
        btn('⤢', 'Сбросить область', () => { b.manualBox = false; b.box = { ...b.origBox }; refreshBlock(b); saveEdit(b); });
        const meta = el('span', 'meta'); tools.appendChild(meta);
        if (b.tableId != null) { const t = el('span', 'tag'); t.textContent = 'таблица ' + (b.tableId + 1); tools.appendChild(t); }
        if (b.inFigure) { const t = el('span', 'tag'); t.textContent = 'на рисунке'; tools.appendChild(t); }
        const warn = el('span', 'warn'), err = el('span', 'err');
        item.append(ta, tools, warn, err);
        list.appendChild(item);
        Object.assign(b, { item, ta, err, warnEl: warn, metaEl: meta, bBtn: bB, iBtn: bI, fontInput: fi, alignSel: al });
        if (state.active === b) item.classList.add('active');
        updateItem(b);
    }
}

function updateItem(b) {
    if (!b.item) return;
    b.item.classList.toggle('changed', isDirty(b));
    b.warnEl.textContent = b.warn || '';
    const s = b.layout ? b.layout.size : b.size;
    b.metaEl.textContent = `${s.toFixed(1)}pt · ${Math.round((s / b.size) * 100)}%`;
    b.bBtn.classList.toggle('on', b.bold);
    b.iBtn.classList.toggle('on', b.italic);
    if (document.activeElement !== b.ta && b.ta.value !== b.text) { b.ta.value = b.text; b.ta.rows = rowsFor(b.text); }
}

function renderImageList(pg) {
    const list = $('imgList');
    list.innerHTML = '';
    $('imgCount').textContent = `(${pg.images.filter((i) => !i.wholePage).length})`;
    for (const im of pg.images) {
        const item = el('div', 'item' + (im.newBlob ? ' changed' : ''));
        item.innerHTML = `<small>${im.kind} · ${Math.round(im.x1 - im.x0)}×${Math.round(im.top - im.bottom)} pt</small>`;
        const row = el('div', 'row');
        const th = el('img', 'thumb');
        th.src = im.newSrc || makeThumb(pg, im) || 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
        const inp = el('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.hidden = true;
        const btn = el('button'); btn.textContent = 'Заменить...';
        btn.onclick = (e) => { e.stopPropagation(); focusItem(im, true); inp.click(); };
        const reset = el('button'); reset.textContent = 'Сброс';
        reset.onclick = (e) => {
            e.stopPropagation();
            im.newBlob = im.newSrc = null; inp.value = '';
            th.src = makeThumb(pg, im);
            if (im.ov) im.ov.style.display = 'none';
            item.classList.remove('changed'); saveImg(im);
        };
        inp.onchange = () => {
            const f = inp.files[0];
            if (!f) return;
            im.newBlob = f; im.newSrc = URL.createObjectURL(f); th.src = im.newSrc;
            if (im.ov) { im.ov.src = im.newSrc; im.ov.style.display = 'block'; }
            item.classList.add('changed'); saveImg(im);
        };
        row.append(th, btn, reset, inp);
        if (!im.wholePage) {
            const del = el('button'); del.textContent = '✕'; del.title = 'Это не картинка';
            del.onclick = (e) => { e.stopPropagation(); saveImg(im, true); removeImage(pg, im); renderImageList(pg); };
            row.appendChild(del);
        }
        item.appendChild(row);
        item.onclick = () => focusItem(im, true);
        list.appendChild(item);
        im.item = item; im.thumbEl = th;
        if (state.active === im) item.classList.add('active');
    }
}

function renderTableList(pg) {
    const list = $('tblList');
    list.innerHTML = '';
    $('tblCount').textContent = `(${pg.tables.length})`;
    if (!pg.tables.length) { list.innerHTML = '<div class="hint">На этой странице таблиц не найдено</div>'; return; }
    for (const t of pg.tables) {
        const item = el('div', 'item');
        const cnt = pg.blocks.filter((b) => b.tableId === t.id).length;
        item.innerHTML = `<small>Таблица ${t.id + 1} · сетка ${t.rows}×${t.cols} · ячеек ${t.cells.length} · текстовых блоков ${cnt}</small>`;
        const mk = (label, val, fn) => {
            const l = el('label'), cb = el('input');
            cb.type = 'checkbox'; cb.checked = val;
            cb.onchange = () => { fn(cb.checked); renderPageOverlays(pg); saveTable(t, pg); };
            l.append(cb, ' ' + label); item.appendChild(l);
        };
        mk('Перерисовать линии таблицы целиком', !!t.redraw, (v) => (t.redraw = v));
        mk('Единый размер шрифта во всей таблице', t.uniform !== false, (v) => (t.uniform = v));
        const show = el('button'); show.textContent = 'Показать';
        show.onclick = () => flashRect(pg, t.bbox);
        item.appendChild(show);
        list.appendChild(item);
    }
}

// ---------- поиск ----------
$('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const N = state.pages.length;
    const startPg = state.current - 1;
    const startIdx = state.active && state.active.type === 'text' && state.active.n === state.current
        ? state.pages[startPg].blocks.indexOf(state.active) + 1 : 0;
    for (let k = 0; k <= N; k++) {
        const pg = state.pages[(startPg + k) % N];
        const from = k === 0 ? startIdx : 0;
        for (let i = from; i < pg.blocks.length; i++) {
            const b = pg.blocks[i];
            if (b.orig.toLowerCase().includes(q) || b.text.toLowerCase().includes(q)) { focusItem(b); return; }
        }
    }
    setStatus('Не найдено: ' + q);
});