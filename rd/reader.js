/* ===== Arabic book reader: image-PDF import, OCR (Claude or on-device), styled reading, long-press dictionary ===== */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LS = { get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };
  const SDEF = { fs: 24, lh: 2.05, theme: 'auto', view: 'text', press: 'long', engine: 'claude', bin: false, bookDecks: true };
  const SET = Object.assign({}, SDEF, LS.get('rd-set', {}));
  const saveSet = () => LS.set('rd-set', SET);
  const isAr = s => /[ء-ي]/.test(s);
  const OFFLINE = !/^https?:$/.test(location.protocol);

  /* ---------------- storage (IndexedDB) ---------------- */
  const IDB_ = (function () {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        let r; try { r = indexedDB.open('hw-reader', 1); } catch (e) { return rej(e); }
        setTimeout(() => rej(new Error('storage timed out')), 5000);
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('books', { keyPath: 'id' }); d.createObjectStore('pdf'); d.createObjectStore('pages'); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    async function tx(store, mode, fn) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(store, mode), s = t.objectStore(store); let out;
        const q = fn(s); if (q) q.onsuccess = () => { out = q.result; };
        t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    }
    return {
      books: () => tx('books', 'readonly', s => s.getAll()).then(a => (a || []).sort((x, y) => (y.opened || y.added) - (x.opened || x.added))),
      book: id => tx('books', 'readonly', s => s.get(id)),
      putBook: b => tx('books', 'readwrite', s => s.put(b)),
      pdf: id => tx('pdf', 'readonly', s => s.get(id)),
      putPdf: (id, buf) => tx('pdf', 'readwrite', s => s.put(buf, id)),
      page: (id, n) => tx('pages', 'readonly', s => s.get(id + ':' + n)),
      putPage: (id, n, v) => tx('pages', 'readwrite', s => s.put(v, id + ':' + n)),
      pagesOf: async id => { const d = await open(); return new Promise((res, rej) => { const out = {}; const t = d.transaction('pages'); const rq = t.objectStore('pages').openCursor(IDBKeyRange.bound(id + ':', id + ':￿')); rq.onsuccess = () => { const c = rq.result; if (c) { out[+String(c.key).split(':').pop()] = c.value; c.continue(); } }; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); }); },
      del: async id => {
        await tx('books', 'readwrite', s => s.delete(id)); await tx('pdf', 'readwrite', s => s.delete(id));
        await tx('pages', 'readwrite', s => s.delete(IDBKeyRange.bound(id + ':', id + ':￿')));
      }
    };
  })();

  /* if this browser won't store data for the page (some saved-file views), keep books in memory instead */
  let MEMONLY = false;
  const MEM = { books: new Map(), pdf: new Map(), pages: new Map() };
  const memApi = {
    books: async () => [...MEM.books.values()].sort((x, y) => (y.opened || y.added) - (x.opened || x.added)),
    book: async id => MEM.books.get(id), putBook: async b => { MEM.books.set(b.id, b); },
    pdf: async id => MEM.pdf.get(id), putPdf: async (id, buf) => { MEM.pdf.set(id, buf); },
    page: async (id, n) => MEM.pages.get(id + ':' + n), putPage: async (id, n, v) => { MEM.pages.set(id + ':' + n, v); },
    pagesOf: async id => { const o = {}; for (const [k, v] of MEM.pages) if (k.startsWith(id + ':')) o[+k.split(':').pop()] = v; return o; },
    del: async id => { MEM.books.delete(id); MEM.pdf.delete(id); for (const k of [...MEM.pages.keys()]) if (k.startsWith(id + ':')) MEM.pages.delete(k); }
  };
  const DB = {};
  for (const k of Object.keys(memApi)) DB[k] = async (...a) => {
    if (!MEMONLY) { try { return await IDB_[k](...a); } catch (e) { MEMONLY = true; } }
    return memApi[k](...a);
  };

  /* ---------------- PDF (pdf.js, loaded on first use) ---------------- */
  let pdfLibP = null;
  function pdfLib() {
    if (pdfLibP) return pdfLibP;
    pdfLibP = new Promise((res, rej) => {
      if (window.pdfjsLib) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'rd/pdf.worker.min.js'; return res(window.pdfjsLib); }
      const s = document.createElement('script'); s.src = 'rd/pdf.min.js';
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'rd/pdf.worker.min.js';
        if (!OFFLINE && !window.RD_SINGLE) return res(window.pdfjsLib);
        /* opened from a file: browsers refuse workers there, so run pdf.js's worker code on the page itself */
        const w = document.createElement('script'); w.src = 'rd/pdf.worker.min.js';
        w.onload = () => res(window.pdfjsLib); w.onerror = () => res(window.pdfjsLib); document.head.appendChild(w);
      };
      s.onerror = () => { pdfLibP = null; rej(new Error('Could not load the PDF reader')); };
      document.head.appendChild(s);
    });
    return pdfLibP;
  }
  const docs = {};
  async function pdfDoc(id) {
    if (docs[id]) return docs[id];
    const lib = await pdfLib(); const buf = await DB.pdf(id);
    if (!buf) throw new Error('This book file is missing on this device');
    docs[id] = lib.getDocument({ data: new Uint8Array(buf.slice ? buf.slice(0) : buf) }).promise;
    return docs[id];
  }
  async function renderPage(id, n, width) {
    const d = await pdfDoc(id); const p = await d.getPage(n);
    const v1 = p.getViewport({ scale: 1 }); const sc = Math.min(4, width / v1.width);
    const vp = p.getViewport({ scale: sc });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }
  const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

  /* ---------------- OCR engines ---------------- */
  let SAMPLE = null, SAMPLE_IMG = false;
  try {
    if (window.claude && window.claude.use) window.claude.use('sample').then(async s => {
      SAMPLE = s || null;
      if (s) { try { const l = await s.limits(); SAMPLE_IMG = !!(l && l.images); } catch (e) { SAMPLE_IMG = true; } }
      if (UI.view === 'book') UI.renderJob();
    }).catch(() => { });
  } catch (e) { }
  const STANDALONE = !!window.RD_STANDALONE;
  const claudeOK = () => !STANDALONE && !!(SAMPLE && SAMPLE_IMG);

  const PROMPT = `You are transcribing one scanned page of an Arabic book for an e-reader.
Transcribe the Arabic text EXACTLY as printed: keep every letter, hamza and every vowel mark (tashkeel) that is printed; add no vowels that are not printed; do not correct, modernise, summarise or translate anything. Keep Qur'an brackets ﴿ ﴾, quotation marks and punctuation as printed. Join words broken across lines; do not keep the page's line breaks inside a paragraph.
Split the page into blocks in reading order and give each block one type:
- "title": a chapter or book title (large or decorated)
- "heading": a section heading
- "subheading": a smaller heading or a bold lead-in on its own line
- "paragraph": ordinary running text (one block per paragraph)
- "verse": a Qur'an verse set apart from the text
- "poetry": a line of poetry; separate its two halves with " … "
- "quote": a hadith or quotation set apart from the text
- "footnote": a footnote below the rule at the bottom of the page
Leave out running heads at the top of the page, page numbers and decorations.
Answer with JSON only, no other words, in this shape: {"blocks":[{"type":"paragraph","text":"..."}]}
If the page has no text, answer {"blocks":[]}.`;

  function parseBlocks(t) {
    t = String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('Unreadable answer');
    const j = JSON.parse(t.slice(a, b + 1));
    const ok = ['title', 'heading', 'subheading', 'paragraph', 'verse', 'poetry', 'quote', 'footnote'];
    return (j.blocks || []).filter(x => x && x.text && String(x.text).trim()).map(x => ({ t: ok.includes(x.type) ? x.type : 'paragraph', x: String(x.text).trim() }));
  }

  async function ocrClaude(id, n, signal) {
    const c = await renderPage(id, n, 1500);
    let blob = await toBlob(c, 'image/jpeg', 0.85);
    if (blob.size > 3.5e6) { const c2 = await renderPage(id, n, 1100); blob = await toBlob(c2, 'image/jpeg', 0.8); }
    const r = await SAMPLE(PROMPT, { images: [blob], modelTier: 'default', signal });
    return parseBlocks(r.text);
  }

  /* on-device: the dictionary page's embedded Tesseract Arabic model */
  let tessQ = Promise.resolve();
  function binarise(c) {
    const ctx = c.getContext('2d'), im = ctx.getImageData(0, 0, c.width, c.height), d = im.data, h = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = g; h[g]++; }
    let tot = d.length / 4, sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
    let sB = 0, wB = 0, best = 0, th = 128;
    for (let i = 0; i < 256; i++) { wB += h[i]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += i * h[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; th = i; } }
    for (let i = 0; i < d.length; i += 4) { const v = d[i] > th ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
    ctx.putImageData(im, 0, 0); return c;
  }
  function linesToBlocks(data, W) {
    let lines = (data.lines || []).filter(l => l.text && isAr(l.text)).map(l => ({ x: l.text.replace(/\s+/g, ' ').trim(), b: l.bbox }));
    if (!lines.length) {
      return String(data.text || '').split(/\n\s*\n/).map(s => s.replace(/\s*\n\s*/g, ' ').trim()).filter(s => isAr(s)).map(x => ({ t: 'paragraph', x }));
    }
    lines.sort((a, b) => a.b.y0 - b.b.y0);
    const hs = lines.map(l => l.b.y1 - l.b.y0).sort((a, b) => a - b), H = hs[hs.length >> 1] || 20;
    const R = Math.max(...lines.map(l => l.b.x1)), L = Math.min(...lines.map(l => l.b.x0)), TW = Math.max(1, R - L), mid = (R + L) / 2;
    /* drop a lone page number / running head */
    lines = lines.filter((l, i) => !(/^[\s\d٠-٩()\-–*]+$/.test(l.x)) && !(i === 0 && lines.length > 4 && (l.b.y1 - l.b.y0) <= H * 1.1 && (l.b.x1 - l.b.x0) < TW * .6 && lines[1].b.y0 - l.b.y1 > H * 1.3));
    const out = []; let cur = null, prev = null;
    for (const l of lines) {
      const h = l.b.y1 - l.b.y0, w = l.b.x1 - l.b.x0, cx = (l.b.x0 + l.b.x1) / 2;
      const centred = Math.abs(cx - mid) < TW * .08 && w < TW * .7, short = w < TW * .7;
      let type = 'paragraph';
      if (h > H * 1.3 && w < TW * .85 && l.x.split(' ').length <= 12) type = h > H * 1.6 ? 'title' : 'heading';
      else if (centred && l.x.split(' ').length <= 9) type = 'heading';
      const gap = prev ? l.b.y0 - prev.b.y1 : 0;
      const prevEnded = prev && (prev.b.x0 - L) > TW * .12;      /* previous line stopped short of the left margin */
      const indented = (R - l.b.x1) > H * 1.2;                     /* first line of a paragraph starts in from the right */
      const brk = !cur || type !== 'paragraph' || cur.t !== 'paragraph' || gap > H * .9 || prevEnded || indented;
      if (brk) { cur = { t: type, x: l.x, y0: l.b.y0, y1: l.b.y1 }; out.push(cur); }
      else { cur.x += ' ' + l.x; cur.y1 = l.b.y1; }
      prev = l;
    }
    /* merge consecutive headings that are really one wrapped heading */
    const m = [];
    for (const b of out) { const p = m[m.length - 1]; if (p && p.t === b.t && b.t !== 'paragraph' && p.x.length + b.x.length < 70 && b.y0 - p.y1 < H * .5) { p.x += ' ' + b.x; p.y1 = b.y1; } else m.push(Object.assign({}, b)); }
    const fix = x => { x = x.replace(/(\S)-\s+(\S)/g, '$1$2'); if (x.indexOf('«') < 0) x = x.replace(/\s*»/g, '،'); return x.replace(/\s+([،؛.:؟!])/g, '$1').replace(/\s{2,}/g, ' ').trim(); };
    return m.map(b => ({ t: b.t, x: fix(b.x) }));
  }
  function ocrDevice(id, n) {
    const job = tessQ.then(async () => {
      if (typeof OCR === 'undefined') throw new Error('On-device reader not available');
      const c = await renderPage(id, n, 1500);
      if (SET.bin) binarise(c);
      const w = await OCR.warm();
      await w.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '0' });
      const r = await w.recognize(c, {}, { text: true, blocks: true });
      return linesToBlocks(r.data, c.width);
    });
    tessQ = job.catch(() => { });
    return job;
  }

  /* ---------------- OCR job runner ---------------- */
  const JOB = { run: false, book: null, done: 0, total: 0, msg: '', ctl: null, queue: [] };
  async function startJob(book, from, to, engine, redo) {
    if (JOB.run) stopJob();
    const have = await DB.pagesOf(book.id);
    const q = []; for (let i = from; i <= to; i++) if (redo || !have[i]) q.push(i);
    if (!q.length) { toast('Those pages are already read'); return; }
    Object.assign(JOB, { run: true, book: book.id, done: 0, total: q.length, msg: '', queue: q, engine });
    UI.renderJob();
    let fails = 0;
    while (JOB.run && JOB.queue.length) {
      const n = JOB.queue[0];
      JOB.msg = `Reading page ${n}…`; UI.renderJob();
      try {
        JOB.ctl = new AbortController();
        const blocks = engine === 'claude' ? await ocrClaude(book.id, n, JOB.ctl.signal) : await ocrDevice(book.id, n);
        await DB.putPage(book.id, n, { b: blocks, e: engine, at: Date.now() });
        JOB.queue.shift(); JOB.done++; fails = 0;
        await bumpBook(book.id);
        if (UI.view === 'book' && UI.book && UI.book.id === book.id && UI.page === n) UI.showPage(n, { keepScroll: true });
      } catch (e) {
        if (!JOB.run) break;
        const code = e && e.code;
        if (code === 'not_granted') { JOB.msg = 'Claude reading was not allowed. Switch to “On this device” in ⚙️.'; JOB.run = false; break; }
        fails++;
        if (code === 'rate_limited' && fails <= 3) { JOB.msg = `Busy – waiting ${20 * fails}s…`; UI.renderJob(); await sleep(20000 * fails); continue; }
        if (fails <= 1) { await sleep(1500); continue; }
        JOB.msg = `Stopped at page ${n}: ${(e && e.message) || e}`; JOB.run = false; break;
      }
    }
    if (JOB.run) { JOB.msg = `Finished – ${JOB.done} page${JOB.done === 1 ? '' : 's'} read`; JOB.run = false; }
    UI.renderJob(); if (UI.view === 'lib') UI.library();
  }
  function stopJob() { JOB.run = false; try { JOB.ctl && JOB.ctl.abort(); } catch (e) { } JOB.msg = 'Paused'; UI.renderJob(); }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function bumpBook(id) {
    const b = await DB.book(id); if (!b) return;
    const have = await DB.pagesOf(id); b.read = Object.keys(have).length;
    await DB.putBook(b); if (UI.book && UI.book.id === id) UI.book.read = b.read;
  }

  /* ---------------- rendering a page ---------------- */
  function wrapWords(s) {
    return esc(s).replace(/[^\s<>&;,.:؛،؟!?()«»"\[\]{}﴿﴾…\-–—]+/g, m => isAr(m) ? `<span class="w">${m}</span>` : m);
  }
  function blocksHtml(blocks) {
    let h = '', fn = false;
    for (const b of blocks) {
      if (b.t === 'footnote' && !fn) { h += '<hr class="fnrule">'; fn = true; }
      if (b.t === 'title') h += `<h2 class="t-title">${wrapWords(b.x)}</h2>`;
      else if (b.t === 'heading') h += `<h3 class="t-heading">${wrapWords(b.x)}</h3>`;
      else if (b.t === 'subheading') h += `<h4 class="t-subheading">${wrapWords(b.x)}</h4>`;
      else if (b.t === 'poetry') h += `<div class="t-poetry">${b.x.split(/\s*(?:…|\.\.\.|\*\*\*)\s*/).map(x => `<span class="hm">${wrapWords(x)}</span>`).join('')}</div>`;
      else h += `<p class="t-${b.t}">${wrapWords(b.x)}</p>`;
    }
    return h;
  }
  /* plain-text markup for the editor */
  const MK = { title: '# ', heading: '## ', subheading: '### ', verse: '> ', quote: '" ', poetry: '% ', footnote: '~ ', paragraph: '' };
  const toMarkup = bl => bl.map(b => MK[b.t] + b.x).join('\n\n');
  function fromMarkup(s) {
    return s.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => {
      for (const [t, k] of [['subheading', '### '], ['heading', '## '], ['title', '# '], ['verse', '> '], ['quote', '" '], ['poetry', '% '], ['footnote', '~ ']]) if (p.startsWith(k)) return { t, x: p.slice(k.length).replace(/\s*\n\s*/g, ' ').trim() };
      return { t: 'paragraph', x: p.replace(/\s*\n\s*/g, ' ') };
    });
  }

  /* ---------------- dictionary lookup ---------------- */
  function cleanWord(w) { return w.replace(/[ـ]/g, '').replace(/[^ء-ْٰٱ]/g, ''); }
  function lookup(el) {
    const w = cleanWord(el.textContent); if (!w) return;
    document.querySelectorAll('#rd .w.on').forEach(x => x.classList.remove('on'));
    el.classList.add('on');
    try { navigator.vibrate && navigator.vibrate(15); } catch (e) { }
    document.body.classList.add('rd-look');
    $('#rdLookW').textContent = w;
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30);
    if (window.HWAPI) { window.HWAPI.search(w); window.scrollTo(0, 0); }
    else toast('The dictionary is still opening…');
  }
  function closeLook() { document.body.classList.remove('rd-look'); document.querySelectorAll('#rd .w.on').forEach(x => x.classList.remove('on')); }
  /* long-press (or tap) on a word */
  let pt = null;
  function bindPress(root) {
    root.addEventListener('pointerdown', e => {
      const el = e.target.closest('.w'); if (!el) return;
      if (SET.press === 'tap') { pt = { el, x: e.clientX, y: e.clientY, tap: true }; return; }
      el.classList.add('press');
      pt = { el, x: e.clientX, y: e.clientY, t: setTimeout(() => { el.classList.remove('press'); pt && (pt.fired = true); lookup(el); }, 480) };
    });
    const cancel = () => { if (pt) { clearTimeout(pt.t); pt.el.classList.remove('press'); } };
    root.addEventListener('pointermove', e => { if (pt && Math.hypot(e.clientX - pt.x, e.clientY - pt.y) > 10) { cancel(); pt = null; } });
    root.addEventListener('pointerup', e => { if (pt && pt.tap && e.target.closest('.w') === pt.el) lookup(pt.el); cancel(); pt = null; });
    root.addEventListener('pointercancel', () => { cancel(); pt = null; });
    root.addEventListener('contextmenu', e => { if (e.target.closest('.w')) e.preventDefault(); });
    /* in lookup mode, a plain tap on another word looks it up too */
    root.addEventListener('click', e => { const el = e.target.closest('.w'); if (el && document.body.classList.contains('rd-look') && !el.classList.contains('on')) lookup(el); });
  }

  /* ---------------- flashcard badge (shared with the dictionary) ---------------- */
  function dueCount() { const c = LS.get('hw-cards', []); const t = Date.now(); return Array.isArray(c) ? c.filter(x => x.due <= t).length : 0; }
  function openCards() { closeReader(true); if (window.HWAPI) window.HWAPI.cards(); }
  function openDictOpts() { closeReader(true); if (window.HWAPI) window.HWAPI.opts(); }

  function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }

  /* ---------------- UI ---------------- */
  const root = document.createElement('div'); root.id = 'rd'; root.className = 'hidden';
  document.body.appendChild(root);
  bindPress(root);
  function applyLook() {
    root.className = root.className.replace(/\bth-\w+/g, '').trim() + ' th-' + SET.theme;
    root.style.setProperty('--fs', SET.fs + 'px'); root.style.setProperty('--lh', SET.lh);
  }

  const UI = {
    view: 'lib', book: null, page: 1, pages: {},
    shell(barHtml, bodyHtml) {
      root.innerHTML = `<div class="lookbar"><span class="lw" id="rdLookW"></span><button id="rdBig" title="Bigger book view">⇕</button><button id="rdLookX">✕ Close dictionary</button></div>
        <div class="bar">${barHtml}</div><div id="rdJob"></div><div class="body" id="rdBody"><div class="wrap">${bodyHtml}</div></div>`;
      $('#rdLookX').onclick = closeLook;
      $('#rdBig').onclick = () => { const cur = getComputedStyle(document.body).getPropertyValue('--rdh').trim(); document.body.style.setProperty('--rdh', cur === '62vh' ? '40vh' : '62vh'); };
      applyLook();
    },
    async library() {
      UI.view = 'lib'; UI.book = null;
      const books = await DB.books().catch(() => null);
      const n = dueCount();
      UI.shell(`<button id="rdX">✕</button><span class="ttl">📚 My Arabic books</span><button id="rdCards">🗂${n ? `<span class="badge">${n}</span>` : ''}</button><button id="rdSet">⚙️</button>`,
        `<div class="panel"><div class="row" style="margin-top:0"><span class="addwrap"><span class="filebtn">＋ Add a book (PDF)</span><input type="file" id="rdFile" accept=".pdf,application/pdf" aria-label="Add a book (PDF)"></span>${STANDALONE ? '' : `<button id="rdOff" style="margin-inline-start:auto">${OFFLINE ? '✈️ Offline copy' : '⬇ Offline copy'}</button>`}</div>
         <div class="hint" id="rdImpMsg" style="margin-top:6px;font-weight:600"></div>
         <div class="hint" style="margin-top:8px">Add a scanned Arabic book. The reader turns each page into clean text with its titles and headings, then you can <b>long-press any word</b> to see it in Hans Wehr and the other dictionaries and add it to your flashcards. Books stay on this device.</div></div>
         ${MEMONLY ? '<div class="panel hint">This browser won\'t let this saved page keep data, so books you add now last only until you close it. Books saved inside the file are always here.</div>' : ''}
         ${books == null ? '<div class="empty">This browser is not letting the page store books (private mode?).</div>' : !books.length ? '<div class="empty">No books yet.</div>' :
          `<div class="books">${books.map(b => `<div class="bk" data-open="${b.id}">${b.cover ? `<img src="${b.cover}" alt="">` : '<div class="noimg"></div>'}<div class="meta"><div class="bt ${isAr(b.title) ? 'ar' : ''}">${esc(b.title)}</div>
            <div class="hint">${b.read || 0} of ${b.n} pages read</div><div class="pbar"><div style="width:${Math.round(100 * (b.read || 0) / b.n)}%"></div></div></div></div>`).join('')}</div>`}`);
      $('#rdX').onclick = () => closeReader();
      $('#rdCards').onclick = openCards;
      $('#rdSet').onclick = () => UI.settings();
      if ($('#rdOff')) $('#rdOff').onclick = () => UI.offline();
      $('#rdFile').onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importPdf(f); setTimeout(() => { try { e.target.value = ''; } catch (x) { } }, 0); };
      /* dropping a PDF anywhere on the library works too */
      $('#rdBody').ondragover = e => e.preventDefault();
      $('#rdBody').ondrop = e => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) importPdf(f); };
      root.querySelectorAll('[data-open]').forEach(el => el.onclick = () => UI.open(el.dataset.open));
      UI.renderJob();
    },
    async open(id, page) {
      const b = await DB.book(id); if (!b) return UI.library();
      UI.book = b; UI.view = 'book'; UI.pages = await DB.pagesOf(id);
      b.opened = Date.now(); DB.putBook(b);
      LS.set('rd-last', { id, open: true });
      bookDeck(b.title);
      const n = dueCount();
      UI.shell(`<button id="rdBack">‹ Books</button><span class="ttl ${isAr(b.title) ? 'ar' : ''}" id="rdTitle">${esc(b.title)}</span><button id="rdToc" title="Contents">☰</button><button id="rdCards">🗂${n ? `<span class="badge">${n}</span>` : ''}</button><button id="rdSet">Aa</button>`,
        `<div id="rdPage"></div>
         <div class="nav"><button id="rdNext">◀ Next</button><span><input class="in" id="rdNum" inputmode="numeric"> / ${b.n}</span><button id="rdPrev">Prev ▶</button></div>`);
      $('#rdBack').onclick = () => { LS.set('rd-last', { id, open: false }); bookDeck(null); UI.library(); };
      $('#rdToc').onclick = () => UI.toc();
      $('#rdCards').onclick = openCards;
      $('#rdSet').onclick = () => UI.settings();
      $('#rdTitle').onclick = () => UI.bookMenu();
      $('#rdNext').onclick = () => UI.showPage(UI.page + 1);
      $('#rdPrev').onclick = () => UI.showPage(UI.page - 1);
      $('#rdNum').onchange = () => { const v = parseInt($('#rdNum').value, 10); if (v) UI.showPage(v); };
      /* swipe: Arabic books turn to the left */
      let sx = null, sy = 0;
      $('#rdBody').addEventListener('touchstart', e => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
      $('#rdBody').addEventListener('touchend', e => { if (sx == null || document.body.classList.contains('rd-look')) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null; if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) UI.showPage(UI.page + (dx > 0 ? 1 : -1)); }, { passive: true });
      UI.renderJob();
      UI.showPage(page || b.last || 1);
    },
    async showPage(n, o = {}) {
      const b = UI.book; if (!b) return;
      n = Math.max(1, Math.min(b.n, n | 0)); const changed = n !== UI.page; UI.page = n; $('#rdNum').value = n;
      if (b.last !== n) { b.last = n; DB.putBook(b); }
      const pg = await DB.page(b.id, n); if (pg) UI.pages[n] = pg;
      if (UI.page !== n) return;
      const box = $('#rdPage'); const body = $('#rdBody'); const st = body.scrollTop;
      const editing = o.edit;
      let h = '';
      if (editing) {
        h = `<div class="pg edit"><div class="hint" style="margin-bottom:6px">Fix the text, then Save. Leave a blank line between paragraphs. Start a line with <b>#</b> for a title, <b>##</b> heading, <b>###</b> sub-heading, <b>&gt;</b> Qur'an verse, <b>"</b> quotation, <b>%</b> poetry (halves split by …), <b>~</b> footnote.</div>
          <textarea id="rdEd">${esc(pg ? toMarkup(pg.b) : '')}</textarea><div class="row"><button class="pri" id="rdSave">Save page</button><button id="rdCancel">Cancel</button></div></div>`;
      } else if (pg && SET.view !== 'scan') {
        h = `<div class="pg"><div class="txt">${pg.b.length ? blocksHtml(pg.b) : '<div class="empty">No text on this page.</div>'}</div><div class="pno">— ${n} —</div></div>`;
        h += `<div class="row" style="justify-content:center"><button id="rdEdit">✏️ Correct text</button><button id="rdShowScan">${SET.view === 'both' ? '🖼 Hide scan' : '🖼 Show scan'}</button><button id="rdRedo">↻ Read again</button></div>`;
        if (SET.view === 'both') h += `<div class="pg scanbox" id="rdScan"><div class="hint">Loading page image…</div></div>`;
      } else {
        h = `<div class="pg scanbox" id="rdScan"><div class="hint">Loading page image…</div></div>`;
        h += pg ? `<div class="row" style="justify-content:center"><button id="rdShowScan">📖 Show text</button></div>`
          : `<div class="panel" style="text-align:center"><div>This page hasn't been turned into text yet.</div><div class="row" style="justify-content:center"><button class="pri" id="rdOne">Read this page</button><button id="rdAll">Read from here to the end</button></div></div>`;
      }
      box.innerHTML = h;
      if (changed && !o.keepScroll) body.scrollTop = 0; else body.scrollTop = st;
      if ($('#rdScan')) renderPage(b.id, n, Math.min(1600, Math.max(700, box.clientWidth * (window.devicePixelRatio || 1)))).then(c => { const s = $('#rdScan'); if (s && UI.page === n) { s.innerHTML = ''; c.className = 'scan'; s.appendChild(c); } }).catch(e => { const s = $('#rdScan'); if (s) s.innerHTML = `<div class="hint">${esc(e.message)}</div>`; });
      const on = (id, f) => { const el = $(id); if (el) el.onclick = f; };
      on('#rdEdit', () => UI.showPage(n, { edit: true, keepScroll: true }));
      on('#rdCancel', () => UI.showPage(n, { keepScroll: true }));
      on('#rdSave', async () => { const bl = fromMarkup($('#rdEd').value); await DB.putPage(b.id, n, { b: bl, e: (pg && pg.e) || 'edit', at: Date.now(), edited: true }); await bumpBook(b.id); UI.showPage(n, { keepScroll: true }); toast('Saved'); });
      on('#rdShowScan', () => { SET.view = SET.view === 'text' ? 'both' : SET.view === 'both' ? 'text' : 'text'; saveSet(); UI.showPage(n, { keepScroll: true }); });
      on('#rdRedo', () => UI.readSheet(n, n, true));
      on('#rdOne', () => startJob(b, n, n, engineNow(), false));
      on('#rdAll', () => startJob(b, n, b.n, engineNow(), false));
      /* read ahead quietly: prepare the next page image in the PDF worker */
      pdfDoc(b.id).then(d => n < b.n && d.getPage(n + 1)).catch(() => { });
    },
    renderJob() {
      const el = $('#rdJob'); if (!el) return;
      const b = UI.book;
      if (JOB.book && (JOB.run || JOB.msg) && (!b || JOB.book === b.id)) {
        const pct = JOB.total ? Math.round(100 * JOB.done / JOB.total) : 0;
        el.innerHTML = `<div class="job"><span>${JOB.run ? '⏳' : 'ℹ️'} ${esc(JOB.msg)} ${JOB.total ? `(${JOB.done}/${JOB.total})` : ''}</span><div class="pbar"><div style="width:${pct}%"></div></div>
          ${JOB.run ? '<button id="rdStop">Pause</button>' : (JOB.queue.length ? '<button id="rdGo">Continue</button>' : '')}<button id="rdJobX">✕</button></div>`;
        const s = $('#rdStop'); if (s) s.onclick = stopJob;
        const g = $('#rdGo'); if (g) g.onclick = async () => { const bk = await DB.book(JOB.book); startJob(bk, JOB.queue[0], JOB.queue[JOB.queue.length - 1], JOB.engine, false); };
        $('#rdJobX').onclick = () => { if (JOB.run) stopJob(); JOB.msg = ''; JOB.book = null; el.innerHTML = ''; };
      } else if (b && (b.read || 0) < b.n && !JOB.run) {
        el.innerHTML = `<div class="job"><span>${b.read || 0} of ${b.n} pages turned into text.</span><span style="flex:1"></span><button class="pri" id="rdReadAll">Read the book</button></div>`;
        $('#rdReadAll').onclick = () => UI.readSheet(1, b.n, false);
      } else el.innerHTML = '';
    },
    sheet(html) {
      const s = document.createElement('div'); s.className = 'sheet'; s.innerHTML = `<div>${html}</div>`;
      s.onclick = e => { if (e.target === s) s.remove(); };
      root.appendChild(s); return s;
    },
    readSheet(from, to, redo) {
      const b = UI.book;
      const s = UI.sheet(`<h3>Turn pages into text</h3>
        <div class="sec">Reader</div>${engineChoice()}
        <div class="sec">Pages</div><div class="row">From <input class="in" id="rsF" type="number" min="1" max="${b.n}" value="${from}" style="width:80px"> to <input class="in" id="rsT" type="number" min="1" max="${b.n}" value="${to}" style="width:80px"></div>
        <label class="opt"><input type="checkbox" id="rsRedo" ${redo ? 'checked' : ''}><span>Read again pages that already have text (replaces your corrections)</span></label>
        <div class="hint">You can keep reading while it works. It carries on page by page and you can pause any time.</div>
        <div class="row"><button class="pri" id="rsGo">Start</button><button id="rsX">Cancel</button></div>`);
      bindEngine(s);
      s.querySelector('#rsX').onclick = () => s.remove();
      s.querySelector('#rsGo').onclick = () => { const f = +s.querySelector('#rsF').value || 1, t = +s.querySelector('#rsT').value || b.n; s.remove(); startJob(b, Math.max(1, Math.min(f, t)), Math.min(b.n, Math.max(f, t)), engineNow(), s.querySelector('#rsRedo').checked); };
    },
    async toc() {
      const b = UI.book; UI.pages = await DB.pagesOf(b.id);
      const items = [];
      for (const [n, pg] of Object.entries(UI.pages).sort((a, c) => a[0] - c[0])) for (const bl of pg.b) if (bl.t === 'title' || bl.t === 'heading') items.push({ n: +n, t: bl.t, x: bl.x });
      const s = UI.sheet(`<h3>Contents</h3>${items.length ? `<div class="toc">${items.map(it => `<a class="${it.t === 'title' ? 'l1' : 'l2'}" data-p="${it.n}"><span class="ar">${esc(it.x)}</span><small>p. ${it.n}</small></a>`).join('')}</div>`
        : '<div class="hint">Titles and headings appear here as pages are turned into text.</div>'}
        <div class="row"><button id="tcX">Close</button></div>`);
      s.querySelector('#tcX').onclick = () => s.remove();
      s.querySelectorAll('[data-p]').forEach(a => a.onclick = () => { s.remove(); UI.showPage(+a.dataset.p); });
    },
    bookMenu() {
      const b = UI.book;
      const s = UI.sheet(`<h3>This book</h3><div class="sec">Title</div><input class="in" id="bmT" value="${esc(b.title)}" style="width:100%;font-family:var(--ar);font-size:20px">
        <div class="row"><button class="pri" id="bmSave">Save title</button></div>
        <div class="sec">Flashcards</div><div class="row"><button class="pri" id="bmDeck">🗂 Study this book's words (${window.HWAPI && HWAPI.deckCount ? HWAPI.deckCount(b.title) : 0})</button></div>
        <div class="hint">${SET.bookDecks ? 'Words you look up in this book are saved in the deck “' + esc(b.title) + '”. You can rename or reorganise decks in 🗂 Flashcards → 📚 Decks.' : 'Book decks are turned off in Aa settings.'}</div>
        <div class="sec">Text</div><div class="row"><button id="bmRead">Turn pages into text…</button><button id="bmCopy">📋 Copy the whole book's text</button></div>
        <div class="sec">Remove</div><div class="row"><button id="bmDel" style="color:#a23423">Delete this book from this device</button></div><div id="bmMsg" class="hint"></div>`);
      s.querySelector('#bmDeck').onclick = () => { s.remove(); closeReader(true); if (window.HWAPI && HWAPI.studyDeck) HWAPI.studyDeck(b.title); };
      s.querySelector('#bmSave').onclick = async () => { const old = b.title; b.title = s.querySelector('#bmT').value.trim() || b.title; if (window.HWAPI && HWAPI.renameDeck && old !== b.title) HWAPI.renameDeck(old, b.title); bookDeck(b.title); await DB.putBook(b); $('#rdTitle').textContent = b.title; s.remove(); };
      s.querySelector('#bmRead').onclick = () => { s.remove(); UI.readSheet(1, b.n, false); };
      s.querySelector('#bmCopy').onclick = async () => {
        const pages = await DB.pagesOf(b.id);
        const txt = Object.entries(pages).sort((a, c) => a[0] - c[0]).map(([n, p]) => toMarkup(p.b)).join('\n\n');
        try { await navigator.clipboard.writeText(txt); s.querySelector('#bmMsg').textContent = 'Copied.'; } catch (e) { s.querySelector('#bmMsg').textContent = 'Copying was blocked here.'; }
      };
      let armed = false;
      s.querySelector('#bmDel').onclick = async e => {
        if (!armed) { armed = true; e.target.textContent = 'Tap again to delete'; return; }
        if (JOB.book === b.id) stopJob();
        await DB.del(b.id); delete docs[b.id]; s.remove(); UI.library();
      };
    },
    settings() {
      const s = UI.sheet(`<h3>Reading settings</h3>
        <div class="sec">Text size</div><div class="row"><button id="stS">A−</button><span id="stV">${SET.fs}px</span><button id="stL">A+</button>
          <span style="flex:1"></span><span>Line spacing</span><div class="seg">${[1.7, 2.05, 2.4].map(v => `<button data-lh="${v}" class="${SET.lh == v ? 'on' : ''}">${v === 1.7 ? 'Tight' : v === 2.05 ? 'Normal' : 'Loose'}</button>`).join('')}</div></div>
        <div class="sec">Page colour</div><div class="seg">${[['auto', 'Auto'], ['white', 'White'], ['sepia', 'Sepia'], ['dark', 'Dark']].map(([k, l]) => `<button data-th="${k}" class="${SET.theme === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="sec">Show</div><div class="seg">${[['text', 'Text'], ['both', 'Text + scan'], ['scan', 'Scan only']].map(([k, l]) => `<button data-vw="${k}" class="${SET.view === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="sec">Look up a word by</div><div class="seg">${[['long', 'Long-press'], ['tap', 'Tap']].map(([k, l]) => `<button data-pr="${k}" class="${SET.press === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="sec">Turning pages into text</div>${engineChoice()}
        <label class="opt"><input type="checkbox" id="stDecks" ${SET.bookDecks ? 'checked' : ''}><span>Save the words I look up in each book into a flashcard deck named after the book</span></label>
        <label class="opt"><input type="checkbox" id="stBin" ${SET.bin ? 'checked' : ''}><span>Clean up the scan (black and white) before the on-device reader – helps with grey or yellowed pages</span></label>
        <div class="sec">Dictionaries &amp; flashcards</div>
        <div class="row"><button id="stDict">📖 Choose dictionaries (Hans Wehr, Lane, Lisan…)</button><button id="stFc">🗂 Flashcard test schedule</button></div>
        <div class="row"><button class="pri" id="stX">Done</button></div>`);
      const re = () => { applyLook(); if (UI.view === 'book') UI.showPage(UI.page, { keepScroll: true }); };
      s.querySelector('#stS').onclick = () => { SET.fs = Math.max(16, SET.fs - 2); s.querySelector('#stV').textContent = SET.fs + 'px'; saveSet(); applyLook(); };
      s.querySelector('#stL').onclick = () => { SET.fs = Math.min(44, SET.fs + 2); s.querySelector('#stV').textContent = SET.fs + 'px'; saveSet(); applyLook(); };
      const seg = (attr, key, num) => s.querySelectorAll(`[data-${attr}]`).forEach(x => x.onclick = () => { SET[key] = num ? +x.dataset[attr] : x.dataset[attr]; saveSet(); s.querySelectorAll(`[data-${attr}]`).forEach(y => y.classList.toggle('on', y === x)); re(); });
      seg('lh', 'lh', true); seg('th', 'theme'); seg('vw', 'view'); seg('pr', 'press');
      bindEngine(s);
      s.querySelector('#stBin').onchange = e => { SET.bin = e.target.checked; saveSet(); };
      s.querySelector('#stDecks').onchange = e => { SET.bookDecks = e.target.checked; saveSet(); bookDeck(UI.view === 'book' && UI.book ? UI.book.title : null); };
      s.querySelector('#stDict').onclick = () => { s.remove(); openDictOpts(); };
      s.querySelector('#stFc').onclick = () => { s.remove(); openCards(); setTimeout(() => { const t = document.querySelector('[data-fct="settings"]'); if (t) t.click(); }, 60); };
      s.querySelector('#stX').onclick = () => s.remove();
    }
  };
  UI.offline = function () {
    if (OFFLINE) {
      const s = UI.sheet(`<h3>✈️ You're using the offline copy</h3>
        <div>Everything here works without internet: your books, the on-device page reader, all ten dictionaries, the Hans Wehr page scans and your flashcards.</div>
        <div class="hint" style="margin-top:8px">Books and flashcards you add here stay in this copy only. The Claude page reader needs the online page.</div>
        <div class="row"><button class="pri" id="ofX">OK</button></div>`);
      s.querySelector('#ofX').onclick = () => s.remove(); return;
    }
    const s = UI.sheet(`<h3>⬇ Save for offline use</h3>
      <div class="sec">Format</div>
      <label class="opt"><input type="radio" name="ofFmt" value="html" checked><span><b>One HTML file</b> – save it and open it in your browser (Chrome, Safari, Edge, Firefox) on a phone or computer.</span></label>
      <label class="opt"><input type="radio" name="ofFmt" value="zip"><span><b>Zip folder</b> – for a computer: unzip it and open index.html.</span></label>
      <div class="sec">What to include</div>
      <label class="opt"><input type="checkbox" checked disabled><span>Reader, Hans Wehr, on-device page reader, your flashcards and settings (about 7 MB)</span></label>
      <label class="opt"><input type="checkbox" id="ofX9" checked><span>The other nine dictionaries – Lane, Lisan, al-Wasit, Mufradat… (about 30 MB)</span></label>
      <label class="opt"><input type="checkbox" id="ofPg"><span>Hans Wehr page scans for “See page in book” (about 43 MB)</span></label>
      <label class="opt"><input type="checkbox" id="ofPdf" checked><span>My books, with the text already read${''} and their scans (needed to see the original pages and read new pages offline)</span></label>
      <div class="hint">A smaller file opens faster on a phone. Make a fresh copy after you add books or flashcards here.</div>
      <div class="pbar" style="margin-top:10px"><div id="ofBar"></div></div><div class="hint" id="ofMsg"></div>
      <div class="row"><button class="pri" id="ofGo">Save</button><button id="ofX">Close</button></div>`);
    s.querySelector('#ofX').onclick = () => s.remove();
    s.querySelector('#ofGo').onclick = async e => {
      e.target.disabled = true;
      const msg = t => { s.querySelector('#ofMsg').textContent = t; }, bar = f => { s.querySelector('#ofBar').style.width = Math.round(f * 100) + '%'; };
      const fmt = s.querySelector('input[name=ofFmt]:checked').value;
      const opt = { x9: s.querySelector('#ofX9').checked, pages: s.querySelector('#ofPg').checked, pdf: s.querySelector('#ofPdf').checked };
      try {
        const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
        const file = fmt === 'html' ? await buildSingle(opt, msg, bar) : await buildOffline(opt, msg, bar);
        const name = fmt === 'html' ? 'Hans-Wehr-Reader.html' : 'Hans-Wehr-Reader-Offline.zip';
        msg('Saving ' + (file.size / 1048576).toFixed(0) + ' MB…');
        if (dl) { await dl.save({ filename: name, data: file }); msg(fmt === 'html' ? 'Saved. Open Hans-Wehr-Reader.html in your browser.' : 'Saved. Unzip it and open index.html.'); }
        else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove(); msg('Done.'); }
      } catch (err) {
        msg(err && err.code === 'declined' ? 'Not saved.' : 'Could not make the copy: ' + ((err && err.message) || err));
      }
      e.target.disabled = false;
    };
  };

  /* ---- the list of the site's own files ---- */
  function siteFiles(opt) {
    const f = ['index.html', 'rd/reader.js', 'rd/reader.css', 'rd/pdf.min.js', 'rd/pdf.worker.min.js'];
    if (opt.pages) for (let i = 0; i <= 56; i++) f.push('pages/p' + String(i).padStart(3, '0') + '.js');
    if (opt.x9) {
      const nn = ['00']; for (let i = 2; i <= 28; i++) nn.push(String(i).padStart(2, '0'));
      for (const d of ['wasit', 'mufradat', 'lisan', 'sihah', 'maqayis', 'ghani', 'muhit', 'muasira', 'lane']) {
        for (const n of nn) f.push(`x/${d}-${n}.js`);
        if (['ghani', 'muasira', 'mufradat'].includes(d)) f.push(`x/${d}-zz.js`);
      }
    }
    return f;
  }
  async function collect(opt, msg, bar) {
    const files = siteFiles(opt), out = {};
    for (let i = 0; i < files.length; i++) {
      msg(`Collecting ${files[i]}…`); bar(i / (files.length + 2) * .85);
      let r = null; try { r = await fetch(files[i], { cache: 'no-cache' }); } catch (e) { }
      if (!r || !r.ok) { if (files[i] === 'index.html' || files[i].startsWith('rd/')) throw new Error('could not read ' + files[i]); continue; }
      out[files[i]] = new Uint8Array(await r.arrayBuffer());
    }
    msg('Copying your books and flashcards…');
    const seed = { made: Date.now(), books: [], pages: {}, pdf: {}, ls: {} };
    for (const k of ['hw-cards', 'hw-fc-set', 'hw-opts', 'hw-recent', 'rd-set']) { try { const v = localStorage.getItem(k); if (v != null) seed.ls[k] = v; } catch (e) { } }
    if (!opt.x9) { try { const o = JSON.parse(seed.ls['hw-opts'] || '{}'); for (const k of ['wasit', 'mufradat', 'lisan', 'sihah', 'maqayis', 'ghani', 'muhit', 'muasira', 'lane']) o[k] = false; seed.ls['hw-opts'] = JSON.stringify(o); } catch (e) { } }
    const books = await DB.books().catch(() => []);
    for (const b of books) {
      seed.books.push(b); seed.pages[b.id] = await DB.pagesOf(b.id);
      if (opt.pdf) { const p = await DB.pdf(b.id); if (p) seed.pdf[b.id] = b64of(p); }
    }
    out['rd/library.js'] = new TextEncoder().encode('window.RD_SEED = ' + JSON.stringify(seed) + ';\n');
    return out;
  }
  function b64of(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }

  /* ---- zip folder ---- */
  async function buildOffline(opt, msg, bar) {
    const files = await collect(opt, msg, bar), enc = new TextEncoder(), DIR = 'Hans-Wehr-Reader/', out = [];
    for (const [name, u0] of Object.entries(files)) {
      let u = u0;
      if (name === 'index.html') {
        let t = new TextDecoder().decode(u);
        if (t.indexOf('rd/library.js') < 0) t = t.replace('<script src="rd/reader.js"></script>', '<script src="rd/library.js"></script>\n<script src="rd/reader.js"></script>');
        u = enc.encode(t);
      }
      out.push({ name: DIR + name, data: u });
    }
    out.push({ name: DIR + 'READ ME.txt', data: enc.encode('Hans Wehr Reader - offline copy\r\n\r\nKeep this whole folder together and open index.html in Chrome, Edge or Firefox.\r\nNo internet is needed. Tap "Reader" for your books.\r\n') });
    bar(.95); msg('Packing…');
    const z = makeZip(out); bar(1); return z;
  }

  /* ---- one self-contained HTML file: every script the page loads later is stored inside it ---- */
  async function buildSingle(opt, msg, bar) {
    const files = await collect(opt, msg, bar), dec = new TextDecoder();
    msg('Building the HTML file…'); bar(.9);
    const safe = t => t.replace(/<\/(script)/gi, '<\\/$1');
    let html = dec.decode(files['index.html']);
    const take = n => { const u = files[n]; delete files[n]; return u ? dec.decode(u) : ''; };
    const css = take('rd/reader.css'), rjs = take('rd/reader.js'), lib = take('rd/library.js'), pdfjs = take('rd/pdf.min.js'), pdfw = take('rd/pdf.worker.min.js');
    const shim = `<script>/* single-file mode: scripts the page asks for by name are served from the copies stored in this file */
(function () {
  window.RD_SINGLE = true;
  const ap = Node.prototype.appendChild;
  Node.prototype.appendChild = function (c) {
    if (c && c.tagName === 'SCRIPT' && c.getAttribute('src')) {
      const rel = c.getAttribute('src'), b = document.getElementById('B:' + rel);
      if (b) { const s = document.createElement('script'); s.textContent = b.textContent; ap.call(document.head, s); b.textContent = ''; b.remove(); setTimeout(() => c.dispatchEvent(new Event('load')), 0); return c; }
      if (/^(x|pages|rd)\\//.test(rel)) { setTimeout(() => c.dispatchEvent(new Event('error')), 0); return c; }
    }
    return ap.call(this, c);
  };
})();
<\/script>`;
    html = html.replace(/<head>/i, '<head>\n' + shim);
    html = html.replace('<link rel="stylesheet" href="rd/reader.css">', () => '<style>\n' + css + '\n</style>');
    let blobs = '';
    blobs += `<script type="text/plain" id="B:rd/pdf.min.js">${safe(pdfjs)}</script>\n`;
    blobs += `<script type="text/plain" id="B:rd/pdf.worker.min.js">${safe(pdfw)}</script>\n`;
    for (const [n, u] of Object.entries(files)) if (n !== 'index.html') blobs += `<script type="text/plain" id="B:${n}">${safe(dec.decode(u))}</script>\n`;
    html = html.replace('<script src="rd/reader.js"></script>', () => blobs + '<script>\n' + safe(lib) + '\n</script>\n<script>\n' + safe(rjs) + '\n</script>');
    bar(1);
    return new Blob([html], { type: 'text/html' });
  }
  /* ---- a plain (stored, uncompressed) zip ---- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function makeZip(entries) {
    const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
    const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    for (const e of entries) {
      const name = enc.encode(e.name), size = e.data.length, crc = crc32(e.data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, e.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      cen.push(c.buffer, name);
      off += 30 + name.length + size;
    }
    const cenSize = cen.reduce((a, b) => a + b.byteLength, 0);
    const z = new DataView(new ArrayBuffer(22));
    z.setUint32(0, 0x06054b50, true); z.setUint16(8, entries.length, true); z.setUint16(10, entries.length, true); z.setUint32(12, cenSize, true); z.setUint32(16, off, true);
    return new Blob([...parts, ...cen, z.buffer], { type: 'application/zip' });
  }
  window.__rdBuild = { buildOffline, buildSingle };
  /* ---- offline copy: bring in the books and flashcards it was made with (once) ---- */
  async function importSeed() {
    const S = window.RD_SEED; if (!S) return;
    const done = LS.get('rd-seeded', 0); if (done >= S.made) return;
    let reload = false;
    for (const [k, v] of Object.entries(S.ls || {})) {
      try {
        if (k === 'hw-cards') {
          const mine = LS.get('hw-cards', []), theirs = JSON.parse(v), key = c => c.r + '|' + c.w;
          const m = new Map(mine.map(c => [key(c), c]));
          for (const c of theirs) { const o = m.get(key(c)); if (!o || (c.last || 0) > (o.last || 0)) { m.set(key(c), c); reload = true; } }
          LS.set('hw-cards', [...m.values()]);
        } else if (localStorage.getItem(k) == null) { localStorage.setItem(k, v); reload = true; }
      } catch (e) { }
    }
    for (const b of S.books || []) {
      const have = await DB.book(b.id).catch(() => null);
      if (have && (have.opened || 0) > (b.opened || 0)) continue;
      if (S.pdf && S.pdf[b.id]) { const bin = atob(S.pdf[b.id]); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await DB.putPdf(b.id, u.buffer); }
      await DB.putBook(b);
      for (const [n, pg] of Object.entries((S.pages || {})[b.id] || {})) await DB.putPage(b.id, +n, pg);
    }
    LS.set('rd-seeded', S.made);
    /* the dictionary read the flashcards before they were copied in: reload once (only if this browser keeps data) */
    if (reload && window.HWAPI && LS.get('rd-seeded', 0) === S.made) location.reload();
  }

  function engineNow() { return SET.engine === 'claude' && claudeOK() ? 'claude' : 'device'; }
  function engineChoice() {
    if (STANDALONE) return `<div class="opt"><span><b>On this device</b> – pages are read by the Arabic text reader built into this file. It works offline and nothing leaves your device. About 15–40 seconds a page on a phone. Check each page with <b>Show scan</b> and fix mistakes with <b>Correct text</b>.</span></div>`;
    const ok = claudeOK();
    return `<label class="opt"><input type="radio" name="eng" value="claude" ${SET.engine === 'claude' && ok ? 'checked' : ''} ${ok ? '' : 'disabled'}><span><b>Claude</b> – best accuracy, keeps vowel marks, finds titles, headings, verses and footnotes. Needs internet; about 10–20 seconds a page.${ok ? '' : OFFLINE ? ' <i>(Not in the offline copy – use the online page for this, then make a new offline copy.)</i>' : ' <i>(Not available in this view – open the page on claude.ai or in the Claude app.)</i>'}</span></label>
      <label class="opt"><input type="radio" name="eng" value="device" ${SET.engine !== 'claude' || !ok ? 'checked' : ''}><span><b>On this device</b> – works offline and stays private, but makes more mistakes, drops most vowel marks and guesses headings from the layout. About 15–40 seconds a page on a phone.</span></label>`;
  }
  function bindEngine(s) { s.querySelectorAll('input[name=eng]').forEach(r => r.onchange = () => { SET.engine = r.value; saveSet(); }); }

  async function importPdf(f) {
    const say = t => { const m = document.getElementById('rdImpMsg'); if (m) m.textContent = t; else toast(t); };
    say('Opening ' + f.name + '…');
    const lib = await pdfLib().catch(e => { say(e.message); return null; }); if (!lib) return;
    try {
      const buf = await f.arrayBuffer();
      const d = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
      const id = 'b' + Date.now().toString(36);
      await DB.putPdf(id, buf);
      docs[id] = Promise.resolve(d);
      let cover = '';
      try { const c = await renderPage(id, 1, 300); cover = c.toDataURL('image/jpeg', .75); } catch (e) { }
      let title = f.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
      try { const m = await d.getMetadata(); if (m && m.info && m.info.Title && m.info.Title.trim().length > 2) title = m.info.Title.trim(); } catch (e) { }
      const b = { id, title, n: d.numPages, added: Date.now(), read: 0, last: 1, cover, file: f.name };
      await DB.putBook(b);
      /* a PDF that already has a text layer: use it straight away */
      UI.open(id, 1);
    } catch (e) { say('Could not open that PDF: ' + (e.message || e)); }
  }

  function openReader() {
    document.body.classList.add('rd-open'); root.classList.remove('hidden');
    const last = LS.get('rd-last', null);
    if (UI.view === 'book' && UI.book) UI.showPage(UI.page, { keepScroll: true });
    else if (last && last.open) UI.open(last.id); else UI.library();
    LS.set('rd-on', true);
  }
  let bdTimer = null;
  function bookDeck(title, n) {
    clearTimeout(bdTimer);
    try { if (window.HWAPI && HWAPI.bookDeck) HWAPI.bookDeck(title && SET.bookDecks ? title : null); else if ((n || 0) < 60) bdTimer = setTimeout(() => bookDeck(title, (n || 0) + 1), 500); } catch (e) { }
  }
  function closeReader(keep) {
    if (!keep) bookDeck(null);
    closeLook(); root.classList.add('hidden'); document.body.classList.remove('rd-open');
    if (!keep) LS.set('rd-on', false);
    const b = document.getElementById('rdBack2'); if (b) b.classList.toggle('hidden', !keep);
  }
  window.READER = { open: openReader, close: closeReader };

  /* entry points on the dictionary page */
  const mb = document.getElementById('mRead'); if (mb) mb.onclick = openReader;
  /* a "back to my book" chip, shown after jumping from the book to flashcards or options */
  const back = document.createElement('button'); back.id = 'rdBack2'; back.className = 'pri hidden'; back.textContent = '📖 Back to my book';
  back.style.cssText = 'position:fixed;right:14px;bottom:max(16px,env(safe-area-inset-bottom));z-index:45;box-shadow:0 4px 14px rgba(0,0,0,.25);padding:10px 16px;border-radius:999px';
  back.onclick = () => { back.classList.add('hidden'); openReader(); };
  document.body.appendChild(back);
  document.addEventListener('keydown', e => {
    if (root.classList.contains('hidden') || UI.view !== 'book' || /INPUT|TEXTAREA/.test((e.target || {}).tagName || '')) return;
    if (e.key === 'ArrowLeft') UI.showPage(UI.page + 1); if (e.key === 'ArrowRight') UI.showPage(UI.page - 1); if (e.key === 'Escape') closeLook();
  });
  setInterval(() => { const n = dueCount(); const c = $('#rdCards'); if (c) c.innerHTML = '🗂' + (n ? `<span class="badge">${n}</span>` : ''); }, 30e3);
  importSeed().catch(() => { }).then(() => { if (LS.get('rd-on', false)) openReader(); });
})();
