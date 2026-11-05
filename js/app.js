const mergePt = () => +$('mergeRange').value;
const pageKey = (n) => state.docKey + '|' + String(n).padStart(6, '0');
$('mergeRange').oninput = () => ($('mergeVal').textContent = $('mergeRange').value);

$('pdfInput').onchange = (e) => {
    const f = e.target.files[0];
    if (f) openFile(f).catch((err) => { console.error(err); setStatus('Ошибка: ' + err.message); });
};
$('saveBtn').onclick = () => save().catch((e) => { console.error(e); setStatus('Ошибка сохранения: ' + e.message); });
$('prevPage').onclick = () => gotoPage(state.current - 1);
$('nextPage').onclick = () => gotoPage(state.current + 1);
$('pageInput').onchange = () => gotoPage(+$('pageInput').value);
$('zoomSel').onchange = () => { state.viewScale = +$('zoomSel').value; if (state.pages.length) buildViewer(state.current); };

async function openFile(f) {
    state.pages.forEach(unmountPage);
    $('viewer').innerHTML = '';
    state.file = f;
    state.docKey = `${f.name}|${f.size}|${f.lastModified}|v${ANALYSIS_VERSION}`;
    await loadFonts();
    if (state.pdf) state.pdf.destroy();
    state.pdf = await pdfjsLib.getDocument({ url: URL.createObjectURL(f) }).promise;
    const N = state.pdf.numPages;

    // анализ (с кэшем в IndexedDB — повторное открытие мгновенное, прерванный анализ продолжается)
    setStatus('Чтение кэша...');
    const cached = new Map((await idbPrefix('pages', state.docKey + '|')).map(([, v]) => [v.n, v]));
    state.pages = new Array(N);
    let buf = [], analyzed = 0;
    const toDo = N - cached.size, t0 = Date.now();
    for (let n = 1; n <= N; n++) {
        let pg = cached.get(n);
        if (!pg) {
            try { pg = await analyzePage(n, mergePt()); }
            catch (e) { console.warn('Стр. ' + n, e); pg = { n, view: [0, 0, 612, 792], blocks: [], images: [], tables: [], opImages: [] }; }
            buf.push([pageKey(n), serializePage(pg)]);
            analyzed++;
            if (buf.length >= 20) { await idbPutMany('pages', buf); buf = []; }
            if (analyzed % 3 === 0) {
                const per = (Date.now() - t0) / analyzed;
                setStatus(`Анализ ${n}/${N} · осталось ≈ ${fmtMin(((toDo - analyzed) * per) / 60000)}`);
                await sleep(0);
            }
        }
        state.pages[n - 1] = pg;
    }
    if (buf.length) await idbPutMany('pages', buf);

    // подготовка
    state.byOrig.clear(); state.byId.clear(); state.active = null;
    for (const pg of state.pages) {
        pg.blocks.forEach((b) => {
            initBlock(b);
            state.byId.set(b.id, b);
            if (!state.byOrig.has(b.orig)) state.byOrig.set(b.orig, []);
            state.byOrig.get(b.orig).push(b);
        });
        pg.images.forEach((o) => initImage(o, pg));
        pg.tables.forEach((t) => { t.redraw = false; t.uniform = true; });
    }
    setStatus('Восстановление переводов и правок...');
    await restoreProject();

    $('pageTotal').textContent = '/ ' + N;
    $('pageInput').max = N;
    $('trFrom').value = 1; $('trTo').value = N;
    buildViewer(1);
    $('saveBtn').disabled = false;
    const blocks = state.pages.reduce((s, p) => s + p.blocks.length, 0);
    const tables = state.pages.reduce((s, p) => s + p.tables.length, 0);
    setStatus(`Страниц ${N} · блоков ${blocks} (уникальных ${state.byOrig.size}) · таблиц ${tables} · переведено ${state.tm.size}`);
}

async function restoreProject() {
    await loadTM();
    const pre = state.docKey + '|';
    for (const [k, e] of await idbPrefix('edits', pre)) {
        const id = k.slice(pre.length);
        if (id.startsWith('tbl:')) {
            const [, n, tid] = id.split(':');
            const t = state.pages[n - 1] && state.pages[n - 1].tables.find((x) => x.id === +tid);
            if (t) Object.assign(t, e);
            continue;
        }
        const b = state.byId.get(id);
        if (!b) continue;
        if (e.manualText) { b.text = e.text; b.manualText = true; }
        if (e.fontSize) b.fontSize = e.fontSize;
        if (e.manualBox) { b.manualBox = true; b.box = e.box; }
        if (e.bold !== undefined) b.bold = e.bold;
        if (e.italic !== undefined) b.italic = e.italic;
        if (e.align) b.align = e.align;
    }
    for (const [, v] of await idbPrefix('imgs', pre)) {
        const pg = state.pages[v.n - 1];
        if (!pg) continue;
        let o = pg.images.find((x) => x.id === v.id);
        if (v.deleted) { if (o) pg.images = pg.images.filter((x) => x !== o); continue; }
        if (!o) { o = { ...v }; initImage(o, pg); pg.images.push(o); }
        Object.assign(o, { x0: v.x0, x1: v.x1, top: v.top, bottom: v.bottom });
        if (v.blob) { o.newBlob = v.blob; o.newSrc = URL.createObjectURL(v.blob); }
    }
}

// повторный поиск картинок на текущей странице (с новой «склейкой»)
$('redetectBtn').onclick = async () => {
    const pg = state.pages[state.current - 1];
    if (!pg) return;
    setStatus('Поиск картинок...');
    const page = await state.pdf.getPage(pg.n);
    const { data, W, H } = await renderForAnalysis(page);
    const keep = pg.images.filter((o) => o.manual || o.newBlob);
    const fresh = detectImages(pg, data, W, H, A_SCALE, mergePt(), 'r' + Date.now().toString(36))
        .filter((im) => !keep.some((k) => (im.wholePage && k.wholePage) || (!im.wholePage && !k.wholePage && overlapX(k, im) && overlapY(k, im))));
    fresh.forEach((o) => initImage(o, pg));
    pg.images.filter((o) => !keep.includes(o)).forEach((o) => saveImg(o, true));
    pg.images = [...keep, ...fresh];
    await idbPutMany('pages', [[pageKey(pg.n), serializePage(pg)]]);
    unmountPage(pg);
    await mountPage(pg);
    renderSidebar();
    setStatus('Найдено картинок: ' + pg.images.filter((o) => !o.wholePage).length);
};