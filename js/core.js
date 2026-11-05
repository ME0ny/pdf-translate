function mul(m, c) {
    return [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3], m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5]];
}

// ---------- векторная графика: линии + картинки ----------
function readOps(ops, view) {
    const O = pdfjsLib.OPS;
    const imgOps = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintJpegXObject].filter((v) => v !== undefined));
    const strokeOps = new Set([O.stroke, O.closeStroke]);
    const fillOps = new Set([O.fill, O.eoFill]);
    const bothOps = new Set([O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
    const pageArea = (view[2] - view[0]) * (view[3] - view[1]);
    let ctm = [1, 0, 0, 1, 0, 0], polys = [], cur = null;
    const stack = [], H = [], V = [], images = [];
    const tp = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    const addSeg = (x1, y1, x2, y2) => {
        if (Math.abs(y1 - y2) < 0.8 && Math.abs(x2 - x1) >= 6) H.push({ y: (y1 + y2) / 2, x0: Math.min(x1, x2), x1: Math.max(x1, x2) });
        else if (Math.abs(x1 - x2) < 0.8 && Math.abs(y2 - y1) >= 6) V.push({ x: (x1 + x2) / 2, y0: Math.min(y1, y2), y1: Math.max(y1, y2) });
    };
    const commit = (stroke, fill) => {
        for (const p of polys) {
            const pts = p.pts;
            if (pts.length < 2) continue;
            if (stroke) {
                for (let k = 1; k < pts.length; k++) addSeg(...pts[k - 1], ...pts[k]);
                if (p.closed) addSeg(...pts[pts.length - 1], ...pts[0]);
            }
            if (fill) { // тонкий залитый прямоугольник = линия таблицы
                const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
                const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
                if (y1 - y0 <= 2.5 && x1 - x0 >= 6) H.push({ y: (y0 + y1) / 2, x0, x1 });
                else if (x1 - x0 <= 2.5 && y1 - y0 >= 6) V.push({ x: (x0 + x1) / 2, y0, y1 });
            }
        }
        polys = []; cur = null;
    };

    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], args = ops.argsArray[i];
        if (fn === O.save) stack.push(ctm.slice());
        else if (fn === O.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (fn === O.transform) ctm = mul(args, ctm);
        else if (fn === O.paintFormXObjectBegin) { stack.push(ctm.slice()); if (args && args[0]) ctm = mul(args[0], ctm); }
        else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (fn === O.constructPath) {
            const [pops, coords] = args;
            let k = 0;
            for (const op of pops) {
                if (op === O.moveTo) { cur = { pts: [tp(coords[k], coords[k + 1])], closed: false }; polys.push(cur); k += 2; }
                else if (op === O.lineTo) {
                    const p = tp(coords[k], coords[k + 1]); k += 2;
                    if (!cur) { cur = { pts: [p], closed: false }; polys.push(cur); } else cur.pts.push(p);
                }
                else if (op === O.curveTo) { k += 6; cur = null; }
                else if (op === O.curveTo2 || op === O.curveTo3) { k += 4; cur = null; }
                else if (op === O.closePath) { if (cur) cur.closed = true; }
                else if (op === O.rectangle) {
                    const x = coords[k], y = coords[k + 1], w = coords[k + 2], h = coords[k + 3]; k += 4;
                    polys.push({ pts: [tp(x, y), tp(x + w, y), tp(x + w, y + h), tp(x, y + h)], closed: true });
                    cur = null;
                }
            }
        }
        else if (strokeOps.has(fn)) commit(true, false);
        else if (fillOps.has(fn)) commit(false, true);
        else if (bothOps.has(fn)) commit(true, true);
        else if (fn === O.endPath) { polys = []; cur = null; } // клип-пути не считаем
        else if (imgOps.has(fn)) {
            const c = [tp(0, 0), tp(1, 0), tp(0, 1), tp(1, 1)];
            const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
            const x0 = Math.min(...xs), x1 = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
            if (x1 - x0 < 15 || top - bottom < 15) continue;
            images.push({ x0, x1, bottom, top, full: ((x1 - x0) * (top - bottom)) / pageArea > 0.6 });
        }
    }
    return { H, V, images };
}

// ---------- линии на растре (для сканов / страниц-картинок) ----------
function pixelLines(data, W, H, s) {
    const minLen = Math.round(30 * s), maxThick = Math.ceil(2.5 * s) + 1;
    const dark = (x, y) => { const i = (y * W + x) * 4; return data[i] + data[i + 1] + data[i + 2] < 420; };
    return {
        hs: runsToSegs(H, W, (a, b) => dark(b, a), minLen, maxThick),
        vs: runsToSegs(W, H, (a, b) => dark(a, b), minLen, maxThick),
    };
}
function runsToSegs(nA, nB, get, minLen, maxThick) {
    let active = [];
    const out = [];
    for (let a = 0; a <= nA; a++) {
        const runs = [];
        if (a < nA) {
            let b = 0;
            while (b < nB) {
                if (!get(a, b)) { b++; continue; }
                const s = b;
                while (b < nB && get(a, b)) b++;
                if (b - s >= minLen) runs.push({ b0: s, b1: b });
            }
        }
        const next = [];
        for (const r of runs) {
            const m = active.find((g) => !next.includes(g) && Math.min(g.b1, r.b1) - Math.max(g.b0, r.b0) > 0.8 * (r.b1 - r.b0));
            if (m) { m.a1 = a; m.b0 = Math.min(m.b0, r.b0); m.b1 = Math.max(m.b1, r.b1); next.push(m); }
            else next.push({ a0: a, a1: a, b0: r.b0, b1: r.b1 });
        }
        for (const g of active) if (!next.includes(g) && g.a1 - g.a0 + 1 <= maxThick) out.push(g);
        active = next;
    }
    return out;
}

// ---------- таблицы ----------
function mergeSegs(segs, k, a, b, tol = 1.5) {
    segs = segs.slice().sort((p, q) => p[k] - q[k] || p[a] - q[a]);
    const out = [];
    for (const s of segs) {
        const m = out.find((o) => Math.abs(o[k] - s[k]) <= tol && s[a] <= o[b] + tol && s[b] >= o[a] - tol);
        if (m) { m[a] = Math.min(m[a], s[a]); m[b] = Math.max(m[b], s[b]); } else out.push({ ...s });
    }
    return out;
}
function cluster(vals, tol = 2) {
    const s = vals.slice().sort((a, b) => a - b), out = [];
    let g = [];
    for (const v of s) {
        if (g.length && v - g[g.length - 1] > tol) { out.push(g.reduce((x, y) => x + y) / g.length); g = []; }
        g.push(v);
    }
    if (g.length) out.push(g.reduce((x, y) => x + y) / g.length);
    return out;
}

function buildTables(H0, V0, items) {
    const H = mergeSegs(H0, 'y', 'x0', 'x1'), V = mergeSegs(V0, 'x', 'y0', 'y1');
    if (H.length < 2 || V.length < 2 || H.length + V.length > 4000) return [];
    const tol = 2, nH = H.length, all = [...H, ...V], parent = all.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < nH; i++) for (let j = 0; j < V.length; j++) {
        const h = H[i], v = V[j];
        if (v.x >= h.x0 - tol && v.x <= h.x1 + tol && h.y >= v.y0 - tol && h.y <= v.y1 + tol) parent[find(i)] = find(nH + j);
    }
    const groups = new Map();
    all.forEach((s, i) => {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, { h: [], v: [] });
        (i < nH ? groups.get(r).h : groups.get(r).v).push(s);
    });

    const tables = [];
    for (const g of groups.values()) {
        if (g.h.length < 2 || g.v.length < 2) continue;
        const x0 = Math.min(...g.v.map((v) => v.x), ...g.h.map((h) => h.x0)), x1 = Math.max(...g.v.map((v) => v.x), ...g.h.map((h) => h.x1));
        const bottom = Math.min(...g.h.map((h) => h.y), ...g.v.map((v) => v.y0)), top = Math.max(...g.h.map((h) => h.y), ...g.v.map((v) => v.y1));
        const w = x1 - x0, ht = top - bottom;
        if (w < 40 || ht < 15) continue;
        // требуем «рамку»: минимум 2 линии на всю ширину и 2 на всю высоту (отсекает чертежи)
        if (g.h.filter((h) => h.x1 - h.x0 >= 0.9 * w).length < 2 || g.v.filter((v) => v.y1 - v.y0 >= 0.9 * ht).length < 2) continue;

        const xs = cluster(g.v.map((v) => v.x)), ys = cluster(g.h.map((h) => h.y)).reverse();
        const cols = xs.length - 1, rows = ys.length - 1;
        if (cols < 1 || rows < 1) continue;
        const cp = Array.from({ length: rows * cols }, (_, i) => i);
        const cf = (i) => (cp[i] === i ? i : (cp[i] = cf(cp[i])));
        const cover = (segs, pos, key, a, b, lo, hi) => {
            let c = 0;
            for (const s of segs) if (Math.abs(s[key] - pos) <= tol) c += Math.max(0, Math.min(s[b], hi) - Math.max(s[a], lo));
            return c / (hi - lo);
        };
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const id = r * cols + c;
            if (c < cols - 1 && cover(g.v, xs[c + 1], 'x', 'y0', 'y1', ys[r + 1], ys[r]) < 0.5) cp[cf(id)] = cf(id + 1);
            if (r < rows - 1 && cover(g.h, ys[r + 1], 'y', 'x0', 'x1', xs[c], xs[c + 1]) < 0.5) cp[cf(id)] = cf(id + cols);
        }
        const cm = new Map();
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const k = cf(r * cols + c), rc = { x0: xs[c], x1: xs[c + 1], top: ys[r], bottom: ys[r + 1] };
            cm.set(k, cm.has(k) ? union(cm.get(k), rc) : rc);
        }
        const cells = [...cm.values()].filter((c) => c.x1 - c.x0 > 3 && c.top - c.bottom > 3);
        const withText = cells.filter((c) => items.some((it) => it.cx > c.x0 && it.cx < c.x1 && it.cy > c.bottom && it.cy < c.top)).length;
        if (cells.length < 3 || withText < 2) continue;
        tables.push({ id: tables.length, bbox: { x0, x1, top, bottom }, cells, h: g.h, v: g.v, rows, cols });
    }
    return tables;
}

function cellAt(tables, x, y) {
    for (let ti = 0; ti < tables.length; ti++) {
        const bb = tables[ti].bbox;
        if (x < bb.x0 || x > bb.x1 || y < bb.bottom || y > bb.top) continue;
        const cells = tables[ti].cells;
        for (let ci = 0; ci < cells.length; ci++) {
            const c = cells[ci];
            if (x >= c.x0 && x <= c.x1 && y >= c.bottom && y <= c.top) return { ti, ci };
        }
    }
    return null;
}

// ---------- стиль шрифта ----------
function styleOfFont(page, fontName, styles) {
    let name = '', bold = false, italic = false;
    try { const f = page.commonObjs.get(fontName); name = f.name || ''; bold = !!(f.bold || f.black); italic = !!f.italic; } catch (e) { /* шрифт не загружен */ }
    name += ' ' + ((styles[fontName] && styles[fontName].fontFamily) || '');
    if (/bold|black|heavy|semibold|demi/i.test(name)) bold = true;
    if (/italic|oblique/i.test(name)) italic = true;
    return { b: bold, i: italic };
}

function toMarkup(pieces, baseB, baseI) {
    const segs = [];
    for (const p of pieces) {
        const fb = p.b !== baseB, fi = p.i !== baseI, t = escapeMd(p.t), last = segs[segs.length - 1];
        if (last && ((last.fb === fb && last.fi === fi) || !p.t.trim())) last.t += t;
        else segs.push({ t, fb, fi });
    }
    return segs.map((s) => {
        const m = (s.fb ? '**' : '') + (s.fi ? '*' : '');
        if (!m || !s.t.trim()) return s.t;
        const lead = s.t.match(/^\s*/)[0], trail = s.t.match(/\s*$/)[0];
        return lead + m + s.t.trim() + [...m].reverse().join('') + trail;
    }).join('').replace(/\s+/g, ' ').trim();
}

// ---------- текст: строки -> абзацы (с учётом ячеек таблиц) ----------
function extractText(tc, styleOf, tables, pageN) {
    const lines = [];
    let cur = null;
    for (const it of tc.items) {
        if (!it.str || !it.str.trim()) { if (cur && it.str) cur.pendingSpace = true; continue; }
        const [a, b, , , x, y] = it.transform;
        if (Math.abs(b) > Math.abs(a) * 0.1) continue; // повёрнутый текст не трогаем
        const size = Math.hypot(a, b) || it.height || 10;
        const st = styleOf(it.fontName);
        const cell = cellAt(tables, x + it.width / 2, y + size * 0.3);
        const ck = cell ? cell.ti + ':' + cell.ci : '';
        if (cur && cur.ck === ck && Math.abs(cur.y - y) < size * 0.3 && x - cur.x1 < size * 3 && x >= cur.x0 - 1) {
            const sp = cur.pendingSpace || x - cur.x1 > size * 0.15;
            cur.pieces.push({ t: (sp ? ' ' : '') + it.str, b: st.b, i: st.i });
            cur.x1 = Math.max(cur.x1, x + it.width);
            cur.pendingSpace = false;
        } else {
            cur = { pieces: [{ t: it.str, b: st.b, i: st.i }], x0: x, x1: x + it.width, y, size, ck, cell, pendingSpace: false };
            lines.push(cur);
        }
    }
    if (!lines.length) return [];
    for (const l of lines) {
        const ps = l.pieces.filter((p) => p.t.trim());
        l.st = ps.every((p) => p.b) ? 'b' : ps.some((p) => p.b) ? 'm' : 'r';
        l.cx = (l.x0 + l.x1) / 2;
    }

    const paras = [];
    for (const ln of lines) {
        let target = null;
        for (let i = paras.length - 1; i >= Math.max(0, paras.length - 30); i--) {
            const p = paras[i], last = p.lines[p.lines.length - 1];
            if (last.ck !== ln.ck) continue;
            const gap = last.y - ln.y;
            if (Math.abs(last.size - ln.size) >= 0.6 || gap <= ln.size * 0.8 || gap >= ln.size * (ln.ck ? 1.6 : 1.45)) continue;
            if ((last.st === 'b' && ln.st === 'r') || (last.st === 'r' && ln.st === 'b')) continue; // заголовок ≠ абзац
            if (ln.ck || Math.abs(last.x0 - ln.x0) < ln.size * 2 || Math.abs(last.cx - ln.cx) < ln.size * 1.5) { target = p; break; }
        }
        if (target) target.lines.push(ln); else paras.push({ lines: [ln] });
    }

    const pageLeft = Math.min(...lines.map((l) => l.x0)), pageRight = Math.max(...lines.map((l) => l.x1));
    const { asc, desc } = state;
    const blocks = paras.map((p, idx) => {
        const L = p.lines, f = L[0], l = L[L.length - 1];
        const pieces = [];
        L.forEach((ln, k) => { if (k) pieces.push({ t: ' ', b: ln.pieces[0].b, i: ln.pieces[0].i }); pieces.push(...ln.pieces); });
        let nb = 0, ni = 0, nAll = 0;
        for (const pc of pieces) { const n = pc.t.replace(/\s/g, '').length; nAll += n; if (pc.b) nb += n; if (pc.i) ni += n; }
        const bold = nb > nAll / 2, italic = ni > nAll / 2;
        const lineH = L.length > 1 ? (f.y - l.y) / (L.length - 1) : f.size * 1.2;
        const x0 = Math.min(...L.map((x) => x.x0)), x1 = Math.max(...L.map((x) => x.x1));
        const origRect = { x0: x0 - 0.5, x1: x1 + 0.5, top: f.y + f.size * 0.95, bottom: l.y - f.size * 0.3 };
        const top = f.y + (lineH - (asc + desc) * f.size) / 2 + asc * f.size;

        let align = 'left', valign = 'top', cell = null, tableId = null, cellIdx = null, box;
        if (f.cell) {
            tableId = f.cell.ti; cellIdx = f.cell.ci; cell = tables[tableId].cells[cellIdx];
            const inner = inset(cell, 2, 1.5);
            const lg = x0 - inner.x0, rg = inner.x1 - x1;
            if (lg > 3 && Math.abs(lg - rg) < Math.max(3, (inner.x1 - inner.x0) * 0.12)) align = 'center';
            else if (rg < 3 && lg > 8) align = 'right';
            const tg = inner.top - origRect.top, bg = origRect.bottom - inner.bottom;
            if (tg > 2 && bg > 2 && Math.abs(tg - bg) < Math.max(3, (inner.top - inner.bottom) * 0.15)) valign = 'middle';
            box = { x0: inner.x0, x1: inner.x1, top: valign === 'top' ? Math.min(inner.top, top + 1) : inner.top, bottom: inner.bottom };
        } else {
            const mid = (pageLeft + pageRight) / 2, centers = L.map((x) => x.cx);
            if (x1 - x0 < (pageRight - pageLeft) * 0.8 && centers.every((c) => Math.abs(c - mid) < f.size * 1.5) && x0 - pageLeft > f.size * 3) align = 'center';
            else if (L.length > 1 && Math.max(...centers) - Math.min(...centers) < f.size * 0.8 && Math.max(...L.map((x) => x.x0)) - x0 > f.size * 2) align = 'center';
            box = { x0, x1: x1 + 1, top, bottom: Math.min(top - L.length * lineH, origRect.bottom) };
        }
        return {
            id: `p${pageN}t${idx}`, n: pageN, orig: toMarkup(pieces, bold, italic), bold, italic,
            size: f.size, lineH, nLines: L.length, align, valign, cell, cellIdx, tableId,
            origRect, origBox: box, inFigure: false, color: null, bg: null,
        };
    });

    // несколько абзацев в одной ячейке — делим её по высоте
    const byCell = new Map();
    for (const b of blocks) if (b.cell) { const k = b.tableId + ':' + b.cellIdx; if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(b); }
    for (const arr of byCell.values()) {
        if (arr.length < 2) continue;
        arr.sort((a, b) => b.origRect.top - a.origRect.top);
        const inner = inset(arr[0].cell, 2, 1.5);
        arr.forEach((b, k) => {
            b.valign = 'top';
            b.origBox.top = Math.min(inner.top, b.origRect.top + 1);
            b.origBox.bottom = k < arr.length - 1 ? Math.max(inner.bottom, arr[k + 1].origRect.top + 0.5) : inner.bottom;
            if (b.origBox.bottom >= b.origBox.top) b.origBox.bottom = b.origRect.bottom;
        });
    }
    return blocks;
}

// ---------- цвета фона и текста ----------
function sampleColors(data, W, H, pg, rect, s) {
    const r = toPx(pg, rect, s);
    const L = Math.max(0, Math.floor(r.left) - 2), T = Math.max(0, Math.floor(r.top) - 2);
    const R = Math.min(W - 1, Math.ceil(r.left + r.width) + 2), B = Math.min(H - 1, Math.ceil(r.top + r.height) + 2);
    if (R <= L || B <= T) return { bg: null, color: null };
    const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    const ring = [];
    for (let x = L; x <= R; x += 2) ring.push(px(x, T), px(x, B));
    for (let y = T; y <= B; y += 2) ring.push(px(L, y), px(R, y));

    // ЗАЩИТА: Если массив ring пуст (например, блок 0x0), возвращаем белый цвет (255)
    const med = (k) => {
        if (!ring.length) return 255;
        const sorted = ring.map((c) => c[k]).sort((a, b) => a - b);
        return sorted[sorted.length >> 1] ?? 255;
    };

    const bg = [med(0), med(1), med(2)];
    const bgL = bg[0] + bg[1] + bg[2];
    const ink = [];
    for (let y = T + 2; y < B - 2; y++) for (let x = L + 2; x < R - 2; x++) {
        const c = px(x, y), d = Math.abs(bgL - c[0] - c[1] - c[2]);
        if (d > 240) ink.push([d, c]);
    }
    let color = null;
    if (ink.length) {
        ink.sort((a, b) => b[0] - a[0]);
        const top = ink.slice(0, Math.max(1, ink.length >> 2)), sum = [0, 0, 0];
        top.forEach(([, c]) => { sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; });
        color = sum.map((v) => Math.round(v / top.length));
        if (color.every((v) => v < 70)) color = null;
    }
    return { bg: bg.every((v) => v > 244) ? null : bg, color };
}

// ---------- картинки (по растру) ----------
function removeLongLines(ink, gw, gh) {
    const scan = (len, other, get, set) => {
        const minLen = Math.floor(len * 0.45);
        for (let a = 0; a < other; a++) {
            let s = 0;
            while (s < len) {
                if (!get(a, s)) { s++; continue; }
                let e = s;
                while (e < len && get(a, e)) e++;
                if (e - s >= minLen) {
                    let around = 0;
                    for (let k = s; k < e; k++) { if (a > 2 && get(a - 3, k)) around++; if (a < other - 3 && get(a + 3, k)) around++; }
                    if (around < (e - s) * 0.2) for (let d = -1; d <= 1; d++) if (a + d >= 0 && a + d < other) for (let k = s; k < e; k++) set(a + d, k);
                }
                s = e;
            }
        }
    };
    scan(gw, gh, (y, x) => ink[y * gw + x], (y, x) => (ink[y * gw + x] = 0));
    scan(gh, gw, (x, y) => ink[y * gw + x], (x, y) => (ink[y * gw + x] = 0));
}
function dilate(src, gw, gh, r) {
    const tmp = new Uint8Array(gw * gh), out = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
        let last = -1e9;
        for (let x = 0; x < gw; x++) { if (src[y * gw + x]) last = x; if (x - last <= r) tmp[y * gw + x] = 1; }
        last = 1e9;
        for (let x = gw - 1; x >= 0; x--) { if (src[y * gw + x]) last = x; if (last - x <= r) tmp[y * gw + x] = 1; }
    }
    for (let x = 0; x < gw; x++) {
        let last = -1e9;
        for (let y = 0; y < gh; y++) { if (tmp[y * gw + x]) last = y; if (y - last <= r) out[y * gw + x] = 1; }
        last = 1e9;
        for (let y = gh - 1; y >= 0; y--) { if (tmp[y * gw + x]) last = y; if (last - y <= r) out[y * gw + x] = 1; }
    }
    return out;
}
function components(grown, ink, gw, gh) {
    const seen = new Uint8Array(gw * gh), out = [], stack = [];
    for (let s = 0; s < gw * gh; s++) {
        if (!grown[s] || seen[s]) continue;
        const c = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, ink: 0 };
        seen[s] = 1; stack.push(s);
        while (stack.length) {
            const p = stack.pop(), x = p % gw, y = (p / gw) | 0;
            if (ink[p]) {
                c.ink++;
                if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
                if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
            }
            if (x > 0 && grown[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
            if (x < gw - 1 && grown[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
            if (y > 0 && grown[p - gw] && !seen[p - gw]) { seen[p - gw] = 1; stack.push(p - gw); }
            if (y < gh - 1 && grown[p + gw] && !seen[p + gw]) { seen[p + gw] = 1; stack.push(p + gw); }
        }
        if (c.ink) out.push(c);
    }
    return out;
}
function looksLikeText(ink, gw, c, C, s) {
    const runs = [], w = c.x1 - c.x0 + 1;
    let cur = 0, dens = 0, rows = 0;
    for (let y = c.y0; y <= c.y1; y++) {
        let cnt = 0;
        for (let x = c.x0; x <= c.x1; x++) cnt += ink[y * gw + x];
        if (cnt) { cur++; dens += cnt / w; rows++; } else if (cur) { runs.push(cur); cur = 0; }
    }
    if (cur) runs.push(cur);
    return runs.length >= 2 && Math.max(...runs) * C <= 13 * s && dens / rows > 0.25;
}
function mergeRects(rs, gap) {
    rs = rs.map((r) => ({ ...r }));
    for (let merged = true; merged;) {
        merged = false;
        outer: for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++)
            if (nearPx(rs[i], rs[j], gap)) { rs[i] = unionPx(rs[i], rs[j]); rs.splice(j, 1); merged = true; break outer; }
    }
    return rs;
}

function detectImages(pg, data, W, H, s, mergePt, idp = 'i') {
    const blocks = pg.blocks, C = 2, gw = Math.ceil(W / C), gh = Math.ceil(H / C);
    const ink = new Uint8Array(gw * gh);
    for (let y = 0; y < H; y++) {
        const row = ((y / C) | 0) * gw;
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) ink[row + ((x / C) | 0)] = 1;
        }
    }
    const erase = (rect, pad) => {
        const r = toPx(pg, rect, s);
        const x0 = Math.max(0, Math.floor((r.left - pad) / C)), x1 = Math.min(gw - 1, Math.floor((r.left + r.width + pad) / C));
        const y0 = Math.max(0, Math.floor((r.top - pad) / C)), y1 = Math.min(gh - 1, Math.floor((r.top + r.height + pad) / C));
        for (let y = y0; y <= y1; y++) ink.fill(0, y * gw + x0, y * gw + x1 + 1);
    };
    blocks.forEach((b) => erase(b.origRect, 2));
    pg.tables.forEach((t) => erase(t.bbox, 4));
    removeLongLines(ink, gw, gh);
    const grown = dilate(ink, gw, gh, Math.max(1, Math.round((mergePt * s) / C)));
    const minDim = 24 * s, minArea = (45 * s) ** 2;
    let boxes = [];
    for (const c of components(grown, ink, gw, gh)) {
        const r = { left: c.x0 * C, top: c.y0 * C, width: (c.x1 - c.x0 + 1) * C, height: (c.y1 - c.y0 + 1) * C };
        if (r.width < minDim || r.height < minDim || r.width * r.height < minArea) continue;
        if (blocks.length < 3 && looksLikeText(ink, gw, c, C, s)) continue;
        boxes.push(r);
    }
    pg.opImages.filter((o) => !o.full).forEach((o) => boxes.push(toPx(pg, o, s)));
    boxes = mergeRects(boxes, 6);

    blocks.forEach((b) => (b.inFigure = false));
    for (let pass = 0; pass < 2; pass++) {
        for (const b of blocks) {
            const t = plain(b.orig).trim();
            if (b.cell || t.length > 80 || b.nLines > 3 || CAPTION_RE.test(t)) continue;
            const br = toPx(pg, b.origRect, s);
            const i = boxes.findIndex((a) => nearPx(a, br, 6 * s));
            if (i >= 0) { boxes[i] = unionPx(boxes[i], br); b.inFigure = true; }
        }
        boxes = mergeRects(boxes, 6);
    }
    boxes.sort((a, b) => a.top - b.top || a.left - b.left);
    const res = boxes.map((r, k) => ({ id: `p${pg.n}${idp}${k}`, ...toPdf(pg, r, s), kind: 'Картинка' }));
    const [vx0, vy0, vx1, vy1] = pg.view;
    res.push({
        id: `p${pg.n}${idp}page`, x0: vx0, x1: vx1, bottom: vy0, top: vy1, wholePage: true,
        kind: pg.opImages.some((o) => o.full) ? 'Вся страница (фоновое изображение)' : 'Страница целиком'
    });
    return res;
}

// ---------- анализ страницы целиком ----------
const aCanvas = document.createElement('canvas');
async function renderForAnalysis(page) {
    const vp = page.getViewport({ scale: A_SCALE, rotation: 0 });
    aCanvas.width = Math.ceil(vp.width); aCanvas.height = Math.ceil(vp.height);
    const ctx = aCanvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, aCanvas.width, aCanvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { data: ctx.getImageData(0, 0, aCanvas.width, aCanvas.height).data, W: aCanvas.width, H: aCanvas.height };
}

async function analyzePage(n, mergePt) {
    const page = await state.pdf.getPage(n);
    const pg = { n, view: page.view.slice() };
    const { data, W, H } = await renderForAnalysis(page); // после рендера шрифты доступны в commonObjs
    const ops = await page.getOperatorList();
    const tc = await page.getTextContent();
    const vec = readOps(ops, pg.view);
    if (vec.images.length) { // есть растр — ищем линии таблиц и на картинке
        const { hs, vs } = pixelLines(data, W, H, A_SCALE);
        for (const g of hs) vec.H.push({ y: pg.view[3] - (g.a0 + g.a1 + 1) / 2 / A_SCALE, x0: pg.view[0] + g.b0 / A_SCALE, x1: pg.view[0] + g.b1 / A_SCALE });
        for (const g of vs) vec.V.push({ x: pg.view[0] + (g.a0 + g.a1 + 1) / 2 / A_SCALE, y0: pg.view[3] - g.b1 / A_SCALE, y1: pg.view[3] - g.b0 / A_SCALE });
    }
    const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({
        cx: it.transform[4] + it.width / 2, cy: it.transform[5] + Math.hypot(it.transform[0], it.transform[1]) * 0.3
    }));
    pg.tables = buildTables(vec.H, vec.V, items);
    const sc = new Map();
    const styleOf = (fn) => { if (!sc.has(fn)) sc.set(fn, styleOfFont(page, fn, tc.styles)); return sc.get(fn); };
    pg.blocks = extractText(tc, styleOf, pg.tables, n);
    for (const b of pg.blocks) {
        const c = sampleColors(data, W, H, pg, b.origRect, A_SCALE);
        b.color = c.color;
        b.bg = b.cell ? sampleColors(data, W, H, pg, inset(b.cell, 3), A_SCALE).bg : c.bg;
    }
    for (const t of pg.tables) t.bg = sampleColors(data, W, H, pg, inset(t.bbox, -3), A_SCALE).bg;
    pg.opImages = vec.images;
    pg.images = detectImages(pg, data, W, H, A_SCALE, mergePt);
    page.cleanup();
    return pg;
}

// только данные анализа (без DOM и правок) — для кэша
function serializePage(pg) {
    return {
        n: pg.n, view: pg.view, opImages: pg.opImages,
        tables: pg.tables.map((t) => ({ id: t.id, bbox: t.bbox, cells: t.cells, h: t.h, v: t.v, rows: t.rows, cols: t.cols, bg: t.bg })),
        blocks: pg.blocks.map((b) => ({
            id: b.id, n: b.n, orig: b.orig, bold: b.bold0 ?? b.bold, italic: b.italic0 ?? b.italic, align: b.align0 ?? b.align,
            size: b.size, lineH: b.lineH, nLines: b.nLines, valign: b.valign, cell: b.cell, cellIdx: b.cellIdx, tableId: b.tableId,
            origRect: b.origRect, origBox: b.origBox, inFigure: b.inFigure, color: b.color, bg: b.bg
        })),
        images: pg.images.filter((o) => !o.manual).map((o) => ({ id: o.id, x0: o.x0, x1: o.x1, top: o.top, bottom: o.bottom, kind: o.kind, wholePage: !!o.wholePage })),
    };
}