/* Aula do dia — grava a aula da faculdade, transcreve por trechos e gera material de estudo */
(function () {
  'use strict';
  const VIEW = 'view-auladia', K_SESS = 'aula-dia-sessoes', CHUNK_MS = 90 * 1000;
  const $ = id => document.getElementById(id);
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const get = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { if (window.toast) toast('Armazenamento do navegador cheio — baixe e apague aulas antigas.', 'error'); return false; } };
  const hojeISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
  const mmss = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const hms = s => (s >= 3600 ? Math.floor(s / 3600) + 'h' : '') + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'min';

  let geminiOk = null, iniciando = false;
  let rec = null;       // estado da gravação em andamento
  let sessAtual = null; // sessão exibida (em gravação ou aberta do histórico)
  let abaRes = 'transcricao';

  /* ───────────── armazenamento ───────────── */
  const sessoes = () => get(K_SESS, []);
  const salvarSessoes = l => set(K_SESS, l.slice(0, 120));
  const palavrasDe = t => (t || '').split(/\s+/).filter(Boolean).length;
  // Só o resumo da aula vai para o localStorage; textos grandes (transcrição, resumo, flashcards) ficam no IndexedDB
  function metaDe(s) {
    return { id: s.id, data: s.data, inicio: s.inicio, disciplina: s.disciplina, tema: s.tema, parte: s.parte || 'Única', cor: s.cor || 'dourado', duracao: s.duracao || 0, marcas: s.marcas || [],
      palavras: palavrasDe(s.textoRevisado || s.texto), pronto: !!(s.resumoMd && s.flashcards), revisada: !!s.textoRevisado, nFlash: (s.flashcards || []).length };
  }
  let _docTimer = null;
  function salvarSess(s) {
    const l = sessoes(); const m = metaDe(s); const i = l.findIndex(x => x.id === s.id);
    if (i >= 0) l[i] = m; else l.unshift(m);
    salvarSessoes(l);
    clearTimeout(_docTimer); _docTimer = setTimeout(() => idbPut('doc:' + s.id, s), 250);
  }
  function salvarAgora(s) { salvarSess(s); clearTimeout(_docTimer); return idbPut('doc:' + s.id, s); }
  async function carregarSess(id) {
    const doc = await idbGet('doc:' + id);
    if (doc) return doc;
    const meta = sessoes().find(x => x.id === id);
    return meta ? Object.assign({ chunks: [], texto: '', live: '' }, meta) : null;
  }
  function idb() {
    return new Promise((ok, no) => { const r = indexedDB.open('aulaDia', 1); r.onupgradeneeded = () => r.result.createObjectStore('audio'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  }
  async function idbPut(k, blob) { try { const d = await idb(); await new Promise((ok, no) => { const t = d.transaction('audio', 'readwrite'); t.objectStore('audio').put(blob, k); t.oncomplete = ok; t.onerror = no; }); } catch (_) {} }
  async function idbGet(k) { try { const d = await idb(); return await new Promise((ok, no) => { const r = d.transaction('audio').objectStore('audio').get(k); r.onsuccess = () => ok(r.result); r.onerror = no; }); } catch (_) { return null; } }
  async function idbDelKey(k) { try { const d = await idb(); d.transaction('audio', 'readwrite').objectStore('audio').delete(k); } catch (_) {} }
  async function idbDel(prefix) { try { const d = await idb(); const t = d.transaction('audio', 'readwrite'); const st = t.objectStore('audio'); const rq = st.openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { if (String(c.key).startsWith(prefix)) c.delete(); c.continue(); } }; } catch (_) {} }

  /* ───────────── tela ───────────── */
  function css() {
    if ($('ad-css')) return;
    const s = document.createElement('style'); s.id = 'ad-css';
    s.textContent = `
.ad{max-width:980px;margin:0 auto;font-family:var(--font-ui);color:var(--text-primary)}
.ad h2{margin:0 0 4px;font-size:21px}.ad .sub{font-size:12.5px;color:var(--text-secondary);margin-bottom:14px}
.ad .card{background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:14px;margin-bottom:14px}
.ad label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin:0 0 4px}
.ad input,.ad select{width:100%;background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-muted);border-radius:var(--radius-md);padding:9px 10px;font:inherit;font-size:16px}
.ad .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ad .b{background:var(--bg-surface);border:1px solid var(--border-muted);color:var(--text-primary);border-radius:var(--radius-md);padding:8px 12px;font-size:13px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.ad .b:hover{border-color:var(--teal-border);background:var(--teal-dim)}.ad .b.pri{background:var(--teal);color:var(--text-inverse);border-color:var(--teal);font-weight:700}
.ad .b.rec{background:#e11d48;border-color:#e11d48;color:#fff;font-weight:700}
.ad .b:disabled{opacity:.5}
.ad-big{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
.ad-timer{font:700 28px var(--font-mono);letter-spacing:.04em}
.ad-meter{flex:1;min-width:120px;height:10px;background:var(--bg-base);border-radius:99px;overflow:hidden;border:1px solid var(--border-subtle)}
.ad-meter i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--teal),var(--cyan));transition:width .1s}
.ad-dot{width:10px;height:10px;border-radius:50%;background:#e11d48;animation:adp 1s infinite}
@keyframes adp{50%{opacity:.25}}
.ad-tr{white-space:pre-wrap;font-size:14px;line-height:1.65;max-height:55vh;overflow:auto;padding:4px 2px}
.ad-tr .mk{color:var(--amber);font-weight:700}
.ad-tr .pend{color:var(--text-muted);font-style:italic}
.ad-tabs{display:flex;gap:6px;margin-bottom:10px;overflow-x:auto}.ad-tabs .b.on{background:var(--teal-dim);border-color:var(--teal-border);color:var(--teal)}
.ad ul{margin:4px 0 10px 18px;padding:0}.ad li{margin:3px 0;font-size:13.5px;line-height:1.5}
.ad h4{margin:12px 0 4px;font-size:14px;color:var(--cyan)}
.ad .fc{border:1px solid var(--border-muted);border-radius:var(--radius-md);padding:10px;margin-bottom:8px;background:var(--bg-base);font-size:13.5px}
.ad .fc b{display:block;margin-bottom:4px}
.ad .hist{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border-subtle);font-size:13px}
.ad .hist small{color:var(--text-secondary)}
.ad .aviso{font-size:12px;color:var(--amber);background:var(--amber-dim);border:1px solid var(--amber-border);border-radius:var(--radius-md);padding:8px 10px;margin-top:10px}

.ad .row3{display:grid;grid-template-columns:1.2fr 1.6fr .8fr;gap:10px;margin-top:10px}
.ad .grp{margin:10px 0 2px;font-weight:700;font-size:14px;color:var(--teal)}.ad .grp2{margin:6px 0 0 8px;font-size:13px;color:var(--text-secondary)}
.ad-md{font-size:14px;line-height:1.7;max-height:70vh;overflow:auto;padding:2px 4px}
.ad-md h1{font-size:22px;margin:14px 0 8px}.ad-md h2{font-size:19px;margin:22px 0 8px;padding-top:10px;border-top:2px solid var(--border-muted);color:var(--teal)}
.ad-md h3{font-size:16px;margin:16px 0 6px;color:var(--cyan)}.ad-md h4{font-size:14px}
.ad-md blockquote{margin:10px 0;padding:10px 14px;border-left:4px solid var(--teal);background:var(--bg-base);border-radius:0 var(--radius-md) var(--radius-md) 0}
.ad-md blockquote p{margin:4px 0}.ad-md table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0;display:block;overflow-x:auto}
.ad-md th{background:var(--bg-elevated,#1e1e24);color:var(--text-primary);text-align:left}.ad-md th,.ad-md td{border:1px solid var(--border-muted);padding:6px 8px}
.ad-md ul,.ad-md ol{margin:6px 0 10px 20px}.ad-md hr{border:0;border-top:1px dashed var(--border-muted);margin:14px 0}
.ad-md a{color:var(--cyan)}
.ad-step{font-size:12.5px;margin:3px 0;color:var(--text-secondary)}.ad-step.ok{color:var(--green,#27ae60)}.ad-step.go{color:var(--amber)}.ad-step.er{color:var(--rose,#e11d48)}
@media(max-width:600px){.ad .row,.ad .row3{grid-template-columns:1fr}}`;
    document.head.appendChild(s);
  }

  function garantirView() {
    if ($(VIEW)) return;
    const ref = $('view-planneria'); if (!ref) return;
    const v = document.createElement('div'); v.id = VIEW; v.className = 'view-section';
    v.innerHTML = '<div class="pad" id="ad-root"></div>';
    ref.parentNode.insertBefore(v, ref.nextSibling);
    const nav = document.querySelector('.nav-item[data-view="view-acervo"]');
    if (nav && !document.querySelector('.nav-item[data-view="' + VIEW + '"]')) {
      const n = document.createElement('div'); n.className = 'nav-item'; n.dataset.view = VIEW; n.dataset.tooltip = 'Aula do dia';
      n.setAttribute('onclick', "go('" + VIEW + "')");
      n.innerHTML = '<i class="ph ph-microphone-stage"></i><span class="nav-text">Aula do dia</span><div class="nav-tooltip">Aula do dia</div>';
      nav.parentNode.insertBefore(n, nav.nextSibling);
    }
  }

  function opcoesDisciplina() {
    const plano = get('planner-v2-plan', null);
    const set1 = new Set();
    if (plano && plano.perfil) {
      (plano.perfil.provasFaculdade || []).forEach(p => set1.add(p.disciplina));
      (plano.perfil.aulasFaculdade || []).forEach(a => set1.add(a.disciplina));
    }
    return [...set1];
  }
  function temaDeHoje(disc) {
    const plano = get('planner-v2-plan', null); if (!plano || !plano.perfil) return '';
    const a = (plano.perfil.aulasFaculdade || []).find(x => x.data === hojeISO() && (!disc || x.disciplina === disc));
    return a ? a.tema : '';
  }
  function assuntosPlano(disc) {
    const plano = get('planner-v2-plan', null); if (!plano || !plano.perfil || !disc) return [];
    return [].concat(...(plano.perfil.provasFaculdade || []).filter(p => p.disciplina === disc).map(p => p.assuntos || []));
  }

  function sugerirParte(disc, tema) {
    const n = sessoes().filter(x => (x.disciplina || '').toLowerCase() === (disc || '').toLowerCase() && (x.tema || '').toLowerCase() === (tema || '').toLowerCase()).length;
    return n ? 'Parte ' + (n + 1) : 'Única';
  }
  function atualizarParteSugerida() {
    const d = ($('ad-disc') || {}).value || '', t = ($('ad-tema') || {}).value || '', p = $('ad-parte');
    if (p && !p.dataset.manual) p.value = sugerirParte(d, t);
  }
  function historicoAgrupado() {
    const lista = sessoes();
    if (!lista.length) return '<div class="sub" style="margin-top:6px">Nenhuma aula gravada ainda.</div>';
    const arv = {};
    lista.forEach(x => { const a = (x.disciplina || 'Sem área').trim() || 'Sem área', c = (x.tema || 'Sem conteúdo definido').trim() || 'Sem conteúdo definido'; ((arv[a] = arv[a] || {})[c] = arv[a][c] || []).push(x); });
    const ordP = p => { const m = /(\d+)/.exec(p || ''); return m ? +m[1] : 0; };
    return Object.keys(arv).sort().map(a => `<div class="grp">📚 ${E(a)}</div>` + Object.keys(arv[a]).sort().map(c =>
      `<div class="grp2">📖 ${E(c)}</div>` + arv[a][c].sort((x, y) => ordP(x.parte) - ordP(y.parte) || (x.inicio || 0) - (y.inicio || 0)).map(s =>
        `<div class="hist"><div><b>${E(s.parte || 'Única')}</b> <small>${E(s.data)} · ${hms(s.duracao || 0)} · ${s.palavras != null ? s.palavras : 0} palavras${s.revisada ? ' · ✔ revisada' : ''}${s.pronto ? ' · ✔ resumo + ' + (s.nFlash || 0) + ' flashcards' : ''}</small></div><div style="display:flex;gap:6px"><button class="b" onclick="auladia.abrir('${s.id}')">Abrir</button><button class="b" onclick="auladia.apagar('${s.id}')">🗑</button></div></div>`).join('')).join('')).join('');
  }

  async function render() {
    css(); garantirView();
    const r = $('ad-root'); if (!r) return;
    if (geminiOk === null) { try { geminiOk = !!(await (await fetch('/api/aula/status')).json()).gemini; } catch (_) { geminiOk = false; } }
    if (rec) return desenharGravando();
    if (sessAtual && !rec) return desenharResultado();
    const opts = opcoesDisciplina();
    const hoje = (get('planner-v2-plan', null) || { perfil: {} }).perfil.aulasFaculdade || [];
    const aulaHoje = hoje.find(a => a.data === hojeISO());
    const d0 = aulaHoje ? aulaHoje.disciplina : '', t0 = aulaHoje ? aulaHoje.tema : '';
    const partes = ['Única'].concat([1, 2, 3, 4, 5, 6, 7, 8].map(n => 'Parte ' + n));
    r.innerHTML = `<div class="ad"><h2>Aula do dia</h2><div class="sub">Grave a aula da faculdade: transcrição fiel, revisada e arquivada por Área › Conteúdo › Parte. No fim eu gero o resumo completo (Crônicas) e os flashcards de revisão.</div>
    <div class="card"><div class="row"><div><label>Área / disciplina</label><input id="ad-disc" list="ad-discs" placeholder="Ex.: Psiquiatria" value="${E(d0)}" oninput="auladia.parteAuto()"><datalist id="ad-discs">${opts.map(o => `<option value="${E(o)}">`).join('')}</datalist></div>
    <div><label>Conteúdo da aula</label><input id="ad-tema" placeholder="Ex.: Transtornos de humor" value="${E(t0)}" oninput="auladia.parteAuto()"></div></div>
    <div class="row3"><div><label>Parte</label><select id="ad-parte" onchange="this.dataset.manual=1">${partes.map(p => `<option${p === sugerirParte(d0, t0) ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
    <div><label>Cor de magia do resumo</label><select id="ad-cor">${['dourado', 'turquesa', 'âmbar', 'violeta', 'esmeralda', 'coral'].map(c => `<option>${c}</option>`).join('')}</select></div><div></div></div>
    <div class="ad-big"><button class="b rec" id="ad-start" onclick="auladia.iniciar()"><i class="ph ph-record"></i> Iniciar gravação</button>
    <span class="sub" style="margin:0">${geminiOk ? 'Transcrição por IA (a cada ~1,5 min), revisão e resumo automáticos no fim.' : 'Sem chave de IA (Gemini/Groq) no servidor: usarei a legenda ao vivo do navegador (Chrome/Safari), sem revisão nem resumo por IA.'}</span></div>
    <div class="aviso">Deixe a tela ligada e o navegador aberto durante a aula — no iPhone, bloquear a tela ou trocar de app pausa a gravação. Posicione o aparelho perto de quem fala e use o botão ⭐ quando o professor disser "isso cai na prova". Grave apenas se a faculdade/professor permitirem.</div></div>
    <div class="card"><b>Aulas gravadas</b> <small class="sub">(por Área › Conteúdo › Parte)</small>${historicoAgrupado()}</div></div>`;
  }

  function desenharGravando() {
    const r = $('ad-root'); if (!r || !rec) return;
    r.innerHTML = `<div class="ad"><h2><span class="ad-dot" style="display:inline-block;margin-right:8px"></span>Gravando — ${E(rec.sess.disciplina || 'aula')}</h2><div class="sub">${E(rec.sess.tema || '')}</div>
    <div class="card"><div class="ad-big" style="margin-top:0"><span class="ad-timer" id="ad-timer">00:00</span><div class="ad-meter"><i id="ad-meter"></i></div>
    <button class="b" onclick="auladia.marcar()">⭐ Marcar momento</button><button class="b pri" onclick="auladia.parar()"><i class="ph ph-stop-circle"></i> Finalizar</button></div>
    <div class="sub" id="ad-status" style="margin:8px 0 0"></div></div>
    <div class="card"><b>Transcrição ao vivo</b><div class="ad-tr" id="ad-tr"></div></div></div>`;
    atualizarTexto();
  }

  function textoHtml(s) {
    const partes = (s.chunks || []).slice().sort((a, b) => a.i - b.i).map(c => c.status === 'ok' ? E(c.texto) : c.status === 'erro' ? '<span class="pend">[trecho ' + (c.i + 1) + ' sem transcrição — toque em "Tentar novamente"]</span>' : '<span class="pend">[transcrevendo trecho ' + (c.i + 1) + '…]</span>');
    const live = s.live ? E(s.live) : '';
    return (partes.join('\n\n') + (live ? (partes.length ? '\n\n' : '') + live : '')).replace(/⭐ \[(\d\d:\d\d)\]/g, '<span class="mk">⭐ [$1]</span>') || '<span class="pend">A transcrição aparecerá aqui…</span>';
  }
  function textoPuro(s) {
    const t = (s.chunks || []).slice().sort((a, b) => a.i - b.i).filter(c => c.status === 'ok').map(c => c.texto).join('\n\n');
    return (t + (s.live ? '\n\n' + s.live : '')).trim();
  }
  function atualizarTexto() {
    const s = rec ? rec.sess : sessAtual; if (!s) return;
    s.texto = textoPuro(s);
    const el = $('ad-tr'); if (el) { const colado = el.scrollTop + el.clientHeight >= el.scrollHeight - 40; el.innerHTML = textoHtml(s); if (colado) el.scrollTop = el.scrollHeight; }
    salvarSess(s);
  }

  /* ───────────── gravação ───────────── */
  function escolherMime() {
    const c = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  }

  async function pedirMicrofone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { toast('Este navegador não permite gravar áudio. Use Safari (iOS 14.3+) ou Chrome.', 'error'); return null; }
    try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) {
      try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e2) { e = e2; }
      const n = (e && e.name) || '';
      if (n === 'NotAllowedError' || n === 'SecurityError') toast('O navegador bloqueou o microfone para este site. No iPhone: Ajustes › Safari › Microfone › Permitir (ou toque em "aA" na barra do Safari › Ajustes do Site › Microfone › Permitir) e recarregue a página.', 'error');
      else if (n === 'NotReadableError' || n === 'AbortError') toast('O microfone está ocupado por outro app/aba (ligação, Jarvis, outra gravação). Feche e tente de novo.', 'error');
      else if (n === 'NotFoundError') toast('Nenhum microfone encontrado neste aparelho.', 'error');
      else toast('Não consegui acessar o microfone (' + (n || 'erro') + ').', 'error');
      return null;
    }
  }

  async function iniciar() {
    if (rec || iniciando) return;
    iniciando = true;
    try {
      // lê o formulário e pede o microfone ANTES de qualquer outra espera: o iPhone só libera o microfone no toque do usuário
      const disc = ($('ad-disc') || {}).value || '', tema = ($('ad-tema') || {}).value || '', parte = ($('ad-parte') || {}).value || 'Única', cor = ($('ad-cor') || {}).value || 'dourado';
      const stream = await pedirMicrofone();
      if (!stream) return;
      garantirView(); css();
      if (geminiOk === null) { try { geminiOk = !!(await (await fetch('/api/aula/status')).json()).gemini; } catch (_) { geminiOk = false; } }
      if ($('view-auladia') && !$('view-auladia').classList.contains('active')) { go(VIEW); await new Promise(r => setTimeout(r, 200)); }
      await comecar(stream, disc, tema, parte, cor);
    } finally { iniciando = false; }
  }

  async function comecar(stream, disc, tema, parte, cor) {
    const sess = { id: 'a' + Date.now(), data: hojeISO(), inicio: Date.now(), disciplina: disc.trim(), tema: tema.trim(), parte, cor, duracao: 0, chunks: [], marcas: [], texto: '', live: '', resultado: null };
    const mime = escolherMime();
    rec = { sess, stream, mime, mr: null, t0: Date.now(), parar: false, fila: [], enviando: false, chunkIdx: 0, silencio: 0, timers: [], ctx: null, wake: null, sr: null };
    sessAtual = sess; salvarSess(sess);
    // medidor de nível
    try {
      const AC = window.AudioContext || window.webkitAudioContext; rec.ctx = new AC();
      const src = rec.ctx.createMediaStreamSource(stream); const an = rec.ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      rec.timers.push(setInterval(() => {
        an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128));
        const nv = Math.min(100, m * 1.6); const el = $('ad-meter'); if (el) el.style.width = nv + '%';
        rec.silencio = nv < 3 ? rec.silencio + 0.1 : 0;
        const st = $('ad-status'); if (st) st.textContent = rec.silencio > 20 ? '⚠ Sem som há mais de 20 s — verifique o microfone e a distância do professor.' : (geminiOk ? 'Gravando · trechos enviados à IA a cada ~1,5 min' : 'Gravando · legenda ao vivo do navegador');
      }, 100));
    } catch (_) {}
    rec.timers.push(setInterval(() => { const el = $('ad-timer'); if (el) el.textContent = mmss((Date.now() - rec.t0) / 1000); sess.duracao = Math.round((Date.now() - rec.t0) / 1000); }, 500));
    try { if (navigator.wakeLock) rec.wake = await navigator.wakeLock.request('screen'); } catch (_) {}
    document.addEventListener('visibilitychange', aoMudarVisibilidade);
    desenharGravando();
    iniciarTrecho();
    if (!geminiOk) iniciarLegendaAoVivo();
    toast('Gravação iniciada', 'success');
  }

  async function aoMudarVisibilidade() {
    if (!rec) return;
    if (document.visibilityState === 'visible') { try { if (navigator.wakeLock && !rec.wake) rec.wake = await navigator.wakeLock.request('screen'); } catch (_) {} if (rec.ctx && rec.ctx.state === 'suspended') rec.ctx.resume().catch(() => {}); }
    else toast('A aula continua gravando, mas o iPhone pode pausar a gravação com a tela em segundo plano.', 'warning');
  }

  function iniciarTrecho() {
    if (!rec) return;
    const idx = rec.chunkIdx++;
    const parts = [];
    let mr;
    try { mr = new MediaRecorder(rec.stream, rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 32000 } : undefined); }
    catch (e) { try { mr = new MediaRecorder(rec.stream); } catch (e2) { toast('Não foi possível iniciar a gravação neste navegador.', 'error'); return; } }
    rec.mr = mr;
    mr.ondataavailable = ev => { if (ev.data && ev.data.size) parts.push(ev.data); };
    mr.onstop = () => {
      const blob = new Blob(parts, { type: mr.mimeType || rec.mime || 'audio/webm' });
      if (blob.size > 2000) { const sess = sessAtual; sess.chunks.push({ i: idx, status: 'pendente', texto: '', mime: blob.type }); salvarSess(sess); idbPut(sess.id + ':' + idx, blob); if (geminiOk) { rec.fila.push({ sess, idx, blob }); bombear(); } }
      if (rec && !rec.parar) iniciarTrecho(); else if (rec && rec.parar) finalizarDepois();
    };
    mr.start();
    clearTimeout(rec.tChunk);
    rec.tChunk = setTimeout(() => { try { if (mr.state !== 'inactive') mr.stop(); } catch (_) {} }, CHUNK_MS);
  }

  function iniciarLegendaAoVivo() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Sem chave do Gemini e este navegador não tem legenda ao vivo: a aula será só gravada.', 'warning'); return; }
    const sr = new SR(); sr.lang = 'pt-BR'; sr.continuous = true; sr.interimResults = true; rec.sr = sr;
    let base = '';
    sr.onresult = ev => {
      let fin = '', interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) { const t = ev.results[i][0].transcript; if (ev.results[i].isFinal) fin += t + ' '; else interim += t; }
      if (fin) { sessAtual.live = (sessAtual.live ? sessAtual.live + ' ' : '') + fin.trim(); }
      sessAtual.liveInterim = interim;
      const el = $('ad-tr'); if (el) { el.innerHTML = textoHtml(sessAtual) + (interim ? ' <span class="pend">' + E(interim) + '</span>' : ''); el.scrollTop = el.scrollHeight; }
      if (fin) { sessAtual.texto = textoPuro(sessAtual); salvarSess(sessAtual); }
    };
    sr.onend = () => { if (rec && !rec.parar) { try { sr.start(); } catch (_) {} } };
    sr.onerror = () => {};
    try { sr.start(); } catch (_) {}
  }

  function marcar() {
    if (!rec) return;
    const t = mmss((Date.now() - rec.t0) / 1000);
    sessAtual.marcas.push(t);
    // insere a marca no ponto atual da transcrição ao vivo / entre trechos
    if (!geminiOk) sessAtual.live = (sessAtual.live ? sessAtual.live + '\n' : '') + '⭐ [' + t + ']\n';
    else sessAtual.chunks.push({ i: rec.chunkIdx - 0.5 + sessAtual.marcas.length * 0.001, status: 'ok', texto: '⭐ [' + t + ']' });
    atualizarTexto(); toast('Momento marcado em ' + t, 'success');
  }

  async function parar() {
    if (!rec) return;
    rec.parar = true;
    rec.timers.forEach(clearInterval); clearTimeout(rec.tChunk);
    try { rec.sr && rec.sr.stop(); } catch (_) {}
    sessAtual.duracao = Math.round((Date.now() - rec.t0) / 1000);
    try { if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); else finalizarDepois(); } catch (_) { finalizarDepois(); }
    const r = $('ad-root'); if (r) { const st = $('ad-status'); if (st) st.textContent = 'Finalizando e transcrevendo o último trecho…'; }
  }

  function finalizarDepois() {
    if (!rec) return;
    const r0 = rec;
    try { r0.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { r0.ctx && r0.ctx.close(); } catch (_) {}
    try { r0.wake && r0.wake.release(); } catch (_) {}
    document.removeEventListener('visibilitychange', aoMudarVisibilidade);
    const esperar = async () => {
      while (r0.fila.length || r0.enviando) await new Promise(r => setTimeout(r, 400));
      rec = null;
      atualizarTexto(); sessAtual.texto = textoPuro(sessAtual); await salvarAgora(sessAtual);
      abaRes = 'transcricao'; desenharResultado();
      if (geminiOk && sessAtual.texto.length > 200) pipeline(sessAtual);
    };
    esperar();
  }

  /* ───────────── envio dos trechos ───────────── */
  async function bombear() {
    if (!rec || rec.enviando) return;
    rec.enviando = true;
    const r0 = rec;
    while (r0.fila.length) {
      const it = r0.fila.shift();
      await transcreverTrecho(it.sess, it.idx, it.blob);
      atualizarTexto();
    }
    r0.enviando = false;
  }

  const blobParaB64 = blob => new Promise((ok, no) => { const f = new FileReader(); f.onload = () => ok(String(f.result).split(',')[1] || ''); f.onerror = no; f.readAsDataURL(blob); });

  async function paraWav16k(blob) {
    const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC();
    const dec = await ctx.decodeAudioData(await blob.arrayBuffer()); ctx.close && ctx.close();
    const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000);
    const src = off.createBufferSource(); src.buffer = dec; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) { const x = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function transcreverTrecho(sess, idx, blob) {
    const c = sess.chunks.find(x => x.i === idx); if (!c) return;
    const anterior = textoPuro(sess).slice(-300);
    let usarWav = false;
    for (let tent = 0; tent < 4; tent++) {
      try {
        const b = usarWav ? await paraWav16k(blob) : blob;
        const r = await fetch('/api/aula/transcrever', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: await blobParaB64(b), mime: b.type, disciplina: sess.disciplina, tema: (sess.tema + (sess.parte && sess.parte !== 'Única' ? ' — ' + sess.parte : '')).trim(), anterior, glossario: assuntosPlano(sess.disciplina).slice(0, 60) }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.success) { c.status = 'ok'; c.texto = j.texto || ''; salvarSess(sess); idbDel(sess.id + ':' + idx); if (!c.texto) c.texto = ''; return; }
        if (j.formato && !usarWav) { usarWav = true; continue; }
        if (r.status === 503) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 1500 * (tent + 1)));
    }
    c.status = 'erro'; salvarSess(sess);
  }

  async function reenviarFalhas() {
    const s = sessAtual; if (!s) return;
    const falhas = (s.chunks || []).filter(c => c.status === 'erro' || c.status === 'pendente');
    if (!falhas.length) return toast('Nada pendente.', 'success');
    toast('Reenviando ' + falhas.length + ' trecho(s)…', 'info');
    for (const c of falhas) {
      const blob = await idbGet(s.id + ':' + c.i);
      if (!blob) { c.status = 'erro'; continue; }
      c.status = 'pendente'; await transcreverTrecho(s, c.i, blob);
    }
    s.texto = textoPuro(s); salvarSess(s); desenharResultado();
    toast('Pronto.', 'success');
  }

  /* ───────────── pipeline: revisão → resumo Crônicas → flashcards → material ───────────── */
  let pipelineRodando = false, htmlPassos = '';
  const post = async (url, corpo, tent = 3) => {
    let ultimo = null;
    for (let i = 0; i < tent; i++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.success) return j;
        ultimo = new Error(j.msg || ('HTTP ' + r.status));
        if (r.status === 503 || r.status === 400 || r.status === 413) break;
      } catch (e) { ultimo = e; }
      await new Promise(ok => setTimeout(ok, 2500 * (i + 1)));
    }
    throw ultimo || new Error('falha');
  };
  const dividirTexto = (t, max = 9000) => {
    const out = []; let at = '';
    String(t).split(/\n{2,}/).forEach(p => {
      while (p.length > max) { out.push(p.slice(0, max)); p = p.slice(max); }
      if (at && (at + '\n\n' + p).length > max) { out.push(at); at = p; } else at = at ? at + '\n\n' + p : p;
    });
    if (at) out.push(at); return out;
  };
  const slug = t => String(t).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
  const nomeCompleto = s => [s.disciplina || 'Aula', s.tema, s.parte && s.parte !== 'Única' ? s.parte : ''].filter(Boolean).join(' — ');

  function passos(s, estado) {
    const L = [['rev', 'Revisando a transcrição (termos médicos, emendas, parágrafos)'], ['res', 'Escrevendo o resumo completo (Crônicas de Residência)'], ['fc', 'Criando os flashcards de revisão'], ['mat', 'Montando "cai na prova" e assuntos do plano']];
    const html = L.map(([k, n]) => { const e = estado[k] || ''; return `<div class="ad-step ${e === 'ok' ? 'ok' : e === 'go' ? 'go' : e === 'er' ? 'er' : ''}">${e === 'ok' ? '✔' : e === 'go' ? '⏳' : e === 'er' ? '✖' : '○'} ${n}${estado[k + 'Info'] ? ' — ' + E(estado[k + 'Info']) : ''}</div>`; }).join('');
    htmlPassos = html; const el = $('ad-proc'); if (el && sessAtual === s) el.innerHTML = html;
  }

  async function pipeline(s) {
    if (pipelineRodando) return toast('Já estou processando esta aula.', 'info');
    if (!geminiOk) return toast('Para revisar e resumir é preciso uma chave de IA (Gemini ou Groq) no servidor.', 'warning');
    pipelineRodando = true;
    const est = { rev: s.textoRevisado ? 'ok' : '', res: s.resumoMd ? 'ok' : '', fc: s.flashcards ? 'ok' : '', mat: s.resultado ? 'ok' : '' };
    passos(s, est);
    const ctx = { area: s.disciplina, conteudo: [s.tema, s.parte && s.parte !== 'Única' ? s.parte : ''].filter(Boolean).join(' — '), glossario: assuntosPlano(s.disciplina).slice(0, 60) };
    try {
      s.texto = textoPuro(s) || s.texto;
      // 1) Revisão da transcrição, pedaço a pedaço
      if (!s.textoRevisado) {
        est.rev = 'go'; passos(s, est);
        const blocos = dividirTexto(s.texto); const saida = [];
        for (let i = 0; i < blocos.length; i++) {
          est.revInfo = (i + 1) + '/' + blocos.length; passos(s, est);
          try { saida.push((await post('/api/aula/revisar', Object.assign({ texto: blocos[i] }, ctx))).texto); } catch (_) { saida.push(blocos[i]); }
        }
        s.textoRevisado = saida.join('\n\n'); est.rev = 'ok'; est.revInfo = ''; await salvarAgora(s); passos(s, est);
        if (abaRes === 'transcricao') { const el = document.querySelector('#ad-root .ad-tr'); if (el) el.innerHTML = E(s.textoRevisado); }
      }
      const fonte = s.textoRevisado || s.texto;
      // 2) Resumo Crônicas: mapa → capítulos → fechamento
      if (!s.resumoMd) {
        est.res = 'go'; est.resInfo = 'mapeando tópicos'; passos(s, est);
        if (!s.mapa) { s.mapa = (await post('/api/aula/mapa', Object.assign({ transcricao: fonte, parte: s.parte }, ctx))).mapa; await salvarAgora(s); }
        const caps = s.mapa.capitulos || []; s.caps = s.caps || [];
        for (let i = s.caps.length; i < caps.length; i++) {
          est.resInfo = 'capítulo ' + (i + 1) + '/' + caps.length + ' — ' + caps[i].titulo; passos(s, est);
          const j = await post('/api/aula/capitulo', Object.assign({ transcricao: fonte, capitulo: caps[i], numero: i + 1, total: caps.length, cor: s.cor || 'dourado' }, ctx), 3);
          s.caps.push(j.markdown); await salvarAgora(s);
        }
        if (!s.fechamento) { est.resInfo = 'considerações finais e revisão'; passos(s, est); s.fechamento = (await post('/api/aula/fechamento', Object.assign({ transcricao: fonte, capitulos: caps, temQuestoes: !!s.mapa.temQuestoes }, ctx))).markdown; await salvarAgora(s); }
        s.resumoMd = montarResumoMd(s); est.res = 'ok'; est.resInfo = ''; await salvarAgora(s); passos(s, est);
      }
      // 3) Flashcards
      if (!s.flashcards) {
        est.fc = 'go'; passos(s, est);
        s.flashcards = (await post('/api/aula/flashcards', Object.assign({ transcricao: fonte, capitulos: (s.mapa && s.mapa.capitulos) || [] }, ctx))).flashcards || [];
        est.fc = 'ok'; est.fcInfo = s.flashcards.length + ' cartões'; await salvarAgora(s); passos(s, est);
      }
      // 4) Material complementar (cai na prova, assuntos do manual)
      if (!s.resultado) {
        est.mat = 'go'; passos(s, est);
        try { s.resultado = (await post('/api/aula/processar', { transcricao: fonte, disciplina: s.disciplina, tema: ctx.conteudo, assuntosPlano: assuntosPlano(s.disciplina), marcas: s.marcas })).resultado; } catch (_) { s.resultado = { caiNaProva: [], assuntosCobertos: [] }; }
        est.mat = 'ok'; await salvarAgora(s); passos(s, est);
      }
      if (sessAtual === s) { abaRes = 'resumo'; desenharResultado(); }
      toast('Aula pronta: transcrição revisada, resumo e ' + (s.flashcards || []).length + ' flashcards.', 'success');
    } catch (e) {
      Object.keys(est).forEach(k => { if (est[k] === 'go') est[k] = 'er'; }); passos(s, est);
      const el = $('ad-proc'); if (el && sessAtual === s) el.insertAdjacentHTML('beforeend', `<div class="ad-step er">Parei por um erro (${E(e.message)}). O que já ficou pronto foi salvo — toque em "Gerar / continuar" para retomar.</div>`);
    }
    pipelineRodando = false;
  }

  function montarResumoMd(s) {
    const caps = (s.mapa && s.mapa.capitulos) || [];
    const titulos = caps.map((c, i) => `${i + 1}.0 — ${c.titulo}`);
    const nome = nomeCompleto(s);
    let md = `# Crônicas de Residência — ${s.tema || s.disciplina || 'Aula'}\n\n> **${nome}**\n> Disciplina: ${s.disciplina || '—'}\n> As Crônicas de @cuscuz-klan — Resumos Inesquecíveis para a Residência Médica\n> ${new Date().getFullYear()}\n> Cor de Magia: ${s.cor || 'dourado'}\n\n## Índice\n\n`;
    md += titulos.map(t => `- [${t}](#${slug(t)})`).join('\n') + `\n- [Considerações Finais](#considerações-finais)\n- [Revisão Final — Fatos e Relações Essenciais](#revisão-final--fatos-e-relações-essenciais)\n\n`;
    md += (s.caps || []).join('\n\n---\n\n') + '\n\n---\n\n' + (s.fechamento || '');
    return md.trim() + '\n';
  }

  /* ───────────── Markdown → HTML (leve, sem dependências) ───────────── */
  function mdParaHtml(md) {
    const inline = t => E(t).replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>').replace(/\[([^\]]+)\]\(#([^)]+)\)/g, '<a href="#" onclick="auladia.ancora(\'$2\');return false">$1</a>');
    const lin = String(md).replace(/\r/g, '').split('\n'); const out = []; let i = 0;
    while (i < lin.length) {
      const l = lin[i];
      let m;
      if (/^\s*$/.test(l)) { i++; continue; }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { out.push(`<h${m[1].length} id="adh-${slug(m[2].replace(/[*_`]/g, ''))}">${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^>/.test(l)) { const b = []; while (i < lin.length && /^>/.test(lin[i])) { b.push(lin[i].replace(/^>\s?/, '')); i++; } out.push('<blockquote>' + b.map(x => x.trim() ? (/^\s*[-•]\s+/.test(x) ? '<div>• ' + inline(x.replace(/^\s*[-•]\s+/, '')) + '</div>' : '<p>' + inline(x) + '</p>') : '').join('') + '</blockquote>'); continue; }
      if (/^\|.*\|\s*$/.test(l) && /^\|?[\s:|-]+\|?\s*$/.test(lin[i + 1] || '')) {
        const cel = x => x.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const cab = cel(l); i += 2; const rows = [];
        while (i < lin.length && /^\|.*\|\s*$/.test(lin[i])) { rows.push(cel(lin[i])); i++; }
        out.push('<table><thead><tr>' + cab.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'); continue;
      }
      if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) { const ord = /^\s*\d+[.)]/.test(l), it = []; while (i < lin.length && /^\s*([-*•]|\d+[.)])\s+/.test(lin[i])) { it.push(lin[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '')); i++; } out.push((ord ? '<ol>' : '<ul>') + it.map(x => '<li>' + inline(x) + '</li>').join('') + (ord ? '</ol>' : '</ul>')); continue; }
      const p = [l]; i++; while (i < lin.length && lin[i].trim() && !/^(#{1,4}\s|>|\||\s*([-*•]|\d+[.)])\s|\s*(-{3,}|\*{3,})\s*$)/.test(lin[i])) { p.push(lin[i]); i++; }
      out.push('<p>' + inline(p.join(' ')) + '</p>');
    }
    return out.join('\n');
  }

  /* ───────────── resultado ───────────── */
  function desenharResultado() {
    const r = $('ad-root'); const s = sessAtual; if (!r || !s) return;
    const res = s.resultado;
    const tabs = [['transcricao', s.textoRevisado ? 'Transcrição (revisada)' : 'Transcrição']];
    if (s.resumoMd) tabs.push(['resumo', 'Resumo']);
    if (s.flashcards) tabs.push(['flash', 'Flashcards (' + s.flashcards.length + ')']);
    if (res) tabs.push(['prova', 'Cai na prova']);
    if (!tabs.some(t => t[0] === abaRes)) abaRes = tabs[0][0];
    let corpo = '';
    if (abaRes === 'transcricao') corpo = `<div class="ad-tr">${s.textoRevisado ? E(s.textoRevisado).replace(/⭐ \[(\d\d:\d\d)\]/g, '<span class="mk">⭐ [$1]</span>') : textoHtml(s)}</div>`;
    else if (abaRes === 'resumo') corpo = `<div class="ad-md" id="ad-md">${mdParaHtml(s.resumoMd)}</div>`;
    else if (abaRes === 'flash') {
      const grupos = {}; (s.flashcards || []).forEach(f => { (grupos[f.tema || 'Geral'] = grupos[f.tema || 'Geral'] || []).push(f); });
      corpo = `<button class="b pri" onclick="auladia.enviarFlash()"><i class="ph ph-cards"></i> Adicionar ao Treino (revisão espaçada)</button><div style="margin-top:10px">${Object.keys(grupos).map(g => `<div class="grp2">${E(g)}</div>` + grupos[g].map(f => `<div class="fc"><b>${E(f.frente)}</b>${E(f.verso)}</div>`).join('')).join('')}</div>`;
    } else if (res && abaRes === 'prova') corpo = `${(res.caiNaProva || []).length ? '<ul>' + res.caiNaProva.map(p => `<li>${E(p)}</li>`).join('') + '</ul>' : '<div class="sub">O professor não indicou explicitamente o que cai na prova.</div>'}${(s.marcas || []).length ? '<h4>Momentos que você marcou</h4><div class="sub">' + s.marcas.map(E).join(' · ') + '</div>' : ''}${(res.assuntosCobertos || []).length ? '<h4>Assuntos do manual abordados nesta aula</h4><ul>' + res.assuntosCobertos.map(a => `<li>${E(a)}</li>`).join('') + '</ul>' : ''}${(res.duvidas || []).length ? '<h4>Para conferir (possíveis imprecisões)</h4><ul>' + res.duvidas.map(d => `<li>${E(d)}</li>`).join('') + '</ul>' : ''}`;
    const falhas = (s.chunks || []).filter(c => c.status === 'erro' || c.status === 'pendente').length;
    const completo = s.resumoMd && s.flashcards && s.resultado;
    r.innerHTML = `<div class="ad"><h2>${E(nomeCompleto(s))}</h2><div class="sub">${E(s.disciplina || '')} › ${E(s.tema || 'sem conteúdo definido')} › ${E(s.parte || 'Única')} · ${E(s.data)} · ${hms(s.duracao || 0)} · ${palavrasDe(s.textoRevisado || s.texto)} palavras</div>
    <div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"><button class="b" onclick="auladia.voltar()"><i class="ph ph-arrow-left"></i> Aulas</button>${geminiOk && !completo ? '<button class="b pri" onclick="auladia.gerar()"><i class="ph ph-sparkle"></i> Gerar / continuar</button>' : ''}${falhas ? `<button class="b" onclick="auladia.reenviar()">Tentar novamente (${falhas})</button>` : ''}<button class="b" onclick="auladia.copiar()">Copiar texto</button><button class="b" onclick="auladia.baixar('transcricao')">⬇ Transcrição .md</button>${s.resumoMd ? '<button class="b" onclick="auladia.baixar(\'resumo\')">⬇ Resumo .md</button>' : ''}<button class="b" onclick="auladia.baixar('tudo')">⬇ Tudo (NotebookLM)</button></div><div id="ad-proc" style="margin:0 0 8px"></div>
    <div class="ad-tabs">${tabs.map(([k, n]) => `<button class="b ${abaRes === k ? 'on' : ''}" onclick="auladia.aba('${k}')">${n}</button>`).join('')}</div>${corpo}</div></div>`;
    if (pipelineRodando && sessAtual && htmlPassos) { const el = $('ad-proc'); if (el) el.innerHTML = htmlPassos; }
  }

  /* ───────────── ações ───────────── */
  function cabecalho(s) { return `# ${nomeCompleto(s)}\n\nÁrea: ${s.disciplina || '—'} · Conteúdo: ${s.tema || '—'} · ${s.parte || 'Única'}\nData: ${s.data} · Duração: ${hms(s.duracao || 0)}\n\n`; }
  function pacoteMd(s, tipo) {
    const transc = `## Transcrição completa${s.textoRevisado ? ' (revisada)' : ''}\n\n${s.textoRevisado || s.texto || textoPuro(s)}\n`;
    if (tipo === 'transcricao') return cabecalho(s) + transc;
    if (tipo === 'resumo') return s.resumoMd || '';
    let md = s.resumoMd ? s.resumoMd + '\n\n---\n\n' : cabecalho(s);
    if (s.flashcards && s.flashcards.length) md += `## Flashcards de revisão\n\n` + s.flashcards.map((f, i) => `**${i + 1}. ${f.frente}**\n${f.verso}\n${f.tema ? '*(' + f.tema + ')*\n' : ''}`).join('\n') + '\n\n---\n\n';
    return md + transc;
  }
  function baixar(tipo) {
    const s = sessAtual; if (!s) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([pacoteMd(s, tipo || 'tudo')], { type: 'text/markdown' }));
    a.download = [s.disciplina || 'aula', s.tema, s.parte, tipo || 'tudo', s.data].filter(Boolean).join(' - ').replace(/[^\p{L}\p{N}\- ]+/gu, '_') + '.md'; document.body.appendChild(a); a.click(); a.remove();
  }
  async function copiar() { const s = sessAtual; if (!s) return; try { await navigator.clipboard.writeText(s.textoRevisado || s.texto || textoPuro(s)); toast('Transcrição copiada', 'success'); } catch (_) { toast('Não consegui copiar — use "Baixar .md".', 'error'); } }
  function enviarFlash() {
    const s = sessAtual; if (!s || !s.flashcards || typeof FCS === 'undefined') return;
    const ja = new Set(FCS.map(c => c.f + '::' + c.b)); let n = 0;
    s.flashcards.forEach(f => { if (!ja.has(f.frente + '::' + f.verso)) { FCS.push({ f: f.frente, b: f.verso, s: 'x' }); n++; } });
    if (typeof saveFC === 'function') saveFC();
    toast(n + ' flashcards adicionados ao Treino — eles entram na revisão espaçada de hoje.', 'success');
  }
  async function abrirSess(id) { const s = await carregarSess(id); if (!s) return; sessAtual = s; abaRes = s.resumoMd ? 'resumo' : 'transcricao'; desenharResultado(); }
  function apagarSess(id) { if (!confirm('Apagar esta aula gravada?')) return; salvarSessoes(sessoes().filter(x => x.id !== id)); idbDel(id + ':'); idbDelKey('doc:' + id); if (sessAtual && sessAtual.id === id) sessAtual = null; render(); }

  window.auladia = {
    iniciar, parar, marcar, abrir: abrirSess, apagar: apagarSess, enviarFlash, baixar, copiar,
    gerar() { if (sessAtual) pipeline(sessAtual); }, reenviar: reenviarFalhas, parteAuto: atualizarParteSugerida,
    ancora(id) { const el = document.getElementById('adh-' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    aba(k) { abaRes = k; desenharResultado(); },
    voltar() { if (rec) return; sessAtual = null; render(); }
  };

  // integra com a navegação do app
  function integrar() {
    garantirView();
    if (window.__adGo) return; window.__adGo = true;
    const og = window.go;
    window.go = function (id) { const rv = og.apply(this, arguments); if (id === VIEW) render(); return rv; };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', integrar); else integrar();
  window.addEventListener('beforeunload', e => { if (rec) { e.preventDefault(); e.returnValue = ''; } });
})();
