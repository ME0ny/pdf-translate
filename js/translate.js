const SETTINGS_KEY = 'pdfEditorAI';
const DEFAULTS = {
    baseUrl: 'https://routerai.ru/api/v1', apiKey: '', model: '', lang: 'русский',
    prompt: 'Ты профессиональный технический переводчик военной и автомобильной документации. Переведи текст на язык: {lang}. ' +
        'Сохраняй числа, артикулы, номера рисунков, пунктов и единицы измерения. Используй принятую техническую терминологию. ' +
        'Переводи кратко — перевод не должен быть заметно длиннее оригинала.',
    concurrency: 10, batchChars: 6000, batchItems: 150, rpm: 0, retries: 4, timeout: 180, temperature: 0.2, jsonMode: false,
    skip: '^(TM\\s?[\\d-]+.*|\\d{4}[–-]\\d+(\\/\\d+)?|\\d{4,6}|[A-Z]?\\d+[A-Z]?)$',
};
let settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };

const FORMAT_RULES = `
ФОРМАТ: на вход приходит JSON-объект {"номер": "текст"}. Это фрагменты одного документа в порядке следования, соседние фрагменты — контекст.
Верни ТОЛЬКО JSON-объект с теми же ключами, где значения — переводы. Ничего не пропускай, не объединяй и не добавляй, без пояснений.
Разметка: **...** — жирный, *...* — курсив. Сохраняй её вокруг соответствующих слов перевода. \\* — обычная звёздочка, оставь как есть.
Если фрагмент не нужно переводить (код, номер, обозначение), верни его без изменений.`;

// ---------- форма настроек ----------
const F = {
    sBase: 'baseUrl', sKey: 'apiKey', sModel: 'model', sLang: 'lang', sPrompt: 'prompt', sConc: 'concurrency', sChars: 'batchChars',
    sItems: 'batchItems', sRpm: 'rpm', sRetries: 'retries', sTimeout: 'timeout', sTemp: 'temperature', sSkip: 'skip'
};
function fillSettingsForm() {
    for (const [id, k] of Object.entries(F)) $(id).value = settings[k];
    $('sJson').checked = !!settings.jsonMode;
    $('sMsg').textContent = '';
}
function readSettingsForm() {
    const s = { ...settings };
    for (const [id, k] of Object.entries(F)) s[k] = typeof DEFAULTS[k] === 'number' ? (+$(id).value || DEFAULTS[k]) : $(id).value.trim();
    if ($('sRpm').value === '0') s.rpm = 0;
    if ($('sRetries').value === '0') s.retries = 0;
    if ($('sTemp').value === '0') s.temperature = 0;
    s.baseUrl = s.baseUrl.replace(/\/+$/, '') || DEFAULTS.baseUrl;
    s.lang = s.lang || DEFAULTS.lang;
    s.prompt = s.prompt || DEFAULTS.prompt;
    s.concurrency = Math.min(64, Math.max(1, s.concurrency));
    s.jsonMode = $('sJson').checked;
    return s;
}
$('settingsBtn').onclick = () => { fillSettingsForm(); $('modal').hidden = false; };
$('sCancel').onclick = () => ($('modal').hidden = true);
$('sSave').onclick = async () => {
    const langChanged = readSettingsForm().lang !== settings.lang;
    settings = readSettingsForm();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    $('modal').hidden = true;
    if (langChanged && state.pages.length) { await loadTM(); state.pages.forEach((pg) => pg.mounted && renderPageOverlays(pg)); renderSidebar(); }
};
$('sTest').onclick = async () => {
    const saved = settings;
    settings = readSettingsForm();
    $('sMsg').style.color = '#374151'; $('sMsg').textContent = 'Проверка...';
    try {
        const { got } = await runBatch([{ orig: 'Remove the **rear door** ramp.' }, { orig: 'Figure 3. Exhaust Pipe.' }], { signal: new AbortController().signal, log: () => { } });
        $('sMsg').style.color = '#16a34a'; $('sMsg').textContent = 'OK: ' + got.map((g) => g[1]).join(' | ');
    } catch (e) { $('sMsg').style.color = '#dc2626'; $('sMsg').textContent = e.message; }
    settings = saved;
};

// ---------- вызов модели ----------
let nextSlot = 0;
async function rateLimit() {
    if (!settings.rpm) return;
    const gap = 60000 / settings.rpm, now = Date.now(), t = Math.max(now, nextSlot);
    nextSlot = t + gap;
    if (t > now) await sleep(t - now);
}

async function callModel(messages, signal) {
    if (!settings.apiKey) throw Object.assign(new Error('Не указан API-ключ (⚙ ИИ)'), { fatal: true });
    if (!settings.model) throw Object.assign(new Error('Не указана модель (⚙ ИИ)'), { fatal: true });
    const ctl = new AbortController(), onAbort = () => ctl.abort();
    signal && signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), settings.timeout * 1000);
    try {
        const body = { model: settings.model, temperature: settings.temperature, messages };
        if (settings.jsonMode) body.response_format = { type: 'json_object' };
        const res = await fetch(settings.baseUrl + '/chat/completions', {
            method: 'POST', signal: ctl.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.apiKey },
            body: JSON.stringify(body),
        });
        const raw = await res.text();
        let data;
        try { data = JSON.parse(raw); } catch { throw Object.assign(new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`), { status: res.status }); }
        if (!res.ok) {
            throw Object.assign(new Error((data.error && data.error.message) || `HTTP ${res.status}`), {
                status: res.status, retryAfter: +res.headers.get('retry-after') || 0, fatal: res.status === 401 || res.status === 403
            });
        }
        if (data.usage && run) run.tokens += data.usage.total_tokens || 0;
        const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!out) throw new Error('Пустой ответ модели');
        return out;
    } catch (e) {
        if (e.name === 'AbortError' && !(signal && signal.aborted)) throw new Error('Таймаут запроса');
        throw e;
    } finally {
        clearTimeout(timer);
        signal && signal.removeEventListener('abort', onAbort);
    }
}

function parseBatchResponse(raw) {
    let s = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const a = s.indexOf('{'), z = s.lastIndexOf('}');
    if (a >= 0 && z > a) { try { return JSON.parse(s.slice(a, z + 1)); } catch (e) { /* чиним ниже */ } }
    const out = {}, re = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(s))) { try { out[m[1]] = JSON.parse('"' + m[2] + '"'); } catch (e) { /* skip */ } }
    if (!Object.keys(out).length) throw new Error('Не удалось разобрать ответ: ' + s.slice(0, 120));
    return out;
}

// один запрос = пачка фрагментов
async function runBatch(batch, ctx) {
    const obj = {};
    batch.forEach((s, k) => (obj[k + 1] = s.orig));
    const messages = [
        { role: 'system', content: settings.prompt.replace(/\{lang\}/g, settings.lang) + '\n' + FORMAT_RULES },
        { role: 'user', content: JSON.stringify(obj) },
    ];
    let lastErr;
    for (let attempt = 0; attempt <= settings.retries; attempt++) {
        if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
        try {
            await rateLimit();
            const res = parseBatchResponse(await callModel(messages, ctx.signal));
            const got = [], missing = [];
            batch.forEach((s, k) => {
                const v = res[k + 1];
                if (typeof v === 'string' && v.trim()) got.push([s.orig, v.trim()]); else missing.push(s);
            });
            if (!got.length) throw new Error('Модель не вернула переводов');
            return { got, missing };
        } catch (e) {
            if (ctx.signal.aborted || e.fatal) throw e;
            lastErr = e;
            if (attempt === settings.retries) break;
            const wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(60000, 2000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
            ctx.log(`Повтор через ${Math.round(wait / 1000)} с: ${e.message}`);
            await sleep(wait);
        }
    }
    throw lastErr;
}

// ---------- память переводов ----------
const tmKey = (orig) => settings.lang + '|' + orig;
async function loadTM() {
    state.tm.clear();
    const origs = [...state.byOrig.keys()];
    const vals = await idbGetMany('tm', origs.map(tmKey));
    origs.forEach((o, i) => { if (vals[i] != null) state.tm.set(o, vals[i]); });
    for (const [o, blocks] of state.byOrig) for (const b of blocks) if (!b.manualText) b.text = state.tm.get(o) ?? o;
}

function applyTranslations(pairs) {
    const touched = new Set();
    for (const [orig, tr] of pairs) {
        state.tm.set(orig, tr);
        for (const b of state.byOrig.get(orig) || []) {
            if (b.manualText) continue;
            b.text = tr; touched.add(b.n);
        }
    }
    idbPutMany('tm', pairs.map(([o, t]) => [tmKey(o), t])).catch(console.error);
    for (const n of touched) {
        const pg = state.pages[n - 1];
        if (pg.mounted && pg.mounted.rendered) renderPageOverlays(pg);
        else if (n === state.current) pg.blocks.forEach(updateItem);
    }
}

function skipRegex() { try { return settings.skip ? new RegExp(settings.skip) : null; } catch { return null; } }
function needsTr(b, re) {
    if (b.manualText || state.tm.has(b.orig)) return false;
    const p = plain(b.orig).trim();
    return hasLetters(p) && !(re && re.test(p));
}

// ---------- массовый перевод ----------
let run = null;
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} ч ${Math.round(m % 60)} мин` : `${Math.max(1, Math.round(m))} мин`);

function updateProgress() {
    if (!run) return;
    const min = (Date.now() - run.t0) / 60000, speed = run.done / Math.max(min, 0.01);
    const left = run.total - run.done - run.failed;
    $('progress').textContent = `Фрагментов ${run.done}/${run.total} (блоков ${run.blocks}) · ошибок ${run.failed} · в работе ${run.inFlight} запр. · ` +
        `${Math.round(speed)}/мин · осталось ≈ ${speed > 0 ? fmtMin(left / speed) : '—'} · токенов ${run.tokens.toLocaleString()}`;
}

async function translateRange(from, to) {
    if (run || !state.pages.length) return;
    from = Math.max(1, from | 0); to = Math.min(state.pages.length, to | 0);
    const re = skipRegex(), seen = new Set(), segs = [];
    let blocks = 0;
    for (let n = from; n <= to; n++) for (const b of state.pages[n - 1].blocks) {
        if (!needsTr(b, re)) continue;
        blocks++;
        if (!seen.has(b.orig)) { seen.add(b.orig); segs.push({ orig: b.orig, tries: 0 }); }
    }
    if (!segs.length) { $('progress').textContent = 'Нечего переводить'; return; }

    const queue = [];
    let cur = [], chars = 0;
    for (const s of segs) {
        const len = s.orig.length + 12;
        if (cur.length && (chars + len > settings.batchChars || cur.length >= settings.batchItems)) { queue.push(cur); cur = []; chars = 0; }
        cur.push(s); chars += len;
    }
    if (cur.length) queue.push(cur);

    const ctl = new AbortController();
    run = { ctl, total: segs.length, blocks, done: 0, failed: 0, inFlight: 0, t0: Date.now(), tokens: 0 };
    const ctx = { signal: ctl.signal, log: (m) => ($('trLog').textContent = m) };
    ['trAllBtn', 'trPageBtn', 'trRangeBtn'].forEach((id) => ($(id).disabled = true));
    $('stopBtn').hidden = false;
    $('trLog').textContent = '';
    updateProgress();
    const ticker = setInterval(updateProgress, 2000);

    const worker = async () => {
        while (!ctl.signal.aborted) {
            const batch = queue.shift();
            if (!batch) { if (run.inFlight === 0) return; await sleep(300); continue; }
            run.inFlight++;
            try {
                const { got, missing } = await runBatch(batch, ctx);
                applyTranslations(got);
                run.done += got.length;
                const retry = missing.filter((s) => ++s.tries <= 2);
                run.failed += missing.length - retry.length;
                if (retry.length) queue.push(retry);
            } catch (e) {
                if (e.name === 'AbortError' || ctl.signal.aborted) { /* стоп */ }
                else if (e.fatal) { ctx.log('Ошибка: ' + e.message); ctl.abort(); }
                else if (batch.length > 1) { const h = batch.length >> 1; queue.push(batch.slice(0, h), batch.slice(h)); ctx.log('Пакет разбит пополам: ' + e.message); }
                else { run.failed++; ctx.log('Не переведено: ' + e.message); }
            } finally { run.inFlight--; updateProgress(); }
        }
    };
    await Promise.all(Array.from({ length: settings.concurrency }, worker));
    clearInterval(ticker);
    updateProgress();
    if (ctl.signal.aborted) $('progress').textContent += ' — остановлено';
    else $('progress').textContent += ' — готово';
    run = null;
    ['trAllBtn', 'trPageBtn', 'trRangeBtn'].forEach((id) => ($(id).disabled = false));
    $('stopBtn').hidden = true;
}

async function translateOne(b) {
    if (b.err) b.err.textContent = '';
    b.item && b.item.classList.add('loading');
    try {
        const { got } = await runBatch([{ orig: b.orig }], { signal: new AbortController().signal, log: () => { } });
        b.manualText = false;
        applyTranslations(got);
        saveEdit(b);
    } catch (e) { if (b.err) b.err.textContent = e.message; }
    finally { b.item && b.item.classList.remove('loading'); }
}

$('trAllBtn').onclick = () => translateRange(1, state.pages.length);
$('trPageBtn').onclick = () => translateRange(state.current, state.current);
$('trRangeBtn').onclick = () => translateRange(+$('trFrom').value || 1, +$('trTo').value || state.pages.length);
$('stopBtn').onclick = () => run && run.ctl.abort();
$('resetTrBtn').onclick = async () => {
    if (!confirm('Сбросить перевод и все правки текста в этом документе?')) return;
    if (run) run.ctl.abort();
    const origs = [...state.byOrig.keys()];
    await idbPutMany('tm', origs.map((o) => [tmKey(o), undefined]));
    await idbDeletePrefix('edits', state.docKey + '|');
    origs.forEach((o) => state.tm.delete(o));
    for (const pg of state.pages) {
        pg.blocks.forEach(resetBlockRuntime);
        pg.tables.forEach((t) => { t.redraw = false; t.uniform = true; });
        if (pg.mounted && pg.mounted.rendered) renderPageOverlays(pg);
    }
    renderSidebar();
    $('progress').textContent = 'Перевод сброшен';
};