function initBlock(b) {
    b.type = 'text';
    b.bold0 = b.bold; b.italic0 = b.italic; b.align0 = b.align;
    resetBlockRuntime(b);
}
function resetBlockRuntime(b) {
    b.text = b.orig; b.manualText = false;
    b.bold = b.bold0; b.italic = b.italic0; b.align = b.align0;
    b.fontSize = null; b.manualBox = false; b.box = { ...b.origBox };
    b.layout = null; b.warn = '';
}
const isDirty = (b) => b.text !== b.orig || b.manualBox || b.fontSize != null ||
    b.bold !== b.bold0 || b.italic !== b.italic0 || b.align !== b.align0;

function wordsOf(b) {
    const key = b.text + '|' + b.bold + '|' + b.italic;
    if (b._wk === key) return b._words;
    const words = [];
    let cur = null, space = false;
    for (const r of parseRuns(b.text, b.bold, b.italic)) {
        for (const part of r.t.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) {
                if (part.includes('\n')) { words.push({ br: true }); space = false; } else space = true;
                cur = null; continue;
            }
            if (!cur) { cur = { pieces: [], space }; words.push(cur); space = false; }
            cur.pieces.push({ t: part, b: r.b, i: r.i });
        }
    }
    b._wk = key; b._words = words;
    return words;
}

function layoutAt(b, size, box) {
    const lh = size * (b.lineH / b.size), maxW = box.x1 - box.x0;
    const lines = [];
    let line = { items: [], width: 0 }, widest = 0;
    const flush = () => { lines.push(line); widest = Math.max(widest, line.width); line = { items: [], width: 0 }; };
    for (const w of wordsOf(b)) {
        if (w.br) { flush(); continue; }
        const ww = w.pieces.reduce((s, p) => s + measure(p.t, size, p.b, p.i), 0);
        const sp = measure(' ', size, w.pieces[0].b, w.pieces[0].i);
        if (line.items.length && line.width + sp + ww > maxW) flush();
        let x = line.items.length ? line.width + sp : 0;
        for (const p of w.pieces) { line.items.push({ t: p.t, b: p.b, i: p.i, x }); x += measure(p.t, size, p.b, p.i); }
        line.width = x;
    }
    flush();
    const height = lines.length * lh;
    return { size, lh, lines, height, fits: height <= box.top - box.bottom + 0.5 && widest <= maxW + 0.5 };
}

// наибольший размер в [to, from], при котором текст влезает
function bestSize(b, box, from, to) {
    const L = layoutAt(b, from, box);
    if (L.fits) return L;
    if (to >= from) return null;
    let best = layoutAt(b, to, box);
    if (!best.fits) return null;
    let lo = to, hi = from;
    while (hi - lo > 0.15) {
        const mid = (lo + hi) / 2, M = layoutAt(b, mid, box);
        if (M.fits) { best = M; lo = mid; } else hi = mid;
    }
    return best;
}

function expandBox(b, pg) {
    const box = { ...b.origBox };
    const others = [
        ...pg.blocks.filter((t) => t !== b).map((t) => union(t.origRect, t.box)),
        ...pg.images.filter((i) => !i.wholePage),
        ...pg.tables.map((t) => t.bbox),
    ];
    let right = Math.max(box.x1, ...pg.blocks.map((t) => t.origRect.x1));
    let left = Math.min(box.x0, ...pg.blocks.map((t) => t.origRect.x0));
    for (const o of others) if (overlapY(o, box)) {
        if (o.x0 >= box.x1 - 0.5) right = Math.min(right, o.x0 - 3);
        if (o.x1 <= box.x0 + 0.5) left = Math.max(left, o.x1 + 3);
    }
    if (b.align === 'center') { const d = Math.min(right - box.x1, box.x0 - left); if (d > 0) { box.x0 -= d; box.x1 += d; } }
    else if (b.align === 'right') box.x0 = Math.min(box.x0, left);
    else box.x1 = Math.max(box.x1, right);
    let bottom = pg.view[1] + 25;
    for (const o of others) if (overlapX(o, box) && o.top <= box.bottom + 0.5) bottom = Math.max(bottom, o.top + 2);
    box.bottom = Math.min(box.bottom, bottom);
    return box;
}

function fitBlock(b, pg) {
    b.warn = '';
    if (!isDirty(b)) { b.layout = null; b.box = { ...b.origBox }; return; }
    const minSize = Math.max(4, b.size * MIN_FONT_RATIO);
    const tight = (box, L) => ({ ...box, bottom: Math.min(box.top - L.height, b.origBox.bottom) });

    if (b.fontSize) {
        let box = b.manualBox ? b.box : { ...b.origBox };
        let L = layoutAt(b, b.fontSize, box);
        if (!L.fits && !b.manualBox && !b.inFigure) {
            const big = expandBox(b, pg);
            L = layoutAt(b, b.fontSize, big);
            box = L.fits ? tight(big, L) : big;
        }
        if (!L.fits) { b.warn = '⚠ Не помещается при этом размере шрифта'; if (!b.manualBox) box = { ...box, bottom: box.top - L.height }; }
        b.box = box; b.layout = L; return;
    }
    if (b.manualBox) {
        let L = bestSize(b, b.box, b.size, minSize);
        if (!L) { L = layoutAt(b, minSize, b.box); b.warn = '⚠ Текст не помещается в заданную область'; }
        b.layout = L; return;
    }
    let box = { ...b.origBox };
    let L = bestSize(b, box, b.size, b.size * 0.85);          // 1) шрифт до 85%
    if (!L) {
        if (!b.inFigure) {                                      // 2) расширяем область
            const big = expandBox(b, pg);
            L = bestSize(b, big, b.size, minSize);                // 3) шрифт до минимума
            box = L ? tight(big, L) : big;
        } else L = bestSize(b, box, b.size * 0.85, minSize);
    }
    if (!L) {
        L = layoutAt(b, minSize, box);
        box = { ...box, bottom: box.top - L.height };
        b.warn = '⚠ Не помещается даже при минимальном шрифте — сократите текст или растяните область';
    }
    b.box = box; b.layout = L;
}

// таблица: текст только внутри ячейки, общий коэффициент шрифта
function fitTable(t, pg) {
    const blocks = pg.blocks.filter((b) => b.tableId === t.id);
    t.dirty = !!t.redraw || blocks.some(isDirty);
    if (!t.dirty) { blocks.forEach((b) => { b.layout = null; b.warn = ''; if (!b.manualBox) b.box = { ...b.origBox }; }); return; }
    const minR = MIN_FONT_RATIO_TABLE;
    const res = blocks.map((b) => {
        if (!b.manualBox) b.box = { ...b.origBox };
        if (b.fontSize) return { b, r: b.fontSize / b.size, fixed: true };
        const L = bestSize(b, b.box, b.size, b.size * minR);
        return { b, r: L ? L.size / b.size : null };
    });
    const ok = res.filter((x) => !x.fixed && x.r != null).map((x) => x.r);
    const ratio = ok.length ? Math.min(...ok) : minR;
    for (const x of res) {
        const r = x.fixed ? x.r : x.r == null ? minR : t.uniform !== false ? ratio : x.r;
        const L = layoutAt(x.b, x.b.size * r, x.b.box);
        x.b.layout = L;
        x.b.warn = L.fits ? '' : '⚠ Не помещается в ячейку — сократите текст';
    }
}

function fitPage(pg) {
    pg.tables.forEach((t) => fitTable(t, pg));
    pg.blocks.forEach((b) => { if (b.tableId == null) fitBlock(b, pg); });
}

// область, которую закрашиваем (в ячейке — не трогаем линии)
function coverOf(b) {
    // Объединяем оригинальный прямоугольник и новый (после перевода/изменения размера)
    const r = union(b.origRect, b.box);

    if (b.cell) {
        // ДЛЯ ТАБЛИЦ: Делаем подложку чуть больше (расширяем на 1.5pt), 
        // чтобы гарантированно перекрыть "призраки" оригинального текста по краям,
        // но не выходим за физические границы ячейки (inset с 0.5pt отступа от линий)
        const expanded = inset(r, -1.5, -1.5);
        return clipRect(expanded, inset(b.cell, 0.5, 0.5));
    }

    // Для обычного текста оставляем стандартное объединение
    return r;
}