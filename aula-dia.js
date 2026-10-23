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
  let geminiOk = null, transcOk = false, paralelo = 1, iniciando = false, uploadRodando = false;
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
    } catch (_) { geminiOk = false; transcOk = false; paralelo = 1; }
  }
  let rec = null;       // estado da gravação em andamento
  let sessAtual = null; // sessão exibida (em gravação ou aberta do histórico)
  let abaRes = 'transcricao';

  /* ───────────── armazenamento ───────────── */
  const sessoes = () => get(K_SESS, []);
  const salvarSessoes = l => set(K_SESS, l.slice(0, 120));
  const palavrasDe = t => (t || '').split(/\s+/).filter(Boolean).length;
  const TIPOS_AULA = { expositiva: 'Expositiva', 'caso-clinico': 'Discussão de caso', 'revisao-prova': 'Revisão para prova', pratica: 'Aula prática ou procedimento' };
  const PROFUNDIDADES = { conciso: 'Enxuto', equilibrado: 'Equilibrado', detalhado: 'Detalhado' };
  function preferenciasAula() {
    const p = get(K_PREF, {});
    return { tipoAula: TIPOS_AULA[p.tipoAula] ? p.tipoAula : 'expositiva', preferenciaMaterial: PROFUNDIDADES[p.preferenciaMaterial] ? p.preferenciaMaterial : 'equilibrado' };
  }
  function salvarPreferencias() {
    const tipoAula = ($('ad-tipo') || {}).value, preferenciaMaterial = ($('ad-detalhe') || {}).value;
    if (TIPOS_AULA[tipoAula] && PROFUNDIDADES[preferenciaMaterial]) set(K_PREF, { tipoAula, preferenciaMaterial });
  }
  // Só o resumo da aula vai para o localStorage; textos grandes (transcrição, resumo, flashcards) ficam no IndexedDB
  function metaDe(s) {
    return { id: s.id, data: s.data, inicio: s.inicio, disciplina: s.disciplina, tema: s.tema, parte: s.parte || 'Única', cor: s.cor || 'dourado', duracao: s.duracao || 0, tipoAula: s.tipoAula || 'expositiva', preferenciaMaterial: s.preferenciaMaterial || 'equilibrado', audioImportado: s.audioImportado || '', audioBytes: s.audioBytes || 0, marcas: s.marcas || [],
      palavras: palavrasDe(s.textoRevisado || s.texto), pronto: !!(s.resumoMd && s.flashcards), revisada: !!s.textoRevisado, nFlash: (s.flashcards || []).length };
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
.ad{max-width:980px;margin:0 auto;font-family:var(--font-ui);color:var(--text-primary)}
.ad h2{margin:0 0 4px;font-size:21px;text-wrap:balance}.ad .sub{font-size:12.5px;color:var(--text-secondary);margin-bottom:14px;overflow-wrap:anywhere}
.ad .card{background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:14px;margin-bottom:14px}
.ad label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin:0 0 4px}
.ad input,.ad select{width:100%;background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-muted);border-radius:var(--radius-md);padding:9px 10px;font:inherit;font-size:16px}
.ad .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ad .b{background:var(--bg-surface);border:1px solid var(--border-muted);color:var(--text-primary);border-radius:var(--radius-md);padding:8px 12px;font-size:13px;cursor:pointer;display:inline-flex;gap:6px;align-items:center;touch-action:manipulation}
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
.ad .file-note{font-size:12px;color:var(--text-secondary);line-height:1.5;margin:8px 0 0}
.ad .file-meta{font-size:13px;color:var(--text-primary);margin-top:2px;flex-basis:100%;overflow-wrap:anywhere}
.ad .file-meta[data-state="error"]{color:var(--amber)}.ad .file-meta[data-state="success"]{color:var(--teal)}
.ad .b:focus-visible,.ad input:focus-visible,.ad select:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
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
.ak-line.on{background:var(--teal-dim);box-shadow:inset 0 0 0 1.5px var(--teal-border);color:var(--text-primary)}
.ak-line .t{color:var(--text-muted);font-family:var(--font-mono);font-size:11.5px;margin-right:8px}
.ak-info{font-size:12px;color:var(--text-muted);margin:6px 0}
.mm-tools{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px}
.mm-tools .b{padding:5px 10px;font-size:12px}
.mm-sc{overflow:auto;max-height:72vh;border-radius:14px;border:1px solid rgba(120,160,150,.25);background:#0b1216}
.mm-inner{transform-origin:0 0;width:max-content}
.mm-node{cursor:pointer}
.mm-node text{user-select:none}
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
        `<div class="hist"><div><b>${E(s.parte || 'Única')}</b> <small>${E(s.data)} · ${hms(s.duracao || 0)} · ${s.palavras != null ? s.palavras : 0} palavras${s.tipoAula ? ' · ' + E(TIPOS_AULA[s.tipoAula] || s.tipoAula) : ''}${s.preferenciaMaterial ? ' · material ' + E(PROFUNDIDADES[s.preferenciaMaterial] || s.preferenciaMaterial) : ''}${s.audioImportado ? ' · áudio ' + E(s.audioImportado) + ' (' + bytesAudio(s.audioBytes || 0) + ')' : ''}${s.revisada ? ' · ✔ revisada' : ''}${s.pronto ? ' · ✔ resumo + ' + (s.nFlash || 0) + ' flashcards' : ''}</small></div><div style="display:flex;gap:6px"><button class="b" onclick="auladia.abrir('${s.id}')">Abrir</button><button class="b" aria-label="Apagar aula ${E(s.tema || s.disciplina || s.parte || '')}" title="Apagar aula" onclick="auladia.apagar('${s.id}')">🗑</button></div></div>`).join('')).join('')).join('');
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
    r.innerHTML = `<div class="ad"><h2>Aula do dia</h2><div class="sub">Grave a aula da faculdade: transcrição fiel, revisada e arquivada por Área › Conteúdo › Parte. No fim eu gero o resumo completo e os flashcards de revisão.</div>
    <div class="card"><div class="row"><div><label for="ad-disc">Área / disciplina</label><input id="ad-disc" name="disciplina" autocomplete="off" list="ad-discs" placeholder="Ex.: Psiquiatria…" value="${E(d0)}" oninput="auladia.parteAuto()"><datalist id="ad-discs">${opts.map(o => `<option value="${E(o)}">`).join('')}</datalist></div>
    <div><label for="ad-tema">Conteúdo da aula</label><input id="ad-tema" name="conteudo" autocomplete="off" placeholder="Ex.: Transtornos de humor…" value="${E(t0)}" oninput="auladia.parteAuto()"></div></div>
    <div class="row3"><div><label for="ad-parte">Parte</label><select id="ad-parte" name="parte" onchange="this.dataset.manual=1">${partes.map(p => `<option${p === sugerirParte(d0, t0) ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
<div></div></div>
    <div class="row3"><div><label for="ad-tipo">Tipo de aula</label><select id="ad-tipo" name="tipoAula" onchange="auladia.salvarPreferencias()"><option value="expositiva"${pref.tipoAula === 'expositiva' ? ' selected' : ''}>Expositiva</option><option value="caso-clinico"${pref.tipoAula === 'caso-clinico' ? ' selected' : ''}>Discussão de caso</option><option value="revisao-prova"${pref.tipoAula === 'revisao-prova' ? ' selected' : ''}>Revisão para prova</option><option value="pratica"${pref.tipoAula === 'pratica' ? ' selected' : ''}>Aula prática ou procedimento</option></select></div><div><label for="ad-detalhe">Tamanho do material</label><select id="ad-detalhe" name="preferenciaMaterial" onchange="auladia.salvarPreferencias()"><option value="conciso"${pref.preferenciaMaterial === 'conciso' ? ' selected' : ''}>Enxuto</option><option value="equilibrado"${pref.preferenciaMaterial === 'equilibrado' ? ' selected' : ''}>Equilibrado</option><option value="detalhado"${pref.preferenciaMaterial === 'detalhado' ? ' selected' : ''}>Detalhado</option></select></div><div class="file-note">A duração do arquivo é detectada automaticamente.</div></div>
    <div class="ad-big"><button class="b rec" id="ad-start" onclick="auladia.iniciar()"><i class="ph ph-record" aria-hidden="true"></i> Gravar agora</button><button class="b" type="button"${transcOk ? '' : ' disabled title="Configure um provedor de transcrição no servidor"'} aria-describedby="ad-audio-note" onclick="document.getElementById('ad-audio-file').click()"><i class="ph ph-upload-simple" aria-hidden="true"></i> Enviar áudio</button><input id="ad-audio-file" name="audio" type="file" accept="audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,audio/flac,audio/x-m4a,.mp3,.m4a,.wav,.ogg,.webm,.flac" hidden onchange="auladia.importarAudio(this)"><span id="ad-audio-meta" class="file-meta" role="status" aria-live="polite" aria-atomic="true"></span>
    <span class="sub" style="margin:0">${transcOk ? (geminiOk ? 'A gravação é enviada em trechos de ~1,5 min; arquivos selecionados são transcritos antes dos materiais.' : 'A transcrição por áudio está disponível; configure também uma IA de texto para gerar resumo e flashcards.') : (geminiOk ? 'Transcrição de áudio indisponível neste momento; você ainda pode gravar com a legenda ao vivo do navegador.' : 'Sem provedor de IA no servidor: a gravação usa apenas a legenda ao vivo do navegador.')}</span></div>
    <div id="ad-audio-note" class="file-note">MP3, M4A, WAV, OGG, WebM ou FLAC. ${audioUploadDireto ? 'Até 50 MB e 60 min; uma aula de 1 h costuma caber em MP3 mono a 64–96 kbps. Arquivos acima de 3 MB passam temporariamente pelo bucket privado do Supabase e são removidos após a transcrição; a cópia local fica para reprodução e retry. Áudios acima de ' + bytesAudio(groqAudioMaxBytes) + (audioGrandeGemini ? ' usam a transcrição dedicada do Gemini.' : ' precisam de Gemini configurado. WAV pode passar do limite.') : 'Sem armazenamento de áudio configurado: arquivos de até 3 MB. Para aulas longas, configure SUPABASE_SERVICE_ROLE_KEY. A duração é detectada automaticamente.'}</div>
    <div class="aviso">Deixe a tela ligada e o navegador aberto durante a aula — no iPhone, bloquear a tela ou trocar de app pausa a gravação. Posicione o aparelho perto de quem fala e use o botão ⭐ quando o professor disser "isso cai na prova". Grave apenas se a faculdade/professor permitirem.</div></div>
    <div class="card"><b>Aulas gravadas</b> <small class="sub">(por Área › Conteúdo › Parte)</small>${historicoAgrupado()}</div></div>`;
  }

  function estadoGrav() { return rec ? (rec.parar ? 'finalizando' : rec.parado ? 'parada' : rec.pausado ? 'pausada' : 'gravando') : null; }
  function decorridoMs() { if (!rec) return 0; return rec.ganho + (!(rec.pausado || rec.parado || rec.parar) ? Date.now() - rec.refer : 0).valueOf(); }

  function desenharGravando() {
    const r = $('ad-root'); if (!r || !rec) return;
    const est = estadoGrav();
    const bPausa = est === 'pausada'
      ? `<button class="b pri" onclick="auladia.continuar()"><i class="ph ph-play"></i> Continuar</button>`
      : est === 'gravando' ? `<button class="b" onclick="auladia.pausar()"><i class="ph ph-pause"></i> Pausar</button>` : '';
    const bParada = est === 'parada'
      ? `<button class="b pri" onclick="auladia.retomar()"><i class="ph ph-microphone"></i> Continuar gravação</button><button class="b pri" onclick="auladia.finalizar()"><i class="ph ph-sparkle"></i> ✅ Finalizar e revisar</button>`
      : est === 'gravando' || est === 'pausada' ? `<button class="b" onclick="auladia.parar()"><i class="ph ph-stop-circle"></i> ⏹ Parar</button>` : '';
    const stTxt = est === 'pausada' ? '⏸ Pausado — o microfone ficou em espera; o trecho atual foi guardado junto com o áudio.'
      : est === 'parada' ? '⏹ Gravação parada — toque em "Continuar gravação" para somar mais um trecho, ou "Finalizar e revisar" para gerar o material de estudo.'
      : est === 'finalizando' ? 'Finalizando e transcrevendo o último trecho…'
      : (transcOk ? 'Gravando · trechos enviados à IA a cada ~1,5 min' : 'Gravando · legenda ao vivo do navegador');
    r.innerHTML = `<div class="ad"><h2><span class="ad-dot" style="display:inline-block;margin-right:8px;${est === 'gravando' ? '' : 'animation:none;background:var(--amber)'}"></span>${est === 'gravando' ? 'Gravando' : est === 'pausada' ? 'Pausado' : est === 'parada' ? 'Gravação parada' : 'Finalizando'} — ${E(rec.sess.disciplina || 'aula')}</h2><div class="sub">${E(rec.sess.tema || '')}</div>
    <div class="card"><div class="ad-big" style="margin-top:0"><span class="ad-timer" id="ad-timer">${mmss(decorridoMs() / 1000)}</span><div class="ad-meter"><i id="ad-meter"></i></div>
    <button class="b" onclick="auladia.marcar()">⭐ Marcar momento</button><button class="b" onclick="auladia.duvida()" title="Marque o ponto que você não entendeu; ele vira dúvida no resultado">❓ Dúvida</button>${bPausa}${bParada}${est !== 'finalizando' ? `<button class="b pri" onclick="auladia.finalizar()"><i class="ph ph-check-circle"></i> Finalizar</button>` : ''}</div>
    <div class="sub" id="ad-status" style="margin:8px 0 0">${E(stTxt)}</div></div>
    <div class="card"><b>Transcrição ao vivo</b><div class="ad-tr" id="ad-tr"></div></div></div>`;
  }

  function textoHtml(s) {
    const partes = (s.chunks || []).slice().sort((a, b) => a.i - b.i).map(c => c.status === 'ok' ? E(c.texto) : c.status === 'erro' ? '<span class="pend">[trecho ' + (c.i + 1) + ' sem transcrição — toque em "Tentar novamente"]</span>' : '<span class="pend">[transcrevendo trecho ' + (c.i + 1) + '…]</span>');
    const live = s.live ? E(s.live) : '';
    return (partes.join('\n\n') + (live ? (partes.length ? '\n\n' : '') + live : '')).replace(/([⭐❓]) \[(\d\d:\d\d)\]/g, '<span class="mk">$1 [$2]</span>') || '<span class="pend">A transcrição aparecerá aqui…</span>';
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
      const disc = ($('ad-disc') || {}).value || '', tema = ($('ad-tema') || {}).value || '', parte = ($('ad-parte') || {}).value || 'Única', cor = ($('ad-cor') || {}).value || 'dourado', tipoAula = ($('ad-tipo') || {}).value || 'expositiva', preferenciaMaterial = ($('ad-detalhe') || {}).value || 'equilibrado';
      salvarPreferencias();
      const stream = await pedirMicrofone();
      if (!stream) return;
      garantirView(); css();
      await carregarStatus();
      if ($('view-auladia') && !$('view-auladia').classList.contains('active')) { go(VIEW); await new Promise(r => setTimeout(r, 200)); }
      await comecar(stream, disc, tema, parte, cor, tipoAula, preferenciaMaterial);
    } finally { iniciando = false; }
  }

  async function comecar(stream, disc, tema, parte, cor, tipoAula = 'expositiva', preferenciaMaterial = 'equilibrado') {
    const sess = { id: 'a' + Date.now(), data: hojeISO(), inicio: Date.now(), disciplina: disc.trim(), tema: tema.trim(), parte, cor, tipoAula, preferenciaMaterial, duracao: 0, chunks: [], marcas: [], texto: '', live: '', resultado: null };
    const mime = escolherMime();
    rec = { sess, stream, mime, mr: null, t0: Date.now(), parar: false, pausado: false, parado: false, ganho: 0, refer: Date.now(), fila: [], enviando: false, chunkIdx: 0, silencio: 0, timers: [], ctx: null, wake: null, sr: null };
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
        // pausa de fala = nível bem abaixo do pico recente (funciona com ruído de sala, onde o silêncio absoluto nunca acontece)
        rec.pico = Math.max(nv, (rec.pico || 0) * 0.997);
        rec.pausaFala = nv < Math.max(4, rec.pico * 0.25) ? (rec.pausaFala || 0) + 0.1 : 0;
        if (estadoGrav() === 'gravando') {
          const st = $('ad-status'); if (st) st.textContent = rec.silencio > 20 ? '⚠ Sem som há mais de 20 s — verifique o microfone e a distância do professor.' : 'Gravando · trechos enviados à IA a cada ~1,5 min';
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
    try { mr = new MediaRecorder(rec.stream, rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 32000 } : undefined); }
    catch (e) { try { mr = new MediaRecorder(rec.stream); } catch (e2) { toast('Não foi possível iniciar a gravação neste navegador.', 'error'); return; } }
    rec.mr = mr; rec.tChunkStart = Date.now();
    mr.ondataavailable = ev => { if (ev.data && ev.data.size) parts.push(ev.data); };
    mr.onstop = () => {
      const blob = new Blob(parts, { type: mr.mimeType || rec.mime || 'audio/webm' });
      if (blob.size > 2000) { const sess = sessAtual; sess.chunks.push({ i: idx, status: 'pendente', texto: '', mime: blob.type, dur: Math.max(0, (Date.now() - rec.tChunkStart) / 1000) }); salvarSess(sess); idbPut(sess.id + ':' + idx, blob).catch(() => {}); if (transcOk) { rec.fila.push({ sess, idx, blob }); bombear(); } }
      // a bola volta a rolar só se a gravação segue ativa (pausa/parada mantêm tudo congelado até a retomada)
      if (rec && rec.parar) finalizarDepois();
      else if (rec && !rec.pausado && !rec.parado) iniciarTrecho();
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
  const duvida = () => marcarTipo('❓');

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

  function finalizar() { // ✅ Encerra a gravação e dispara o processo secundário (revisão → resumo → flashcards)
    if (!rec || rec.parar) return;
    rec.parar = true; rec.pausado = false; rec.parado = false;
    rec.timers.forEach(clearInterval); clearTimeout(rec.tChunk); clearInterval(rec.vad);
    try { rec.sr && rec.sr.stop(); } catch (_) {}
    sessAtual.duracao = Math.round(decorridoMs() / 1000);
    try { if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); else finalizarDepois(); } catch (_) { finalizarDepois(); }
    desenharGravando();
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

  const AUDIO_MAX_BYTES = () => audioUploadDireto ? audioMaxBytes : audioInlineMaxBytes;
  function statusArquivo(texto, estado) {
    const el = $('ad-audio-meta'); if (!el) return;
    el.textContent = texto || ''; el.dataset.state = estado || 'info';
  }
  function erroArquivo(texto) { statusArquivo(texto, 'error'); toast(texto, 'error'); }
  function obterDuracaoAudio(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), el = new Audio(); let terminou = false;
      const limpar = () => { URL.revokeObjectURL(url); el.removeAttribute('src'); };
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
      const sess = { id: 'a' + Date.now(), data: hojeISO(), inicio: Date.now(), disciplina: (($('ad-disc') || {}).value || '').trim(), tema: (($('ad-tema') || {}).value || '').trim(), parte: ($('ad-parte') || {}).value || 'Única', tipoAula: pref.tipoAula, preferenciaMaterial: pref.preferenciaMaterial, duracao: Math.round(duracao), audioBytes: file.size, chunks: [{ i: 0, status: 'pendente', texto: '', mime, duracao }], marcas: [], texto: '', live: '', resultado: null, audioImportado: file.name };
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

  async function enviarAudioParaTranscricao(blob, sess, chunk, anterior) {
    let mime = blob.type || chunk.mime || 'audio/webm';
    if (mime === 'audio/x-wav') mime = 'audio/wav';
    if (mime === 'audio/x-m4a') mime = 'audio/mp4';
    if (mime === 'audio/x-flac') mime = 'audio/flac';
    const contexto = { mime, disciplina: sess.disciplina, tema: (sess.tema + (sess.parte && sess.parte !== 'Única' ? ' — ' + sess.parte : '')).trim(), anterior, glossario: assuntosPlano(sess.disciplina).slice(0, 60), tipoAula: sess.tipoAula || 'expositiva' };
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
      return await fetch('/api/aula/audio/transcrever', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...contexto, path: init.path, duracao: Number(chunk.duracao || chunk.dur) || 0 }) });
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
          c.status = 'ok'; c.texto = j.texto || ''; delete c.erro;
          // segmentos com marca de tempo (Whisper verbose_json) — entram no timeline do karaoke
          c.segs = (Array.isArray(j.segmentos) && j.segmentos.length) ? j.segmentos.map(x => {
            const avg = x.avgLogprob == null ? null : Number(x.avgLogprob), semFala = x.noSpeechProb == null ? null : Number(x.noSpeechProb);
            return { a: Number(x.ini) || 0, b: Number(x.fim) || 0, t: String(x.text || ''), avgLogprob: Number.isFinite(avg) ? avg : null, noSpeechProb: Number.isFinite(semFala) ? semFala : null, baixaConfianca: Number.isFinite(avg) && avg <= -1 || Number.isFinite(semFala) && semFala >= 0.6 };
          }) : null;
          c.dur = null; salvarSess(sess); return; // ⚠ o áudio (blob) PERMANECE no IndexedDB — é o que alimenta o modo karaoke
        }
        if (j.formato && !usarWav) { usarWav = true; continue; }
        ultimoErro = String(j.msg || j.error || ('Falha na transcrição (HTTP ' + r.status + ').')).slice(0, 240);
        if (r.status === 503) break;
      } catch (e) { ultimoErro = e && e.message ? String(e.message).slice(0, 240) : 'Falha de conexão ao transcrever.'; }
      await new Promise(r => setTimeout(r, 1500 * (tent + 1)));
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
    const L = [['rev', 'Revisando a transcrição (termos médicos, emendas, parágrafos)'], ['res', 'Escrevendo o resumo completo ()'], ['fc', 'Criando os flashcards de revisão'], ['mat', 'Montando "cai na prova" e assuntos do plano']];
    const html = L.map(([k, n]) => { const e = estado[k] || ''; return `<div class="ad-step ${e === 'ok' ? 'ok' : e === 'go' ? 'go' : e === 'er' ? 'er' : ''}">${e === 'ok' ? '✔' : e === 'go' ? '⏳' : e === 'er' ? '✖' : '○'} ${n}${estado[k + 'Info'] ? ' — ' + E(estado[k + 'Info']) : ''}</div>`; }).join('');
    htmlPassos = html; const el = $('ad-proc'); if (el && sessAtual === s) el.innerHTML = html;
  }

  async function pipeline(s) {
    if (pipelineRodando) return toast('Já estou processando esta aula.', 'info');
    if (!geminiOk) return toast('Para revisar e resumir é preciso uma chave de IA (Gemini ou Groq) no servidor.', 'warning');
    pipelineRodando = true;
    const est = { rev: s.textoRevisado ? 'ok' : '', res: s.resumoMd ? 'ok' : '', fc: s.flashcards ? 'ok' : '', mat: s.resultado ? 'ok' : '' };
    passos(s, est);
    const ctx = { area: s.disciplina, conteudo: [s.tema, s.parte && s.parte !== 'Única' ? s.parte : ''].filter(Boolean).join(' — '), glossario: assuntosPlano(s.disciplina).slice(0, 60), tipoAula: s.tipoAula || 'expositiva', preferenciaMaterial: s.preferenciaMaterial || 'equilibrado' };
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
        if (!s.mapa) { s.mapa = (await postL('/api/aula/mapa', Object.assign({ transcricao: fonte, parte: s.parte }, ctx))).mapa; await salvarAgora(s); }
      }
      // 2b) Extração única (fase 2): lê a aula UMA vez e deriva fechamento/flashcards/"cai na prova" da base.
      //     Se falhar, segue o caminho antigo (cada etapa relendo a aula) — nada deixa de ser gerado.
      if (!s.base && (!s.fechamento || !s.flashcards || !s.resultado)) {
        try {
          est.res = est.res === 'ok' ? 'ok' : 'go'; est.resInfo = 'extraindo fatos da aula'; passos(s, est);
          s.base = (await postL('/api/aula/extrair', { transcricao: fonte, area: s.disciplina, conteudo: ctx.conteudo, tipoAula: ctx.tipoAula, preferenciaMaterial: ctx.preferenciaMaterial, capitulos: (s.mapa && s.mapa.capitulos) || [], assuntosPlano: assuntosPlano(s.disciplina), marcas: s.marcas, duvidasMarcas: s.duvidasMarcas || [] })).base;
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
      const frentes = [frenteResumo, frenteFlash, frenteMaterial];
      if (N > 1) {
        // allSettled: uma frente que falha não interrompe as outras (o que ficou pronto é salvo); o primeiro erro é relançado no fim
        const rs = await Promise.allSettled(frentes.map(f => f()));
        const falha = rs.find(r => r.status === 'rejected'); if (falha) throw falha.reason;
      } else { for (const f of frentes) await f(); }
      if (sessAtual === s) { abaRes = 'resumo'; desenharResultado(); }
      verificarQualidade(s, true); // sem IA: não atrasa nem pode quebrar o pipeline
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
        box.innerHTML = '<div class="sub">🎙 Os áudios desta aula não estão guardados neste navegador (gravados numa versão anterior ou limpos do armazenamento). Grave uma aula nova para acompanhar no modo karaoke.</div>';
        ak.montando = false; return;
      }
      let off = 0;
      for (const it of plavs) { it.dur = await durDe(it.blob); it.off = off; off += it.dur; }
      ak.pars = plavs; ak.cur = -1; ak.j = 0; ak.chave = ''; ak.el = null;
      let corpo = '';
      plavs.forEach((it, i) => {
        const marc = `Trecho ${it.c.i + 1} · 🎵 de ${mmss(it.off)} a ${mmss(it.off + it.dur)}`;
        const linhas = (it.c.segs && it.c.segs.length)
          ? it.c.segs.map((g, j) => `<div class="ak-line" id="ak-${i}-${j}" onclick="auladia.kVai(${i},${j})"><span class="t">${mmss(it.off + Math.max(0, g.a))}</span>${E(g.t || '—')}</div>`).join('')
          : `<div class="ak-line" id="ak-${i}-0" onclick="auladia.kVai(${i},0)"><span class="t">${mmss(it.off)}</span>${it.c.status === 'ok' ? E(it.c.texto || '') : '<span class="pend">[trecho sem transcrição]</span>'}</div>`;
        corpo += `<div class="ak-chunk"><h5>${E(marc)}</h5>${linhas}</div>`;
      });
      box.innerHTML = `<div class="ak-bar"><audio id="ak-au" controls preload="metadata" style="width:100%"></audio></div>
        <div class="ak-info">${plavs.length} trecho(s) · ${hms(off)} no total · a linha acende conforme o professor fala; toque em qualquer linha para pular para ela 🎤</div>
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
    const tools = `<div class="mm-tools"><button class="b" onclick="auladia.mmZoom(0.75)">−</button><button class="b" onclick="auladia.mmZoom(1.3)">+</button><button class="b" onclick="auladia.mmFit()">⌂ Ajustar</button><button class="b" onclick="auladia.mmTudo(true)">⇲ Fechar ramos</button><button class="b" onclick="auladia.mmTudo(false)">⇱ Abrir tudo</button><button class="b" onclick="auladia.mmPNG()">⬇ PNG</button><button class="b pri" onclick="auladia.mmGerar()"><i class="ph ph-tree-structure"></i> ${s.mindmap ? 'Regenerar (IA)' : 'Gerar (IA)'}</button></div>`;
    box.innerHTML = tools + `<div class="mm-sc"><div class="mm-inner" style="transform:scale(${mm.zoom})"><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg></div></div><div class="sub" style="margin-top:6px">🗺 Toque num nó para fechar/abrir os ramos dele · arraste as barras de rolagem para navegar · ⬇ PNG para imprimir ou colar no caderno.</div>`;
  }

  function mmAceitar(raiz, salvar) { mm.raiz = mmEnxugia(raiz || {}); mm.fech.clear(); mm.zoom = 1; }
  async function mmGerar() {
    const s = sessAtual; if (!s || mmRodando) return;
    if (!geminiOk) return toast('Precisa de IA configurada (Gemini ou Groq) no servidor.', 'warning');
    if (rqRodando || pipelineRodando) return toast('Já estou gerando material para esta aula — aguarde.', 'info');
    mmRodando = true; desenharMindmap();
    try {
      const j = await post('/api/aula/mapa-mental', { transcricao: s.textoRevisado || s.texto || textoPuro(s), area: s.disciplina || '', conteudo: s.tema || '', capitulos: (s.mapa && s.mapa.capitulos) || [], tipoAula: s.tipoAula || 'expositiva', preferenciaMaterial: s.preferenciaMaterial || 'equilibrado' }, 1);
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
  async function regenerar(tipo) {
    const s = sessAtual; if (!s || pipelineRodando || mmRodando || rqRodando) return;
    const campos = { resumo: ['caps', 'fechamento', 'resumoMd'], flashcards: ['flashcards'], material: ['resultado'] }[tipo];
    if (!campos) return;
    arquivarMateriais(s, 'Regeneração: ' + tipo);
    const anteriores = {}; campos.forEach(k => { anteriores[k] = s[k]; delete s[k]; });
    await pipeline(s);
    campos.forEach(k => { if (!s[k] && anteriores[k]) s[k] = anteriores[k]; });
    await salvarAgora(s); desenharResultado();
  }
  function baixarHistorico() {
    if (!sessAtual) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(sessAtual.historico || [], null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'historico-aula.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function desenharResultado() {
    const r = $('ad-root'); const s = sessAtual; if (!r || !s) return;
    const res = s.resultado;
    const tabs = [['transcricao', s.textoRevisado ? 'Transcrição (revisada)' : 'Transcrição']];
    if (s.resumoMd) tabs.push(['resumo', 'Resumo']);
    if (s.flashcards) tabs.push(['flash', 'Flashcards (' + s.flashcards.length + ')']);
    if (res) tabs.push(['prova', 'Cai na prova']);
    if (s.resumoMd || s.flashcards) tabs.push(['qual', '🔎 Qualidade' + (s.qualidade && s.qualidade.flashcards && (s.qualidade.flashcards.comAlerta || (s.qualidade.flashcards.revisaoHumana || []).length) ? ' ⚠' : '')]);
    if (s.textoRevisado || s.texto) tabs.push(['resumo_g', s.resumoGeral ? '📜 Resumo Geral' : '📜 Resumo Geral ✨']);
    if ((s.chunks || []).some(c => Number.isInteger(c.i))) tabs.push(['audio', '🎤 Áudio · karaoke']);
    tabs.push(['mm', '🗺 Mapa mental']);
    if (!tabs.some(t => t[0] === abaRes)) abaRes = tabs[0][0];
    let corpo = '';
    const incertos = (s.chunks || []).flatMap(c => (c.segs || []).filter(x => x.baixaConfianca).map(x => ({ trecho: c.i + 1, ...x })));
    const alertaConfianca = incertos.length ? `<div class="aviso" role="note">⚠ ${incertos.length} segmento(s) sinalizado(s) para revisão por uma heurística de confiança da transcrição. Isso não avalia precisão médica. Confira o áudio, especialmente doses, números e condutas.<ul>${incertos.slice(0, 5).map(x => `<li>[trecho ${x.trecho} · ${mmss(x.a)}–${mmss(x.b)}] ${E(x.t)}</li>`).join('')}${incertos.length > 5 ? `<li>e mais ${incertos.length - 5} segmento(s)</li>` : ''}</ul><button class="b" onclick="auladia.aba('audio')">Ouvir o áudio</button></div>` : '';
    if (abaRes === 'transcricao') corpo = `${alertaConfianca}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><button class="b" id="ad-ed-btn" onclick="auladia.editarTexto()"><i class="ph ph-pencil-simple"></i> Editar transcrição</button>${s.texto && s.textoRevisado ? '<button class="b" onclick="auladia.verOriginal()">Ver original (sem revisão)</button>' : ''}</div><div class="ad-tr" id="ad-tr-txt">${s.textoRevisado ? E(s.textoRevisado).replace(/([⭐❓]) \[(\d\d:\d\d)\]/g, '<span class="mk">$1 [$2]</span>') : textoHtml(s)}</div>`;
    else if (abaRes === 'audio') corpo = `<div id="ak-box"><div class="sub">Montando o player do karaoke…</div></div>`;
    else if (abaRes === 'resumo') corpo = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><button class="b" onclick="auladia.regenerar('resumo')"><i class="ph ph-arrows-clockwise"></i> Regenerar resumo</button></div>${versoesHtml(s, 'resumoMd')}<div class="ad-md" id="ad-md">${mdParaHtml(s.resumoMd)}</div>`;
    else if (abaRes === 'qual') corpo = qualidadeHtml(s);
    else if (abaRes === 'flash') {
      const grupos = {}; (s.flashcards || []).forEach(f => { (grupos[f.tema || 'Geral'] = grupos[f.tema || 'Geral'] || []).push(f); });
      corpo = `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="b pri" onclick="auladia.enviarFlash()"><i class="ph ph-cards"></i> Revisar e adicionar ao Treino</button><button class="b" onclick="auladia.regenerar('flash')"><i class="ph ph-arrows-clockwise"></i> Regenerar cartões</button></div>${versoesHtml(s, 'flashcards')}<div class="sub" style="margin-top:6px">Confira pergunta, resposta e alertas; edite ou remova qualquer cartão antes de aprová-lo para o Treino. As referências de origem apontam para o trecho usado na geração.</div><div style="margin-top:10px">${Object.keys(grupos).map(g => `<div class="grp2">${E(g)}</div>` + grupos[g].map(f => { const i = s.flashcards.indexOf(f); const qi = s.qualidade && s.qualidade.flashcards; const fl = (qi && qi.itens[i] || {}).flags || []; const revisar = qi && (qi.revisaoHumana || []).some(x => x.i === i); const fmt = ({ pergunta: 'Pergunta', mecanismo: 'Mecanismo', comparativo: 'Comparativo', sequencia: 'Sequência', vinheta: 'Vinheta' })[f.formato] || 'Pergunta'; const temOrigem = origemCartaoTexto(s, f); return `<div class="fc"${fl.length || revisar ? ' style="border-color:var(--amber)"' : ''}><div class="sub">${E(fmt)} · ${E(({ facil: 'Fácil', media: 'Média', dificil: 'Difícil' })[f.dificuldade] || 'Média')}</div><b>${E(f.frente)}</b>${E(f.verso)}${fl.length ? `<div class="sub" style="color:var(--amber)">⚠ ${fl.map(E).join(' · ')}</div>` : ''}${revisar ? '<div class="sub" style="color:var(--amber)">🩺 Revisão humana recomendada: confira os pontos clínicos diretamente na aula.</div>' : ''}<div style="margin-top:6px"><button class="b" onclick="auladia.cartaoEditar(${i})">✎ Editar</button> <button class="b" onclick="auladia.cartaoRemover(${i})">✕ Remover</button>${temOrigem ? ` <button class="b" onclick="auladia.verOrigem(${i})">↗ Trecho de origem</button>` : ''}</div></div>`; }).join('')).join('')}</div>`;
    } else if (res && abaRes === 'prova') corpo = `${(res.caiNaProva || []).length ? '<ul>' + res.caiNaProva.map(p => `<li>${E(p)}</li>`).join('') + '</ul>' : '<div class="sub">O professor não indicou explicitamente o que cai na prova.</div>'}${(s.marcas || []).length ? '<h4>Momentos que você marcou</h4><div class="sub">' + s.marcas.map(E).join(' · ') + '</div>' : ''}${(res.assuntosCobertos || []).length ? '<h4>Assuntos do manual abordados nesta aula</h4><ul>' + res.assuntosCobertos.map(a => `<li>${E(a)}</li>`).join('') + '</ul>' : ''}${(() => { const ehAluno = d => /^\s*\[\d\d:\d\d\]/.test(d); const dv = res.duvidas || []; const meus = dv.filter(ehAluno), conf = dv.filter(d => !ehAluno(d));
      return ((s.duvidasMarcas || []).length ? '<h4>❓ Suas dúvidas na aula</h4>' + (meus.length ? '<ul>' + meus.map(d => `<li>${E(d)}</li>`).join('') + '</ul>' : '<div class="sub">' + s.duvidasMarcas.map(E).join(' · ') + '</div>') : '')
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
      : audioComErro ? `<div class="ad-step" role="status" aria-live="polite">⚠ ${E(audioComErro.erro)} O áudio continua salvo; use “Tentar novamente”.</div>` : '';
    const completo = s.resumoMd && s.flashcards && s.resultado;
    r.innerHTML = `<div class="ad"><h2>${E(nomeCompleto(s))}</h2><div class="sub">${E(s.disciplina || '')} › ${E(s.tema || 'sem conteúdo definido')} › ${E(s.parte || 'Única')} · ${E(s.data)} · ${s.audioImportado ? duracaoAudio(s.duracao || 0) : hms(s.duracao || 0)}${s.audioImportado ? ' · ' + E(s.audioImportado) + ' · ' + bytesAudio(s.audioBytes || 0) : ''} · ${E(TIPOS_AULA[s.tipoAula] || s.tipoAula || 'Expositiva')} · material ${E(PROFUNDIDADES[s.preferenciaMaterial] || s.preferenciaMaterial || 'Equilibrado')} · ${palavrasDe(s.textoRevisado || s.texto)} palavras</div>
    <div class="card">${statusAudio}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"><button class="b" onclick="auladia.voltar()"><i class="ph ph-arrow-left"></i> Aulas</button>${geminiOk && !completo ? '<button class="b pri" onclick="auladia.gerar()"><i class="ph ph-sparkle"></i> Gerar / continuar</button>' : ''}${falhas ? `<button class="b" onclick="auladia.reenviar()">Tentar novamente (${falhas})</button>` : ''}<button class="b" onclick="auladia.copiar()">Copiar texto</button><button class="b" onclick="auladia.baixar('transcricao')">⬇ Transcrição .md</button>${s.resumoMd ? '<button class="b" onclick="auladia.baixar(\'resumo\')">⬇ Resumo .md</button>' : ''}${s.resumoGeral ? '<button class="b" onclick="auladia.baixar(\'resumogeral\')">⬇ Resumo Geral .md</button>' : ''}<button class="b" onclick="auladia.baixar('tudo')">⬇ Tudo (NotebookLM)</button></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><button class="b" onclick="auladia.editarTranscricao()">Revisar transcrição</button><button class="b" onclick="auladia.regenerar('resumo')">Refazer resumo</button><button class="b" onclick="auladia.regenerar('flashcards')">Refazer cartões</button><button class="b" onclick="auladia.baixarHistorico()">Baixar histórico</button></div><div id="ad-proc" style="margin:0 0 8px"></div>${cicloHtml(s)}
    <div class="ad-tabs">${tabs.map(([k, n]) => `<button class="b ${abaRes === k ? 'on' : ''}" onclick="auladia.aba('${k}')">${n}</button>`).join('')}</div>${corpo}</div></div>`;
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
        + (r.numerosParaConferir.length ? `<div class="card" style="border-color:var(--amber)"><b>⚠ Números/doses no resumo que não aparecem na transcrição:</b> ${r.numerosParaConferir.map(E).join(' · ')}<div class="sub">Podem ser erro de transcrição, de escrita da IA ou apenas outra forma de falar ("um grama"). Confira no áudio antes de estudar.</div></div>` : '<div class="sub">✔ Todo número com unidade do resumo aparece na transcrição.</div>');
    }
    if (f) {
      h += `<h4>Flashcards</h4><div class="card"><b>${f.comAlerta}</b> de ${f.itens.length} cartões com alerta · <b>${f.duplicatas.length}</b> possíveis duplicatas${f.cobertura ? ' · cobertura estimada dos fatos: <b>' + f.cobertura.percentual + '%</b>' : ''}</div>`;
      if (f.dimensoes && f.dimensoes.length) h += `<div class="card"><b>Indicadores automáticos (heurísticos)</b><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:6px;margin-top:8px">${f.dimensoes.map(d => `<div class="sub">${E(d.nome)}: <b>${d.nota}/10</b></div>`).join('')}</div><div class="sub" style="margin-top:8px">As notas medem apenas regras verificáveis de contexto, concisão, números encontrados na fonte, duplicação provável e referência de origem. Não medem verdade clínica nem substituem a revisão da aula.</div></div>`;
      if ((f.revisaoHumana || []).length) h += `<div class="card" style="border-color:var(--amber)"><b>🩺 Revisão humana recomendada para ${f.revisaoHumana.length} cartão(ões)</b><div class="sub">Valores e unidades, medicamentos, critérios, condutas e vinhetas clínicas merecem conferência explícita na aula antes de estudar. Esse sinal não significa que o cartão esteja errado.</div>${f.revisaoHumana.slice(0, 20).map(x => `<div class="sub">Cartão ${x.i + 1}: ${E(x.motivos.join(' '))}</div>`).join('')}</div>`;
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
    if (regenerarCartoes) { guardarVersao(s, 'flashcards', s.flashcards); s.flashcards = null; s.qualidade = null; }
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
      s.textoRevisado = novo; s.textoEditadoEm = new Date().toISOString(); s.qualidade = null; await salvarAgora(s);
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
    const linha = (ok, txt) => `<div class="ad-step ${ok ? 'ok' : ''}">${ok ? '✔' : '○'} ${txt}</div>`;
    return `<div class="card" id="ad-ciclo" style="margin-bottom:10px"><b>🔁 Fechar o ciclo</b>
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
    gerar() { if (sessAtual) pipeline(sessAtual); }, reenviar: reenviarFalhas, parteAuto: atualizarParteSugerida,
    kVai, fecharCiclo, testar: testarAgora,
    _deveCortar: deveCortar, _chunksProntos: () => (sessAtual && sessAtual.chunks ? sessAtual.chunks.length : 0), _CHUNK: { SOFT: CHUNK_SOFT_MS, HARD: CHUNK_MS }, _pool: pool, _limitador: limitador, _revisoes: revisoesParaPlano, _previa: concluirPrevia,
    editarTranscricao, regenerar, baixarHistorico, importarAudio, salvarPreferencias,
    gerarRQ: gerarResumoGeral,
    mmGerar, mmToggle: mmClique, mmZoom, mmFit, mmTudo, mmPNG,
    ancora(id) { const el = document.getElementById('adh-' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    aba(k) { if (abaRes === 'audio' && k !== 'audio') karaokeParar(true); abaRes = k; desenharResultado(); },
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
