async function toPngOrJpg(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (blob.type === 'image/png') return { buf, type: 'png' };
    if (blob.type === 'image/jpeg') return { buf, type: 'jpg' };
    const bmp = await createImageBitmap(blob);
    const c = el('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { buf: new Uint8Array(await png.arrayBuffer()), type: 'png' };
}

async function save() {
    const N = state.pages.length;
    const from = Math.max(1, +$('saveFrom').value || 1), to = Math.min(N, +$('saveTo').value || N);
    setStatus('Чтение PDF...');
    const { PDFDocument, rgb } = PDFLib;
    const src = await PDFDocument.load(new Uint8Array(await state.file.arrayBuffer()), { ignoreEncryption: true });
    let doc = src, idx = (n) => n - 1;
    if (from !== 1 || to !== N) {
        doc = await PDFDocument.create();
        const list = [];
        for (let n = from; n <= to; n++) list.push(n - 1);
        (await doc.copyPages(src, list)).forEach((p) => doc.addPage(p));
        idx = (n) => n - from;
    }
    doc.registerFontkit(fontkit);
    const fonts = {};
    const getFont = async (k) => fonts[k] || (fonts[k] = await doc.embedFont(state.fonts[k].buf.slice(0), { subset: true, features: { liga: false, kern: false } }));
    const pages = doc.getPages();
    const col = (c, d) => {
        // Проверяем, что c - это валидный массив из 3 чисел, и ни одно из них не NaN
        const isValid = Array.isArray(c) && c.length === 3 &&
            typeof c[0] === 'number' && !isNaN(c[0]) &&
            typeof c[1] === 'number' && !isNaN(c[1]) &&
            typeof c[2] === 'number' && !isNaN(c[2]);

        const v = isValid ? c : d;

        // Делим на 255 и принудительно ограничиваем диапазон от 0 до 1 для безопасности pdf-lib
        const r = Math.max(0, Math.min(1, v[0] / 255));
        const g = Math.max(0, Math.min(1, v[1] / 255));
        const b = Math.max(0, Math.min(1, v[2] / 255));

        return rgb(r, g, b);
    };
    const { asc, desc } = state;

    for (let n = from; n <= to; n++) {
        const pg = state.pages[n - 1], p = pages[idx(n)];
        const imgs = pg.images.filter((o) => o.newBlob);
        const anyText = pg.blocks.some(isDirty) || pg.tables.some((t) => t.redraw);
        if (n % 25 === 0) { setStatus(`Сохранение: страница ${n}/${to}`); await sleep(0); }
        if (!imgs.length && !anyText) continue;

        for (const im of imgs) {
            const { buf, type } = await toPngOrJpg(im.newBlob);
            const emb = type === 'png' ? await doc.embedPng(buf) : await doc.embedJpg(buf);
            const bw = im.x1 - im.x0, bh = im.top - im.bottom;
            p.drawRectangle({ x: im.x0, y: im.bottom, width: bw, height: bh, color: rgb(1, 1, 1) });
            const k = Math.min(bw / emb.width, bh / emb.height), w = emb.width * k, h = emb.height * k;
            p.drawImage(emb, { x: im.x0 + (bw - w) / 2, y: im.bottom + (bh - h) / 2, width: w, height: h });
        }
        if (!anyText) continue;
        fitPage(pg);

        for (const t of pg.tables) {
            if (!t.redraw) continue;
            const r = inset(t.bbox, -2);
            p.drawRectangle({ x: r.x0, y: r.bottom, width: r.x1 - r.x0, height: r.top - r.bottom, color: col(t.bg, [255, 255, 255]) });
            for (const h of t.h) p.drawLine({ start: { x: h.x0, y: h.y }, end: { x: h.x1, y: h.y }, thickness: 0.75, color: rgb(0, 0, 0) });
            for (const v of t.v) p.drawLine({ start: { x: v.x, y: v.y0 }, end: { x: v.x, y: v.y1 }, thickness: 0.75, color: rgb(0, 0, 0) });
        }
        const todo = pg.blocks.filter((b) => b.layout);
        for (const b of todo) { // сначала все подложки
            const c = coverOf(b);
            p.drawRectangle({ x: c.x0, y: c.bottom, width: c.x1 - c.x0, height: c.top - c.bottom, color: col(b.bg, [255, 255, 255]) });
        }
        for (const b of todo) { // потом весь текст
            const L = b.layout, W = b.box.x1 - b.box.x0, color = col(b.color, [0, 0, 0]);
            const offY = b.valign === 'middle' ? Math.max(0, (b.box.top - b.box.bottom - L.height) / 2) : 0;
            for (let i = 0; i < L.lines.length; i++) {
                const ln = L.lines[i];
                const dx = b.align === 'center' ? (W - ln.width) / 2 : b.align === 'right' ? W - ln.width : 0;
                const y = b.box.top - offY - i * L.lh - (L.lh - (asc + desc) * L.size) / 2 - asc * L.size;
                for (const it of ln.items) p.drawText(it.t, { x: b.box.x0 + dx + it.x, y, size: L.size, font: await getFont(fontKey(it.b, it.i)), color });
            }
        }
    }

    setStatus('Запись файла...');
    const out = await doc.save();
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    a.download = state.file.name.replace(/\.pdf$/i, '') + (from !== 1 || to !== N ? `_p${from}-${to}` : '') + '_edited.pdf';
    a.click();
    setStatus('Сохранено');
}