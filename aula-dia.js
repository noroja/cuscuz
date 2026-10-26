/* Aula do dia — grava a aula da faculdade, transcreve por trechos e gera material de estudo */
(function () {
  'use strict';
  const VIEW = 'view-auladia', K_SESS = 'aula-dia-sessoes', K_PREF = 'aula-dia-preferencias', CHUNK_MS = 90 * 1000, CHUNK_SOFT_MS = 65 * 1000, SILENCIO_CORTE_S = 0.5;
  const $ = id => document.getElementById(id);
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const get = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { if (window.toast) toast('Armazenamento do navegador cheio — baixe e apague aulas antigas.', 'error'); return false; } };
  const hojeISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
  const mmss = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const hms = s => (s >= 3600 ? Math.floor(s / 3600) + 'h' : '') + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'min';
  const duracaoAudio = s => { const n = Math.max(0, Math.round(Number(s) || 0)), m = Math.floor(n / 60), seg = n % 60; return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'min' : m + 'min ' + seg + 's'; };

  // geminiOk = há IA de texto (revisão/resumo); transcOk = há Whisper no servidor; paralelo = chamadas de texto simultâneas permitidas
  let geminiOk = null, transcOk = false, paralelo = 1, iniciando = false, uploadRodando = false, perfisPedagogicos = [], tutorRodando = false, tutorFalha = '';
  let audioUploadDireto = false, audioGrandeGemini = false, audioMaxBytes = 3 * 1024 * 1024, audioInlineMaxBytes = 3 * 1024 * 1024, groqAudioMaxBytes = 25_000_000;
  async function carregarStatus() {
    if (geminiOk !== null) return;
    try {
      const j = await (await fetch('/api/aula/status')).json();
      geminiOk = !!(j.texto != null ? j.texto : j.gemini);
      transcOk = j.transcricao != null ? !!j.transcricao : geminiOk; // servidores antigos: sem o campo, assume o comportamento anterior
      paralelo = Math.max(1, Math.min(3, parseInt(j.paralelo, 10) || 1));
      audioUploadDireto = !!j.uploadAudioDireto;
      audioMaxBytes = Math.max(1, Number(j.limiteAudioBytes) || (audioUploadDireto ? 50_000_000 : 3 * 1024 * 1024));
      audioInlineMaxBytes = Math.max(1, Number(j.limiteAudioInlineBytes) || 3 * 1024 * 1024);
      groqAudioMaxBytes = Math.max(1, Number(j.limiteGroqAudioBytes) || 25_000_000);
      audioGrandeGemini = !!j.audioGrandeGemini;
      perfisPedagogicos = Array.isArray(j.perfisPedagogicos) ? j.perfisPedagogicos : [];
    } catch (_) { geminiOk = false; transcOk = false; paralelo = 1; }
  }
  let rec = null;       // estado da gravação em andamento
  let sessAtual = null; // sessão exibida (em gravação ou aberta do histórico)
  let abaRes = 'transcricao';
  let slidesPendente = null;

  /* ───────────── armazenamento ───────────── */
  const sessoes = () => get(K_SESS, []);
  const salvarSessoes = l => set(K_SESS, l.slice(0, 120));
  const palavrasDe = t => (t || '').split(/\s+/).filter(Boolean).length;
  const chavesIscDaSessao = s => [...new Set([
    ...(Array.isArray(s?.iscResourceKeys) ? s.iscResourceKeys : []),
    ...(Array.isArray(s?.iscSlideResourceKeys) ? s.iscSlideResourceKeys : []),
    s?.iscTranscriptResourceKey, s?.iscResourceKey
  ].filter(key => typeof key === 'string' && key.startsWith('user:')))].slice(-12);
  const TIPOS_AULA = { expositiva: 'Expositiva', 'caso-clinico': 'Discussão de caso', 'revisao-prova': 'Revisão para prova', pratica: 'Aula prática ou procedimento' };
  const PROFUNDIDADES = { conciso: 'Enxuto', equilibrado: 'Equilibrado', detalhado: 'Detalhado' };
  function preferenciasAula() {
    const p = get(K_PREF, {});
    return {
      tipoAula: TIPOS_AULA[p.tipoAula] ? p.tipoAula : 'expositiva',
      preferenciaMaterial: PROFUNDIDADES[p.preferenciaMaterial] ? p.preferenciaMaterial : 'equilibrado',
      processamentoAudio: p.processamentoAudio !== false
    };
  }
  function salvarPreferencias() {
    const tipoAula = ($('ad-tipo') || {}).value, preferenciaMaterial = ($('ad-detalhe') || {}).value;
    const anterior = get(K_PREF, {});
    if (TIPOS_AULA[tipoAula] && PROFUNDIDADES[preferenciaMaterial]) set(K_PREF, { ...anterior, tipoAula, preferenciaMaterial, processamentoAudio: ($('ad-mic-processing') || {}).checked !== false });
  }
  function preferenciasPedagogicasFormulario() {
    return {
      perfilPedagogico: ($('ad-perfil') || {}).value || 'automatico',
      objetivoEstudo: ($('ad-objetivo') || {}).value || 'automatico',
      objetivosAprendizagem: String(($('ad-objetivos') || {}).value || '').slice(0, 1600),
      enfasePedagogica: String(($('ad-enfase') || {}).value || '').slice(0, 300)
    };
  }
  // Só o resumo da aula vai para o localStorage; textos grandes (transcrição, resumo, flashcards) ficam no IndexedDB
  function metaDe(s) {
    return { id: s.id, data: s.data, inicio: s.inicio, disciplina: s.disciplina, tema: s.tema, parte: s.parte || 'Única', cor: s.cor || 'dourado', duracao: s.duracao || 0, tipoAula: s.tipoAula || 'expositiva', preferenciaMaterial: s.preferenciaMaterial || 'equilibrado', perfilPedagogico: s.perfilPedagogico || 'automatico', objetivoEstudo: s.objetivoEstudo || 'automatico', objetivosAprendizagem: s.objetivosAprendizagem || '', enfasePedagogica: s.enfasePedagogica || '', audioImportado: s.audioImportado || '', audioBytes: s.audioBytes || 0, marcas: s.marcas || [],
      palavras: palavrasDe(s.textoRevisado || s.texto), pronto: !!(s.resumoMd && s.resultado), revisada: !!s.textoRevisado, nFlash: (s.flashcards || []).length,
      iscResourceKey: s.iscResourceKey || '', iscTranscriptResourceKey: s.iscTranscriptResourceKey || '',
      iscResourceKeys: chavesIscDaSessao(s), iscSlideResourceKeys: Array.isArray(s.iscSlideResourceKeys) ? s.iscSlideResourceKeys : [],
      iscSelectedTopicIds: Array.isArray(s.iscSelectedTopicIds) ? s.iscSelectedTopicIds : [] };
  }
  let _docTimer = null;
  function salvarSess(s) {
    const l = sessoes(); const m = metaDe(s); const i = l.findIndex(x => x.id === s.id);
    if (i >= 0) l[i] = m; else l.unshift(m);
    salvarSessoes(l);
    clearTimeout(_docTimer); _docTimer = setTimeout(() => idbPut('doc:' + s.id, s).catch(() => {}), 250);
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
  async function idbPut(k, blob) { const d = await idb(); await new Promise((ok, no) => { const t = d.transaction('audio', 'readwrite'); t.objectStore('audio').put(blob, k); t.oncomplete = ok; t.onerror = () => no(t.error); t.onabort = () => no(t.error || new Error('IndexedDB write aborted')); }); }
  async function idbGet(k) { try { const d = await idb(); return await new Promise((ok, no) => { const r = d.transaction('audio').objectStore('audio').get(k); r.onsuccess = () => ok(r.result); r.onerror = no; }); } catch (_) { return null; } }
  async function idbDelKey(k) { try { const d = await idb(); d.transaction('audio', 'readwrite').objectStore('audio').delete(k); } catch (_) {} }
  async function idbDel(prefix) { try { const d = await idb(); const t = d.transaction('audio', 'readwrite'); const st = t.objectStore('audio'); const rq = st.openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { if (String(c.key).startsWith(prefix)) c.delete(); c.continue(); } }; } catch (_) {} }

  /* ───────────── tela ───────────── */
  function css() {
    if ($('ad-css')) return;
    const s = document.createElement('style'); s.id = 'ad-css';
    s.textContent = `
.ad{max-width:1280px;margin:0 auto;font-family:var(--font-ui);color:var(--text-primary);color-scheme:dark}
.ad h2{margin:0 0 4px;font-size:21px;text-wrap:balance}.ad .sub{font-size:12.5px;color:var(--text-secondary);margin-bottom:14px;overflow-wrap:anywhere}
.ad .card{background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:14px;margin-bottom:14px}
.ad label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin:0 0 4px}
.ad input,.ad select{width:100%;background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-muted);border-radius:var(--radius-md);padding:9px 10px;font:inherit;font-size:16px}
.ad textarea{width:100%;min-height:58px;resize:vertical;background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-muted);border-radius:var(--radius-md);padding:9px 10px;font:inherit;font-size:14px}
.ad .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ad .b{background:var(--bg-surface);border:1px solid var(--border-muted);color:var(--text-primary);border-radius:var(--radius-md);padding:8px 12px;min-height:40px;font-size:13px;cursor:pointer;display:inline-flex;gap:6px;align-items:center;touch-action:manipulation}
.ad .b:hover{border-color:var(--teal-border);background:var(--teal-dim)}.ad .b.pri{background:var(--teal);color:var(--text-inverse);border-color:var(--teal);font-weight:700}
.ad .b.rec{background:#e11d48;border-color:#e11d48;color:#fff;font-weight:700}
.ad .b:disabled{opacity:.5}
.ad-big{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
.ad-timer{font:700 28px var(--font-ui);font-variant-numeric:tabular-nums;letter-spacing:.04em}
.ad-meter{flex:1;min-width:120px;height:10px;background:var(--bg-base);border-radius:99px;overflow:hidden;border:1px solid var(--border-subtle)}
.ad-meter i{display:block;height:100%;width:0;background:var(--teal);transition:width .1s}
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
.ad-setup-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:2px 0 18px}
.ad-setup-actions .b{min-height:48px;padding-inline:16px}
.ad-setup-actions .b.pri{min-width:180px;justify-content:center}
.ad-setup-slides{color:var(--text-secondary);font-size:12px;margin:-8px 0 14px}
.ad-advanced{margin-top:14px;border-top:1px solid var(--border-subtle);padding-top:10px}
.ad-advanced summary{cursor:pointer;color:var(--text-secondary);font-size:13px;font-weight:600;padding:7px 0}
.ad-advanced summary:focus-visible,.ad .b:focus-visible,.ad button:focus-visible,.ad input:focus-visible,.ad select:focus-visible,.ad textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.ad-setup{padding:20px 22px}
.ad-history-search{max-width:420px;margin:0 0 12px}
.ad-workspace-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:10px}
.ad-workspace-grid{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:14px;align-items:start}
.ad-workspace-main{min-width:0}
.ad-primary-tabs{display:flex;gap:18px;border-bottom:1px solid var(--border-muted);overflow-x:auto;scrollbar-width:thin}
.ad-primary-tabs .b{background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--text-secondary);min-height:44px;white-space:nowrap}
.ad-primary-tabs .b[aria-pressed="true"]{color:var(--teal);border-bottom-color:var(--teal);background:transparent}
.ad-subtabs{display:flex;gap:6px;margin:8px 0 12px;overflow-x:auto}
.ad-workspace-rail{position:sticky;top:76px;min-width:0}
.ad-workspace-actions{display:grid;gap:8px;margin-bottom:12px}
.ad-study-panel{min-height:300px}
.ad-action-details{border-top:1px solid var(--border-subtle);margin-top:8px;padding-top:8px}
.ad-action-details summary{cursor:pointer;color:var(--text-secondary);font-size:12px;padding:6px 0}
.ad-rail-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
.ad-rail-actions .b{justify-content:center;text-align:center;min-width:0;padding:7px}
.ad-rail-section{padding:12px 0;border-bottom:1px solid var(--border-subtle)}
.ad-rail-section:first-child{padding-top:0}
.ad-rail-section b{display:block;font-size:13px;margin-bottom:4px}
.ad-rail-section .sub{margin-bottom:0}
.ad-workspace .ad-panel{min-height:300px}
.ad-index-state{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px;border-top:1px solid var(--border-subtle);margin:12px 0 0}
.ad-index-state .ad-progress-line{min-width:0}
.ad-empty{padding:18px 0;color:var(--text-secondary);font-size:13px;line-height:1.6}
.ad-actions-details{margin-top:8px}
.ad-actions-details summary{cursor:pointer;color:var(--text-secondary);font-size:12px;padding:8px 0}
.ad-actions-list{display:flex;gap:7px;flex-wrap:wrap;padding:6px 0}
.ad-recording{max-width:1000px;margin:0 auto}
.ad-recording .ad-timer{font-size:clamp(32px,5vw,54px)}
.ad-recording .ad-big{gap:8px}
.ad-recording .b{min-height:44px}
.ad-recording .ad-meter{height:12px}
.ad-recording .ad-tr{min-height:180px}
.ad .aviso{font-size:12px;color:var(--amber);background:var(--amber-dim);border:1px solid var(--amber-border);border-radius:var(--radius-md);padding:8px 10px;margin-top:10px}
.ad-tutor-msg{padding:12px 0;border-bottom:1px solid var(--border-subtle);line-height:1.6}.ad-tutor-msg:last-child{border-bottom:0}.ad-tutor-msg.user{color:var(--text-secondary)}.ad-tutor-msg.assistant{font-size:14px}.ad-tutor-msg .ad-md{max-height:none;overflow:visible;padding:0}.ad-tutor-source{margin:6px 0 0 12px;font-size:12px;color:var(--text-secondary)}.ad-tutor-source blockquote{white-space:pre-wrap;margin:6px 0;padding:8px 10px;border-left:2px solid var(--border-muted);background:var(--bg-base)}.ad-tutor-quick{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.ad-tutor-form{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.ad-tutor-form textarea{min-height:74px}.ad-objective{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border-subtle);font-size:13.5px}.ad-objective input{width:18px;height:18px;flex:0 0 18px;margin:1px 0 0;accent-color:var(--teal)}.ad-progress-line{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:13px}.ad-progress-line span:last-child{color:var(--text-secondary);text-align:right}

.ad .row3{display:grid;grid-template-columns:1.2fr 1.6fr .8fr;gap:10px;margin-top:10px}
.ad .file-note{font-size:12px;color:var(--text-secondary);line-height:1.5;margin:8px 0 0}
.ad .file-meta{font-size:13px;color:var(--text-primary);margin-top:2px;flex-basis:100%;overflow-wrap:anywhere}
.ad .ad-mic-toggle{display:flex;align-items:flex-start;gap:8px;margin:8px 0 0;color:var(--text-secondary);font-size:12px;line-height:1.45;text-transform:none;letter-spacing:0}
.ad .ad-mic-toggle input{width:16px;height:16px;flex:0 0 16px;margin:1px 0 0;accent-color:var(--teal)}
.ad #ad-mic-test-status[data-state="warning"]{color:var(--amber)}.ad #ad-mic-test-status[data-state="success"]{color:var(--teal)}
.ad .file-meta[data-state="error"]{color:var(--amber)}.ad .file-meta[data-state="success"]{color:var(--teal)}
.ad .b:focus-visible,.ad input:focus-visible,.ad select:focus-visible,.ad textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.ad-dot{animation:none}.ad-meter i{transition:none}}
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
.ak-bar{display:flex;gap:10px;align-items:center;margin:8px 0;flex-wrap:wrap}
.ak-bar audio{width:100%;height:40px}
.ak-max{max-height:58vh;overflow:auto;padding:4px 2px}
.ak-chunk{margin:8px 0}.ak-chunk h5{margin:0 0 2px;font-size:10.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em}
.ak-line{padding:4px 10px;border-radius:10px;cursor:pointer;font-size:14px;line-height:1.6;transition:background .15s}
.ak-line:hover{background:var(--bg-base)}
.ak-line.on{background:var(--teal-dim);outline:1px solid var(--teal-border);color:var(--text-primary)}
.ak-line .t{color:var(--text-muted);font-family:var(--font-ui);font-variant-numeric:tabular-nums;font-size:11.5px;margin-right:8px}
.ak-info{font-size:12px;color:var(--text-muted);margin:6px 0}
.mm-tools{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px}
.mm-tools .b{padding:5px 10px;font-size:12px}
.mm-sc{overflow:auto;max-height:72vh;border-radius:14px;border:1px solid rgba(120,160,150,.25);background:#0b1216}
.mm-inner{transform-origin:0 0;width:max-content}
.mm-node{cursor:pointer}
.mm-node text{user-select:none}
@media(max-width:900px){.ad-workspace-grid{grid-template-columns:1fr}.ad-workspace-rail{position:static;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.ad-workspace-rail .ad-rail-section:last-child{border-bottom:0}}
@media(max-width:600px){.ad-setup{padding:15px}.ad-setup-actions{display:grid;grid-template-columns:1fr}.ad-setup-actions .b{width:100%;justify-content:center}.ad-workspace-rail{grid-template-columns:1fr}.ad-index-state{grid-template-columns:1fr}.ad-workspace-head{display:block}.ad-primary-tabs{gap:8px}}
@media(max-width:600px){.ad .row,.ad .row3,.ad-tutor-form{grid-template-columns:1fr}.ad-tutor-form .b{min-height:44px;justify-content:center}.ad-tabs .b{flex:0 0 auto;min-height:40px}.ad-tutor-form textarea{font-size:16px}}
@media(max-width:420px){.ad-progress-line{display:grid;grid-template-columns:1fr;gap:3px}.ad-progress-line span:last-child{text-align:left}}`;
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
  function historicoAgrupado(filtro = '') {
    const normalizar = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const busca = normalizar(filtro).trim();
    const todas = sessoes();
    const lista = busca ? todas.filter(session => normalizar([session.disciplina, session.tema, session.parte, session.data].join(' ')).includes(busca)) : todas;
    if (!lista.length) return `<div class="ad-empty">${busca ? 'Nenhuma aula corresponde à busca.' : 'Nenhuma aula gravada ainda. Suas aulas aparecerão aqui depois de gravar ou enviar áudio.'}</div>`;
    const arv = {};
    lista.forEach(x => { const a = (x.disciplina || 'Sem área').trim() || 'Sem área', c = (x.tema || 'Sem conteúdo definido').trim() || 'Sem conteúdo definido'; ((arv[a] = arv[a] || {})[c] = arv[a][c] || []).push(x); });
    const ordP = p => { const m = /(\d+)/.exec(p || ''); return m ? +m[1] : 0; };
    return Object.keys(arv).sort().map(a => `<div class="grp"><i class="ph ph-books" aria-hidden="true"></i> ${E(a)}</div>` + Object.keys(arv[a]).sort().map(c =>
      `<div class="grp2"><i class="ph ph-book-open" aria-hidden="true"></i> ${E(c)}</div>` + arv[a][c].sort((x, y) => ordP(x.parte) - ordP(y.parte) || (x.inicio || 0) - (y.inicio || 0)).map(s =>
        `<div class="hist"><div><b>${E(s.parte || 'Única')}</b> <small>${E(s.data)} · ${hms(s.duracao || 0)} · ${s.palavras != null ? s.palavras : 0} palavras${s.tipoAula ? ' · ' + E(TIPOS_AULA[s.tipoAula] || s.tipoAula) : ''}${s.preferenciaMaterial ? ' · material ' + E(PROFUNDIDADES[s.preferenciaMaterial] || s.preferenciaMaterial) : ''}${s.audioImportado ? ' · áudio ' + E(s.audioImportado) + ' (' + bytesAudio(s.audioBytes || 0) + ')' : ''}${s.revisada ? ' · revisada' : ''}${s.pronto ? ' · resumo disponível' + (s.nFlash ? ' + ' + s.nFlash + ' flashcards' : '') : ''}</small></div><div style="display:flex;gap:6px"><button class="b" onclick="auladia.abrir('${s.id}')">Abrir</button><button class="b" aria-label="Apagar aula ${E(s.tema || s.disciplina || s.parte || '')}" title="Apagar aula" onclick="auladia.apagar('${s.id}')"><i class="ph ph-trash" aria-hidden="true"></i></button></div></div>`).join('')).join('')).join('');
  }

  function filtrarHistorico(value) {
    const output = $('ad-history-list'); if (output) output.innerHTML = historicoAgrupado(value);
  }

  async function render() {
    css(); garantirView();
    const r = $('ad-root'); if (!r) return;
    await carregarStatus();
    if (rec) return desenharGravando();
    if (sessAtual && !rec) return desenharResultado();
    const opts = opcoesDisciplina();
    const hoje = (get('planner-v2-plan', null) || { perfil: {} }).perfil.aulasFaculdade || [];
    const aulaHoje = hoje.find(a => a.data === hojeISO());
    const d0 = aulaHoje ? aulaHoje.disciplina : '', t0 = aulaHoje ? aulaHoje.tema : '', pref = preferenciasAula();
    const partes = ['Única'].concat([1, 2, 3, 4, 5, 6, 7, 8].map(n => 'Parte ' + n));
    r.innerHTML = `<div class="ad"><div class="ad-workspace-head"><div><h2>Começar uma nova aula</h2><div class="sub">Prepare os dados essenciais e escolha como capturar o conteúdo. Os flashcards são gerados somente quando você pedir.</div></div></div>
    <section class="card ad-setup" aria-label="Preparar aula">
      <div class="ad-setup-actions"><button class="b pri" id="ad-start" type="button" onclick="auladia.iniciar()"><i class="ph ph-record" aria-hidden="true"></i> Gravar aula</button><button class="b" type="button"${transcOk ? '' : ' disabled title="Configure um provedor de transcrição no servidor"'} aria-describedby="ad-audio-note" onclick="document.getElementById('ad-audio-file').click()"><i class="ph ph-upload-simple" aria-hidden="true"></i> Enviar áudio</button><button class="b" type="button" onclick="document.getElementById('ad-setup-slides').click()"><i class="ph ph-presentation" aria-hidden="true"></i> Adicionar slides</button></div>
      <input id="ad-audio-file" name="audio" type="file" accept="audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,audio/flac,audio/x-m4a,.mp3,.m4a,.wav,.ogg,.webm,.flac" hidden onchange="auladia.importarAudio(this)">
      <input id="ad-setup-slides" type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx" hidden onchange="auladia.selecionarSlidesSetup(this)">
      <div id="ad-audio-meta" class="file-meta" role="status" aria-live="polite" aria-atomic="true"></div>
      <div id="ad-setup-slides-status" class="ad-setup-slides" role="status" aria-live="polite">${slidesPendente ? `Slides selecionados: ${E(slidesPendente.name)} · serão indexados quando você abrir o índice da aula.` : 'PDF ou PPTX opcional. O texto só será enviado ao índice após sua confirmação.'}</div>
      <div class="row"><div><label for="ad-disc">Disciplina</label><input id="ad-disc" name="disciplina" autocomplete="off" list="ad-discs" placeholder="Ex.: Cardiologia" value="${E(d0)}" oninput="auladia.parteAuto()"><datalist id="ad-discs">${opts.map(o => `<option value="${E(o)}">`).join('')}</datalist></div>
      <div><label for="ad-tema">Conteúdo da aula</label><input id="ad-tema" name="conteudo" autocomplete="off" placeholder="Ex.: Insuficiência cardíaca" value="${E(t0)}" oninput="auladia.parteAuto()"></div></div>
      <div class="row3"><div><label for="ad-parte">Parte ou identificação</label><select id="ad-parte" name="parte" onchange="this.dataset.manual=1">${partes.map(p => `<option${p === sugerirParte(d0, t0) ? ' selected' : ''}>${p}</option>`).join('')}</select></div><div></div><div></div></div>
      <details class="ad-advanced"><summary>Configurações pedagógicas avançadas</summary>
        <div class="row3"><div><label for="ad-tipo">Tipo de aula</label><select id="ad-tipo" name="tipoAula" onchange="auladia.salvarPreferencias()"><option value="expositiva"${pref.tipoAula === 'expositiva' ? ' selected' : ''}>Expositiva</option><option value="caso-clinico"${pref.tipoAula === 'caso-clinico' ? ' selected' : ''}>Discussão de caso</option><option value="revisao-prova"${pref.tipoAula === 'revisao-prova' ? ' selected' : ''}>Revisão para prova</option><option value="pratica"${pref.tipoAula === 'pratica' ? ' selected' : ''}>Aula prática ou procedimento</option></select></div><div><label for="ad-detalhe">Tamanho do material</label><select id="ad-detalhe" name="preferenciaMaterial" onchange="auladia.salvarPreferencias()"><option value="conciso"${pref.preferenciaMaterial === 'conciso' ? ' selected' : ''}>Enxuto</option><option value="equilibrado"${pref.preferenciaMaterial === 'equilibrado' ? ' selected' : ''}>Equilibrado</option><option value="detalhado"${pref.preferenciaMaterial === 'detalhado' ? ' selected' : ''}>Detalhado</option></select></div><div class="file-note">A duração é detectada no áudio; não precisa estimar.</div></div>
        <div class="row3"><div><label for="ad-perfil">Perfil pedagógico</label><select id="ad-perfil" name="perfilPedagogico"><option value="automatico" selected>Inferir pelo conteúdo</option>${perfisPedagogicos.map(p => `<option value="${E(p.id)}">${E(p.nome)}</option>`).join('')}</select></div><div><label for="ad-objetivo">Objetivo de estudo</label><select id="ad-objetivo" name="objetivoEstudo"><option value="automatico" selected>Automático pelo tipo e conteúdo</option><option value="compreender">Compreender</option><option value="prova">Preparar para prova</option><option value="osce">Aplicação prática / OSCE</option><option value="revisar">Revisar conteúdo estudado</option><option value="aprofundar">Aprofundar mecanismos</option></select></div><div class="file-note">O perfil pode ser inferido ou fixado manualmente.</div></div>
        <div class="row"><div><label for="ad-objetivos">Objetivos de aprendizagem</label><textarea id="ad-objetivos" name="objetivosAprendizagem" maxlength="1600" placeholder="Um objetivo por linha"></textarea></div><div><label for="ad-enfase">Ênfase da aula</label><input id="ad-enfase" name="enfasePedagogica" maxlength="300" placeholder="Ex.: diferenciar mecanismos e correlações"></div></div>
        <div class="card"><b>Teste de microfone</b><div class="sub" style="margin:4px 0 8px">Meça o nível antes da aula. O teste não grava nem envia áudio.</div><div class="ad-big" style="margin:0"><button class="b" type="button" id="ad-mic-test" onclick="auladia.testarMicrofone()">Testar microfone</button><div class="ad-meter" role="meter" aria-label="Nível de áudio do teste" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="ad-mic-meter"></i></div></div><div id="ad-mic-test-status" class="file-note" role="status" aria-live="polite">Fale por alguns segundos depois de iniciar o teste.</div><label class="ad-mic-toggle"><input id="ad-mic-processing" type="checkbox"${pref.processamentoAudio ? ' checked' : ''} onchange="auladia.salvarPreferencias()"><span>Usar cancelamento de eco, redução de ruído e ganho automático do navegador.</span></label><div class="file-note">Aproxime o microfone da fonte de voz e reduza conversas próximas.</div></div>
      </details>
      <details><summary class="file-note" style="cursor:pointer">Formatos e limites de áudio</summary><div id="ad-audio-note" class="file-note">MP3, M4A, WAV, OGG, WebM ou FLAC. ${audioUploadDireto ? 'Até 50 MB e 60 min; para uma aula de 1 h, MP3 mono a 64–96 kbps costuma equilibrar tamanho e inteligibilidade. Arquivos maiores que 3 MB passam temporariamente pelo bucket privado; a cópia local fica para reprodução e retry. Áudios acima de ' + bytesAudio(groqAudioMaxBytes) + (audioGrandeGemini ? ' usam a transcrição dedicada do Gemini.' : ' exigem Gemini configurado.') : 'Sem armazenamento de áudio configurado: arquivos de até 3 MB. A duração é detectada automaticamente.'}</div></details>
      <div class="file-note" style="margin-top:10px">Mantenha esta tela aberta durante a gravação; no iPhone, bloquear a tela ou trocar de app pode interrompê-la. Grave somente com autorização.</div>
    </section>
    <section class="card"><div style="display:flex;justify-content:space-between;gap:14px;align-items:end;flex-wrap:wrap"><div><h3 style="margin:0 0 4px">Aulas anteriores</h3><div class="sub" style="margin:0">Retome uma transcrição, resumo ou material salvo neste dispositivo.</div></div><input id="ad-history-search" class="ad-history-search" type="search" placeholder="Buscar disciplina, conteúdo ou data" aria-label="Buscar aulas anteriores" oninput="auladia.filtrarHistorico(this.value)"></div><div id="ad-history-list">${historicoAgrupado()}</div></section></div>`;
  }

  function estadoGrav() { return rec ? (rec.parar ? 'finalizando' : rec.parado ? 'parada' : rec.pausado ? 'pausada' : 'gravando') : null; }
  function decorridoMs() { if (!rec) return 0; return rec.ganho + (!(rec.pausado || rec.parado || rec.parar) ? Date.now() - rec.refer : 0).valueOf(); }

  function desenharGravando() {
    const r = $('ad-root'); if (!r || !rec) return;
    const est = estadoGrav();
    const enviados = rec.sess.chunks.filter(chunk => chunk.status === 'ok').length;
    const pendentes = rec.fila.length + rec.preparando;
    const bPausa = est === 'pausada'
      ? `<button class="b pri" onclick="auladia.continuar()"><i class="ph ph-play" aria-hidden="true"></i> Continuar</button>`
      : est === 'gravando' ? `<button class="b" onclick="auladia.pausar()"><i class="ph ph-pause"></i> Pausar</button>` : '';
    const bParada = est === 'parada'
      ? `<button class="b pri" onclick="auladia.retomar()"><i class="ph ph-microphone" aria-hidden="true"></i> Continuar gravação</button><button class="b pri" onclick="auladia.finalizar()"><i class="ph ph-check-circle" aria-hidden="true"></i> Finalizar e revisar</button>`
      : est === 'gravando' || est === 'pausada' ? `<button class="b" onclick="auladia.parar()"><i class="ph ph-stop-circle" aria-hidden="true"></i> Parar</button>` : '';
    const stTxt = est === 'pausada' ? 'Pausado. O microfone ficou em espera; o trecho atual foi guardado junto com o áudio.'
      : est === 'parada' ? 'Gravação parada. Toque em “Continuar gravação” para somar mais um trecho, ou “Finalizar e revisar” para gerar o material de estudo.'
      : est === 'finalizando' ? 'Finalizando e transcrevendo o último trecho…'
      : (transcOk ? 'Gravando · trechos enviados à IA a cada ~1,5 min' : 'Gravando · legenda ao vivo do navegador');
    r.innerHTML = `<div class="ad ad-recording"><div class="ad-workspace-head"><div><h2><span class="ad-dot" style="display:inline-block;margin-right:8px;${est === 'gravando' ? '' : 'animation:none;background:var(--amber)'}"></span>${est === 'gravando' ? 'Aula em andamento' : est === 'pausada' ? 'Gravação pausada' : est === 'parada' ? 'Gravação parada' : 'Finalizando aula'}</h2><div class="sub">${E(rec.sess.disciplina || 'Sem disciplina definida')}${rec.sess.tema ? ' · ' + E(rec.sess.tema) : ''} · ${E(rec.sess.parte || 'Única')}</div></div><button class="b" type="button" onclick="auladia.voltar()"${est === 'finalizando' ? ' disabled' : ''}>Aulas anteriores</button></div>
    <section class="card"><div class="ad-big" style="margin-top:0"><span class="ad-timer" id="ad-timer" role="timer" aria-label="Duração da gravação" aria-live="off">${mmss(decorridoMs() / 1000)}</span><div class="ad-meter" role="meter" aria-label="Nível sonoro captado" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="ad-meter"></i></div>
    <button class="b" type="button" onclick="auladia.marcar()"><i class="ph ph-bookmark-simple" aria-hidden="true"></i> Marcar momento</button><button class="b" type="button" onclick="auladia.duvida()" title="Marque um ponto para rever depois"><i class="ph ph-question" aria-hidden="true"></i> Marcar dúvida</button>${bPausa}${bParada}${est !== 'finalizando' ? `<button class="b pri" type="button" onclick="auladia.finalizar()"><i class="ph ph-check-circle" aria-hidden="true"></i> Finalizar aula</button>` : ''}</div>
    <div class="sub" id="ad-status" role="status" aria-live="polite" style="margin:8px 0 0">${E(stTxt)}</div>
    <div class="ad-index-state"><div class="ad-progress-line"><span>Microfone</span><span>${est === 'gravando' ? 'Captando' : est === 'pausada' ? 'Em espera' : 'Parado'}</span></div><div class="ad-progress-line"><span>Trechos transcritos</span><span>${enviados}${pendentes ? ` · ${pendentes} na fila` : ''}</span></div>${slidesPendente ? `<div class="ad-progress-line"><span>Slides</span><span>Selecionados; indexar após a gravação</span></div>` : ''}</div></section>
    <section class="card"><b>Transcrição ao vivo</b><div class="ad-tr" id="ad-tr" aria-live="polite" aria-atomic="false"></div></section>
    <p class="file-note">Mantenha o navegador aberto. A gravação em segundo plano depende do navegador e do sistema operacional.</p></div>`;
  }

  function textoHtml(s) {
    const partes = (s.chunks || []).slice().sort((a, b) => a.i - b.i).map(c => c.status === 'ok' ? E(c.texto) : c.status === 'erro' ? '<span class="pend">[trecho ' + (c.i + 1) + ' sem transcrição — toque em "Tentar novamente"]</span>' : '<span class="pend">[transcrevendo trecho ' + (c.i + 1) + '…]</span>');
    const live = s.live ? E(s.live) : '';
    return (partes.join('\n\n') + (live ? (partes.length ? '\n\n' : '') + live : '')).replace(/([\u2B50\u2753]) \[(\d\d:\d\d)\]/g, '<span class="mk">$1 [$2]</span>') || '<span class="pend">A transcrição aparecerá aqui…</span>';
  }
  function textoPuro(s) {
    const t = (s.chunks || []).slice().sort((a, b) => a.i - b.i).filter(c => c.status === 'ok').map(c => c.texto).join('\n\n');
    return (t + (s.live ? '\n\n' + s.live : '')).trim();
  }
  const tokensASR = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  function repeticaoNaEmenda(anterior, atual) {
    const a = tokensASR(anterior), b = tokensASR(atual), max = Math.min(10, a.length, b.length);
    for (let n = max; n >= 4; n--) if (a.slice(-n).join(' ') === b.slice(0, n).join(' ')) return n;
    return 0;
  }
  function alertasCaptura(s) {
    const chunks = (s.chunks || []).filter(c => Number.isInteger(c.i)).sort((a, b) => a.i - b.i), avisos = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i], anterior = chunks[i - 1];
      if (c.avisoCaptura) avisos.push({ i: c.i, texto: c.avisoCaptura });
      if (c.erroRetranscricao) avisos.push({ i: c.i, texto: 'A retranscrição falhou; a versão anterior foi mantida. ' + c.erroRetranscricao });
      if (anterior && c.status === 'ok' && anterior.status === 'ok' && repeticaoNaEmenda(anterior.texto, c.texto)) avisos.push({ i: c.i, texto: 'Possível repetição na emenda entre os trechos ' + (anterior.i + 1) + ' e ' + (c.i + 1) + '; confira antes de remover.' });
      if ((c.segs || []).some((g, n, all) => !Number.isFinite(g.a) || !Number.isFinite(g.b) || g.a < 0 || g.b <= g.a || n > 0 && g.a < all[n - 1].a)) avisos.push({ i: c.i, texto: 'Os tempos retornados pelo provedor têm uma inconsistência neste trecho.' });
      if (c.captura && c.captura.audioLocalSalvo === false) avisos.push({ i: c.i, texto: c.avisoAudio || 'O áudio deste trecho não está disponível para reprodução/retry neste navegador.' });
    }
    return avisos;
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

  async function pedirMicrofone(processarAudio = true) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { toast('Este navegador não permite gravar áudio. Use Safari (iOS 14.3+) ou Chrome.', 'error'); return null; }
    const audio = { echoCancellation: !!processarAudio, noiseSuppression: !!processarAudio, autoGainControl: !!processarAudio };
    try { return await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) {
      try { return await navigator.mediaDevices.getUserMedia({ audio: processarAudio ? true : audio }); } catch (e2) { e = e2; }
      const n = (e && e.name) || '';
      if (n === 'NotAllowedError' || n === 'SecurityError') toast('O navegador bloqueou o microfone para este site. No iPhone: Ajustes › Safari › Microfone › Permitir (ou toque em "aA" na barra do Safari › Ajustes do Site › Microfone › Permitir) e recarregue a página.', 'error');
      else if (n === 'NotReadableError' || n === 'AbortError') toast('O microfone está ocupado por outro app/aba (ligação, Jarvis, outra gravação). Feche e tente de novo.', 'error');
      else if (n === 'NotFoundError') toast('Nenhum microfone encontrado neste aparelho.', 'error');
      else toast('Não consegui acessar o microfone (' + (n || 'erro') + ').', 'error');
      return null;
    }
  }

  async function testarMicrofone() {
    const status = $('ad-mic-test-status'), meter = $('ad-mic-meter'), meterBox = meter && meter.parentElement, button = $('ad-mic-test');
    if (!status || !meter) return;
    if (button) button.disabled = true;
    status.dataset.state = 'info'; status.textContent = 'Aguardando permissão do microfone…';
    if (meterBox) meterBox.setAttribute('aria-valuenow', '0'); meter.style.width = '0%';
    let stream = null, ctx = null, raf = 0, timeout = 0;
    try {
      const processar = ($('ad-mic-processing') || {}).checked !== false;
      stream = await pedirMicrofone(processar);
      if (!stream) { status.dataset.state = 'warning'; status.textContent = 'Não foi possível abrir o microfone. Verifique a permissão do navegador.'; return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Este navegador não oferece medição de áudio. A gravação ainda pode funcionar.');
      ctx = new AC(); await ctx.resume();
      const source = ctx.createMediaStreamSource(stream), analyser = ctx.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
      const data = new Float32Array(analyser.fftSize); let count = 0, sumSquares = 0, peak = 0, clipped = 0;
      const inicio = Date.now(), duracaoMs = 3500;
      status.textContent = 'Fale normalmente por 3 segundos…';
      const finalizar = () => {
        if (!stream) return;
        cancelAnimationFrame(raf); clearTimeout(timeout);
        const track = stream.getAudioTracks()[0], config = track && track.getSettings ? track.getSettings() : {};
        try { stream.getTracks().forEach(track => track.stop()); } catch (_) {}
        try { ctx && ctx.close(); } catch (_) {}
        const rms = count ? Math.sqrt(sumSquares / count) : 0;
        const detalhes = [config.sampleRate ? (config.sampleRate / 1000).toFixed(config.sampleRate % 1000 ? 1 : 0) + ' kHz' : '', config.channelCount ? config.channelCount + (config.channelCount === 1 ? ' canal' : ' canais') : '', typeof config.noiseSuppression === 'boolean' ? 'redução de ruído ' + (config.noiseSuppression ? 'ativa' : 'inativa') : ''].filter(Boolean).join(' · ');
        const descricao = detalhes ? ' Captura: ' + detalhes + '.' : '';
        if (!count || peak < 0.005) { status.dataset.state = 'warning'; status.textContent = 'Quase nenhum som detectado. Confira a entrada selecionada e aproxime o microfone da fonte de voz.' + descricao; }
        else if (peak >= 0.995 || clipped / Math.max(1, count) > 0.005) { status.dataset.state = 'warning'; status.textContent = 'Sinal muito alto, com risco de clipping. Afaste o microfone ou reduza o volume de entrada.' + descricao; }
        else if (rms < 0.012) { status.dataset.state = 'warning'; status.textContent = 'Sinal baixo. Aproxime o aparelho (cerca de 20–50 cm) e faça outro teste.' + descricao; }
        else { status.dataset.state = 'success'; status.textContent = 'Nível detectado. Faça um teste curto e confira a reprodução antes de uma aula longa.' + descricao; }
        stream = null; if (button) button.disabled = false;
      };
      const medir = () => {
        if (!stream) return;
        analyser.getFloatTimeDomainData(data);
        let quadroPico = 0;
        for (const valor of data) { const abs = Math.abs(valor); quadroPico = Math.max(quadroPico, abs); sumSquares += valor * valor; count++; if (abs >= 0.995) clipped++; }
        peak = Math.max(peak, quadroPico);
        const nivel = Math.min(100, Math.round(quadroPico * 100)); meter.style.width = nivel + '%'; if (meterBox) meterBox.setAttribute('aria-valuenow', String(nivel));
        if (Date.now() - inicio >= duracaoMs) finalizar(); else raf = requestAnimationFrame(medir);
      };
      timeout = setTimeout(finalizar, duracaoMs + 300);
      raf = requestAnimationFrame(medir);
    } catch (error) {
      status.dataset.state = 'warning'; status.textContent = error.message || 'Falha ao medir o microfone.';
      try { stream && stream.getTracks().forEach(track => track.stop()); } catch (_) {}
      try { ctx && ctx.close(); } catch (_) {}
      stream = null;
    } finally { if (!stream && button) button.disabled = false; }
  }

  async function iniciar() {
    if (rec || iniciando) return;
    iniciando = true;
    try {
      // lê o formulário e pede o microfone ANTES de qualquer outra espera: o iPhone só libera o microfone no toque do usuário
      const disc = ($('ad-disc') || {}).value || '', tema = ($('ad-tema') || {}).value || '', parte = ($('ad-parte') || {}).value || 'Única', cor = ($('ad-cor') || {}).value || 'dourado';
      salvarPreferencias();
      const pref = preferenciasAula();
      const pedagogia = preferenciasPedagogicasFormulario();
      const stream = await pedirMicrofone(pref.processamentoAudio);
      if (!stream) return;
      garantirView(); css();
      await carregarStatus();
      if ($('view-auladia') && !$('view-auladia').classList.contains('active')) { go(VIEW); await new Promise(r => setTimeout(r, 200)); }
      await comecar(stream, disc, tema, parte, cor, pref.tipoAula, pref.preferenciaMaterial, pedagogia);
    } finally { iniciando = false; }
  }

  async function comecar(stream, disc, tema, parte, cor, tipoAula = 'expositiva', preferenciaMaterial = 'equilibrado', preferenciasPedagogicas = {}) {
    const sess = { id: 'a' + Date.now(), data: hojeISO(), inicio: Date.now(), disciplina: disc.trim(), tema: tema.trim(), parte, cor, tipoAula, preferenciaMaterial, perfilPedagogico: preferenciasPedagogicas.perfilPedagogico || 'automatico', objetivoEstudo: preferenciasPedagogicas.objetivoEstudo || 'automatico', objetivosAprendizagem: preferenciasPedagogicas.objetivosAprendizagem || '', enfasePedagogica: preferenciasPedagogicas.enfasePedagogica || '', duracao: 0, chunks: [], marcas: [], texto: '', live: '', resultado: null };
    const mime = escolherMime();
    rec = { sess, stream, mime, mr: null, t0: Date.now(), parar: false, pausado: false, parado: false, ganho: 0, refer: Date.now(), fila: [], enviando: false, preparando: 0, chunkIdx: 0, silencio: 0, timers: [], ctx: null, wake: null, sr: null };
    sessAtual = sess; salvarSess(sess);
    // medidor de nível
    try {
      const AC = window.AudioContext || window.webkitAudioContext; rec.ctx = new AC();
      const src = rec.ctx.createMediaStreamSource(stream); const an = rec.ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      rec.timers.push(setInterval(() => {
        an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128));
        const nv = Math.min(100, m * 1.6); const el = $('ad-meter'); if (el) el.style.width = nv + '%';
        if (el?.parentElement?.getAttribute('role') === 'meter') el.parentElement.setAttribute('aria-valuenow', String(Math.round(nv)));
        rec.silencio = nv < 3 ? rec.silencio + 0.1 : 0;
        // pausa de fala = nível bem abaixo do pico recente (funciona com ruído de sala, onde o silêncio absoluto nunca acontece)
        rec.pico = Math.max(nv, (rec.pico || 0) * 0.997);
        rec.pausaFala = nv < Math.max(4, rec.pico * 0.25) ? (rec.pausaFala || 0) + 0.1 : 0;
        if (estadoGrav() === 'gravando') {
          const st = $('ad-status'); if (st) st.textContent = rec.silencio > 20 ? 'Sem som há mais de 20 s. Verifique o microfone e a distância do professor.' : 'Gravando · trechos enviados à IA a cada ~1,5 min';
        }
      }, 100));
    } catch (_) {}
    rec.timers.push(setInterval(() => { const el = $('ad-timer'); if (el) el.textContent = mmss(decorridoMs() / 1000); if (!(rec.pausado || rec.parado || rec.parar)) sess.duracao = Math.round(decorridoMs() / 1000); }, 500));
    try { if (navigator.wakeLock) rec.wake = await navigator.wakeLock.request('screen'); } catch (_) {}
    document.addEventListener('visibilitychange', aoMudarVisibilidade);
    desenharGravando();
    iniciarTrecho();
    if (!transcOk) iniciarLegendaAoVivo();
    toast('Gravação iniciada', 'success');
  }

  async function aoMudarVisibilidade() {
    if (!rec) return;
    if (document.visibilityState === 'visible') { try { if (navigator.wakeLock && !rec.wake) rec.wake = await navigator.wakeLock.request('screen'); } catch (_) {} if (rec.ctx && rec.ctx.state === 'suspended') rec.ctx.resume().catch(() => {}); }
    else toast('A aula continua gravando, mas o iPhone pode pausar a gravação com a tela em segundo plano.', 'warning');
  }

  // Corte no silêncio: a partir de CHUNK_SOFT_MS o trecho termina na primeira pausa de fala (≥ 0,5 s), em vez de partir a frase no
  // meio aos 90 s fixos (que seguem como limite máximo). `gravadoMs` conta só o tempo realmente gravado (sem pausas).
  const deveCortar = (gravadoMs, silencioS) => gravadoMs >= CHUNK_SOFT_MS && silencioS >= SILENCIO_CORTE_S;

  function iniciarTrecho() {
    if (!rec || rec.parar || rec.pausado || rec.parado) return;
    const idx = rec.chunkIdx++;
    const parts = [];
    let mr;
    try { mr = new MediaRecorder(rec.stream, rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 }); }
    catch (e) { try { mr = new MediaRecorder(rec.stream); } catch (e2) { toast('Não foi possível iniciar a gravação neste navegador.', 'error'); return; } }
    rec.mr = mr; rec.tChunkStart = Date.now(); mr._startedAt = rec.tChunkStart; mr._elapsedStart = decorridoMs();
    mr.ondataavailable = ev => { if (ev.data && ev.data.size) parts.push(ev.data); };
    mr.onstop = () => {
      const blob = new Blob(parts, { type: mr.mimeType || rec.mime || 'audio/webm' });
      const r0 = rec, terminouEm = Date.now();
      if (r0 && blob.size > 2000) {
        const sess = r0.sess, anterior = sess.chunks.filter(c => Number.isInteger(c.i)).sort((a, b) => b.i - a.i)[0];
        const trackSettings = r0.stream.getAudioTracks()[0]?.getSettings?.() || {};
        const captura = { inicioUnixMs: mr._startedAt, fimUnixMs: terminouEm, inicioSessaoMs: mr._elapsedStart, fimSessaoMs: decorridoMs(), bytes: blob.size, mime: blob.type, sampleRate: Number(trackSettings.sampleRate) || null, canais: Number(trackSettings.channelCount) || null, echoCancellation: typeof trackSettings.echoCancellation === 'boolean' ? trackSettings.echoCancellation : null, noiseSuppression: typeof trackSettings.noiseSuppression === 'boolean' ? trackSettings.noiseSuppression : null, autoGainControl: typeof trackSettings.autoGainControl === 'boolean' ? trackSettings.autoGainControl : null, bitrateSolicitado: 64000, bitrateReportado: Number(mr.audioBitsPerSecond) || null, gapAnteriorMs: null, duracaoAudioS: null, audioLocalSalvo: null };
        const chunk = { i: idx, status: 'pendente', texto: '', mime: blob.type, dur: null, duracao: null, captura };
        sess.chunks.push(chunk); r0.preparando = (r0.preparando || 0) + 1; salvarSess(sess);
        // Reabre o gravador antes de qualquer operação assíncrona (IndexedDB/metadata), reduzindo a janela entre trechos.
        if (rec === r0 && !r0.parar && !r0.pausado && !r0.parado) iniciarTrecho();
        (async () => {
          try {
            try { await idbPut(sess.id + ':' + idx, blob); captura.audioLocalSalvo = true; }
            catch (_) { captura.audioLocalSalvo = false; chunk.avisoAudio = 'O áudio foi transcrito, mas não foi possível guardá-lo neste navegador para reprodução/retry.'; }
            try {
              const duracaoReal = await obterDuracaoAudio(blob);
              if (Number.isFinite(duracaoReal) && duracaoReal > 0) {
                chunk.dur = duracaoReal; chunk.duracao = duracaoReal; captura.duracaoAudioS = duracaoReal; captura.integridade = 'metadata_lida';
                const inicioAnteriorMs = anterior && anterior.captura && anterior.captura.inicioSessaoMs != null ? Number(anterior.captura.inicioSessaoMs) : NaN;
                const duracaoAnteriorMs = anterior && anterior.captura && anterior.captura.duracaoAudioS != null ? Number(anterior.captura.duracaoAudioS) * 1000 : NaN;
                if (Number.isFinite(inicioAnteriorMs) && Number.isFinite(duracaoAnteriorMs) && duracaoAnteriorMs > 0) captura.gapAnteriorMs = Math.max(0, mr._elapsedStart - inicioAnteriorMs - duracaoAnteriorMs);
              }
              else captura.integridade = 'duracao_indisponivel';
            } catch (_) { captura.integridade = 'duracao_indisponivel'; }
            if (captura.gapAnteriorMs > 750) chunk.avisoCaptura = 'Possível lacuna de ' + Math.round(captura.gapAnteriorMs) + ' ms entre trechos; confira a emenda no áudio.';
            salvarSess(sess);
            if (transcOk) { r0.fila.push({ sess, idx, blob }); bombear(); }
          } catch (error) {
            chunk.status = 'erro'; chunk.erro = 'Não foi possível preparar o trecho salvo: ' + String(error.message || error).slice(0, 180); salvarSess(sess);
          } finally {
            r0.preparando = Math.max(0, (r0.preparando || 1) - 1);
            if (r0.parar) finalizarDepois();
          }
        })();
      } else if (r0 && blob.size) {
        const sess = r0.sess; sess.chunks.push({ i: idx, status: 'ignorado', texto: '', mime: blob.type, dur: null, captura: { inicioUnixMs: mr._startedAt, fimUnixMs: terminouEm, bytes: blob.size, integridade: 'trecho_muito_pequeno' } }); salvarSess(sess);
        if (rec === r0 && !r0.parar && !r0.pausado && !r0.parado) iniciarTrecho();
      } else if (r0 && !r0.parar && !r0.pausado && !r0.parado && rec === r0) {
        iniciarTrecho();
      }
      // Pausa/parada intencional congela o capturador. Finalizar espera a persistência e a fila.
      if (r0 && r0.parar) finalizarDepois();
      else if (r0 && !r0.pausado && !r0.parado && rec === r0 && mr === r0.mr) iniciarTrecho();
    };
    mr.start();
    clearTimeout(rec.tChunk);
    rec.tChunk = setTimeout(() => { try { if (mr.state !== 'inactive') mr.stop(); } catch (_) {} }, CHUNK_MS);
    clearInterval(rec.vad); let gravado = 0;
    rec.vad = setInterval(() => {
      if (!rec || rec.mr !== mr) return clearInterval(rec && rec.vad);
      if (mr.state !== 'recording') return; // pausado/parado: não conta
      gravado += 250;
      if (deveCortar(gravado, rec.pausaFala || 0)) { clearInterval(rec.vad); try { mr.stop(); } catch (_) {} }
    }, 250);
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

  // ⭐ momento importante (sobe a prioridade da revisão) e ❓ dúvida (vai para "dúvidas" no resultado). Ambos viram uma linha na transcrição.
  function marcarTipo(emoji) {
    if (!rec) return;
    const t = mmss(decorridoMs() / 1000);
    if (emoji === '⭐') sessAtual.marcas.push(t); else (sessAtual.duvidasMarcas = sessAtual.duvidasMarcas || []).push(t);
    const n = sessAtual.marcas.length + (sessAtual.duvidasMarcas || []).length;
    // insere a marca no ponto atual da transcrição ao vivo / entre trechos
    if (!transcOk) sessAtual.live = (sessAtual.live ? sessAtual.live + '\n' : '') + emoji + ' [' + t + ']\n';
    else sessAtual.chunks.push({ i: rec.chunkIdx - 0.5 + n * 0.001, status: 'ok', texto: emoji + ' [' + t + ']' });
    atualizarTexto(); toast((emoji === '⭐' ? 'Momento marcado em ' : 'Dúvida marcada em ') + t, 'success');
  }
  const marcar = () => marcarTipo('⭐');
  const duvida = () => marcarTipo('\u2753');

  function pausar() {
    if (!rec || rec.pausado || rec.parado || rec.parar) return;
    rec.pausado = true;
    clearTimeout(rec.tChunk);
    rec.ganho += Date.now() - rec.refer;
    try {
      if (rec.mr && rec.mr.state === 'recording') { try { rec.mr.pause(); } catch (e) { rec.mr.stop(); } }
      else if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop();
    } catch (_) {}
    try { rec.sr && rec.sr.stop(); } catch (_) {} // legenda ao vivo também congela na pausa
    desenharGravando();
    toast('Gravação em pausa — o trecho em curso ficou salvo com o áudio.', 'info');
  }

  function continuar() {
    if (!rec || !rec.pausado || rec.parado || rec.parar) return;
    rec.pausado = false; rec.refer = Date.now();
    let retomou = false;
    try { if (rec.mr && rec.mr.state === 'paused') { rec.mr.resume(); retomou = true; } } catch (_) {}
    if (!retomou || !rec.mr || rec.mr.state === 'inactive') { rec.mr = null; iniciarTrecho(); }
    else { // replaneja a virada do trecho com o tempo que restava
      clearTimeout(rec.tChunk);
      const restante = Math.max(5000, CHUNK_MS - (Date.now() - (rec.tChunkStart || Date.now())));
      rec.tChunk = setTimeout(() => { try { if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); } catch (_) {} }, restante);
    }
    if (!transcOk) iniciarLegendaAoVivo();
    desenharGravando();
    toast('Gravação retomada.', 'success');
  }

  function parar() { // ⏹ Para a gravação sem encerrar a sessão — dá para continuar depois
    if (!rec || rec.parar) return;
    rec.parado = true; rec.pausado = false;
    clearTimeout(rec.tChunk);
    rec.ganho += Date.now() - rec.refer;
    try { rec.sr && rec.sr.stop(); } catch (_) {}
    sessAtual.duracao = Math.round(decorridoMs() / 1000);
    try { if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); } catch (_) {}
    desenharGravando();
    atualizarTexto();
  }

  function retomar() { // ▶ Continua a gravação após o ⏹
    if (!rec || !rec.parado || rec.parar) return;
    rec.parado = false; rec.refer = Date.now(); rec.mr = null;
    iniciarTrecho();
    if (!transcOk) iniciarLegendaAoVivo();
    desenharGravando();
    toast('Gravação retomada — o novo trecho entra no fim da aula.', 'success');
  }

  function finalizar() { // Encerra a gravação e inicia a revisão e geração dos materiais.
    if (!rec || rec.parar) return;
    const duracaoFinal = Math.round(decorridoMs() / 1000);
    rec.parar = true; rec.pausado = false; rec.parado = false;
    rec.timers.forEach(clearInterval); clearTimeout(rec.tChunk); clearInterval(rec.vad);
    try { rec.sr && rec.sr.stop(); } catch (_) {}
    sessAtual.duracao = duracaoFinal;
    try { if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); else finalizarDepois(); } catch (_) { finalizarDepois(); }
    desenharGravando();
  }

  function finalizarDepois() {
    if (!rec) return;
    const r0 = rec;
    if (r0.finalizando) return;
    r0.finalizando = true;
    try { r0.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { r0.ctx && r0.ctx.close(); } catch (_) {}
    try { r0.wake && r0.wake.release(); } catch (_) {}
    document.removeEventListener('visibilitychange', aoMudarVisibilidade);
    const esperar = async () => {
      while (r0.fila.length || r0.enviando || r0.preparando) await new Promise(r => setTimeout(r, 400));
      rec = null;
      const audioCapturado = r0.sess.chunks.reduce((total, c) => total + Math.max(0, Number(c.captura && c.captura.duracaoAudioS) || 0), 0);
      if (audioCapturado > 0) r0.sess.duracao = Math.round(audioCapturado);
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

  const AUDIO_MAX_BYTES = () => audioUploadDireto ? audioMaxBytes : audioInlineMaxBytes;
  function statusArquivo(texto, estado) {
    const el = $('ad-audio-meta'); if (!el) return;
    el.textContent = texto || ''; el.dataset.state = estado || 'info';
  }
  function erroArquivo(texto) { statusArquivo(texto, 'error'); toast(texto, 'error'); }
  function obterDuracaoAudio(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), el = new Audio(); let terminou = false;
      const timer = setTimeout(() => { if (terminou) return; terminou = true; limpar(); reject(new Error('O navegador demorou para ler os metadados de duração.')); }, 8000);
      const limpar = () => { clearTimeout(timer); URL.revokeObjectURL(url); el.onloadedmetadata = null; el.onerror = null; el.removeAttribute('src'); };
      el.preload = 'metadata';
      el.onloadedmetadata = () => { if (terminou) return; terminou = true; const d = el.duration; limpar(); Number.isFinite(d) && d > 0 ? resolve(d) : reject(new Error('Duração do áudio indisponível.')); };
      el.onerror = () => { if (terminou) return; terminou = true; limpar(); reject(new Error('O navegador não reconheceu este arquivo de áudio.')); };
      el.src = url;
    });
  }
  function bytesAudio(n) { return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + '\u00a0MB' : Math.ceil(n / 1000) + '\u00a0KB'; }
  async function importarAudio(input) {
    const file = input && input.files && input.files[0]; if (!file) return;
    input.value = '';
    if (rec || iniciando || pipelineRodando || uploadRodando) return erroArquivo('Finalize a atividade atual antes de importar outro áudio.');
    if (!transcOk) return erroArquivo('Transcrição de áudio indisponível. Configure um provedor de transcrição no servidor.');
    statusArquivo(file.name + ' · ' + bytesAudio(file.size) + ' · verificando arquivo…', 'info');
    if (file.size > AUDIO_MAX_BYTES()) return erroArquivo('O arquivo tem ' + bytesAudio(file.size) + '. O limite disponível é ' + bytesAudio(AUDIO_MAX_BYTES()) + '. Para aulas de 1 hora, exporte em MP3 mono a 64–96 kbps; WAV pode ultrapassar o limite.');
    const ext = /\.([^.]+)$/.exec(file.name || '');
    const porExt = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac' };
    const formatos = ['audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/ogg','audio/webm','audio/flac','audio/x-flac','audio/x-m4a'];
    const mimeInformado = String(file.type || '').split(';')[0].toLowerCase();
    let mime = formatos.includes(mimeInformado) ? mimeInformado : porExt[(ext && ext[1] || '').toLowerCase()] || '';
    if (mime === 'audio/x-flac') mime = 'audio/flac';
    if (mime === 'audio/x-wav') mime = 'audio/wav';
    if (mime === 'audio/x-m4a') mime = 'audio/mp4';
    if (!mime) return erroArquivo('Formato não suportado. Use MP3, M4A, WAV, OGG, WebM ou FLAC.');
    uploadRodando = true;
    try {
      const duracao = await obterDuracaoAudio(file);
      if (duracao > 3600) return erroArquivo('Cada arquivo pode ter até 60 minutos. Divida aulas mais longas em partes menores.');
      if (file.size > groqAudioMaxBytes && !audioGrandeGemini) return erroArquivo('Este áudio passa de ' + bytesAudio(groqAudioMaxBytes) + '. Configure GEMINI_API_KEY e mantenha AI_PROVIDER diferente de groq para processar arquivos longos.');
      statusArquivo(file.name + ' · ' + duracaoAudio(duracao) + ' · ' + bytesAudio(file.size) + ' · salvando uma cópia local…', 'info');
      salvarPreferencias();
      const pref = preferenciasAula();
      const sess = { id: 'a' + Date.now(), data: hojeISO(), inicio: Date.now(), disciplina: (($('ad-disc') || {}).value || '').trim(), tema: (($('ad-tema') || {}).value || '').trim(), parte: ($('ad-parte') || {}).value || 'Única', ...pref, ...preferenciasPedagogicasFormulario(), duracao: Math.round(duracao), audioBytes: file.size, chunks: [{ i: 0, status: 'pendente', texto: '', mime, duracao }], marcas: [], texto: '', live: '', resultado: null, audioImportado: file.name };
      await idbPut(sess.id + ':0', file);
      sessAtual = sess; await salvarAgora(sess); desenharResultado();
      const c = sess.chunks[0]; c.status = 'transcrevendo'; await salvarAgora(sess); desenharResultado();
      await transcreverTrecho(sess, 0, file);
      sess.texto = textoPuro(sess); await salvarAgora(sess); desenharResultado();
      if (c.status !== 'ok') return toast('A transcrição falhou. O arquivo foi mantido nesta sessão para tentar novamente.', 'error');
      if (geminiOk && sess.texto.length > 200) await pipeline(sess);
      else toast('Transcrição pronta. Revise o texto; a geração dos materiais precisa de IA de texto ativa.', 'success');
    } catch (e) { erroArquivo('Não consegui importar o áudio: ' + (e.message || 'erro inesperado')); }
    finally { uploadRodando = false; }
  }

  async function obterGlossarioASR(sess) {
    const slides = Array.isArray(sess.iscSlideResourceKeys) ? sess.iscSlideResourceKeys.slice(0, 12) : [];
    let topicos = Array.isArray(sess.iscGlossarioASR) ? sess.iscGlossarioASR : null;
    if (slides.length && !topicos) {
      try {
        const result = await post('/api/isc/lesson-index', { resourceKeys: slides }, 1);
        topicos = (result.index?.topics || []).map(topic => ({ id: String(topic.topicId || ''), nome: String(topic.name || '').trim() })).filter(topic => topic.nome);
      } catch (_) { topicos = []; }
      sess.iscGlossarioASR = topicos;
      await salvarAgora(sess);
    }
    const selecionados = new Set(sess.iscSelectedTopicIds || []);
    const ordenados = (topicos || []).slice().sort((a, b) => Number(selecionados.has(b.id)) - Number(selecionados.has(a.id)));
    return [...new Set([...ordenados.map(topic => topic.nome), ...assuntosPlano(sess.disciplina)])]
      .map(termo => String(termo || '').trim().slice(0, 120)).filter(Boolean).slice(0, 80);
  }

  async function enviarAudioParaTranscricao(blob, sess, chunk, anterior) {
    let mime = blob.type || chunk.mime || 'audio/webm';
    if (mime === 'audio/x-wav') mime = 'audio/wav';
    if (mime === 'audio/x-m4a') mime = 'audio/mp4';
    if (mime === 'audio/x-flac') mime = 'audio/flac';
    const contexto = { mime, disciplina: sess.disciplina, tema: (sess.tema + (sess.parte && sess.parte !== 'Única' ? ' — ' + sess.parte : '')).trim(), anterior, glossario: await obterGlossarioASR(sess), tipoAula: sess.tipoAula || 'expositiva' };
    if (blob.size <= audioInlineMaxBytes) {
      return fetch('/api/aula/transcrever', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: await blobParaB64(blob), ...contexto }) });
    }
    if (!audioUploadDireto) throw new Error('Este arquivo precisa de upload direto. Configure SUPABASE_SERVICE_ROLE_KEY no servidor.');
    const client = window.supabase;
    if (!client || !client.storage) throw new Error('O cliente Supabase ainda não está pronto. Recarregue a página e tente novamente.');
    if (sess.audioImportado) statusArquivo(sess.audioImportado + ' · enviando ' + bytesAudio(blob.size) + ' ao armazenamento temporário…', 'info');
    const initResponse = await fetch('/api/aula/audio/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bytes: blob.size, mime }) });
    const init = await initResponse.json().catch(() => ({}));
    if (!initResponse.ok || !init.success) throw new Error(init.msg || 'Não foi possível preparar o upload do áudio.');
    try {
      const uploaded = await client.storage.from(init.bucket).uploadToSignedUrl(init.path, init.token, blob, { contentType: blob.type, cacheControl: '60' });
      if (uploaded.error) throw uploaded.error;
      if (sess.audioImportado) statusArquivo(sess.audioImportado + ' · enviado · transcrevendo aula…', 'info');
      return await fetch('/api/aula/audio/transcrever', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...contexto, path: init.path, bytes: blob.size, duracao: Number(chunk.duracao || chunk.dur) || 0 }) });
    } catch (error) {
      fetch('/api/aula/audio/remover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: init.path }) }).catch(() => {});
      throw error;
    }
  }

  async function transcreverTrecho(sess, idx, blob) {
    const c = sess.chunks.find(x => x.i === idx); if (!c) return;
    c.status = 'transcrevendo'; delete c.erro; salvarSess(sess);
    if (!rec && sessAtual === sess) desenharResultado();
    const anterior = textoPuro(sess).slice(-300);
    let usarWav = false, ultimoErro = '';
    for (let tent = 0; tent < 4; tent++) {
      let esperaMs = 1500 * (tent + 1);
      try {
        if (usarWav && Number(c.duracao || c.dur) > 600) {
          ultimoErro = 'Não converto automaticamente aulas longas para WAV para evitar uso excessivo de memória. Exporte em MP3 ou M4A e tente novamente.';
          break;
        }
        if (usarWav && Number(c.duracao || c.dur) > 0 && Number(c.duracao || c.dur) * 32000 + 44 > AUDIO_MAX_BYTES()) {
          ultimoErro = 'A conversão para WAV excederia o limite de ' + bytesAudio(AUDIO_MAX_BYTES()) + '. Envie o original em MP3/M4A ou reduza o bitrate.';
          break;
        }
        const b = usarWav ? await paraWav16k(blob) : blob;
        if (b.size > AUDIO_MAX_BYTES()) { ultimoErro = 'O áudio excede o limite disponível de ' + bytesAudio(AUDIO_MAX_BYTES()) + '.'; break; }
        const r = await enviarAudioParaTranscricao(b, sess, c, anterior);
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.success) {
          const novoTexto = j.texto || '';
          if (c.texto && c.texto !== novoTexto) {
            const historico = c.historicoTranscricoes || (c.historicoTranscricoes = []);
            historico.push({ em: new Date().toISOString(), texto: c.texto });
            c.historicoTranscricoes = historico.slice(-5);
          }
          c.status = 'ok'; c.texto = novoTexto; delete c.erro;
          // segmentos com marca de tempo (Whisper verbose_json) — entram no timeline do karaoke
          c.segs = (Array.isArray(j.segmentos) && j.segmentos.length) ? j.segmentos.map(x => {
            const avg = x.avgLogprob == null ? null : Number(x.avgLogprob), semFala = x.noSpeechProb == null ? null : Number(x.noSpeechProb);
            return { a: Number(x.ini) || 0, b: Number(x.fim) || 0, t: String(x.text || ''), avgLogprob: Number.isFinite(avg) ? avg : null, noSpeechProb: Number.isFinite(semFala) ? semFala : null, baixaConfianca: Number.isFinite(avg) && avg <= -1 || Number.isFinite(semFala) && semFala >= 0.6 };
          }) : null;
          c.dur = null; salvarSess(sess); return; // O áudio (blob) permanece no IndexedDB e alimenta o modo karaoke.
        }
        if (j.formato && !usarWav) { usarWav = true; continue; }
        ultimoErro = String(j.msg || j.error || ('Falha na transcrição (HTTP ' + r.status + ').')).slice(0, 240);
        if (r.status === 429) esperaMs = Math.max(esperaMs, Number(j.retryAfterMs) || Number(r.headers.get('retry-after')) * 1000 || 0);
        else if ([400, 413, 415, 422, 503].includes(r.status)) break;
      } catch (e) { ultimoErro = e && e.message ? String(e.message).slice(0, 240) : 'Falha de conexão ao transcrever.'; }
      if (tent < 3) await new Promise(r => setTimeout(r, Math.min(60000, esperaMs)));
    }
    c.status = 'erro'; c.erro = ultimoErro || 'Não foi possível transcrever após 4 tentativas.'; salvarSess(sess);
  }

  async function reenviarFalhas() {
    const s = sessAtual; if (!s) return;
    const falhas = (s.chunks || []).filter(c => c.status === 'erro' || c.status === 'pendente');
    if (!falhas.length) return toast('Nada pendente.', 'success');
    toast('Reenviando ' + falhas.length + ' trecho(s)…', 'info');
    for (const c of falhas) {
      const blob = await idbGet(s.id + ':' + c.i);
      if (!blob) { c.status = 'erro'; c.erro = 'O arquivo deste trecho não está mais salvo neste navegador. Importe o áudio novamente.'; continue; }
      c.status = 'pendente'; await transcreverTrecho(s, c.i, blob);
    }
    s.texto = textoPuro(s); salvarSess(s); desenharResultado();
    toast('Pronto.', 'success');
  }

  async function retranscreverTrechoSelecionado(idx) {
    const s = sessAtual, c = s && (s.chunks || []).find(x => x.i === idx);
    if (!s || !c || pipelineRodando || uploadRodando) return;
    const blob = await idbGet(s.id + ':' + idx);
    if (!blob) return toast('O áudio original deste trecho não está salvo neste navegador.', 'error');
    const textoAnterior = c.texto || '', statusAnterior = c.status;
    s.texto = textoPuro(s);
    if (textoAnterior) arquivarMateriais(s, 'Antes da retranscrição do trecho ' + (idx + 1));
    c.status = 'pendente'; await salvarAgora(s); desenharResultado();
    await transcreverTrecho(s, idx, blob);
    if (c.status === 'erro' && textoAnterior) {
      c.erroRetranscricao = c.erro; c.erro = null; c.status = statusAnterior === 'ok' ? 'ok' : statusAnterior; c.texto = textoAnterior;
      toast('A nova tentativa falhou; a transcrição anterior foi mantida.', 'warning');
    } else if (c.texto !== textoAnterior) {
      delete c.erroRetranscricao;
      s.revisaoDesatualizada = !!s.textoRevisado;
      s.materiaisAguardamAtualizacao = true;
    }
    s.texto = textoPuro(s); await salvarAgora(s); desenharResultado();
    if (c.status === 'ok' && c.texto !== textoAnterior) toast('Trecho retranscrito. A versão anterior foi preservada no histórico.', 'success');
  }

  /* ───────────── pipeline: revisão → resumo → flashcards → material ───────────── */
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

  // Executa fn(item) com no máximo n em voo. Em erro, para de iniciar novos itens, espera os em voo e relança o primeiro erro.
  async function pool(n, itens, fn) {
    let prox = 0, erro = null;
    const ws = Array.from({ length: Math.max(1, Math.min(n, itens.length)) }, async () => {
      while (prox < itens.length && !erro) { const it = itens[prox++]; try { await fn(it); } catch (e) { erro = erro || e; } }
    });
    await Promise.all(ws);
    if (erro) throw erro;
  }

  // Limitador global: no máximo n tarefas em execução ao mesmo tempo, as demais esperam na fila (ordem de chegada).
  function limitador(n) {
    let ativos = 0; const fila = [];
    const solta = () => { while (ativos < n && fila.length) { ativos++; fila.shift()(); } };
    return (fn) => new Promise((ok, no) => { fila.push(() => { Promise.resolve().then(fn).then(ok, no).finally(() => { ativos--; solta(); }); }); solta(); });
  }

  function passos(s, estado) {
    const L = [['rev', 'Revisando a transcrição (termos médicos, emendas, parágrafos)'], ['res', 'Escrevendo o resumo completo'], ['fc', 'Flashcards (sob demanda)'], ['mat', 'Montando "cai na prova" e assuntos do plano']];
    const html = L.map(([k, n]) => { const e = estado[k] || ''; const icon = e === 'ok' ? 'ph-check-circle' : e === 'go' ? 'ph-circle-notch' : e === 'er' ? 'ph-x-circle' : 'ph-circle'; return `<div class="ad-step ${e === 'ok' ? 'ok' : e === 'go' ? 'go' : e === 'er' ? 'er' : ''}"><i class="ph ${icon}" aria-hidden="true"></i> ${n}${estado[k + 'Info'] ? ' — ' + E(estado[k + 'Info']) : ''}</div>`; }).join('');
    htmlPassos = html; const el = $('ad-proc'); if (el && sessAtual === s) el.innerHTML = html;
  }

  async function pipeline(s) {
    if (pipelineRodando) return toast('Já estou processando esta aula.', 'info');
    if (!geminiOk) return toast('Para revisar e resumir é preciso uma chave de IA (Gemini ou Groq) no servidor.', 'warning');
    const solicitouCartoes = !!s.solicitouFlashcards;
    pipelineRodando = true;
    const est = { rev: s.textoRevisado ? 'ok' : '', res: s.resumoMd ? 'ok' : '', fc: s.flashcards ? 'ok' : '', mat: s.resultado ? 'ok' : '' };
    passos(s, est);
    const ctx = { area: s.disciplina, conteudo: [s.tema, s.parte && s.parte !== 'Única' ? s.parte : ''].filter(Boolean).join(' — '), glossario: assuntosPlano(s.disciplina).slice(0, 60), tipoAula: s.tipoAula || 'expositiva', preferenciaMaterial: s.preferenciaMaterial || 'equilibrado', perfilPedagogico: s.perfilPedagogico || 'automatico', objetivoEstudo: s.objetivoEstudo || 'automatico', objetivosAprendizagem: s.objetivosAprendizagem || '', enfasePedagogica: s.enfasePedagogica || '' };
    try {
      s.texto = textoPuro(s) || s.texto;
      const N = Math.max(1, paralelo);
      const gate = limitador(N); const postL = (u, c, t) => gate(() => post(u, c, t)); // teto GLOBAL de chamadas simultâneas, somando todas as frentes
      // 1) Revisão da transcrição, pedaço a pedaço (blocos independentes → em paralelo quando o servidor permite)
      if (!s.textoRevisado) {
        est.rev = 'go'; passos(s, est);
        const blocos = dividirTexto(s.texto); const saida = new Array(blocos.length); let feitos = 0;
        est.revInfo = '0/' + blocos.length; passos(s, est);
        await pool(N, blocos.map((_, i) => i), async (i) => {
          saida[i] = (await postL('/api/aula/revisar', Object.assign({ texto: blocos[i] }, ctx))).texto;
          if (!String(saida[i] || '').trim()) throw new Error('Revisão vazia: a transcrição original foi preservada.');
          est.revInfo = (++feitos) + '/' + blocos.length; passos(s, est);
        });
        s.textoRevisado = saida.join('\n\n'); est.rev = 'ok'; est.revInfo = ''; await salvarAgora(s); passos(s, est);
        if (abaRes === 'transcricao') { const el = document.querySelector('#ad-root .ad-tr'); if (el) el.innerHTML = E(s.textoRevisado); }
      }
      const fonte = s.textoRevisado || s.texto;
      // 2) O mapa vem primeiro (os flashcards usam os capítulos como "tema"); depois as três frentes são independentes:
      //    A) capítulos + fechamento, B) flashcards, C) "cai na prova"/assuntos. Em paralelo quando N > 1.
      if (!s.resumoMd) {
        est.res = 'go'; est.resInfo = 'mapeando tópicos'; passos(s, est);
        if (!s.mapa) {
          const mapeado = await postL('/api/aula/mapa', Object.assign({ transcricao: fonte, parte: s.parte }, ctx));
          s.mapa = mapeado.mapa; s.planoPedagogico = mapeado.planoPedagogico || null; await salvarAgora(s);
        }
      }
      if (!s.planoPedagogico) {
        const plano = await postL('/api/aula/plano', Object.assign({}, ctx, { capitulos: (s.mapa && s.mapa.capitulos) || [] }));
        s.planoPedagogico = plano.planoPedagogico; await salvarAgora(s);
      }
      ctx.planoPedagogico = s.planoPedagogico;
      // 2b) Extração única (fase 2): lê a aula UMA vez e deriva fechamento/flashcards/"cai na prova" da base.
      //     Se falhar, segue o caminho antigo (cada etapa relendo a aula) — nada deixa de ser gerado.
      if (!s.base && (!s.fechamento || !s.flashcards || !s.resultado)) {
        try {
          est.res = est.res === 'ok' ? 'ok' : 'go'; est.resInfo = 'extraindo fatos da aula'; passos(s, est);
          s.base = (await postL('/api/aula/extrair', Object.assign({ transcricao: fonte, capitulos: (s.mapa && s.mapa.capitulos) || [], assuntosPlano: assuntosPlano(s.disciplina), marcas: s.marcas, duvidasMarcas: s.duvidasMarcas || [] }, ctx))).base;
          await salvarAgora(s);
        } catch (_) { s.base = null; }
      }
      const baseOpt = () => (s.base && Array.isArray(s.base.fatos) && s.base.fatos.length ? { base: s.base } : {});
      const frenteResumo = async () => {
        if (s.resumoMd) return;
        const caps = (s.mapa && s.mapa.capitulos) || []; s.caps = Array.isArray(s.caps) ? s.caps : [];
        const faltam = caps.map((_, i) => i).filter(i => !s.caps[i]); let prontos = caps.length - faltam.length;
        est.resInfo = prontos + '/' + caps.length + ' capítulos'; passos(s, est);
        await pool(N, faltam, async (i) => {
          const j = await postL('/api/aula/capitulo', Object.assign({ transcricao: fonte, capitulo: caps[i], numero: i + 1, total: caps.length }, ctx), 3);
          s.caps[i] = j.markdown; await salvarAgora(s);
          est.resInfo = (++prontos) + '/' + caps.length + ' capítulos'; passos(s, est);
        });
        if (!s.fechamento) { est.resInfo = 'considerações finais e revisão'; passos(s, est); s.fechamento = (await postL('/api/aula/fechamento', Object.assign({ transcricao: fonte, capitulos: caps, temQuestoes: !!s.mapa.temQuestoes }, baseOpt(), ctx))).markdown; await salvarAgora(s); }
        s.resumoMd = montarResumoMd(s); est.res = 'ok'; est.resInfo = ''; await salvarAgora(s); passos(s, est);
      };
      const frenteFlash = async () => {
        if (s.flashcards) return;
        est.fc = 'go'; passos(s, est);
        const cards = (await postL('/api/aula/flashcards', Object.assign({ transcricao: fonte, capitulos: (s.mapa && s.mapa.capitulos) || [] }, baseOpt(), ctx))).flashcards;
        if (!Array.isArray(cards) || !cards.length) throw new Error('Nenhum cartão válido retornado. Tente gerar novamente.');
        s.flashcards = cards;
        est.fc = 'ok'; est.fcInfo = s.flashcards.length + ' cartões'; await salvarAgora(s); passos(s, est);
      };
      const frenteMaterial = async () => {
        if (s.resultado) return;
        est.mat = 'go'; passos(s, est);
        s.resultado = (await postL('/api/aula/processar', Object.assign({ transcricao: fonte, disciplina: s.disciplina, tema: ctx.conteudo, assuntosPlano: assuntosPlano(s.disciplina), marcas: s.marcas }, baseOpt(), ctx))).resultado;
        if (!s.resultado) throw new Error('Material de revisão ausente.');
        est.mat = 'ok'; await salvarAgora(s); passos(s, est);
      };
      const frentes = [frenteResumo, frenteMaterial];
      if (s.solicitouFlashcards && !s.flashcards) frentes.push(frenteFlash);
      if (N > 1) {
        // allSettled: uma frente que falha não interrompe as outras (o que ficou pronto é salvo); o primeiro erro é relançado no fim
        const rs = await Promise.allSettled(frentes.map(f => f()));
        const falha = rs.find(r => r.status === 'rejected'); if (falha) throw falha.reason;
      } else { for (const f of frentes) await f(); }
      if (s.flashcards) { s.solicitouFlashcards = false; await salvarAgora(s); }
      if (sessAtual === s) { abaRes = solicitouCartoes ? 'flash' : 'resumo'; desenharResultado(); }
      verificarQualidade(s, true); // sem IA: não atrasa nem pode quebrar o pipeline
      toast('Aula pronta: transcrição revisada e material gerado.' + (s.flashcards ? ' ' + s.flashcards.length + ' flashcards disponíveis.' : ' Flashcards serão criados quando você solicitar.'), 'success');
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
    let md = `# ${s.tema || s.disciplina || 'Aula'} — material de estudo\n\n> **${nome}**\n> Disciplina: ${s.disciplina || '—'}\n> ${new Date().getFullYear()}\n> Gerado por IA a partir da transcrição; confira doses, condutas e critérios antes de usar em prova.\n\n## Índice\n\n`;
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

  /* ───────────── modo KARAOKE: áudio guardado + transcrição pintada em tempo real ───────────── */
  const ak = { pars: [], cur: -1, j: 0, chave: '', el: null, url: null, montando: false };

  // duração de um trecho de áudio (decodeAudioData; se o webm vier sem metadados, hack do seek)
  async function durDe(blob) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC();
      const dec = await ctx.decodeAudioData(await blob.arrayBuffer()); ctx.close && ctx.close();
      if (isFinite(dec.duration) && dec.duration > 0) return dec.duration;
    } catch (_) {}
    try {
      return await new Promise((ok, no) => {
        const a = new Audio(); a.preload = 'metadata';
        a.onloadedmetadata = () => {
          if (isFinite(a.duration) && a.duration > 0) { URL.revokeObjectURL(a.src); ok(a.duration); return; }
          a.currentTime = 1e7;
          a.onseeked = () => { const d = a.duration; URL.revokeObjectURL(a.src); ok(isFinite(d) && d > 0 ? d : CHUNK_MS / 1000); };
        };
        a.onerror = () => { URL.revokeObjectURL(a.src); no(new Error('sem duração')); };
        a.src = URL.createObjectURL(blob);
      });
    } catch (_) { return CHUNK_MS / 1000; }
  }

  function karaokeParar(sair) {
    try { const au = $('ak-au'); au && au.pause(); } catch (_) {}
    if (sair) {
      if (ak.url) { URL.revokeObjectURL(ak.url); ak.url = null; }
      ak.cur = -1; ak.j = 0; ak.chave = ''; ak.el = null; ak.pars = []; ak.montando = false;
    }
  }

  function karaokeTick() {
    const au = $('ak-au'); const it = ak.pars[ak.cur];
    if (!au || !it) return;
    const tL = au.currentTime;
    let j = ak.j;
    if (it.c.segs && it.c.segs.length) {
      j = Math.max(0, Math.min(j, it.c.segs.length - 1));
      while (j + 1 < it.c.segs.length && it.c.segs[j].b <= tL) j++;
      while (j > 0 && it.c.segs[j - 1].b > tL) j--;
    } else j = 0;
    const chave = ak.cur + '-' + j;
    if (chave === ak.chave) return;
    ak.chave = chave; ak.j = j;
    if (ak.el) ak.el.classList.remove('on');
    ak.el = document.getElementById('ak-' + chave);
    if (ak.el) {
      ak.el.classList.add('on');
      const m = $('ak-max');
      if (m && !au.paused) m.scrollTo({ top: Math.max(0, ak.el.offsetTop - m.clientHeight / 2), behavior: 'smooth' });
    }
  }

  async function kVai(i, jIdx) {
    const it = ak.pars[i]; const au = $('ak-au');
    if (!it || !au) return;
    if (ak.cur !== i || !au.src) {
      if (ak.url) { URL.revokeObjectURL(ak.url); ak.url = null; }
      ak.url = URL.createObjectURL(it.blob);
      ak.cur = i; ak.j = jIdx || 0; ak.chave = '';
      au.src = ak.url;
      await new Promise(r => { if (au.readyState >= 1) r(); else { au.onloadedmetadata = r; setTimeout(r, 1500); } });
    }
    ak.j = jIdx || 0;
    const segs = it.c.segs || [];
    const alvo = segs.length && segs[ak.j] ? Math.min(segs[ak.j].a, Math.max(0, it.dur - 0.05)) : 0;
    try { au.currentTime = alvo; } catch (_) {}
    au.play().catch(() => {});
  }

  async function ouvirTrecho(chunkId, segundo = 0) {
    if (abaRes !== 'audio') { abaRes = 'audio'; desenharResultado(); await new Promise(resolve => setTimeout(resolve, 80)); }
    const i = ak.pars.findIndex(it => it.c.i === chunkId);
    if (i < 0) return toast('O áudio deste trecho não está disponível neste navegador.', 'warning');
    const segs = ak.pars[i].c.segs || [];
    let j = 0;
    if (segs.length) {
      const alvo = Number(segundo) || 0;
      const dentro = segs.findIndex(seg => Number(seg.a) <= alvo && Number(seg.b) >= alvo);
      j = dentro >= 0 ? dentro : segs.reduce((best, seg, n) => Number(seg.a) <= alvo ? n : best, 0);
    }
    await kVai(i, j);
  }

  async function desenharKaraoke() {
    const s = sessAtual, box = $('ak-box');
    if (!box || !s || ak.montando) return;
    ak.montando = true;
    try {
      karaokeParar(false);
      if (ak.url) { URL.revokeObjectURL(ak.url); ak.url = null; ak.cur = -1; }
      const itens = (s.chunks || []).filter(c => Number.isInteger(c.i) && c.status !== 'pendente').sort((a, b) => a.i - b.i);
      const plavs = [];
      for (const c of itens) { const blob = await idbGet(s.id + ':' + c.i); if (blob) plavs.push({ c, blob, dur: 0, off: 0 }); }
      if (!plavs.length) {
         box.innerHTML = '<div class="sub"><i class="ph ph-microphone" aria-hidden="true"></i> Os áudios desta aula não estão guardados neste navegador (gravados numa versão anterior ou limpos do armazenamento). Grave uma aula nova para acompanhar no modo karaoke.</div>';
        ak.montando = false; return;
      }
      let off = 0;
      for (const it of plavs) { it.dur = await durDe(it.blob); it.off = off; off += it.dur; }
      ak.pars = plavs; ak.cur = -1; ak.j = 0; ak.chave = ''; ak.el = null;
      let corpo = '';
      plavs.forEach((it, i) => {
         const marc = `Trecho ${it.c.i + 1} · Áudio de ${mmss(it.off)} a ${mmss(it.off + it.dur)}`;
        const linhas = (it.c.segs && it.c.segs.length)
          ? it.c.segs.map((g, j) => `<div class="ak-line" id="ak-${i}-${j}" onclick="auladia.kVai(${i},${j})"><span class="t">${mmss(it.off + Math.max(0, g.a))}</span>${E(g.t || '—')}</div>`).join('')
          : `<div class="ak-line" id="ak-${i}-0" onclick="auladia.kVai(${i},0)"><span class="t">${mmss(it.off)}</span>${it.c.status === 'ok' ? E(it.c.texto || '') : '<span class="pend">[trecho sem transcrição]</span>'}</div>`;
        corpo += `<div class="ak-chunk"><h5>${E(marc)}</h5>${linhas}</div>`;
      });
      box.innerHTML = `<div class="ak-bar"><audio id="ak-au" controls preload="metadata" style="width:100%"></audio></div>
         <div class="ak-info">${plavs.length} trecho(s) · ${hms(off)} no total · a linha acende conforme o professor fala; toque em qualquer linha para pular para ela.</div>
        <div class="ak-max" id="ak-max">${corpo}</div>`;
      const au = $('ak-au');
      au.ontimeupdate = karaokeTick;
      au.onended = () => { if (ak.cur + 1 < ak.pars.length) { const i = ak.cur + 1; kVai(i, 0); } };
      // um trecho que estava pendente pode ter chegado: recarrega se os dados mudarem por trás
      ak.montando = false;
    } catch (_) {
      box.innerHTML = '<div class="sub">Não consegui montar o player de áudio neste navegador.</div>';
      ak.montando = false;
    }
  }

  /* ───────────── Resumo Geral (material autossuficiente) + MAPA MENTAL interativo ───────────── */
  let rqRodando = false;
  async function gerarResumoGeral() {
    const s = sessAtual;
    if (!s) return;
    if (!geminiOk) return toast('Precisa de IA configurada (Gemini ou Groq) no servidor.', 'warning');
    if (rqRodando || pipelineRodando) return toast('Já estou gerando material para esta aula.', 'info');
    rqRodando = true; abaRes = 'resumo_g'; desenharResultado();
    try {
      const j = await post('/api/aula/resumo-geral', {
        transcricao: s.textoRevisado || s.texto || textoPuro(s),
        area: s.disciplina || '',
        conteudo: [s.tema, s.parte && s.parte !== 'Única' ? s.parte : ''].filter(Boolean).join(' — '),
        parte: s.parte || '',
        tipoAula: s.tipoAula || 'expositiva',
        preferenciaMaterial: s.preferenciaMaterial || 'equilibrado',
        perfilPedagogico: s.perfilPedagogico || 'automatico',
        objetivoEstudo: s.objetivoEstudo || 'automatico',
        objetivosAprendizagem: s.objetivosAprendizagem || '',
        enfasePedagogica: s.enfasePedagogica || '',
        planoPedagogico: s.planoPedagogico || null,
        capitulos: (s.mapa && s.mapa.capitulos) || []
      }, 3);
      s.resumoGeral = j.markdown; await salvarAgora(s);
      toast('Resumo Geral pronto — arquivo novo também disponível em "⬇ Resumo Geral .md".', 'success');
    } catch (e) { toast('Resumo Geral falhou: ' + e.message, 'error'); }
    rqRodando = false; desenharResultado();
  }

  // Mapa mental: estado + layout + SVG reenderizado à mão (leve, sem dependência externa e exportável p/ PNG)
  const mm = { zoom: 1, fech: new Set(), raiz: null };
  let mmRodando = false;
  const MM_H = 28, MM_GAP = 4, MM_OX = 14, MM_COL = 34;
  function mmEnxugia(no) { return { t: String((no && no.t) || '—'), f: (no && Array.isArray(no.f) ? no.f.filter(x => x && x && x.t) : []).slice(0, 9) }; }
  function mmDeMapa(s) {
    const caps = (s.mapa && s.mapa.capitulos) || [];
    return mmEnxugia({ t: 'Aula — ' + (s.tema || s.disciplina || ''), f: caps.map(c => ({ t: c.titulo, f: (c.pontos || []).slice(0, 8).map(p => ({ t: p })) })) });
  }
  function mmClique(p) { mm.fech.has(p) ? mm.fech.delete(p) : mm.fech.add(p); desenharMindmap(); }
  function mmTudo(fechar) {
    mm.fech.clear();
    if (fechar) { const passa = (no, path) => { if (path && (no.f || []).length) mm.fech.add(path.join('-')); (no.f || []).forEach((f, k) => passa(f, path.concat(k))); }; passa(mm.raiz || {}, []); }
    desenharMindmap();
  }

  function desenharMindmap() {
    const s = sessAtual, box = $('mm-box'); if (!box || !s) return;
    if (!mm.raiz && s.mindmap) { mm.raiz = mmEnxugia(s.mindmap); }
    if (mmRodando) { box.innerHTML = '<div class="sub">⏳ Montando o mapa mental com a IA (1 chamada)…</div>'; return; }
    if (!mm.raiz) {
      if (s.mapa && (s.mapa.capitulos || []).length) mm.raiz = mmDeMapa(s);
      else {
        box.innerHTML = '<div class="sub">O mapa mental é a árvore da aula: tema central → temas → subtemas → pontos de memorização (com os números/doses exatos da aula). Interativo: feche/abra ramos tocando nos nós, ajuste o zoom e exporte em PNG.</div><button class="b pri" onclick="auladia.mmGerar()"><i class="ph ph-tree-structure"></i> Gerar mapa mental (IA)</button>';
        return;
      }
    }
    // ── layout: cada ramo avança para a direita; folhas empilham no cursor vertical ──
    let cur = 14 + MM_H / 2, maxX = 0;
    const nos = [], lig = [];
    const largura = (d, t) => d === 0 ? Math.min(250, Math.max(160, t.length * 7.4 + 42)) : Math.min(460, Math.max(118, t.length * 7.1 + 28));
    const volta = (no, d, x, path) => {
      no.w = largura(d, no.t);
      const fil = (no.f || []).map(mmEnxugia);
      const aberto = fil.length > 0 && !mm.fech.has(path.join('-'));
      let y;
      if (aberto) {
        const ys = fil.map((f, k) => volta(f, d + 1, x + no.w + MM_COL, path.concat(k)));
        y = (ys[0] + ys[ys.length - 1]) / 2;
        fil.forEach((f, k) => lig.push({ x1: x + no.w, y1: y, x2: f.x, y2: f.y }));
      } else { y = cur; cur += MM_H + MM_GAP; }
      no.x = x; no.y = y;
      maxX = Math.max(maxX, x + no.w);
      nos.push({ t: no.t, d, x, y, w: no.w, p: path.join('-'), temFilhos: fil.length > 0, aberto });
      return y;
    };
    volta(mm.raiz, 0, MM_OX, []);
    const W = Math.max(320, maxX + MM_OX + 8), H = cur + 24 - MM_GAP;
    const trunc = (t, max) => { t = String(t || ''); return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t; };
    // raízes/ramos cheios (fundo colorido); folhas em estilo "card" com contorno
    let svg = lig.map(l => `<path d="M${l.x1},${l.y1} C${l.x1 + MM_COL / 2},${l.y1} ${l.x2 - MM_COL / 2},${l.y2} ${l.x2},${l.y2}" fill="none" stroke="#31473f" stroke-width="1.4"/>`).join('');
    svg += nos.map(n => {
      if (n.d >= 2 && !n.temFilhos) {
        return `<g class="mm-node" data-p="${n.p}" onclick="auladia.mmToggle('${n.p}')"><rect x="${n.x}" y="${n.y - MM_H / 2}" width="${n.w}" height="${MM_H}" rx="8" fill="#0d221f" stroke="#14b8a6" stroke-width="1.1"/><text x="${n.x + 10}" y="${n.y + 4}" font-size="11" fill="#a7e8df">${E(trunc(n.t, 62))}</text></g>`;
      }
      const fundo = ['#115e59', '#155e75', '#5b21b6'][Math.min(n.d, 2)];
      const h = n.d === 0 ? MM_H + 8 : MM_H;
      const fs = n.d === 0 ? 13 : 11.5, fw = n.d === 0 ? '700' : '600';
      return `<g class="mm-node" data-p="${n.p}" onclick="auladia.mmToggle('${n.p}')"><rect x="${n.x}" y="${n.y - h / 2}" width="${n.w}" height="${h}" rx="10" fill="${fundo}"/><text x="${n.x + 12}" y="${n.y + 4.5}" font-size="${fs}" font-weight="${fw}" fill="#e9fbf7">${E(trunc(n.t, n.d === 0 ? 28 : 52))}</text>${n.temFilhos ? `<text x="${n.x + n.w - 14}" y="${n.y + 4}" font-size="11" fill="#9fd8cf">${n.aberto ? '−' : '+'}</text>` : ''}</g>`;
    }).join('');
    const tools = `<div class="mm-tools"><button class="b" onclick="auladia.mmZoom(0.75)">−</button><button class="b" onclick="auladia.mmZoom(1.3)">+</button><button class="b" onclick="auladia.mmFit()">⌂ Ajustar</button><button class="b" onclick="auladia.mmTudo(true)">⇲ Fechar ramos</button><button class="b" onclick="auladia.mmTudo(false)">⇱ Abrir tudo</button><button class="b" onclick="auladia.mmPNG()">⬇ PNG</button><button class="b" onclick="auladia.mmMermaid()" title="Baixar diagrama editável em Mermaid">⬇ Mermaid (.mmd)</button><button class="b pri" onclick="auladia.mmGerar()"><i class="ph ph-tree-structure"></i> ${s.mindmap ? 'Regenerar (IA)' : 'Gerar (IA)'}</button></div>`;
    box.innerHTML = tools + `<div class="mm-sc"><div class="mm-inner" style="transform:scale(${mm.zoom})"><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg></div></div><div class="sub" style="margin-top:6px">Toque num nó para fechar ou abrir os ramos. Use as barras de rolagem para navegar. Exporte o PNG para imprimir ou guardar.</div>`;
  }

  function mmAceitar(raiz, salvar) { mm.raiz = mmEnxugia(raiz || {}); mm.fech.clear(); mm.zoom = 1; }
  async function mmGerar() {
    const s = sessAtual; if (!s || mmRodando) return;
    if (!geminiOk) return toast('Precisa de IA configurada (Gemini ou Groq) no servidor.', 'warning');
    if (rqRodando || pipelineRodando) return toast('Já estou gerando material para esta aula — aguarde.', 'info');
    mmRodando = true; desenharMindmap();
    try {
      const j = await post('/api/aula/mapa-mental', { transcricao: s.textoRevisado || s.texto || textoPuro(s), area: s.disciplina || '', conteudo: s.tema || '', capitulos: (s.mapa && s.mapa.capitulos) || [], tipoAula: s.tipoAula || 'expositiva', preferenciaMaterial: s.preferenciaMaterial || 'equilibrado', perfilPedagogico: s.perfilPedagogico || 'automatico', objetivoEstudo: s.objetivoEstudo || 'automatico', objetivosAprendizagem: s.objetivosAprendizagem || '', enfasePedagogica: s.enfasePedagogica || '', planoPedagogico: s.planoPedagogico || null }, 1);
      if (j.raiz && j.raiz.t) { mmAceitar(j.raiz); s.mindmap = j.raiz; await salvarAgora(s); toast('Mapa mental pronto!', 'success'); }
    } catch (e) {
      if (s.mindmap) toast('Falha ao regenerar: o mapa anterior foi mantido.', 'warning');
      else if (s.mapa && (s.mapa.capitulos || []).length) { s.mindmap = mmDeMapa(s); mm.raiz = s.mindmap; mm.fech.clear(); mm.zoom = 1; await salvarAgora(s); toast('IA falhou — montei o mapa pelo esqueleto dos capítulos da aula.', 'warning'); }
      else toast('Mapa mental falhou: ' + e.message, 'error');
    }
    mmRodando = false; desenharMindmap();
  }
  function mmZoom(f) { mm.zoom = Math.min(2.6, Math.max(0.45, mm.zoom * f)); desenharMindmap(); }
  function mmFit() { mm.zoom = 1; desenharMindmap(); }
  async function mmPNG() {
    const sv = document.querySelector('#mm-box svg'); if (!sv) return toast('Abra a aba do mapa mental primeiro.', 'info');
    try {
      const xml = new XMLSerializer().serializeToString(sv);
      const img = new Image();
      await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
      const c = document.createElement('canvas'); const sc = Math.min(2, 7000 / Math.max(img.width || 1, img.height || 1, 1)) || 2;
      c.width = Math.ceil((img.width || 2000) * sc); c.height = Math.ceil((img.height || 1000) * sc);
      const g = c.getContext('2d'); g.fillStyle = '#0b1216'; g.fillRect(0, 0, c.width, c.height); g.scale(sc, sc); g.drawImage(img, 0, 0);
      const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = 'mapa-mental-' + slug((sessAtual && (sessAtual.tema || sessAtual.disciplina)) || 'aula') + '.png'; a.click();
      toast('PNG do mapa mental salvo.', 'success');
    } catch (_) { toast('Não consegui exportar o PNG neste navegador.', 'error'); }
  }
  function mmMermaid() {
    const root = mm.raiz || (sessAtual && sessAtual.mindmap ? mmEnxugia(sessAtual.mindmap) : null);
    if (!root) return toast('Gere ou abra um mapa mental antes de exportar.', 'info');
    const label = value => String(value || '').replace(/[\r\n]+/g, ' ').replace(/[()[\]{}#;"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || 'Ponto';
    const lines = ['mindmap', `  root((${label(root.t)}))`];
    const addChildren = (node, indent) => (node.f || []).forEach(child => {
      lines.push(' '.repeat(indent) + label(child.t));
      addChildren(child, indent + 2);
    });
    addChildren(root, 4);
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mapa-mental-' + slug((sessAtual && (sessAtual.tema || sessAtual.disciplina)) || 'aula') + '.mmd';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Arquivo Mermaid editável salvo.', 'success');
  }

  /* ───────────── resultado ───────────── */
  const camposMaterial = ['textoRevisado', 'base', 'mapa', 'caps', 'fechamento', 'resumoMd', 'flashcards', 'resultado', 'resumoGeral', 'mindmap'];
  function arquivarMateriais(s, motivo) {
    const versao = { data: new Date().toISOString(), motivo, texto: s.texto };
    camposMaterial.forEach(k => { if (s[k] != null) versao[k] = JSON.parse(JSON.stringify(s[k])); });
    (s.historico || (s.historico = [])).push(versao);
  }
  function invalidarMateriais(s) { camposMaterial.forEach(k => delete s[k]); delete s.ciclo; }
  async function editarTranscricao() {
    const s = sessAtual; if (!s || pipelineRodando || mmRodando || rqRodando) return;
    const texto = prompt('Revise a transcrição. Os materiais atuais ficarão no histórico e precisarão ser regenerados.', s.textoRevisado || s.texto || textoPuro(s));
    if (texto == null || !texto.trim()) return;
    arquivarMateriais(s, 'Revisão manual'); invalidarMateriais(s);
    s.textoRevisado = texto.trim(); s.revisaoManualEm = new Date().toISOString();
    await salvarAgora(s); desenharResultado();
  }
  async function gerarFlashcards() {
    const s = sessAtual;
    if (!s || !fonteGeracao(s)) return toast('Gere ou importe a transcrição antes de pedir flashcards.', 'warning');
    if (s.flashcards) return regenerar('flashcards');
    if (pipelineRodando) return toast('A aula já está sendo processada. Aguarde e tente novamente.', 'info');
    if (!geminiOk) return toast('Configure um provedor de IA de texto para gerar flashcards.', 'warning');
    s.solicitouFlashcards = true; await salvarAgora(s); await pipeline(s);
  }
  function baixarHistorico() {
    if (!sessAtual) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(sessAtual.historico || [], null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'historico-aula.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function personalizacaoHtml(s) {
    const objetivo = s.objetivoEstudo || 'automatico';
    const perfil = s.perfilPedagogico || 'automatico';
    const objetivos = s.objetivosAprendizagem || '';
    const enfase = s.enfasePedagogica || '';
    return `<details class="card"><summary style="cursor:pointer;font-weight:600">Personalizar metodologia desta aula</summary><div class="row3" style="margin-top:12px"><div><label for="ad-edit-tipo">Tipo de aula</label><select id="ad-edit-tipo"><option value="expositiva"${s.tipoAula === 'expositiva' ? ' selected' : ''}>Expositiva</option><option value="caso-clinico"${s.tipoAula === 'caso-clinico' ? ' selected' : ''}>Discussão de caso</option><option value="revisao-prova"${s.tipoAula === 'revisao-prova' ? ' selected' : ''}>Revisão para prova</option><option value="pratica"${s.tipoAula === 'pratica' ? ' selected' : ''}>Aula prática / procedimento</option></select></div><div><label for="ad-edit-depth">Profundidade</label><select id="ad-edit-depth"><option value="conciso"${s.preferenciaMaterial === 'conciso' ? ' selected' : ''}>Essencial</option><option value="equilibrado"${(!s.preferenciaMaterial || s.preferenciaMaterial === 'equilibrado') ? ' selected' : ''}>Completa</option><option value="detalhado"${s.preferenciaMaterial === 'detalhado' ? ' selected' : ''}>Avançada</option></select></div><div><label for="ad-edit-profile">Perfil pedagógico</label><select id="ad-edit-profile"><option value="automatico"${perfil === 'automatico' ? ' selected' : ''}>Inferir pelo conteúdo</option>${perfisPedagogicos.map(p => `<option value="${E(p.id)}"${perfil === p.id ? ' selected' : ''}>${E(p.nome)}</option>`).join('')}</select></div></div><div class="row3" style="margin-top:10px"><div><label for="ad-edit-goal">Objetivo de estudo</label><select id="ad-edit-goal"><option value="automatico"${objetivo === 'automatico' ? ' selected' : ''}>Automático</option><option value="compreender"${objetivo === 'compreender' ? ' selected' : ''}>Compreender</option><option value="prova"${objetivo === 'prova' ? ' selected' : ''}>Preparar para prova</option><option value="osce"${objetivo === 'osce' ? ' selected' : ''}>Aplicação prática / OSCE</option><option value="revisar"${objetivo === 'revisar' ? ' selected' : ''}>Revisar</option><option value="aprofundar"${objetivo === 'aprofundar' ? ' selected' : ''}>Aprofundar</option></select></div><div><label for="ad-edit-objectives">Objetivos de aprendizagem</label><textarea id="ad-edit-objectives" maxlength="1600" placeholder="Um objetivo por linha">${E(objetivos)}</textarea></div><div><label for="ad-edit-emphasis">Ênfase desta aula</label><input id="ad-edit-emphasis" maxlength="300" value="${E(enfase)}" placeholder="Ex.: relações entre mecanismo e manifestação"></div></div><div class="file-note">A alteração preserva os materiais existentes e orienta as próximas gerações. Para atualizar um material, use seu botão de regeneração.</div><button class="b" type="button" onclick="auladia.salvarMetodologia()">Salvar metodologia</button></details>`;
  }

  async function salvarMetodologia() {
    const s = sessAtual; if (!s) return;
    const tipoAula = ($('ad-edit-tipo') || {}).value || 'expositiva';
    const preferenciaMaterial = ($('ad-edit-depth') || {}).value || 'equilibrado';
    const perfilPedagogico = ($('ad-edit-profile') || {}).value || 'automatico';
    const objetivoEstudo = ($('ad-edit-goal') || {}).value || 'automatico';
    const objetivosAprendizagem = String(($('ad-edit-objectives') || {}).value || '').slice(0, 1600);
    const enfasePedagogica = String(($('ad-edit-emphasis') || {}).value || '').slice(0, 300);
    const j = await post('/api/aula/plano', {
      area: s.disciplina, conteudo: [s.tema, s.parte && s.parte !== 'Única' ? s.parte : ''].filter(Boolean).join(' — '),
      tipoAula, preferenciaMaterial, perfilPedagogico, objetivoEstudo, objetivosAprendizagem, enfasePedagogica,
      perfisSugeridos: s.planoPedagogico?.perfisSugeridos || [],
      objetivosSugeridos: s.planoPedagogico?.origemObjetivos === 'sugestao_ia' ? s.planoPedagogico.objetivos : [],
      capitulos: (s.mapa && s.mapa.capitulos) || []
    }, 1);
    Object.assign(s, { tipoAula, preferenciaMaterial, perfilPedagogico, objetivoEstudo, objetivosAprendizagem, enfasePedagogica, planoPedagogico: j.planoPedagogico });
    await salvarAgora(s); desenharResultado(); toast('Metodologia desta aula atualizada. Os materiais anteriores foram preservados.', 'success');
  }

  function progressoHtml(s) {
    const fonte = !!(s.textoRevisado || s.texto || textoPuro(s));
    const etapas = [
      ['Transcrição disponível', fonte ? (s.textoRevisado ? 'Revisada' : 'Original; revisão pendente') : 'Pendente'],
      ['Resumo didático', s.resumoMd ? 'Gerado' : 'Pendente'],
      ['Verificação heurística', s.qualidade ? 'Executada; confira os alertas' : 'Pendente'],
      ['Flashcards', s.flashcards ? `${s.flashcards.length} cartão(ões) gerado(s)` : 'Não solicitados'],
      ['Mapa mental', s.mindmap ? 'Gerado' : 'Opcional; ainda não solicitado'],
      ['Revisões no Mentor', s.ciclo?.revisoes ? `${s.ciclo.revisoes} revisão(ões) agendada(s)` : 'Aguardando fechar o ciclo']
    ];
    const revisados = new Set(Array.isArray(s.objetivosRevisados) ? s.objetivosRevisados : []);
    const objetivos = (s.planoPedagogico?.objetivos || []).slice(0, 20);
    const objetivosHtml = objetivos.length ? objetivos.map(obj => `<label class="ad-objective"><input type="checkbox" data-ad-objective="${E(obj)}"${revisados.has(obj) ? ' checked' : ''}><span>${E(obj)}<small class="file-note" style="display:block">${revisados.has(obj) ? 'Marcado como revisado por você' : 'Ainda não marcado como revisado'}</small></span></label>`).join('') : '<div class="sub">Os objetivos serão sugeridos ao organizar a transcrição. Você também pode defini-los na metodologia da aula.</div>';
    return `<div class="card"><b>Produção desta aula</b>${etapas.map(([nome, valor]) => `<div class="ad-progress-line"><span>${E(nome)}</span><span>${E(valor)}</span></div>`).join('')}<div class="file-note">Estas etapas mostram materiais e ações registrados; não são uma medida de domínio.</div></div><div class="card"><b>Objetivos de aprendizagem</b><div class="sub" style="margin:4px 0 8px">Marque um objetivo depois de revisá-lo. Essa marca é sua autodeclaração; a compreensão não é inferida por leitura.</div>${objetivosHtml}<div class="file-note">Compreensão demonstrada: não avaliada automaticamente nesta tela. Use “Testar agora” para praticar questões.</div><button class="b" type="button" onclick="auladia.testar()">Testar agora</button></div>`;
  }

  function tutorHtml(s) {
    const historico = Array.isArray(s.tutorHistory) ? s.tutorHistory.slice(-12) : [];
    const mensagens = historico.map(m => {
      const assistant = m.role === 'assistant';
      const citadas = assistant ? [...new Set((String(m.content || '').match(/\[(T[1-4])\]/g) || []).map(x => x.slice(1, -1)))] : [];
      const fontes = (Array.isArray(m.sources) ? m.sources : []).filter(src => citadas.includes(src.id));
      return `<div class="ad-tutor-msg ${assistant ? 'assistant' : 'user'}"><b>${assistant ? 'Tutor IA' : 'Você'}</b><div class="${assistant ? 'ad-md' : ''}">${assistant ? mdParaHtml(m.content || '') : E(m.content || '').replace(/\n/g, '<br>')}</div>${fontes.map(src => `<details class="ad-tutor-source"><summary>Fonte ${E(src.id)} · transcrição, caracteres ${src.inicio}–${src.fim}</summary><blockquote>${E(src.texto)}</blockquote></details>`).join('')}</div>`;
    }).join('') || '<div class="sub">Pergunte sobre esta aula. O Tutor combina o plano pedagógico, o material gerado e trechos da transcrição relacionados à sua dúvida.</div>';
    const erro = tutorFalha ? `<div class="aviso" role="status">${E(tutorFalha)} ${s.tutorPendente ? '<button class="b" type="button" onclick="auladia.tutorReenviar()">Tentar novamente</button>' : ''}</div>` : '';
    return `<div class="card"><div id="ad-tutor-history" aria-live="polite">${mensagens}</div>${tutorRodando ? '<div class="ad-step go" role="status">O Tutor está relacionando sua pergunta ao material da aula…</div>' : ''}${erro}<div class="ad-tutor-quick"><button class="b" type="button" onclick="auladia.tutorAtalho('Explique do zero')">Explique do zero</button><button class="b" type="button" onclick="auladia.tutorAtalho('Aprofunde o mecanismo deste tema')">Aprofunde o mecanismo</button><button class="b" type="button" onclick="auladia.tutorAtalho('Dê um exemplo didático')">Dê um exemplo</button><button class="b" type="button" onclick="auladia.tutorAtalho('O que ainda falta revisar nesta aula?')">O que falta revisar?</button></div><form class="ad-tutor-form" onsubmit="event.preventDefault();auladia.tutorEnviar()"><div><label for="ad-tutor-input">Sua pergunta</label><textarea id="ad-tutor-input" maxlength="1600" placeholder="Ex.: como o mecanismo explica a manifestação discutida?"${tutorRodando ? ' disabled' : ''}></textarea></div><button class="b pri" type="submit"${tutorRodando ? ' disabled' : ''}>Enviar</button></form><div class="file-note">O Tutor usa o conteúdo salvo nesta aula e envia a pergunta e trechos pertinentes ao provedor de IA configurado no servidor. Não inclua dados que identifiquem pacientes.</div></div>`;
  }

  async function marcarObjetivoRevisado(objetivo, revisado) {
    const s = sessAtual; if (!s) return;
    const list = Array.isArray(s.objetivosRevisados) ? s.objetivosRevisados : [];
    s.objetivosRevisados = revisado ? [...new Set(list.concat([objetivo]))] : list.filter(x => x !== objetivo);
    await salvarAgora(s); desenharResultado();
  }

  async function salvarContextoTutor(s, pergunta, registrar) {
    const historico = Array.isArray(s.tutorHistory) ? s.tutorHistory : [];
    let paraEnviar = historico;
    if (registrar) {
      paraEnviar = historico.slice(-6);
      s.tutorHistory = historico.concat([{ role: 'user', content: pergunta }]).slice(-12);
    } else if (historico.at(-1)?.role === 'user' && historico.at(-1)?.content === pergunta) {
      paraEnviar = historico.slice(0, -1).slice(-6);
    } else paraEnviar = historico.slice(-6);
    s.tutorPendente = pergunta;
    tutorFalha = ''; tutorRodando = true;
    await salvarAgora(s); if (sessAtual === s) desenharResultado();
    try {
      const fonte = s.textoRevisado || s.texto || textoPuro(s);
      const resultado = await post('/api/aula/tutor', {
        pergunta, historico: paraEnviar,
        transcricao: fonte,
        resumoMd: s.resumoMd || '', base: s.base || null,
        capitulos: (s.mapa && s.mapa.capitulos) || [],
        area: s.disciplina, conteudo: [s.tema, s.parte && s.parte !== 'Única' ? s.parte : ''].filter(Boolean).join(' — '),
        tipoAula: s.tipoAula || 'expositiva', preferenciaMaterial: s.preferenciaMaterial || 'equilibrado',
        perfilPedagogico: s.perfilPedagogico || 'automatico', objetivoEstudo: s.objetivoEstudo || 'automatico',
        objetivosAprendizagem: s.objetivosAprendizagem || '', enfasePedagogica: s.enfasePedagogica || '',
        planoPedagogico: s.planoPedagogico || null, objetivosRevisados: s.objetivosRevisados || [],
        iscResourceKey: s.iscResourceKey || '', iscResourceKeys: chavesIscDaSessao(s)
      }, 1);
      s.tutorHistory = (Array.isArray(s.tutorHistory) ? s.tutorHistory : []).concat([{ role: 'assistant', content: resultado.reply, sources: resultado.sources || [] }]).slice(-12);
      if (/\b(n[aã]o entendi|n[aã]o compreendi|tenho dificuldade|me confundi)\b/i.test(pergunta)) {
        s.dificuldadesDeclaradas = [...new Set([...(s.dificuldadesDeclaradas || []), pergunta])].slice(-20);
      }
      delete s.tutorPendente; await salvarAgora(s);
    } catch (e) { tutorFalha = e.message || 'Não consegui responder agora.'; await salvarAgora(s); }
    finally { tutorRodando = false; if (sessAtual === s) desenharResultado(); }
  }

  function tutorEnviar() {
    const pergunta = String(($('ad-tutor-input') || {}).value || '').trim().slice(0, 1600);
    if (!pergunta) return toast('Escreva uma pergunta para o Tutor.', 'info');
    return salvarContextoTutor(sessAtual, pergunta, true);
  }

  function tutorReenviar() {
    const s = sessAtual; if (!s || !s.tutorPendente) return;
    return salvarContextoTutor(s, s.tutorPendente, false);
  }

  function iscControlsHtml(s) {
    const indexed = chavesIscDaSessao(s).length;
    const slides = Array.isArray(s?.iscSlideResourceKeys) ? s.iscSlideResourceKeys.length : 0;
    return `<div class="card" style="border-color:var(--border-muted)"><b>Índice curricular privado</b>
      <div class="sub" style="margin:5px 0 9px">Slides e fala do professor são indexados separadamente e consolidados para revisão. PDF/PPTX são extraídos neste navegador; somente o texto extraído segue ao provedor de embeddings após sua confirmação. A busca do acervo usa os tópicos disponíveis e identifica quando só há metadados de título/pasta.</div>
      <input id="ad-isc-slides" type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx" onchange="auladia.indexarSlides(this)" style="display:none">
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="b pri" type="button" onclick="auladia.indexarAtual()">${s.iscTranscriptResourceKey ? 'Atualizar índice da fala' : 'Indexar fala do professor'}</button><button class="b" type="button" onclick="auladia.processarSlidesPendentes()"${slidesPendente ? '' : ' hidden'}>Indexar slides selecionados</button><button class="b" type="button" onclick="document.getElementById('ad-isc-slides')?.click()">${slides ? `Adicionar slides (${slides})` : 'Adicionar slides (PDF/PPTX)'}</button>
      ${indexed ? `<button class="b" type="button" onclick="auladia.revisarIndice()">Revisar índice consolidado</button><button class="b" type="button" onclick="auladia.removerDoIndice()">Remover índices desta aula</button>` : ''}</div>
      ${slidesPendente ? `<div class="file-note">Selecionado antes da aula: ${E(slidesPendente.name)} · ainda não enviado para indexação.</div>` : ''}
      <div id="ad-isc-status" class="file-note" role="status" aria-live="polite" style="margin-top:7px"></div></div>`;
  }

  function indiceWorkspaceHtml(s) {
    const sources = chavesIscDaSessao(s);
    const slideCount = (s.iscSlideResourceKeys || []).length;
    return `<div class="ad-panel"><p class="sub">Índice privado da transcrição e dos slides. Cada tópico mantém origem e evidência; revise as associações antes de usar recomendações.</p>${iscControlsHtml(s)}
      <div class="ad-index-state"><div class="ad-progress-line"><span>Transcrição</span><span>${s.iscTranscriptResourceKey ? 'Indexada' : fonteGeracao(s).trim().length >= 50 ? 'Disponível para indexar' : 'Sem texto revisado'}</span></div>
      <div class="ad-progress-line"><span>Slides</span><span>${slideCount ? `${slideCount} fonte(s) indexada(s)` : slidesPendente ? 'Selecionados; aguardam confirmação' : 'Nenhuma fonte indexada'}</span></div>
      <div class="ad-progress-line"><span>Fontes privadas</span><span>${sources.length}</span></div>
      <div class="ad-progress-line"><span>Confiança</span><span>Heurística; requer revisão</span></div></div></div>`;
  }

  function comparadorWorkspaceHtml(s) {
    const indexed = chavesIscDaSessao(s).length > 0;
    return `<div class="ad-panel"><h3 style="margin:4px 0">Aulas relacionadas</h3><p class="sub">A busca usa tópicos revisados no índice da aula. O catálogo distingue pistas de título/pasta de transcrições de vídeo realmente indexadas.</p>
      ${indexed ? `<div class="ad-empty">Selecione os tópicos curriculares que quer complementar e depois escolha videoaulas para comparar.</div><button class="b pri" type="button" onclick="auladia.revisarIndice()">Abrir índice e buscar aulas relacionadas</button>` : `<div class="ad-empty">Indexe a transcrição ou adicione os slides para habilitar busca e comparação curricular.</div><button class="b pri" type="button" onclick="auladia.aba('indice')">Preparar índice curricular</button>`}
      <p class="file-note">Se o vídeo do acervo ainda não tiver transcrição, ele pode aparecer por metadados; isso não comprova cobertura do conteúdo.</p></div>`;
  }

  function anexarChaveIsc(s, resourceKey, primary = false) {
    s.iscResourceKeys = [...new Set(chavesIscDaSessao(s).concat([resourceKey]))].slice(-12);
    if (primary || !s.iscResourceKey) s.iscResourceKey = resourceKey;
    delete s.iscGlossarioASR;
  }

  function iscPodeAdicionarFonte(s, sourceId) {
    const existing = chavesIscDaSessao(s);
    if (existing.some(key => key.endsWith(`:${sourceId}`)) || existing.length < 12) return true;
    toast('Esta aula já tem 12 fontes no índice. Remova uma antes de adicionar outra.', 'warning');
    return false;
  }

  async function indexarAtual() {
    const s = sessAtual; if (!s) return;
    const text = fonteGeracao(s).trim();
    if (text.length < 50) return toast('Revise uma transcrição antes de indexá-la.', 'warning');
    if (!iscPodeAdicionarFonte(s, s.id)) return;
    if (!confirm('A transcrição revisada será enviada ao provedor de embeddings configurado e armazenada no seu espaço privado. Continuar?')) return;
    const status = $('ad-isc-status'); if (status) status.textContent = 'Preparando segmentos e embeddings…';
    try {
      const result = await post('/api/isc/user-resources', {
        sourceId: s.id, sourceKind: 'transcript', title: nomeCompleto(s), course: s.disciplina || '', text
      }, 1);
      anexarChaveIsc(s, result.resourceKey, true);
      s.iscTranscriptResourceKey = result.resourceKey;
      s.iscSelectedTopicIds = [];
      await salvarAgora(s);
      desenharResultado();
      toast(result.unchanged ? 'Esta transcrição já está atualizada no índice privado.' : `Aula indexada em ${result.segments} segmentos, com ${result.topics} tópicos rastreáveis.`, 'success');
    } catch (error) {
      const current = $('ad-isc-status'); if (current) current.textContent = error.message || 'Não foi possível indexar a aula.';
      toast(error.message || 'Não foi possível indexar a aula.', 'error');
    }
  }

  async function extrairTextoPptx(buffer, status) {
    if (typeof DecompressionStream !== 'function') throw new Error('Este navegador não consegue descompactar PPTX. Exporte a apresentação como PDF e tente novamente.');
    const view = new DataView(buffer), bytes = new Uint8Array(buffer);
    const minEocd = Math.max(0, bytes.length - 22 - 65_535);
    let eocd = -1;
    for (let offset = bytes.length - 22; offset >= minEocd; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error('O arquivo não parece ser uma apresentação PPTX válida.');
    const entryCount = view.getUint16(eocd + 10, true);
    let cursor = view.getUint32(eocd + 16, true);
    let totalUncompressed = 0;
    if (!entryCount || entryCount > 6000 || cursor >= bytes.length) throw new Error('A estrutura da apresentação não é válida ou excede o limite de itens.');
    const decoder = new TextDecoder('utf-8');
    const slideEntries = [];
    for (let i = 0; i < entryCount; i++) {
      if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('O índice interno do PPTX está incompleto.');
      const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true), uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const nameStart = cursor + 46, next = nameStart + nameLength + extraLength + commentLength;
      if (next > bytes.length) throw new Error('A estrutura interna do PPTX ultrapassa o tamanho do arquivo.');
      const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
      const match = name.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
      if (match) {
        totalUncompressed += uncompressedSize;
        if (totalUncompressed > 80 * 1024 * 1024) throw new Error('A apresentação descompactada excede 80 MB. Divida o arquivo antes de indexar.');
        slideEntries.push({ number: Number(match[1]), flags, method, compressedSize, uncompressedSize, localOffset });
      }
      cursor = next;
    }
    slideEntries.sort((a, b) => a.number - b.number);
    if (!slideEntries.length || slideEntries.length > 500) throw new Error('A apresentação precisa ter entre 1 e 500 slides.');
    const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const slidesWithFigures = [];
    let text = '';
    const sourcePages = [];
    for (let index = 0; index < slideEntries.length; index++) {
      const entry = slideEntries[index];
      if (status) status.textContent = `Extraindo texto do PPTX… slide ${index + 1}/${slideEntries.length}`;
      if (entry.flags & 1) throw new Error('PPTX protegido por senha não pode ser indexado.');
      if (![0, 8].includes(entry.method) || entry.uncompressedSize > 4 * 1024 * 1024) throw new Error('O PPTX usa um formato de compactação ou slide fora do limite suportado.');
      if (entry.localOffset + 30 > bytes.length || view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error('Um slide PPTX está truncado.');
      const localNameLength = view.getUint16(entry.localOffset + 26, true), localExtraLength = view.getUint16(entry.localOffset + 28, true);
      const start = entry.localOffset + 30 + localNameLength + localExtraLength, end = start + entry.compressedSize;
      if (end > bytes.length) throw new Error('O conteúdo de um slide ultrapassa o arquivo.');
      let slideBuffer = bytes.slice(start, end);
      if (entry.method === 8) {
        try { slideBuffer = new Uint8Array(await new Response(new Blob([slideBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
        catch { throw new Error('Não foi possível descompactar um slide. Exporte a apresentação como PDF e tente novamente.'); }
      }
      if (slideBuffer.length !== entry.uncompressedSize) throw new Error('O conteúdo descompactado de um slide está incompleto.');
      const xml = new DOMParser().parseFromString(decoder.decode(slideBuffer), 'application/xml');
      if (xml.getElementsByTagName('parsererror').length) throw new Error(`O slide ${entry.number} contém XML inválido.`);
      const paragraphs = [...xml.getElementsByTagNameNS(drawingNs, 'p')];
      const lines = paragraphs.map(paragraph => {
        const value = [...paragraph.getElementsByTagNameNS(drawingNs, 't')].map(node => node.textContent || '').join('').trim();
        if (!value) return '';
        const properties = [...paragraph.children].find(child => child.localName === 'pPr');
        const level = Math.min(5, Math.max(0, Number.parseInt(properties?.getAttribute('lvl') || '0', 10) || 0));
        return `${level ? '  '.repeat(level) + '• ' : ''}${value}`;
      }).filter(Boolean);
      const slideText = lines.join('\n').trim();
      const hasFigure = xml.getElementsByTagNameNS(presentationNs, 'pic').length > 0;
      if (hasFigure) slidesWithFigures.push(entry.number);
      if (!slideText) continue;
      const separator = text ? '\n\n' : '';
      const heading = `## Slide ${entry.number}\n`;
      const startOffset = text.length + separator.length;
      const section = heading + slideText;
      const endOffset = startOffset + section.length;
      if (endOffset > 200_000) throw new Error('A apresentação ultrapassa 200 mil caracteres extraíveis. Divida-a antes de indexar.');
      text += separator + section;
      sourcePages.push({ page: entry.number, start: startOffset, end: endOffset });
    }
    return { text, sourcePages, sourceMeta: { slideCount: slideEntries.length, slidesWithFigures } };
  }

  function selecionarSlidesSetup(input) {
    const file = input?.files?.[0]; if (input) input.value = '';
    if (!file) return;
    const valid = /\.pdf$/i.test(file.name) || file.type === 'application/pdf' || /\.pptx$/i.test(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (!valid) return toast('Selecione um PDF ou PPTX para os slides.', 'warning');
    if (file.size > 18 * 1024 * 1024) return toast('O limite é 18 MB por arquivo de slides. Divida arquivos maiores.', 'warning');
    slidesPendente = file;
    const status = $('ad-setup-slides-status');
    if (status) status.textContent = `Selecionado: ${file.name} · ${bytesAudio(file.size)}. Os slides ainda não foram enviados; a confirmação aparece ao indexar.`;
  }

  async function processarSlidesPendentes() {
    if (!sessAtual || !slidesPendente) return toast('Selecione um PDF ou PPTX na preparação da aula primeiro.', 'info');
    const file = slidesPendente;
    const success = await indexarSlides({ files: [file] });
    if (!success) return false;
    slidesPendente = null;
    desenharResultado();
    return true;
  }

  async function indexarSlides(input) {
    const s = sessAtual, file = input?.files?.[0]; if (!s || !file) return false;
    const status = $('ad-isc-status');
    try {
      const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      const isPptx = /\.pptx$/i.test(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      if (!isPdf && !isPptx) throw new Error('Selecione um PDF ou PPTX.');
      if (file.size > 18 * 1024 * 1024) throw new Error('O limite é 18 MB por arquivo de slides. Divida arquivos maiores.');
      if (!confirm(`“${file.name}” será extraído neste navegador. O arquivo original não será enviado; somente o texto extraído, as referências de página/slide e os embeddings serão armazenados no seu índice privado. ${isPptx ? 'Figuras sem texto serão sinalizadas, não interpretadas visualmente nesta versão. ' : ''}Continuar?`)) return false;
      if (status) status.textContent = 'Lendo arquivo de slides…';
      const buffer = await file.arrayBuffer();
      let extracted;
      if (isPdf) {
        if (!window.pdfjsLib && typeof window.plCarregarPdfJs === 'function') await window.plCarregarPdfJs();
        const pdfjs = window.pdfjsLib;
        if (!pdfjs?.getDocument) throw new Error('O leitor de PDF não ficou disponível. Recarregue a página e tente novamente.');
        pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const pdf = await pdfjs.getDocument({ data: buffer }).promise;
        if (pdf.numPages > 500) { await pdf.destroy(); throw new Error('O limite é 500 páginas por PDF. Divida o arquivo em partes menores.'); }
        let text = ''; const sourcePages = [];
        try {
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            if (status) status.textContent = `Extraindo texto do PDF… ${pageNumber}/${pdf.numPages} páginas`;
            const page = await pdf.getPage(pageNumber), content = await page.getTextContent();
            const pageText = (content.items || []).map(item => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').trim();
            if (!pageText) continue;
            const separator = text ? '\n\n' : '', start = text.length + separator.length;
            const section = `## Página ${pageNumber}\n${pageText}`, end = start + section.length;
            if (end > 200_000) throw new Error('O PDF ultrapassa 200 mil caracteres extraíveis. Divida-o antes de indexar.');
            text += separator + section;
            sourcePages.push({ page: pageNumber, start, end });
          }
        } finally { await pdf.destroy().catch(() => {}); }
        extracted = { text, sourcePages, sourceMeta: { pageCount: pdf.numPages, slidesWithFigures: [] } };
      } else extracted = await extrairTextoPptx(buffer, status);
      if (extracted.text.trim().length < 50) throw new Error(`Não encontrei texto selecionável neste ${isPdf ? 'PDF' : 'PPTX'}. ${isPdf ? 'Se for escaneado, precisa de OCR.' : 'Se os slides forem imagens, exporte para PDF e aguarde o suporte a OCR.'}`);
      if (!window.crypto?.subtle) throw new Error('A identificação segura do arquivo não está disponível neste navegador. Abra a plataforma em HTTPS e tente novamente.');
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
      const fileHash = [...new Uint8Array(hashBuffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const sourceId = `slides-${fileHash}`;
      if (!iscPodeAdicionarFonte(s, sourceId)) return false;
      const result = await post('/api/isc/user-resources', {
        sourceId, sourceKind: 'slides', title: file.name,
        course: s.disciplina || '', text: extracted.text, sourcePages: extracted.sourcePages,
        sourceMeta: extracted.sourceMeta
      }, 1);
      anexarChaveIsc(s, result.resourceKey, false);
      s.iscSlideResourceKeys = [...new Set([...(s.iscSlideResourceKeys || []), result.resourceKey])].slice(-12);
      s.iscSelectedTopicIds = [];
      await salvarAgora(s); desenharResultado();
      const figures = extracted.sourceMeta.slidesWithFigures?.length || 0;
      const message = result.unchanged ? 'Estes slides já estão atualizados no índice privado.'
        : `Índice dos slides pronto: ${result.segments} segmentos e ${result.topics} tópicos. ${figures ? `${figures} slide(s) têm figuras ainda sem leitura visual.` : ''}`;
      toast(message, 'success');
      return true;
    } catch (error) {
      if (status) status.textContent = error.message || 'Não foi possível indexar os slides.';
      toast(error.message || 'Não foi possível indexar os slides.', 'error');
      return false;
    } finally { if (input) input.value = ''; }
  }

  async function removerDoIndice() {
    const s = sessAtual, keys = chavesIscDaSessao(s); if (!s || !keys.length) return;
    if (!confirm('Remover os materiais indexados desta aula? As cópias locais da Aula do Dia serão mantidas.')) return;
    try {
      const settled = await Promise.allSettled(keys.map(async key => {
        const response = await fetch('/api/isc/my-resources/' + encodeURIComponent(key), { method: 'DELETE' });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) throw new Error(result.msg || `Não foi possível remover ${key}.`);
        return key;
      }));
      const removed = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
      const failed = settled.filter(item => item.status === 'rejected');
      s.iscResourceKeys = chavesIscDaSessao(s).filter(key => !removed.includes(key));
      s.iscSlideResourceKeys = (s.iscSlideResourceKeys || []).filter(key => !removed.includes(key));
      if (removed.includes(s.iscTranscriptResourceKey)) s.iscTranscriptResourceKey = '';
      s.iscSelectedTopicIds = [];
      if (removed.includes(s.iscResourceKey)) s.iscResourceKey = s.iscResourceKeys[0] || '';
      delete s.iscGlossarioASR;
      await salvarAgora(s); desenharResultado();
      if (failed.length) toast(`${removed.length} material(is) removido(s); ${failed.length} não puderam ser removidos. Tente novamente.`, 'warning');
      else toast('Materiais desta aula removidos do índice privado.', 'success');
    } catch (error) { toast(error.message || 'Não foi possível remover o material.', 'error'); }
  }

  async function compararAulas() {
    const s = sessAtual; if (!s || !chavesIscDaSessao(s).length) return toast('Indexe uma transcrição ou PDF primeiro.', 'info');
    try {
      const response = await fetch('/api/isc/my-resources', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.msg || 'Não foi possível carregar suas aulas indexadas.');
      const resources = data.items || [];
      if (resources.length < 2) return toast('Indexe mais um material para comparar conteúdos.', 'info');
      const modal = document.createElement('div'); modal.id = 'ad-isc-compare-modal';
      modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'ad-isc-compare-title');
      modal.style.cssText = 'position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.68);display:grid;place-items:center;padding:18px';
      const checkedByDefault = new Set(chavesIscDaSessao(s).slice(0, 4));
      modal.innerHTML = `<section style="width:min(740px,100%);max-height:85vh;overflow:auto;background:var(--bg-surface);color:var(--text);border:1px solid var(--border-default);border-radius:16px;padding:18px;box-shadow:var(--shadow-lg)">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><h3 id="ad-isc-compare-title" style="margin:0">Comparar aulas indexadas</h3><button class="b" type="button" onclick="document.getElementById('ad-isc-compare-modal')?.remove()" aria-label="Fechar comparador">Fechar</button></div>
        <p class="sub">Escolha de dois a quatro materiais do seu espaço privado. Materiais desta aula aparecem marcados por padrão.</p>
        ${resources.map(item => `<label class="hist"><span><b>${E(item.title)}</b><small class="sub">${E(item.course || 'Aula do Dia')} · ${E(item.sourceKind === 'pdf_text' ? 'PDF' : 'Transcrição')}</small></span><input type="checkbox" data-isc-resource="${E(item.resourceKey)}"${checkedByDefault.has(item.resourceKey) ? ' checked' : ''}></label>`).join('')}
        <button class="b pri" type="button" onclick="auladia.compararSelecionadas()" style="margin-top:12px">Comparar selecionadas</button><div id="ad-isc-compare-results" aria-live="polite"></div>
      </section>`;
      document.body.appendChild(modal);
      modal.addEventListener('change', event => {
        const selected = [...modal.querySelectorAll('[data-isc-resource]:checked')];
        if (selected.length > 4) { event.target.checked = false; toast('Compare até quatro materiais por vez.', 'info'); }
      });
    } catch (error) { toast(error.message || 'Não foi possível abrir o comparador.', 'error'); }
  }

  async function compararSelecionadas() {
    const modal = $('ad-isc-compare-modal'); if (!modal) return;
    const resourceKeys = [...modal.querySelectorAll('[data-isc-resource]:checked')].map(input => input.dataset.iscResource);
    if (resourceKeys.length < 2 || resourceKeys.length > 4) return toast('Selecione de duas a quatro aulas.', 'warning');
    const output = $('ad-isc-compare-results'); if (output) output.innerHTML = '<div class="sub" role="status">Comparando evidências…</div>';
    try {
      const result = await post('/api/isc/compare', { resourceKeys }, 1);
      const names = new Map((result.resources || []).map(resource => [resource.resourceKey, resource.title]));
      const percent = (entry, fallback = 'Dados insuficientes') => entry && Number.isFinite(entry.score)
        ? `${Math.round(entry.score * 100)}%${entry.status === 'preliminary' || entry.status === 'metadata_match_only' ? ' · preliminar' : ''}` : fallback;
      const relation = { equivalent: 'Possivelmente equivalentes', redundant: 'Sobreposição alta', complementary: 'Conteúdos complementares', distinct: 'Temas distintos' };
      const pairs = (result.pairs || []).map(pair => {
        const metrics = pair.metrics || {}, coverage = metrics.curriculumCoverage?.resources || [];
        const gain = metrics.complementaryGain || {};
        const topics = (pair.topicNames?.exclusiveLeft || []).slice(0, 6).map(E).join(' · ') || '—';
        const otherTopics = (pair.topicNames?.exclusiveRight || []).slice(0, 6).map(E).join(' · ') || '—';
        return `<div class="card"><b>${E(names.get(pair.left) || pair.left)} ↔ ${E(names.get(pair.right) || pair.right)}</b>
          <div class="sub" style="margin-top:5px">${E(relation[pair.relation] || 'Relação não classificada')} · ${pair.classificationStatus === 'assessed' ? 'com evidência de conteúdo' : pair.classificationStatus === 'preliminary' ? 'classificação preliminar por metadados' : 'evidência insuficiente'}</div>
          <div class="sub">Similaridade temática: <b>${percent(metrics.thematicSimilarity)}</b></div>
          <div class="sub">Cobertura curricular: <b>${percent(coverage[0])}</b> / <b>${percent(coverage[1])}</b></div>
          <div class="sub">Ganho complementar: <b>${percent(gain.leftToRight)}</b> / <b>${percent(gain.rightToLeft)}</b></div>
          <div class="sub">Tópicos exclusivos: ${topics} · ${otherTopics}</div></div>`;
      }).join('');
      if (output) output.innerHTML = `<p class="file-note">As métricas dependem do material indexado e não avaliam correção clínica. ${result.pairs?.length || 0} par(es) comparado(s).</p>${pairs}`;
    } catch (error) { if (output) output.innerHTML = `<div class="sub" role="alert">${E(error.message || 'Não foi possível comparar as aulas.')}</div>`; }
  }

  function fecharIndiceAula() { $('ad-isc-index-modal')?.remove(); }

  async function revisarIndice() {
    const s = sessAtual, keys = chavesIscDaSessao(s); if (!s || !keys.length) return toast('Indexe os slides ou a fala antes de revisar o índice.', 'info');
    const previous = $('ad-isc-index-modal'); if (previous) previous.remove();
    const modal = document.createElement('div'); modal.id = 'ad-isc-index-modal';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'ad-isc-index-title');
    modal.style.cssText = 'position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:18px';
    modal.innerHTML = '<section style="width:min(900px,100%);max-height:88vh;overflow:auto;background:var(--bg-surface);color:var(--text);border:1px solid var(--border-default);border-radius:16px;padding:18px;box-shadow:var(--shadow-lg)"><div role="status">Carregando os índices desta aula…</div></section>';
    document.body.appendChild(modal);
    try {
      const result = await post('/api/isc/lesson-index', { resourceKeys: keys }, 1);
      const index = result.index || {}, topics = index.topics || [], topicOptions = result.topicOptions || [];
      const selected = new Set((s.iscSelectedTopicIds || []).filter(id =>
        topics.some(topic => topic.topicId === id) || topicOptions.some(topic => topic.topicId === id)));
      const initialSelection = selected.size ? selected : new Set(topics.map(topic => topic.topicId));
      const originLabels = { slides_only: 'Apenas nos slides', oral_only: 'Apenas na fala', both: 'Nos dois', uncertain: 'Incerto' };
      const roleLabel = role => role === 'slides' ? 'Slides' : 'Explicação oral';
      const displayedTopics = [...topics, ...topicOptions.filter(option => initialSelection.has(option.topicId) && !topics.some(topic => topic.topicId === option.topicId))
        .map(option => ({ topicId: option.topicId, name: option.name, origin: 'uncertain', confidence: null, evidence: [], manuallySelected: true }))];
      const topicRows = displayedTopics.map(topic => {
        const evidence = (topic.evidence || []).slice(0, 4).map(item => {
          const origin = item.page ? `página/slide ${item.page}` : Number.isFinite(item.timestampStart) ? `${mmss(item.timestampStart)}${Number.isFinite(item.timestampEnd) ? '–' + mmss(item.timestampEnd) : ''}` : item.sourceRef || 'origem não marcada';
          return `<div class="file-note">${E(roleLabel(item.role))} · ${E(item.title)} · ${E(origin)}${item.excerpt ? `<blockquote style="margin:4px 0 8px">${E(item.excerpt)}</blockquote>` : ''}</div>`;
        }).join('');
        const topicOrigin = topic.manuallySelected ? 'Objetivo selecionado manualmente; sem evidência nos materiais' : originLabels[topic.origin] || 'Origem não identificada';
        return `<div class="hist" style="align-items:flex-start"><label style="display:flex;gap:9px;align-items:flex-start;flex:1"><input type="checkbox" data-isc-topic="${E(topic.topicId)}"${initialSelection.has(topic.topicId) ? ' checked' : ''}><span><b>${E(topic.name)}</b><small class="sub" style="display:block">${E(topicOrigin)}${Number.isFinite(topic.confidence) ? ` · confiança heurística ${Math.round(topic.confidence * 100)}%` : ''}</small></span></label><div style="flex:1;min-width:240px">${evidence || (topic.manuallySelected ? '<small class="file-note">Este tópico foi incluído por você como objetivo de busca. Nenhuma evidência foi adicionada ao índice original.</small>' : '')}</div></div>`;
      }).join('');
      const topicOptionsHtml = topicOptions.map(option => `<option value="${E([option.name, option.parentName].filter(Boolean).join(' — '))}" data-topic-id="${E(option.topicId)}"></option>`).join('');
      const sources = (index.sources || []).map(source => `<span class="tag">${E(roleLabel(source.role))}: ${E(source.title)} · ${E(source.indexStatus)}</span>`).join(' ');
      const unknown = (index.unclassifiedSegments || []).slice(0, 10).map(item => {
        const origin = item.page ? `página/slide ${item.page}` : Number.isFinite(item.timestampStart) ? mmss(item.timestampStart) : item.sourceRef || 'origem não marcada';
        return `<li><b>${E(roleLabel(item.role))} · ${E(origin)}:</b> ${E(item.excerpt)}</li>`;
      }).join('');
      modal.querySelector('section').innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><h3 id="ad-isc-index-title" style="margin:0">Índice curricular consolidado</h3><button class="b" type="button" onclick="auladia.fecharIndiceAula()" aria-label="Fechar índice">Fechar</button></div>
        <p class="sub">Slides: ${index.counts?.slides || 0} · fala: ${index.counts?.oral || 0} · tópicos reconhecidos: ${topics.length}. Marque os tópicos que representam os objetivos desta aula; isso altera a busca, sem apagar a evidência original.</p>
        <div style="margin-bottom:10px">${sources}</div>
        <div class="aviso" role="note">A associação automática usa nomes e sinônimos da taxonomia. “Não identificado” significa que o índice não reconheceu um tópico, não que o conteúdo esteja ausente. Confirme conceitos clínicos antes de usar recomendações.</div>
        <div id="ad-isc-index-topics" style="display:grid;gap:6px;margin:12px 0">${topicRows || '<div class="sub">Nenhum tópico canônico foi reconhecido. Verifique se o texto extraído está legível ou revise a transcrição.</div>'}</div>
        <div class="card"><b>Adicionar um objetivo não reconhecido</b><div class="sub" style="margin:4px 0 8px">A seleção manual orienta a busca, mas não altera nem cria evidência na transcrição ou nos slides.</div><div style="display:flex;gap:8px;flex-wrap:wrap"><input id="ad-isc-add-topic" list="ad-isc-topic-options" placeholder="Buscar assunto ou objetivo curricular" aria-label="Buscar assunto ou objetivo curricular"><datalist id="ad-isc-topic-options">${topicOptionsHtml}</datalist><button class="b" type="button" onclick="auladia.adicionarTopicoManual()">Adicionar objetivo</button></div></div>
        ${unknown ? `<details><summary>Trechos sem tópico canônico (${index.counts?.unclassifiedSegments || 0})</summary><ul>${unknown}</ul><p class="file-note">A lista é uma amostra dos segmentos sem classificação e não substitui a revisão do material original.</p></details>` : ''}
        <button class="b pri" type="button" onclick="auladia.buscarAulasRelacionadas()"${topicOptions.length ? '' : ' disabled'}>Buscar aulas relacionadas no acervo</button><div id="ad-isc-related-results" aria-live="polite"></div>`;
    } catch (error) {
      modal.querySelector('section').innerHTML = `<div role="alert" class="sub">${E(error.message || 'Não foi possível carregar o índice.')}</div><button class="b" type="button" onclick="auladia.fecharIndiceAula()">Fechar</button>`;
    }
  }

  function adicionarTopicoManual() {
    const modal = $('ad-isc-index-modal'), input = $('ad-isc-add-topic'), list = $('ad-isc-topic-options'), container = $('ad-isc-index-topics');
    const value = String(input?.value || '').trim();
    const option = [...(list?.options || [])].find(item => item.value === value);
    if (!modal || !container || !option?.dataset.topicId) return toast('Escolha um assunto ou objetivo da lista curricular.', 'warning');
    const existing = [...modal.querySelectorAll('[data-isc-topic]')].find(item => item.dataset.iscTopic === option.dataset.topicId);
    if (existing) existing.checked = true;
    else {
      const row = document.createElement('div'); row.className = 'hist'; row.style.alignItems = 'flex-start';
      row.innerHTML = `<label style="display:flex;gap:9px;align-items:flex-start;flex:1"><input type="checkbox" data-isc-topic="${E(option.dataset.topicId)}" checked><span><b>${E(value.split(' — ')[0])}</b><small class="sub" style="display:block">Objetivo selecionado manualmente; sem evidência nos materiais</small></span></label><div style="flex:1;min-width:240px"><small class="file-note">Este tópico foi incluído por você como objetivo de busca. Nenhuma evidência foi adicionada ao índice original.</small></div>`;
      container.appendChild(row);
    }
    input.value = '';
  }

  async function buscarAulasRelacionadas() {
    const s = sessAtual, modal = $('ad-isc-index-modal'); if (!s || !modal) return;
    const topicIds = [...modal.querySelectorAll('[data-isc-topic]:checked')].map(input => input.dataset.iscTopic);
    if (!topicIds.length) return toast('Marque ao menos um tópico para buscar aulas relacionadas.', 'warning');
    if (topicIds.length > 100) return toast('Selecione até 100 objetivos por busca para manter as recomendações rápidas.', 'warning');
    s.iscSelectedTopicIds = topicIds; await salvarAgora(s);
    const output = $('ad-isc-related-results'); if (output) output.innerHTML = '<div class="sub" role="status">Buscando relações curriculares no catálogo…</div>';
    try {
      const result = await post('/api/isc/recommendations', { resourceKeys: chavesIscDaSessao(s), topicIds }, 1);
      const items = result.items || [];
      if (!items.length) {
        if (output) output.innerHTML = '<div class="sub" role="status">O catálogo atual não tem aula vinculada a esses tópicos por título ou caminho. Isso não confirma que as aulas sejam irrelevantes; elas podem ainda não ter transcrição indexada.</div>';
        return;
      }
      const cards = items.map(item => {
        const topics = (item.matchedTopics || []).map(topic => `<li><b>${E(topic.name)}</b> · ${E(topic.sourceKind || 'origem')} — ${E(topic.excerpt || 'sem trecho de evidência')}</li>`).join('');
        const metadataOnly = item.evidenceMode === 'catalog_metadata';
        const similarity = Number.isFinite(item.semanticSimilarity)
          ? `<small class="sub" style="display:block">Similaridade ${item.semanticEvidenceKind === 'catalog_metadata' ? 'de metadados' : 'semântica'}: ${Math.round(item.semanticSimilarity * 100)}%</small>` : '';
        return `<div class="hist" style="align-items:flex-start"><label style="display:flex;gap:9px;align-items:flex-start;flex:1"><input type="checkbox" data-isc-video="${E(item.resourceKey)}"><span><b>${E(item.title)}</b><small class="sub" style="display:block">${E(item.course || 'Curso não informado')} · ${E(item.sourcePath || 'caminho não informado')} · ${item.matchedTopicCount}/${item.targetTopicCount} tópicos vinculados</small>
          <small class="sub" style="display:block">${metadataOnly ? 'Pista de título/pasta; a fala da videoaula ainda não está indexada.' : 'Há evidência textual indexada nesta videoaula.'}</small>${similarity}${topics ? `<ul style="margin:5px 0">${topics}</ul>` : ''}</span></label><button class="b" type="button" onclick="auladia.abrirAulaCatalogo(${E(JSON.stringify(String(item.resourceId || '')))})">Abrir no player</button></div>`;
      }).join('');
      const section = modal.querySelector('section');
      section.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><h3 id="ad-isc-index-title" style="margin:0">Aulas relacionadas</h3><button class="b" type="button" onclick="auladia.fecharIndiceAula()">Fechar</button></div>
        <p class="sub">Selecione de duas a quatro aulas para comparar. A ordem inicial prioriza a quantidade de tópicos relacionados; pistas de título/pasta não medem cobertura do conteúdo.</p>${cards}
        <button class="b pri" type="button" onclick="auladia.compararVideoAulas()">Comparar aulas selecionadas</button><div id="ad-isc-compare-video-results" aria-live="polite"></div>
        <button class="b" type="button" onclick="auladia.revisarIndice()">Voltar ao índice consolidado</button>`;
      section.addEventListener('change', event => {
        if (!event.target.matches('[data-isc-video]')) return;
        const checked = section.querySelectorAll('[data-isc-video]:checked');
        if (checked.length > 4) { event.target.checked = false; toast('Compare até quatro aulas por vez.', 'info'); }
      });
    } catch (error) { if (output) output.innerHTML = `<div role="alert" class="sub">${E(error.message || 'Não foi possível buscar aulas relacionadas.')}</div>`; }
  }

  async function compararVideoAulas() {
    const s = sessAtual, modal = $('ad-isc-index-modal'); if (!s || !modal) return;
    const videoKeys = [...modal.querySelectorAll('[data-isc-video]:checked')].map(input => input.dataset.iscVideo);
    if (videoKeys.length < 2 || videoKeys.length > 4) return toast('Selecione de duas a quatro videoaulas.', 'warning');
    const output = $('ad-isc-compare-video-results'); if (output) output.innerHTML = '<div class="sub" role="status">Comparando índices e evidências…</div>';
    try {
      const result = await post('/api/isc/lesson-compare', {
        sourceKeys: chavesIscDaSessao(s), videoKeys, topicIds: s.iscSelectedTopicIds || []
      }, 1);
      const showMetric = metric => {
        const matched = metric?.matchedTopicIds?.length || 0, total = metric?.targetCount || 0;
        if (metric?.status === 'indexed_topic_match') return `${matched}/${total} tópicos reconhecidos no índice de conteúdo`;
        if (metric?.status === 'metadata_match_only') return `${matched}/${total} pistas no título/pasta; cobertura da aula não avaliada`;
        return 'Sem dados suficientes';
      };
      const rows = (result.comparisons || []).map(item => {
        const gaps = item.topicNames?.notLinkedInCatalogIndex || [];
        const linked = item.topicNames?.shared || [];
        const evidence = (item.matchedTopicEvidence || []).map(topic => {
          const origin = topic.page != null ? `página/slide ${topic.page}` : Number.isFinite(topic.timestampStart) ? `${mmss(topic.timestampStart)}${Number.isFinite(topic.timestampEnd) ? '–' + mmss(topic.timestampEnd) : ''}` : topic.sourceRef || 'sem referência de origem';
          return `<li><b>${E(topic.name)}</b> · ${E(topic.sourceKind || 'origem')} · ${E(origin)}${topic.excerpt ? ` — ${E(topic.excerpt)}` : ''}</li>`;
        }).join('');
        const segments = (item.recommendedSegments || []).map(segment => `<li><button class="b" type="button" onclick="auladia.abrirTrechoVideo(${E(JSON.stringify(String(item.resourceKey.slice(6))) )},${Number(segment.timestampStart)})">Assistir ${E(mmss(segment.timestampStart))}</button> ${E(segment.excerpt || '')}</li>`).join('');
        return `<tr><th scope="row">${E(item.title)}</th><td>${E(showMetric(item.coverage?.slides))}</td><td>${E(showMetric(item.coverage?.oral))}</td><td>${E(showMetric(item.coverage?.consolidated))}</td></tr>
          <tr><td colspan="4"><small><b>Vínculos encontrados:</b> ${E(linked.slice(0, 12).join(' · ') || 'nenhum')} ${gaps.length ? `<br><b>Sem vínculo no índice do acervo:</b> ${E(gaps.slice(0, 12).join(' · '))}. Isso não prova ausência no vídeo.` : ''}</small>${evidence ? `<ul><b>Evidências:</b>${evidence}</ul>` : ''}${segments ? `<ul>${segments}</ul>` : ''}<small class="sub">Profundidade: ${item.depth?.length ? E([...new Set(item.depth)].join(', ')) : 'não avaliada'} · similaridade: ${item.thematicSimilarity?.score == null ? 'dados insuficientes' : Math.round(item.thematicSimilarity.score * 100) + '%'}</small></td></tr>`;
      }).join('');
      const titlesByKey = new Map((result.comparisons || []).map(item => [item.resourceKey, item.title]));
      const pairs = (result.pairs || []).map(pair => `<li><b>${E(titlesByKey.get(pair.left) || pair.left)} ↔ ${E(titlesByKey.get(pair.right) || pair.right)}</b>: ${E(pair.classificationStatus === 'preliminary' ? 'relação preliminar por metadados' : pair.relation)}${pair.sharedTopicNames?.length ? ` · em comum: ${E(pair.sharedTopicNames.join(' · '))}` : ''}${pair.exclusiveLeft?.length ? ` · exclusivos da primeira: ${E(pair.exclusiveLeft.join(' · '))}` : ''}${pair.exclusiveRight?.length ? ` · exclusivos da segunda: ${E(pair.exclusiveRight.join(' · '))}` : ''}</li>`).join('');
      const plan = (result.roadmap || []).map(item => `<li>${E(item.order)}. <b>${E(item.title)}</b> — ${E(item.focus)}</li>`).join('');
      if (output) output.innerHTML = `<div class="aviso" role="note">${result.evidenceMode === 'catalog_metadata' ? 'As videoaulas ainda não têm conteúdo indexado. A matriz mostra vínculos encontrados em título/pasta e não porcentagem de cobertura real.' : 'A matriz usa os segmentos de conteúdo disponíveis. Confira a evidência original; o índice não substitui revisão docente.'}</div>
        <div style="overflow:auto"><table class="table"><caption>Relação dos índices selecionados com a Aula do Dia</caption><thead><tr><th>Aula</th><th>Slides</th><th>Fala</th><th>Consolidado</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${pairs ? `<h4>Sobreposição entre candidatas</h4><ul>${pairs}</ul>` : ''}${plan ? `<h4>Roteiro de estudo</h4><ol>${plan}</ol>` : ''}`;
    } catch (error) { if (output) output.innerHTML = `<div role="alert" class="sub">${E(error.message || 'Não foi possível comparar as aulas.')}</div>`; }
  }

  async function abrirAulaCatalogo(videoId) {
    try {
      if (typeof go === 'function') go('view-acervo');
      if (typeof ac2Init === 'function') await ac2Init();
      if (window.AC2?.indice?.has(videoId) && typeof window.ac2Abrir === 'function') window.ac2Abrir(videoId, false, true);
      else toast('Esta aula ainda não está disponível no índice do player.', 'warning');
    } catch (error) { toast(error.message || 'Não foi possível abrir a videoaula.', 'error'); }
  }

  async function abrirTrechoVideo(videoId, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return toast('O trecho não tem timestamp confiável.', 'warning');
    try {
      if (typeof go === 'function') go('view-acervo');
      if (typeof ac2Init === 'function') await ac2Init();
      if (!window.AC2?.indice?.has(videoId) || typeof window.ac2Abrir !== 'function') return toast('Esta aula ainda não está disponível no índice do player.', 'warning');
      if (typeof lsSet === 'function') lsSet('med_pos_' + videoId, seconds);
      window.ac2Abrir(videoId, false, true);
      const video = document.getElementById('ac2-native-video');
      if (video?.readyState >= 1 && window.AC2?.atualId === videoId) video.currentTime = seconds;
    } catch (error) { toast(error.message || 'Não foi possível abrir o trecho da videoaula.', 'error'); }
  }

  function tutorAtalho(pergunta) {
    return salvarContextoTutor(sessAtual, String(pergunta || '').slice(0, 1600), true);
  }

  function desenharResultado() {
    const r = $('ad-root'); const s = sessAtual; if (!r || !s) return;
    const res = s.resultado;
    const planoPedagogico = s.planoPedagogico;
    const nomesPerfil = planoPedagogico ? [planoPedagogico.perfilPrincipal, ...(planoPedagogico.perfisSecundarios || [])].map(id => (perfisPedagogicos.find(p => p.id === id) || {}).nome || (id === 'geral' ? 'Geral' : id)).filter(Boolean) : [];
    const objetivoNome = ({ compreender: 'compreender', prova: 'preparar para prova', osce: 'aplicar na prática / OSCE', revisar: 'revisar', aprofundar: 'aprofundar' })[planoPedagogico && planoPedagogico.objetivoEstudo];
    const origemPerfil = planoPedagogico && planoPedagogico.origemPerfilPrincipal === 'manual' ? 'manual' : 'inferido';
    const resumoPlano = planoPedagogico ? ` · perfil ${origemPerfil}: ${E(nomesPerfil.join(' + ') || 'Geral')}${objetivoNome ? ' · objetivo: ' + E(objetivoNome) : ''}` : '';
    const temFonte = !!(s.textoRevisado || s.texto || textoPuro(s) || s.resumoMd || s.base);
    const tabs = [['transcricao', s.textoRevisado ? 'Transcrição (revisada)' : 'Transcrição']];
    tabs.push(['indice', 'Índice curricular'], ['comparar', 'Comparar aulas']);
    if (s.resumoMd) tabs.push(['resumo', 'Resumo']);
    if (temFonte) tabs.push(['flash', s.flashcards ? 'Flashcards (' + s.flashcards.length + ')' : 'Flashcards']);
    if (temFonte) tabs.push(['tutor', 'Tutor IA']);
    tabs.push(['progresso', 'Progresso']);
    if (res) tabs.push(['prova', 'Cai na prova']);
    if (s.resumoMd || s.flashcards) tabs.push(['qual', 'Qualidade' + (s.qualidade && s.qualidade.flashcards && (s.qualidade.flashcards.comAlerta || (s.qualidade.flashcards.revisaoHumana || []).length) ? ' · revisão recomendada' : '')]);
    if (s.textoRevisado || s.texto) tabs.push(['resumo_g', 'Resumo geral']);
    if ((s.chunks || []).some(c => Number.isInteger(c.i))) tabs.push(['audio', 'Áudio · karaoke']);
    tabs.push(['mm', 'Mapa mental']);
    if (!tabs.some(t => t[0] === abaRes)) abaRes = tabs[0][0];
    let corpo = '';
    const incertos = (s.chunks || []).flatMap(c => (c.segs || []).filter(x => x.baixaConfianca).map(x => ({ trecho: c.i + 1, chunkId: c.i, ...x })));
    const alertasCapturaDaAula = alertasCaptura(s);
    const alertaConfianca = incertos.length ? `<div class="aviso" role="note"><i class="ph ph-warning-circle" aria-hidden="true"></i> ${incertos.length} segmento(s) sinalizado(s) por heurísticas de confiança do provedor. Isso não comprova erro nem avalia precisão médica. Confira o áudio, especialmente doses, números e condutas.<ul>${incertos.slice(0, 5).map(x => `<li>[trecho ${x.trecho} · ${mmss(x.a)}–${mmss(x.b)}] ${E(x.t)} <button class="b" type="button" onclick="auladia.ouvirTrecho(${x.chunkId},${Number(x.a) || 0})">Ouvir aqui</button> <button class="b" type="button" onclick="auladia.retranscrever(${x.chunkId})">Retranscrever trecho</button></li>`).join('')}${incertos.length > 5 ? `<li>e mais ${incertos.length - 5} segmento(s)</li>` : ''}</ul></div>` : '';
    const alertaIntegridade = alertasCapturaDaAula.length ? `<div class="aviso" role="note"><i class="ph ph-warning-circle" aria-hidden="true"></i> ${alertasCapturaDaAula.length} possível(is) problema(s) na captura ou emenda. Revise antes de aceitar a transcrição.<ul>${alertasCapturaDaAula.slice(0, 8).map(x => `<li>Trecho ${x.i + 1}: ${E(x.texto)} <button class="b" type="button" onclick="auladia.ouvirTrecho(${x.i},0)">Ouvir</button> <button class="b" type="button" onclick="auladia.retranscrever(${x.i})">Retranscrever</button></li>`).join('')}</ul><span class="file-note">As sinalizações são heurísticas: não removem texto automaticamente.</span></div>` : '';
    const diagnosticoCaptura = (s.chunks || []).some(c => c.captura) ? `<details class="card"><summary style="cursor:pointer;font-weight:600">Diagnóstico da captura</summary><div class="file-note">${(s.chunks || []).filter(c => c.captura).length} segmento(s) · mídia ${E(((s.chunks || []).find(c => c.captura) || {}).mime || 'não informada')} · ${E(String(((s.chunks || []).find(c => c.captura) || {}).captura?.sampleRate || 'taxa não informada'))} Hz · bitrate solicitado 64 kb/s; bitrate efetivo varia por navegador. O arquivo capturado é preservado sem conversão posterior; o processamento do navegador, se ativado, ocorre antes da codificação.</div></details>` : '';
    if (abaRes === 'transcricao') corpo = `${alertaConfianca}${alertaIntegridade}${diagnosticoCaptura}${s.revisaoDesatualizada ? '<div class="aviso" role="status">Uma transcrição de trecho foi atualizada. A revisão anterior continua preservada; revise novamente para alinhar o texto e os materiais.</div>' : ''}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><button class="b" id="ad-ed-btn" onclick="auladia.editarTexto()"><i class="ph ph-pencil-simple"></i> Editar transcrição</button>${s.texto && s.textoRevisado ? '<button class="b" onclick="auladia.verOriginal()">Ver original (sem revisão)</button>' : ''}</div><div class="ad-tr" id="ad-tr-txt">${s.textoRevisado ? E(s.textoRevisado).replace(/([\u2B50\u2753]) \[(\d\d:\d\d)\]/g, '<span class="mk">$1 [$2]</span>') : textoHtml(s)}</div>`;
    else if (abaRes === 'audio') corpo = `<div id="ak-box"><div class="sub">Montando o player do karaoke…</div></div>`;
    else if (abaRes === 'indice') corpo = indiceWorkspaceHtml(s);
    else if (abaRes === 'comparar') corpo = comparadorWorkspaceHtml(s);
    else if (abaRes === 'resumo') corpo = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><button class="b" onclick="auladia.regenerar('resumo')"><i class="ph ph-arrows-clockwise"></i> Regenerar resumo</button></div>${versoesHtml(s, 'resumoMd')}<div class="ad-md" id="ad-md">${mdParaHtml(s.resumoMd)}</div>`;
    else if (abaRes === 'qual') corpo = qualidadeHtml(s);
    else if (abaRes === 'tutor') corpo = tutorHtml(s);
    else if (abaRes === 'progresso') corpo = progressoHtml(s);
    else if (abaRes === 'flash' && !s.flashcards) corpo = `<div class="card"><b>Flashcards sob demanda</b><div class="sub">Os cartões não são gerados automaticamente. Peça-os quando quiser praticar recuperação ativa a partir da transcrição e do plano desta aula.</div><button class="b pri" type="button" onclick="auladia.gerarFlashcards()"${pipelineRodando ? ' disabled' : ''}><i class="ph ph-cards"></i> Gerar flashcards</button></div>`;
    else if (abaRes === 'flash') {
      const grupos = {}; (s.flashcards || []).forEach(f => { (grupos[f.tema || 'Geral'] = grupos[f.tema || 'Geral'] || []).push(f); });
      corpo = `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="b pri" onclick="auladia.enviarFlash()"><i class="ph ph-cards" aria-hidden="true"></i> Revisar e adicionar ao Treino</button><button class="b" onclick="auladia.regenerar('flash')"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Regenerar cartões</button></div>${versoesHtml(s, 'flashcards')}<div class="sub" style="margin-top:6px">Confira pergunta, resposta e alertas; edite ou remova qualquer cartão antes de aprová-lo para o Treino. As referências de origem apontam para o trecho usado na geração.</div><div style="margin-top:10px">${Object.keys(grupos).map(g => `<div class="grp2">${E(g)}</div>` + grupos[g].map(f => { const i = s.flashcards.indexOf(f); const qi = s.qualidade && s.qualidade.flashcards; const fl = (qi && qi.itens[i] || {}).flags || []; const revisar = qi && (qi.revisaoHumana || []).some(x => x.i === i); const fmt = ({ pergunta: 'Pergunta', mecanismo: 'Mecanismo', comparativo: 'Comparativo', sequencia: 'Sequência', vinheta: 'Vinheta' })[f.formato] || 'Pergunta'; const temOrigem = origemCartaoTexto(s, f); return `<div class="fc"${fl.length || revisar ? ' style="border-color:var(--amber)"' : ''}><div class="sub">${E(fmt)} · ${E(({ facil: 'Fácil', media: 'Média', dificil: 'Difícil' })[f.dificuldade] || 'Média')}</div><b>${E(f.frente)}</b>${E(f.verso)}${fl.length ? `<div class="sub" style="color:var(--amber)"><i class="ph ph-warning-circle" aria-hidden="true"></i> ${fl.map(E).join(' · ')}</div>` : ''}${revisar ? '<div class="sub" style="color:var(--amber)"><i class="ph ph-stethoscope" aria-hidden="true"></i> Revisão humana recomendada: confira os pontos clínicos diretamente na aula.</div>' : ''}<div style="margin-top:6px"><button class="b" onclick="auladia.cartaoEditar(${i})">Editar</button> <button class="b" onclick="auladia.cartaoRemover(${i})">Remover</button>${temOrigem ? ` <button class="b" onclick="auladia.verOrigem(${i})">Trecho de origem</button>` : ''}</div></div>`; }).join('')).join('')}</div>`;
    } else if (res && abaRes === 'prova') corpo = `${(res.caiNaProva || []).length ? '<ul>' + res.caiNaProva.map(p => `<li>${E(p)}</li>`).join('') + '</ul>' : '<div class="sub">O professor não indicou explicitamente o que cai na prova.</div>'}${(s.marcas || []).length ? '<h4>Momentos que você marcou</h4><div class="sub">' + s.marcas.map(E).join(' · ') + '</div>' : ''}${(res.assuntosCobertos || []).length ? '<h4>Assuntos do manual abordados nesta aula</h4><ul>' + res.assuntosCobertos.map(a => `<li>${E(a)}</li>`).join('') + '</ul>' : ''}${(() => { const ehAluno = d => /^\s*\[\d\d:\d\d\]/.test(d); const dv = res.duvidas || []; const meus = dv.filter(ehAluno), conf = dv.filter(d => !ehAluno(d));
      return ((s.duvidasMarcas || []).length ? '<h4><i class="ph ph-question" aria-hidden="true"></i> Suas dúvidas na aula</h4>' + (meus.length ? '<ul>' + meus.map(d => `<li>${E(d)}</li>`).join('') + '</ul>' : '<div class="sub">' + s.duvidasMarcas.map(E).join(' · ') + '</div>') : '')
        + (conf.length ? '<h4>Para conferir (possíveis imprecisões)</h4><ul>' + conf.map(d => `<li>${E(d)}</li>`).join('') + '</ul>' : ''); })()}}`;
    else if (abaRes === 'resumo_g') corpo = rqRodando
      ? `<div class="card"><div class="ad-step go">⏳ Gerando o Resumo Geral — examinando TODA a aula e escrevendo o material autossuficiente (índice, hierarquia completa, tabelas, Síntese Integradora e Revisão de Véspera). Pode levar 1–3 min; não feche a página.</div></div>`
      : s.resumoGeral
        ? `<div class="ad-md" id="ad-md">${mdParaHtml(s.resumoGeral)}</div>`
        : `<div class="card"><div class="sub">Resumo Geral no tamanho selecionado (${E(PROFUNDIDADES[s.preferenciaMaterial] || s.preferenciaMaterial || 'Equilibrado')}): percorre toda a aula, organiza os temas e preserva valores, exceções e ressalvas da transcrição.</div><button class="b pri" onclick="auladia.gerarRQ()"><i class="ph ph-scroll"></i> Gerar Resumo Geral</button></div>`;
    else if (abaRes === 'mm') corpo = `<div id="mm-box"></div>`;
    const falhas = (s.chunks || []).filter(c => c.status === 'erro' || c.status === 'pendente').length;
    const audioComErro = (s.chunks || []).find(c => c.status === 'erro' && c.erro);
    const audioEmCurso = (s.chunks || []).some(c => c.status === 'transcrevendo');
    const statusAudio = audioEmCurso
      ? '<div class="ad-step go" role="status" aria-live="polite">⏳ Transcrevendo o arquivo… Ele já está salvo neste navegador; a etapa pode levar alguns minutos.</div>'
      : audioComErro ? `<div class="ad-step" role="status" aria-live="polite"><i class="ph ph-warning-circle" aria-hidden="true"></i> ${E(audioComErro.erro)} O áudio continua salvo; use “Tentar novamente”.</div>` : '';
    const completo = !!(s.resumoMd && s.resultado);
    const groupForTab = key => ({ transcricao: 'materiais', audio: 'materiais', indice: 'indice', comparar: 'comparar' })[key] || 'estudar';
    const activeGroup = groupForTab(abaRes);
    const groupDefinitions = [
      { id: 'materiais', label: 'Materiais', first: 'transcricao' },
      { id: 'indice', label: 'Índice curricular', first: 'indice' },
      { id: 'comparar', label: 'Comparar aulas', first: 'comparar' },
      { id: 'estudar', label: 'Estudar', first: s.resumoMd ? 'resumo' : 'progresso' }
    ];
    const visibleTabs = tabs.filter(([key]) => groupForTab(key) === activeGroup);
    const railStatus = pipelineRodando ? 'Gerando materiais' : audioEmCurso ? 'Transcrevendo áudio' : falhas ? `${falhas} trecho(s) precisam de atenção` : completo ? 'Resumo disponível' : temFonte ? 'Conteúdo disponível para estudo' : 'Aguardando conteúdo';
    const indexedSources = chavesIscDaSessao(s).length;
    const availableMaterials = [
      (s.textoRevisado || s.texto) ? 'Transcrição' : '', s.audioImportado || (s.chunks || []).length ? 'Áudio original' : '',
      s.resumoMd ? 'Resumo' : '', s.resumoGeral ? 'Resumo geral' : '', s.flashcards?.length ? `${s.flashcards.length} flashcards` : '',
      (s.iscSlideResourceKeys || []).length ? 'Slides indexados' : ''
    ].filter(Boolean);
    r.innerHTML = `<div class="ad ad-workspace">
      <header class="ad-workspace-head"><div><h2>${E(nomeCompleto(s))}</h2><div class="sub">${E(s.disciplina || '')} › ${E(s.tema || 'sem conteúdo definido')} › ${E(s.parte || 'Única')} · ${E(s.data)} · ${s.audioImportado ? duracaoAudio(s.duracao || 0) : hms(s.duracao || 0)}${s.audioImportado ? ' · ' + E(s.audioImportado) + ' · ' + bytesAudio(s.audioBytes || 0) : ''} · ${E(TIPOS_AULA[s.tipoAula] || s.tipoAula || 'Expositiva')} · material ${E(PROFUNDIDADES[s.preferenciaMaterial] || s.preferenciaMaterial || 'Equilibrado')} · ${palavrasDe(s.textoRevisado || s.texto)} palavras${resumoPlano}</div></div><button class="b" type="button" onclick="auladia.voltar()"><i class="ph ph-arrow-left" aria-hidden="true"></i> Aulas</button></header>
      <div class="ad-workspace-grid"><main class="ad-workspace-main">
        <section class="ad-workspace-actions" aria-label="Ações principais"><div style="display:flex;gap:8px;flex-wrap:wrap">${geminiOk && !completo ? '<button class="b pri" type="button" onclick="auladia.gerar()"><i class="ph ph-sparkle" aria-hidden="true"></i> Gerar / continuar</button>' : ''}${falhas ? `<button class="b" type="button" onclick="auladia.reenviar()">Tentar novamente (${falhas})</button>` : ''}</div>${statusAudio}<div id="ad-proc" style="margin:0 0 8px"></div></section>
        <nav class="ad-primary-tabs" aria-label="Etapas da aula">${groupDefinitions.map(group => `<button class="b" type="button" aria-pressed="${activeGroup === group.id}" onclick="auladia.grupo('${group.id}')">${group.label}</button>`).join('')}</nav>
        ${visibleTabs.length > 1 ? `<div class="ad-subtabs" role="tablist" aria-label="Conteúdo de ${groupDefinitions.find(group => group.id === activeGroup)?.label || 'aula'}">${visibleTabs.map(([key, label]) => `<button class="b ${abaRes === key ? 'on' : ''}" type="button" role="tab" aria-selected="${abaRes === key}" aria-controls="ad-tab-panel" onclick="auladia.aba('${key}')">${label}</button>`).join('')}</div>` : ''}
        <section class="card ad-study-panel"><div id="ad-tab-panel" role="tabpanel" tabindex="0">${corpo}</div></section>
      </main><aside class="ad-workspace-rail" aria-label="Resumo da aula">
        <section class="card"><div class="ad-rail-section"><b>Status</b><div class="sub" role="status" aria-live="polite">${E(railStatus)}</div>${falhas ? `<div class="file-note">${falhas} segmento(s) com falha ou pendentes. O áudio permanece salvo para nova tentativa.</div>` : ''}</div>
          <div class="ad-rail-section"><b>Materiais disponíveis</b><div class="sub">${availableMaterials.length ? availableMaterials.map(E).join(' · ') : 'Nenhum material gerado ainda.'}</div></div>
          <div class="ad-rail-section"><b>Índice curricular</b><div class="sub">${indexedSources ? `${indexedSources} fonte(s) privada(s) indexada(s)` : 'Ainda sem fontes indexadas.'}</div><button class="b" type="button" onclick="auladia.aba('indice')">Abrir índice</button></div>
          <details class="ad-advanced ad-action-details"><summary>Ações e exportação</summary><div class="ad-rail-actions"><button class="b" type="button" onclick="auladia.copiar()">Copiar transcrição</button><button class="b" type="button" onclick="auladia.baixar('transcricao')">Transcrição .md</button>${s.resumoMd ? '<button class="b" type="button" onclick="auladia.baixar(\'resumo\')">Resumo .md</button>' : ''}${s.resumoGeral ? '<button class="b" type="button" onclick="auladia.baixar(\'resumogeral\')">Resumo geral .md</button>' : ''}<button class="b" type="button" onclick="auladia.baixar('tudo')">Exportar tudo</button><button class="b" type="button" onclick="auladia.editarTranscricao()">Revisar transcrição</button><button class="b" type="button" onclick="auladia.regenerar('resumo')">Refazer resumo</button>${s.flashcards ? '<button class="b" type="button" onclick="auladia.regenerar(\'flashcards\')">Refazer cartões</button>' : '<button class="b" type="button" onclick="auladia.gerarFlashcards()">Gerar flashcards</button>'}<button class="b" type="button" onclick="auladia.baixarHistorico()">Baixar histórico</button></div></details>
          <details class="ad-advanced ad-action-details"><summary>Preferências pedagógicas</summary>${personalizacaoHtml(s)}</details>
        </section>${cicloHtml(s)}</aside></div></div>`;
    r.querySelectorAll('[data-ad-objective]').forEach(el => el.addEventListener('change', () => marcarObjetivoRevisado(el.dataset.adObjective, el.checked)));
    if (pipelineRodando && sessAtual && htmlPassos) { const el = $('ad-proc'); if (el) el.innerHTML = htmlPassos; }
    if (abaRes === 'audio') desenharKaraoke();
    if (abaRes === 'mm') desenharMindmap();
  }


  /* ───────────── qualidade, edição e versões ───────────── */
  const fonteDe = s => [s.texto, s.textoRevisado].filter(Boolean).join('\n\n'); // números aceitos se estiverem no original OU na revisão
  function textoBaseRastreio(base) {
    if (!base || !Array.isArray(base.fatos)) return '';
    const sintese = Array.isArray(base.sintese) ? base.sintese : [], termos = Array.isArray(base.termos) ? base.termos : [], caiNaProva = Array.isArray(base.caiNaProva) ? base.caiNaProva : [];
    return [ ...sintese.map(x => 'SÍNTESE: ' + x), ...base.fatos.map(f => `[${f.capitulo || 'geral'}] (${f.tipo || 'fato'}) ${f.texto}`), ...termos.map(t => `TERMO: ${t.termo} = ${t.definicao}`), ...caiNaProva.map(x => 'CAI NA PROVA: ' + x) ].join('\n').replace(/\n/g, '\n\n');
  }
  const fonteGeracao = s => s && (s.textoRevisado || s.texto || textoPuro(s)) || '';
  function origemCartaoTexto(s, cartao) {
    const o = cartao && cartao.origem; if (!o || !['transcricao', 'base'].includes(o.tipo)) return '';
    const fonte = o.tipo === 'base' ? textoBaseRastreio(s.base) : fonteGeracao(s);
    return Number.isSafeInteger(o.inicio) && Number.isSafeInteger(o.fim) && o.inicio >= 0 && o.fim > o.inicio && o.fim <= fonte.length ? fonte.slice(o.inicio, o.fim).trim() : '';
  }
  function verOrigem(i) {
    const s = sessAtual, c = s && s.flashcards && s.flashcards[i], trecho = origemCartaoTexto(s, c);
    if (!trecho) return toast('Não foi possível localizar o trecho desta versão do cartão.', 'warning');
    alert(`Referência da aula${c.origem.tipo === 'transcricao' ? ` · caracteres ${c.origem.inicio}–${c.origem.fim}` : ' · base estruturada'}\n\n${trecho.slice(0, 1600)}${trecho.length > 1600 ? '\n…' : ''}`);
  }
  async function verificarQualidade(s, silencioso) {
    if (!s || !(s.resumoMd || (s.flashcards && s.flashcards.length))) return null;
    try {
      const j = await post('/api/aula/qualidade', { fonte: fonteDe(s), fonteRastreio: fonteGeracao(s), resumoMd: s.resumoMd || '', flashcards: s.flashcards || [], base: s.base || null }, 1);
      s.qualidade = j.relatorio; await salvarAgora(s);
      if (sessAtual === s) desenharResultado();
      return j.relatorio;
    } catch (e) { if (!silencioso) toast('Não consegui verificar a qualidade: ' + e.message, 'error'); return null; }
  }
  function qualidadeHtml(s) {
    const q = s.qualidade;
    const topo = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><button class="b pri" onclick="auladia.verificar()"><i class="ph ph-seal-check"></i> Verificar agora</button></div>`;
    if (!q) return topo + '<div class="sub">Ainda não verificado. A verificação é automática, sem IA, e leva instantes.</div>';
    const r = q.resumo, f = q.flashcards; let h = topo;
    if (r) {
      const c = r.cobertura;
      h += '<h4>Resumo</h4>' + (c ? `<div class="card"><b>Cobertura estimada dos fatos extraídos da aula: ${c.percentual}%</b> (${c.cobertos} de ${c.total})<div class="sub">Estimativa por coincidência de termos e números; não confirma cobertura semântica.</div></div>` + (c.naoCobertos.length ? '<div class="sub" style="margin:6px 0">Fatos que parecem não estar no resumo (confira na transcrição):</div><ul>' + c.naoCobertos.slice(0, 25).map(x => `<li>${E(x.texto)} <span class="sub">— ${E(x.motivo)}</span></li>`).join('') + '</ul>' : '') : '<div class="sub">Sem base de fatos para medir cobertura (a extração não rodou nesta aula).</div>')
        + (r.numerosParaConferir.length ? `<div class="card" style="border-color:var(--amber)"><b><i class="ph ph-warning-circle" aria-hidden="true"></i> Números/doses no resumo que não aparecem na transcrição:</b> ${r.numerosParaConferir.map(E).join(' · ')}<div class="sub">Podem ser erro de transcrição, de escrita da IA ou apenas outra forma de falar ("um grama"). Confira no áudio antes de estudar.</div></div>` : '<div class="sub">Todo número com unidade do resumo aparece na transcrição.</div>');
    }
    if (f) {
      h += `<h4>Flashcards</h4><div class="card"><b>${f.comAlerta}</b> de ${f.itens.length} cartões com alerta · <b>${f.duplicatas.length}</b> possíveis duplicatas${f.cobertura ? ' · cobertura estimada dos fatos: <b>' + f.cobertura.percentual + '%</b>' : ''}</div>`;
      if (f.dimensoes && f.dimensoes.length) h += `<div class="card"><b>Indicadores automáticos (heurísticos)</b><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:6px;margin-top:8px">${f.dimensoes.map(d => `<div class="sub">${E(d.nome)}: <b>${d.nota}/10</b></div>`).join('')}</div><div class="sub" style="margin-top:8px">As notas medem apenas regras verificáveis de contexto, concisão, números encontrados na fonte, duplicação provável e referência de origem. Não medem verdade clínica nem substituem a revisão da aula.</div></div>`;
      if ((f.revisaoHumana || []).length) h += `<div class="card" style="border-color:var(--amber)"><b><i class="ph ph-stethoscope" aria-hidden="true"></i> Revisão humana recomendada para ${f.revisaoHumana.length} cartão(ões)</b><div class="sub">Valores e unidades, medicamentos, critérios, condutas e vinhetas clínicas merecem conferência explícita na aula antes de estudar. Esse sinal não significa que o cartão esteja errado.</div>${f.revisaoHumana.slice(0, 20).map(x => `<div class="sub">Cartão ${x.i + 1}: ${E(x.motivos.join(' '))}</div>`).join('')}</div>`;
      if (f.duplicatas.length) h += '<button class="b" onclick="auladia.removerDuplicatas()"><i class="ph ph-copy"></i> Revisar possíveis duplicatas</button>';
    }
    return h + `<div class="sub" style="margin-top:10px">${E(q.aviso || '')} Material com dose, conduta ou critério clínico deve ser conferido por você antes de ser usado em prova.</div>`;
  }
  const verRot = { flashcards: 'cartões', resumoMd: 'resumo' };
  function versoesHtml(s, tipo) {
    const v = (s.versoes && s.versoes[tipo]) || []; if (!v.length) return '';
    return `<details style="margin:6px 0"><summary class="sub">Versões anteriores dos ${verRot[tipo]} (${v.length})</summary>` + v.map((x, i) => `<div class="sub" style="margin:3px 0">${E(new Date(x.em).toLocaleString('pt-BR'))} · ${tipo === 'flashcards' ? x.valor.length + ' cartões' : (x.valor || '').length + ' caracteres'} <button class="b" onclick="auladia.restaurar('${tipo}',${i})">Restaurar</button></div>`).join('') + '</details>';
  }
  function guardarVersao(s, tipo, valor) {
    if (!valor || (Array.isArray(valor) && !valor.length)) return;
    s.versoes = s.versoes || {}; s.versoes[tipo] = [{ em: new Date().toISOString(), valor: JSON.parse(JSON.stringify(valor)) }].concat(s.versoes[tipo] || []).slice(0, 3);
  }
  async function regenerar(tipo) {
    const s = sessAtual; if (!s || pipelineRodando) return toast('Aguarde o processamento atual terminar.', 'warning');
    if (!geminiOk) return toast('Preciso de uma chave de IA no servidor para regenerar.', 'warning');
    const regenerarCartoes = tipo === 'flash' || tipo === 'flashcards';
    if (!confirm(regenerarCartoes ? 'Regenerar os flashcards? A versão atual fica guardada em "Versões anteriores".' : 'Regenerar o resumo? A versão atual fica guardada em "Versões anteriores".')) return;
    if (regenerarCartoes) { guardarVersao(s, 'flashcards', s.flashcards); s.flashcards = null; s.solicitouFlashcards = true; s.qualidade = null; }
    else { guardarVersao(s, 'resumoMd', s.resumoMd); s.resumoMd = ''; s.caps = []; s.fechamento = ''; s.qualidade = null; }
    await salvarAgora(s); pipeline(s);
  }
  async function restaurar(tipo, i) {
    const s = sessAtual; const v = s && s.versoes && s.versoes[tipo] && s.versoes[tipo][i]; if (!v) return;
    guardarVersao(s, tipo, tipo === 'flashcards' ? s.flashcards : s.resumoMd);
    if (tipo === 'flashcards') s.flashcards = v.valor; else s.resumoMd = v.valor;
    s.qualidade = null; await salvarAgora(s); desenharResultado(); verificarQualidade(s, true);
  }
  async function cartaoRemover(i) {
    const s = sessAtual; if (!s || !s.flashcards || !s.flashcards[i]) return;
    guardarVersao(s, 'flashcards', s.flashcards); s.flashcards.splice(i, 1); s.qualidade = null; await salvarAgora(s); desenharResultado(); verificarQualidade(s, true);
  }
  async function cartaoEditar(i) {
    const s = sessAtual; const c = s && s.flashcards && s.flashcards[i]; if (!c) return;
    const f = prompt('Frente (pergunta):', c.frente); if (f === null) return;
    const v = prompt('Verso (resposta):', c.verso); if (v === null) return;
    if (!f.trim() || !v.trim()) return toast('Frente e verso não podem ficar vazios.', 'warning');
    c.frente = f.trim(); c.verso = v.trim(); c.editado = true; s.qualidade = null; await salvarAgora(s); desenharResultado(); verificarQualidade(s, true);
  }
  async function removerDuplicatas() {
    const s = sessAtual; const d = s && s.qualidade && s.qualidade.flashcards && s.qualidade.flashcards.duplicatas; if (!d || !d.length) return;
    if (!confirm(`${d.length} par(es) parecem semelhantes. A detecção é heurística e pode marcar cartões complementares. Remover os cartões repetidos prováveis, mantendo o primeiro de cada par?`)) return;
    const fora = new Set(d.map(x => x[1])); guardarVersao(s, 'flashcards', s.flashcards);
    s.flashcards = s.flashcards.filter((_, i) => !fora.has(i)); s.qualidade = null; await salvarAgora(s); desenharResultado(); verificarQualidade(s, true);
    toast(fora.size + ' duplicatas removidas.', 'success');
  }
  let _editandoTxt = false;
  async function editarTexto() {
    const s = sessAtual; const el = $('ad-tr-txt'); const b = $('ad-ed-btn'); if (!s || !el || !b) return;
    if (!_editandoTxt) { _editandoTxt = true; el.contentEditable = 'true'; el.style.outline = '2px solid var(--amber)'; el.style.whiteSpace = 'pre-wrap'; el.innerText = s.textoRevisado || s.texto || ''; b.innerHTML = '<i class="ph ph-floppy-disk"></i> Salvar edição'; el.focus(); return; }
    const novo = el.innerText.replace(/\u00a0/g, ' ').trim(); _editandoTxt = false;
    if (novo.length < 20) { toast('Texto curto demais; edição descartada.', 'warning'); return desenharResultado(); }
    if (novo !== (s.textoRevisado || s.texto)) {
      if (!s.textoRevisado) s.textoRevisado = s.texto; // o original (s.texto) nunca é sobrescrito
      s.textoRevisado = novo; s.textoEditadoEm = new Date().toISOString(); s.revisaoDesatualizada = false; s.qualidade = null; await salvarAgora(s);
      toast('Transcrição salva. O resumo e os cartões já gerados não mudam: use "Regenerar" se quiser refazê-los com o texto corrigido.', 'success');
    }
    desenharResultado();
  }
  function verOriginal() { const el = $('ad-tr-txt'); if (!el || !sessAtual) return; el.style.whiteSpace = 'pre-wrap'; el.textContent = sessAtual.texto || ''; }

  /* ───────────── ações ───────────── */
  function cabecalho(s) { return `# ${nomeCompleto(s)}\n\nÁrea: ${s.disciplina || '—'} · Conteúdo: ${s.tema || '—'} · ${s.parte || 'Única'}\nData: ${s.data} · Duração: ${hms(s.duracao || 0)}\n\n`; }
  function pacoteMd(s, tipo) {
    const transc = `## Transcrição completa${s.textoRevisado ? ' (revisada)' : ''}\n\n${s.textoRevisado || s.texto || textoPuro(s)}\n`;
    if (tipo === 'transcricao') return cabecalho(s) + transc;
    if (tipo === 'resumo') return s.resumoMd || '';
    if (tipo === 'resumogeral') return s.resumoGeral ? cabecalho(s) + s.resumoGeral : '';
    let md = s.resumoMd ? s.resumoMd + '\n\n---\n\n' : cabecalho(s);
    if (s.resumoGeral) md += s.resumoGeral + '\n\n---\n\n';
    if (s.flashcards && s.flashcards.length) md += `## Flashcards de revisão\n\n` + s.flashcards.map((f, i) => `**${i + 1}. ${f.frente}**\n${f.verso}\n${f.tema ? '*(' + f.tema + ')*\n' : ''}`).join('\n') + '\n\n---\n\n';
    return md + transc;
  }
  function baixar(tipo) {
    const s = sessAtual; if (!s) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([pacoteMd(s, tipo || 'tudo')], { type: 'text/markdown' }));
    a.download = [s.disciplina || 'aula', s.tema, s.parte, tipo || 'tudo', s.data].filter(Boolean).join(' - ').replace(/[^\p{L}\p{N}\- ]+/gu, '_') + '.md'; document.body.appendChild(a); a.click(); a.remove();
  }
  async function copiar() { const s = sessAtual; if (!s) return; try { await navigator.clipboard.writeText(s.textoRevisado || s.texto || textoPuro(s)); toast('Transcrição copiada', 'success'); } catch (_) { toast('Não consegui copiar — use "Baixar .md".', 'error'); } }
  // Adiciona os cartões da aula ao Treino (sem duplicar). Devolve quantos entraram, ou -1 se o Treino não está disponível.
  function adicionarFlashcards(s) {
    if (!s || !s.flashcards || typeof FCS === 'undefined') return -1;
    const ja = new Set(FCS.map(c => c.f + '::' + c.b)); let n = 0;
    s.flashcards.forEach(f => { if (!ja.has(f.frente + '::' + f.verso)) { FCS.push({ f: f.frente, b: f.verso, s: 'x', tema: f.tema, dificuldade: f.dificuldade, formato: f.formato || 'pergunta', origem: { aulaId: s.id, trecho: f.origem || f.trecho || null } }); ja.add(f.frente + '::' + f.verso); n++; } });
    if (typeof saveFC === 'function') saveFC();
    return n;
  }
  async function enviarFlash() {
    const s = sessAtual; if (!s || !s.flashcards || !s.flashcards.length) return toast('Gere os flashcards antes de adicioná-los ao Treino.', 'warning');
    const q = s.qualidade && s.qualidade.flashcards ? s.qualidade : await verificarQualidade(s, true);
    const f = q && q.flashcards, alertas = f ? f.comAlerta : 0, revisar = f && f.revisaoHumana ? f.revisaoHumana.length : 0;
    if (!confirm(`Aprovar ${s.flashcards.length} cartões para o Treino?\n\n${alertas} cartão(ões) têm alertas automáticos e ${revisar} recomendam conferência humana de valores, critérios, condutas ou vinhetas. Os indicadores não comprovam correção clínica. Revise, edite ou remova os cartões antes de confirmar.`)) return;
    const n = adicionarFlashcards(s); if (n < 0) return;
    toast(n ? n + ' flashcards adicionados ao Treino — eles entram na revisão espaçada de hoje.' : 'Esses flashcards já estavam no Treino.', n ? 'success' : 'info');
  }

  /* ───────────── fechar o ciclo: cartões → Treino · revisões → Mentor · teste imediato ───────────── */
  const REVISOES = [[1, '24h', 'flashcards', 10], [7, '7 dias', 'questoes', 15], [30, '30 dias', 'questoes', 15]]; // mesmos intervalos do motor do Mentor
  const pad2 = n => String(n).padStart(2, '0');
  const somaDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const normTxt = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const temaDaAula = s => (s.tema || '').trim() || ((s.mapa && s.mapa.capitulos && s.mapa.capitulos[0]) || {}).titulo || s.disciplina || 'Aula';

  // Cria no plano do Mentor as revisões desta aula (24h, 7 e 30 dias). Idempotente (ids por aula+intervalo), não passa da prova da matéria.
  function revisoesParaPlano(s, plano, hoje) {
    const tema = temaDaAula(s), disc = (s.disciplina || 'Aula').trim(), base = s.data || hoje;
    const destaques = ((s.resultado && s.resultado.caiNaProva) || []).slice(0, 3);
    const destaque = destaques.length > 0 || (s.marcas || []).length > 0;
    const prova = ((plano.perfil && plano.perfil.provasFaculdade) || []).filter(p => p.data >= base && normTxt(p.disciplina) && (normTxt(disc).includes(normTxt(p.disciplina)) || normTxt(p.disciplina).includes(normTxt(disc)))).map(p => p.data).sort()[0];
    const existentes = new Set((plano.tarefas || []).map(t => t.id));
    const novas = [];
    for (const [d, rot, kind, min] of REVISOES) {
      const id = 'aula-' + s.id + '-r' + d; if (existentes.has(id)) continue;
      let data = somaDias(base, d); if (data < hoje) data = hoje;
      if (prova && data >= prova) continue; // revisão depois da prova não serve
      const rotulo = (kind === 'flashcards' ? 'Flashcards: ' : 'Questões: ') + tema;
      novas.push({ id, data, tipo: 'revisao', trilha: 'faculdade', titulo: 'Revisão ' + rot + ': ' + tema, materia: disc, tema, minutos: min,
        passos: [{ n: 1, acao: kind, minutos: min, recursos: [0], texto: kind === 'flashcards' ? 'Revisão de ' + rot + ' — "' + tema + '": faça os flashcards SEM olhar o resumo; o que errar volta amanhã.' : 'Revisão de ' + rot + ' — "' + tema + '": responda questões do tema e anote em 1 linha a regra de cada erro.' }],
        recursos: [{ tipo: kind, titulo: rotulo, tema, disc }], estrategia: { [kind]: min },
        observacoes: 'Criada pela Aula do dia (' + s.data + ').' + (destaques.length ? ' O professor indicou que cai na prova: ' + destaques.join(' · ') + '.' : ''),
        status: 'pendente', origem: 'aula-dia', origemAula: s.id, destaque });
    }
    return novas;
  }

  // A aula foi assistida: marca como feita a "Prévia da aula" pendente dessa matéria (a mais recente até hoje), com registro no histórico.
  function concluirPrevia(s, plano, hoje) {
    const disc = normTxt(s.disciplina); if (!disc) return null;
    const cand = (plano.tarefas || []).filter(t => t.status === 'pendente' && /^Prévia da aula/i.test(t.titulo || '') && t.data <= hoje && t.origem !== 'aula-dia'
      && (normTxt(t.materia).includes(disc) || disc.includes(normTxt(t.materia))) && normTxt(t.materia));
    if (!cand.length) return null;
    const tm = normTxt(s.tema);
    cand.sort((a, b) => (tm && normTxt(b.titulo).includes(tm) ? 1 : 0) - (tm && normTxt(a.titulo).includes(tm) ? 1 : 0) || String(b.data).localeCompare(String(a.data)));
    const t = cand[0]; t.status = 'feito'; t.feitoEm = new Date().toISOString(); t.observacoes = ((t.observacoes || '') + ' Concluída pela Aula do dia (' + s.data + ').').trim();
    plano.historico = (plano.historico || []).concat([{ ts: t.feitoEm, acao: 'concluir', id: t.id, titulo: t.titulo, origem: 'aula-dia' }]).slice(-500);
    return t;
  }

  async function fecharCiclo() {
    const s = sessAtual; if (!s || !s.flashcards) return toast('Gere o resumo e os flashcards primeiro.', 'warning');
    if (typeof FCS === 'undefined') return toast('O Treino não está disponível nesta tela.', 'warning');
    const q = s.qualidade && s.qualidade.flashcards ? s.qualidade : await verificarQualidade(s, true);
    const f = q && q.flashcards, alertas = f ? f.comAlerta : 0, revisar = f && f.revisaoHumana ? f.revisaoHumana.length : 0;
    if (!confirm(`Fechar o ciclo e adicionar ao Treino os cartões desta aula, se o Treino estiver disponível?\n\n${alertas} cartão(ões) têm alertas automáticos e ${revisar} recomendam conferência humana de valores, critérios, condutas ou vinhetas. A revisão é sua aprovação dos cartões para estudo.`)) return;
    const out = s.ciclo = Object.assign({}, s.ciclo);
    const nc = adicionarFlashcards(s);
    out.cartoes = nc < 0 ? out.cartoes || 0 : (out.cartoes || 0) + nc; out.cartoesTotal = (s.flashcards || []).length;
    const I = window.plv2 && window.plv2._i;
    let plano = I ? I.get('planner-v2-plan', null) : null;
    if (!plano || !Array.isArray(plano.tarefas)) { out.revisoes = out.revisoes || 0; out.semPlano = true; }
    else {
      out.semPlano = false;
      const novas = revisoesParaPlano(s, plano, hojeISO());
      const previa = (s.ciclo && s.ciclo.previa) ? null : concluirPrevia(s, plano, hojeISO());
      if (previa) out.previa = previa.titulo;
      if (novas.length || previa) {
        plano.tarefas = plano.tarefas.concat(novas).sort((a, b) => String(a.data).localeCompare(String(b.data)));
        I.set('planner-v2-plan', plano);
        try { if (window.plv3 && plv3.anotar) { const p2 = await plv3.anotar(plano); if (p2 && Array.isArray(p2.tarefas)) { plano = p2; I.set('planner-v2-plan', plano); } } } catch (_) { /* sem prioridade calculada agora; o próximo replanejamento calcula */ }
        try { I.sync(); } catch (_) {}
      }
      out.revisoes = (out.revisoes || 0) + novas.length; out.revisoesTotal = REVISOES.length;
    }
    out.em = new Date().toISOString();
    await salvarAgora(s); desenharResultado();
    toast(out.semPlano ? 'Cartões enviados ao Treino. Para agendar revisões, crie um plano no Mentor primeiro.' : 'Ciclo fechado: ' + (nc < 0 ? 0 : nc) + ' cartões no Treino e revisões agendadas no Mentor.', out.semPlano ? 'warning' : 'success');
  }

  async function testarAgora() {
    const s = sessAtual; if (!s) return;
    if (typeof window.buscarQtdQuestoesTema !== 'function' || typeof window.iniciarSimuladoDoTema !== 'function') return toast('O Treino não está disponível nesta tela.', 'warning');
    toast('Buscando questões do tema…', 'info');
    const tema = temaDaAula(s);
    try {
      const r = await window.buscarQtdQuestoesTema(tema, s.disciplina || '', '');
      if (!r || !(r.questions || []).length) return toast('Ainda não há questões do banco sobre este tema.', 'warning');
      await window.iniciarSimuladoDoTema(tema, s.disciplina || '', r.questions, '');
    } catch (e) { toast('Não consegui abrir o teste: ' + e.message, 'error'); }
  }

  function cicloHtml(s) {
    if (!s.flashcards) return '';
    const c = s.ciclo;
    const linha = (ok, txt) => `<div class="ad-step ${ok ? 'ok' : ''}"><i class="ph ${ok ? 'ph-check-circle' : 'ph-circle'}" aria-hidden="true"></i> ${txt}</div>`;
    return `<div class="card" id="ad-ciclo" style="margin-bottom:10px"><b><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Fechar o ciclo</b>
      <div class="sub" style="margin:4px 0 8px">Ler não basta: testar e revisar nos intervalos certos é o que fixa. Um toque faz tudo.</div>
      ${linha(c && c.cartoes != null, c && c.cartoes != null ? (c.cartoes + ' cartões novos no Treino (de ' + (c.cartoesTotal || (s.flashcards || []).length) + ')') : 'Flashcards da aula no Treino (revisão espaçada)')}
      ${linha(c && c.revisoes > 0, c && c.semPlano ? 'Sem plano no Mentor: crie um para agendar revisões' : (c && c.revisoes != null ? c.revisoes + ' revisões agendadas no Mentor (24 h, 7 e 30 dias)' : 'Revisões em 24 h, 7 e 30 dias no seu plano do Mentor'))}
      ${c && c.previa ? linha(true, 'Tarefa concluída no Mentor: ' + E(c.previa)) : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="b pri" onclick="auladia.fecharCiclo()"><i class="ph ph-arrows-clockwise"></i> ${c ? 'Atualizar' : 'Fechar o ciclo'}</button><button class="b" onclick="auladia.testar()"><i class="ph ph-exam"></i> Testar agora (questões do tema)</button></div></div>`;
  }
  async function abrirSess(id) { if (rec) return toast('Fim da gravação primeiro — finalize ou aguarde terminar.', 'warning'); const s = await carregarSess(id); if (!s) return; sessAtual = s; abaRes = s.resumoMd ? 'resumo' : 'transcricao'; desenharResultado(); }
  function apagarSess(id) { if (!confirm('Apagar esta aula gravada?')) return; salvarSessoes(sessoes().filter(x => x.id !== id)); idbDel(id + ':'); idbDelKey('doc:' + id); if (sessAtual && sessAtual.id === id) sessAtual = null; render(); }

  window.auladia = {
    regenerar, restaurar, cartaoRemover, cartaoEditar, removerDuplicatas, editarTexto, verOriginal, verOrigem, verificar: () => verificarQualidade(sessAtual, false),
    iniciar, marcar, duvida, abrir: abrirSess, apagar: apagarSess, enviarFlash, baixar, copiar,
    pausar, continuar, parar, retomar, finalizar,
    gerar() { if (sessAtual) pipeline(sessAtual); }, reenviar: reenviarFalhas, retranscrever: retranscreverTrechoSelecionado, ouvirTrecho, testarMicrofone, parteAuto: atualizarParteSugerida,
    kVai, fecharCiclo, testar: testarAgora,
    _deveCortar: deveCortar, _chunksProntos: () => (sessAtual && sessAtual.chunks ? sessAtual.chunks.length : 0), _CHUNK: { SOFT: CHUNK_SOFT_MS, HARD: CHUNK_MS }, _pool: pool, _limitador: limitador, _revisoes: revisoesParaPlano, _previa: concluirPrevia,
    editarTranscricao, regenerar, baixarHistorico, importarAudio, salvarPreferencias,
    gerarRQ: gerarResumoGeral, gerarFlashcards, salvarMetodologia, tutorEnviar, tutorReenviar, tutorAtalho,
    indexarAtual, indexarSlides, revisarIndice, adicionarTopicoManual, buscarAulasRelacionadas, compararVideoAulas,
    abrirAulaCatalogo, abrirTrechoVideo, fecharIndiceAula,
    compararAulas, compararSelecionadas, removerDoIndice,
    mmGerar, mmToggle: mmClique, mmZoom, mmFit, mmTudo, mmPNG, mmMermaid,
    ancora(id) { const el = document.getElementById('adh-' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    aba(k) { if (abaRes === 'audio' && k !== 'audio') karaokeParar(true); abaRes = k; desenharResultado(); },
    grupo(key) {
      const first = ({ materiais: 'transcricao', indice: 'indice', comparar: 'comparar', estudar: sessAtual?.resumoMd ? 'resumo' : 'progresso' })[key];
      if (!first) return;
      if (abaRes === 'audio') karaokeParar(true);
      abaRes = first; desenharResultado();
    },
    filtrarHistorico, selecionarSlidesSetup, processarSlidesPendentes,
    voltar() { if (rec) return; karaokeParar(true); sessAtual = null; render(); }
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
