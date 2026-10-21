/* Mentor IA acadêmico — Faculdade + Residência. Evolui a área de planejamento existente (planner-v2.js):
   seções, conferência de cronogramas, ações nas tarefas, perfil acadêmico persistente.
   Regras de negócio ficam no servidor (/api/planner/v3/*); aqui só interface e estado local. */
(function () {
  'use strict';
  const V = '/api/planner/v3';
  const K_PERFIL = 'planner-v3-perfil', K_SEC = 'plv3-sec';
  const I = () => (window.plv2 && window.plv2._i) || null;
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, t) => { try { if (window.toast) window.toast(m, t || 'info'); } catch (_) {} };
  const SECOES = [['visao', 'Visão geral', 'ph-squares-four'], ['faculdade', 'Faculdade', 'ph-graduation-cap'], ['residencia', 'Residência', 'ph-stethoscope'], ['integrado', 'Plano integrado', 'ph-git-merge'],
    ['calendario', 'Calendário de provas', 'ph-calendar-check'], ['hoje', 'Tarefas do dia', 'ph-list-checks'], ['revisoes', 'Revisões e desempenho', 'ph-chart-line-up'], ['perfil', 'Perfil e configurações', 'ph-sliders']];
  const PESOS_ROTULO = { prova: 'Proximidade da prova', desempenho: 'Desempenho (erros em questões)', revisao: 'Tempo desde a última revisão', volume: 'Volume de conteúdo pendente', conteudo: 'Incidência em provas de residência', sinergia: 'Sinergia faculdade ↔ residência', material: 'Material do acervo disponível' };
  const PESOS_PADRAO = { prova: 30, desempenho: 20, revisao: 15, volume: 10, conteudo: 10, sinergia: 10, material: 5 };
  const PERFIL_AC_VAZIO = () => ({ periodo: '', instituicao: '', disciplinas: [], blocoMin: 50, objetivosAcademicos: '', residencia: { especialidade: '', instituicoes: '', provaAlvo: '' }, preferencias: '', pesos: {}, associacoes: [], atualizadoEm: 0 });

  let sec = 'visao';
  try { const s = localStorage.getItem(K_SEC); if (SECOES.some(x => x[0] === s)) sec = s; } catch (_) {}
  let imp = null;         // conferência em andamento
  let ocupado = false;

  /* ───────── estado ───────── */
  const get = (k, d) => { const i = I(); return i ? i.get(k, d) : d; };
  const set = (k, v) => { const i = I(); if (i) i.set(k, v); };
  const plano = () => get('planner-v2-plan', null);
  const chat = () => I().chatState();
  const perfilAc = () => Object.assign(PERFIL_AC_VAZIO(), get(K_PERFIL, null) || {});
  const perfilMotor = () => { const p = plano(); return (p && p.perfil) || (I() && chat().perfil) || {}; };
  const ativa = t => !!t && t.status !== 'cancelado' && t.status !== 'reagendada';
  const hoje = () => I().hoje();

  function salvarPerfilAc(patch) {
    const p = Object.assign(perfilAc(), patch || {}); p.atualizadoEm = Date.now();
    set(K_PERFIL, p); agendarNuvem(); return p;
  }
  let timerNuvem = null;
  function agendarNuvem() { clearTimeout(timerNuvem); timerNuvem = setTimeout(salvarNuvem, 1500); }
  async function salvarNuvem() {
    try {
      const pa = perfilAc(); const pl = plano();
      const r = await fetch(V + '/estado', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: { perfilAcademico: pa, plano: pl || undefined }, atualizado: Date.now() }) });
      const j = await r.json().catch(() => ({}));
      if (j && j.offline) window.__plv3Offline = true;
    } catch (_) { /* segue só com o armazenamento local */ }
  }
  async function carregarNuvem() {
    try {
      const r = await fetch(V + '/estado'); const j = await r.json().catch(() => ({}));
      if (!j || !j.success || !j.dados || !j.dados.estado) return;
      const e = j.dados.estado; let mudou = false;
      const local = perfilAc();
      if (e.perfilAcademico && (e.perfilAcademico.atualizadoEm || 0) > (local.atualizadoEm || 0)) { set(K_PERFIL, Object.assign(PERFIL_AC_VAZIO(), e.perfilAcademico)); mudou = true; }
      if (e.plano && Array.isArray(e.plano.tarefas) && !plano()) { set('planner-v2-plan', e.plano); mudou = true; }
      if (mudou && document.getElementById('plv2-lista')) I().renderPlano();
    } catch (_) {}
  }

  // Desempenho por matéria a partir do histórico de questões do app
  function desempenho() {
    const por = {};
    try {
      if (typeof BANK_ANSWERS === 'undefined' || typeof BANK_QUESTIONS === 'undefined') return por;
      const idx = new Map(BANK_QUESTIONS.map(q => [q.id, q]));
      for (const [id, a] of Object.entries(BANK_ANSWERS || {})) {
        const q = idx.get(id); if (!q) continue;
        for (const k of new Set([q.specialty, q.subspecialty].filter(Boolean))) { const o = por[k] || (por[k] = { acertos: 0, total: 0 }); o.total++; if (a && a.isCorrect) o.acertos++; }
      }
    } catch (_) {}
    return por;
  }
  const ctx = () => { const pa = perfilAc(); return { associacoes: pa.associacoes, desempenho: desempenho(), pesos: pa.pesos, hoje: hoje() }; };
  const slimAssoc = a => ({ id: a.id, status: a.status, confianca: a.confianca, origem: a.origem, fac: a.fac, res: a.res });

  /* ───────── chamadas ao servidor ───────── */
  const post = (rota, corpo) => I().api(V + rota, corpo);
  async function anotar(pl) {
    const j = await post('/integrar', Object.assign({ plano: pl }, ctx()));
    salvarPerfilAc({ associacoes: (j.plano.associacoes || []).map(slimAssoc) });
    return j.plano;
  }
  async function regerar(antigo, perfil, dias, motivo) {
    const j = await post('/replanejar', Object.assign({ plano: Object.assign({}, antigo, { perfil: perfil || antigo.perfil }), dias, motivo: motivo || '' }, ctx()));
    salvarPerfilAc({ associacoes: (j.plano.associacoes || []).map(slimAssoc) });
    return j.plano;
  }
  async function acao(tipo, id, extra) {
    if (ocupado) return; ocupado = true;
    try {
      const j = await post('/acao', Object.assign({ plano: plano(), acao: Object.assign({ tipo, id }, extra || {}) }, ctx()));
      set('planner-v2-plan', j.plano); I().sync(); agendarNuvem();
      if (j.aviso) toast(j.aviso, 'warning');
      else toast({ concluir: 'Tarefa concluída ✅', adiar: 'Tarefa adiada para ' + (j.para ? j.para.split('-').reverse().join('/') : ''), editar: 'Tarefa atualizada', cancelar: 'Tarefa cancelada (fica no histórico)', reabrir: 'Tarefa reaberta' }[tipo] || 'Feito', 'success');
      ocupado = false; I().renderPlano();
    } catch (e) { ocupado = false; toast(e.message, 'error'); }
  }
  async function aplicarPerfil(perfil, motivo) {
    const st = chat(); st.perfil = perfil; set('planner-v2-chat', st);
    if (plano()) await I().gerar({ perfil, motivo });
    else { toast('Perfil atualizado. Gere o cronograma para ver as tarefas.', 'success'); I().renderPlano(); }
  }
  async function editarPerfilMotor(patch) {
    const j = await post('/perfil', { perfil: perfilMotor(), patch });
    return j.perfil;
  }

  /* ───────── CSS ───────── */
  function css() {
    if (document.getElementById('plv3-css')) return;
    const s = document.createElement('style'); s.id = 'plv3-css';
    s.textContent = `
.plv3-nav{display:flex;gap:6px;overflow-x:auto;max-width:1180px;margin:0 auto 14px;padding-bottom:4px}
.plv3-nav button{white-space:nowrap;background:var(--bg-surface);border:1px solid var(--border-muted);color:var(--text-secondary);border-radius:var(--radius-full);padding:7px 13px;font-size:12.5px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.plv3-nav button.on{background:var(--teal-dim);border-color:var(--teal-border);color:var(--teal);font-weight:700}
.plv3{max-width:1180px;margin:0 auto}
.plv3 h2{font-size:18px;margin:0 0 4px;color:var(--text-primary)}
.plv3 .sub{font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;line-height:1.5}
.plv3 .card{background:var(--bg-surface);border:1px solid var(--border-muted);border-radius:12px;padding:14px 16px;margin-bottom:12px}
.plv3 .card{overflow-x:auto}
.plv3 .card h3{margin:0 0 8px;font-size:14px;color:var(--text-primary)}
.plv3 .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.plv3 .b{background:var(--bg-surface);border:1px solid var(--border-muted);color:var(--text-primary);border-radius:var(--radius-md);padding:7px 11px;font-size:12.5px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.plv3 .b:hover{border-color:var(--teal-border);background:var(--teal-dim)}
.plv3 .b.pri{background:var(--teal);color:var(--text-inverse);border-color:var(--teal);font-weight:700}
.plv3 .b:disabled{opacity:.5}
.plv3 input,.plv3 select,.plv3 textarea,.plv3-ov input,.plv3-ov select,.plv3-ov textarea{background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-muted);border-radius:8px;padding:7px 9px;font:inherit;font-size:16px;max-width:100%}
.plv3 label,.plv3-ov label{display:block;font-size:11.5px;color:var(--text-secondary);margin:8px 0 3px}
.plv3 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.plv3 .kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:12px}
.plv3 .kv div{background:var(--bg-surface);border:1px solid var(--border-muted);border-radius:10px;padding:10px 12px}
.plv3 .kv b{display:block;font-size:20px;font-variant-numeric:tabular-nums;color:var(--text-primary)}
.plv3 .kv span{font-size:11px;color:var(--text-muted)}
.plv3 table.l{width:100%;border-collapse:collapse;font-size:13px}
.plv3 table.l th{font-size:11px;text-transform:uppercase;color:var(--text-muted);text-align:left;padding:6px 8px;border-bottom:1px solid var(--border-subtle)}
.plv3 table.l td{padding:7px 8px;border-bottom:1px solid var(--border-subtle);vertical-align:top;color:var(--text-primary)}
.plv3 .muted{color:var(--text-secondary);font-size:12px}
.plv3 .warn{border-color:var(--amber,#d97706)}
.plv3 .bar{height:8px;border-radius:99px;background:var(--bg-hover);overflow:hidden;min-width:80px}.plv3 .bar i{display:block;height:100%;background:var(--rose,#e11d48)}
.plv3 .tag{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:99px;border:1px solid var(--border-muted);color:var(--text-secondary)}
.plv3 .tag.alta{color:var(--green);border-color:var(--green)}.plv3 .tag.media{color:var(--amber,#d97706);border-color:var(--amber,#d97706)}
.plv2-trilha{display:inline-block;font-size:10px;font-weight:800;padding:2px 7px;border-radius:99px;margin:0 0 5px 5px;border:1px solid}
.plv2-trilha.t-faculdade{color:#38bdf8;border-color:#38bdf8}.plv2-trilha.t-residencia{color:#f59e0b;border-color:#f59e0b}.plv2-trilha.t-compartilhada{color:#a78bfa;border-color:#a78bfa}
.plv3-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:14px}
.plv3-ov>div{background:var(--bg-surface,#111);border:1px solid var(--border-muted,#333);border-radius:14px;padding:16px;max-width:860px;width:100%;max-height:92vh;overflow:auto;color:var(--text-primary)}
.plv3-ov h3{margin:0 0 6px}
.plv3-ov table{width:100%;border-collapse:collapse;font-size:13px}.plv3-ov td,.plv3-ov th{padding:5px;border-bottom:1px solid var(--border-subtle);vertical-align:top;text-align:left}
.plv3-ov .alerta{background:var(--bg-elevated);border-left:3px solid var(--amber,#d97706);padding:8px 10px;border-radius:6px;font-size:12.5px;margin:6px 0}
.plv3-ov .b{background:var(--bg-surface);border:1px solid var(--border-muted);color:var(--text-primary);border-radius:8px;padding:7px 11px;font-size:12.5px;cursor:pointer}
.plv3-ov .b.pri{background:var(--teal);color:var(--text-inverse);border-color:var(--teal);font-weight:700}
@media(max-width:820px){.plv3 table.l:not(#plv3-provas) thead{display:none}.plv3 input[type=date]{max-width:150px}}`;
    document.head.appendChild(s);
  }

  /* ───────── navegação ───────── */
  function nav() {
    css(); I().css();
    return `<div class="plv3-nav" role="tablist" aria-label="Seções do Mentor IA">${SECOES.map(([k, n, ic]) => `<button role="tab" aria-selected="${sec === k}" class="${sec === k ? 'on' : ''}" onclick="plv3.ir('${k}')"><i class="ph ${ic}"></i> ${n}</button>`).join('')}</div>`;
  }
  function ir(k) {
    if (!SECOES.some(x => x[0] === k)) return; sec = k;
    try { localStorage.setItem(K_SEC, k); } catch (_) {}
    if (plano()) I().renderPlano(); else I().renderChat();
  }
  const fmtBr = iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '—';
  const diasAte = iso => Math.round((new Date(iso + 'T00:00:00Z') - new Date(hoje() + 'T00:00:00Z')) / 864e5);

  function tabela(ts, vazio) {
    const i = I(); if (!ts.length) return `<div class="plv2-empty">${E(vazio || 'Nada por aqui.')}</div>`;
    const por = {}; ts.forEach(t => (por[t.data] = por[t.data] || []).push(t));
    return Object.keys(por).sort().map(d => { const l = por[d]; const m = l.reduce((a, t) => a + (t.minutos || 0), 0);
      return `<div class="plv2-day"><div class="plv2-dh ${d === hoje() ? 'hoje' : ''}">${E(i.fmtDia(d))}${d === hoje() ? ' · hoje' : ''}<span>${m ? i.fmtMin(m) + ' planejados' : ''}</span></div><table class="plv2-t"><thead><tr><th style="width:23%">Tarefa</th><th style="width:34%">Passo a passo</th><th style="width:23%">Materiais</th><th>Observações</th></tr></thead><tbody>${l.map(i.tarefaRow).join('')}</tbody></table></div>`; }).join('')
      + `<p class="muted">Origem das informações: datas, provas e conteúdos vêm do que <b>você informou</b>; aulas, PDFs e questões vêm do <b>acervo</b>; textos marcados com ✨ foram gerados por <b>IA</b> e podem conter erros — confira nas suas fontes. A IA é apoio ao estudo, não substitui diretrizes nem fontes primárias.</p>`;
  }
  const proximos = (pl, filtro, dias = 14) => { const h = hoje(); const f = new Date(h + 'T00:00:00Z'); f.setUTCDate(f.getUTCDate() + dias); const fim = f.toISOString().slice(0, 10); return pl.tarefas.filter(t => ativa(t) && t.data >= h && t.data < fim && filtro(t)); };

  /* ───────── corpo das seções ───────── */
  function corpo(pl) {
    const f = { faculdade: secFaculdade, residencia: secResidencia, integrado: secIntegrado, calendario: secCalendario, hoje: secHoje, revisoes: secRevisoes, perfil: secPerfil }[sec] || secFaculdade;
    return `<div class="plv3">${f(pl)}</div>`;
  }
  function depois() { /* ganchos pós-render, se necessários */ }

  function secFaculdade(pl) {
    const p = perfilMotor(); const provas = (p.provasFaculdade || []).slice().sort((a, b) => a.data.localeCompare(b.data));
    const ts = proximos(pl, t => t.trilha === 'faculdade' || t.trilha === 'compartilhada');
    return `<h2>Trilha Faculdade</h2><div class="sub">Disciplinas, aulas e provas da graduação. Importe o cronograma, confira o que foi lido e só então ele vira plano.</div>
      <div class="kv"><div><b>${new Set([...(p.provasFaculdade || []).map(x => x.disciplina), ...(p.aulasFaculdade || []).map(x => x.disciplina)]).size}</b><span>disciplinas</span></div><div><b>${provas.length}</b><span>provas com data</span></div><div><b>${(p.aulasFaculdade || []).length}</b><span>aulas/TBLs com data</span></div><div><b>${pl.tarefas.filter(t => ativa(t) && t.trilha === 'faculdade').length}</b><span>tarefas exclusivas</span></div></div>
      <div class="card"><h3>Cronograma da faculdade</h3><div class="row"><button class="b pri" onclick="plv3.importar('faculdade')"><i class="ph ph-upload-simple"></i> Importar e conferir cronograma</button><span class="muted">Texto colado, .txt/.md ou PDF com texto selecionável (imagens e PDF escaneado não são lidos).</span></div>
      ${provas.length ? `<table class="l" style="margin-top:10px"><thead><tr><th>Disciplina</th><th>Prova</th><th>Data</th><th>Assuntos</th></tr></thead><tbody>${provas.map(x => `<tr><td>${E(x.disciplina)}</td><td>${E(x.tipo || 'Prova')}</td><td>${fmtBr(x.data)} <span class="muted">(${diasAte(x.data)} d)</span></td><td class="muted">${(x.assuntos || []).length ? (x.assuntos || []).length + ' assuntos' : '⚠️ sem conteúdo informado'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nenhuma prova cadastrada ainda.</p>'}</div>
      <h3 style="font-size:14px;margin:14px 0 8px">Próximos 14 dias — Faculdade e compartilhadas</h3>${tabela(ts, 'Nenhuma tarefa da faculdade nos próximos 14 dias.')}`;
  }

  function secResidencia(pl) {
    const p = perfilMotor(), pa = perfilAc(); const cr = p.cronogramaResidencia || [];
    const ts = proximos(pl, t => t.trilha === 'residencia' || t.trilha === 'compartilhada');
    return `<h2>Trilha Residência</h2><div class="sub">Preparação para as provas de residência: teoria, questões, revisão de erros, revisão espaçada e simulados.</div>
      <div class="card"><h3>Objetivo</h3><div class="grid"><div><label>Especialidade desejada</label><input id="plv3-esp" value="${E(pa.residencia.especialidade)}" placeholder="Ex.: Clínica Médica"></div><div><label>Instituições de interesse</label><input id="plv3-inst" value="${E(pa.residencia.instituicoes)}" placeholder="Ex.: USP, UNIFESP, ENARE"></div><div><label>Prova-alvo</label><input id="plv3-alvo" value="${E(p.alvo || pa.residencia.provaAlvo)}" placeholder="Ex.: ENARE 2027"></div><div><label>Data da prova</label><input type="date" id="plv3-dprova" value="${E(p.dataProva || '')}"></div></div>
      <div class="row" style="margin-top:10px"><button class="b pri" onclick="plv3.salvarResidencia()"><i class="ph ph-floppy-disk"></i> Salvar objetivo</button><span class="muted">${p.dataProva ? 'Faltam ' + diasAte(p.dataProva) + ' dias.' : 'Sem data definida.'}</span></div></div>
      <div class="card"><h3>Cronograma de preparação</h3><p class="muted" style="margin:0 0 8px">O acervo <b>não</b> tem cronogramas estruturados — tem PDFs de cronograma (Extensivo, turmas, reta final). Escolha um, o texto é lido e você confere antes de virar plano. ${cr.length ? `<b>Atual: ${cr.length} temas com data.</b>` : ''}</p>
      <div class="row"><button class="b pri" onclick="plv3.importar('residencia')"><i class="ph ph-upload-simple"></i> Importar meu cronograma</button><button class="b" onclick="plv3.acervoPdf()"><i class="ph ph-books"></i> Escolher PDF do acervo</button><button class="b" onclick="plv3.importar('residencia',true)"><i class="ph ph-pencil-simple-line"></i> Criar manualmente</button></div></div>
      <h3 style="font-size:14px;margin:14px 0 8px">Próximos 14 dias — Residência e compartilhadas</h3>${tabela(ts, 'Nenhuma tarefa de residência nos próximos 14 dias.')}`;
  }

  function secIntegrado(pl) {
    const at = pl.tarefas.filter(ativa).filter(t => t.tipo !== 'prova'); const c = { faculdade: 0, residencia: 0, compartilhada: 0 }; at.forEach(t => { if (c[t.trilha] != null) c[t.trilha]++; });
    const ig = pl.integracao || { minutosEconomizados: 0, aplicadas: [] }; const as = pl.associacoes || [];
    const lin = a => `<tr><td><b>${E(a.fac.tema)}</b><div class="muted">Faculdade · ${E(a.fac.materia)} · ${fmtBr(a.fac.data)}</div></td><td><b>${E(a.res.tema)}</b><div class="muted">Residência · ${E(a.res.materia)} · ${fmtBr(a.res.data)}</div></td><td><span class="tag ${a.confianca}">${a.confianca === 'alta' ? 'Alta' : 'Média'}${a.origem === 'ia' ? ' · IA' : ''}</span><div class="muted">${a.status === 'confirmada' ? '✅ confirmada' : a.status === 'rejeitada' ? '🚫 rejeitada' : a.confianca === 'alta' ? 'aplicada (sugerida)' : 'aguardando você'}</div></td><td>${a.status !== 'confirmada' ? `<button class="b" onclick="plv3.assoc('${E(a.id)}','confirmada')">Confirmar</button> ` : ''}${a.status !== 'rejeitada' ? `<button class="b" onclick="plv3.assoc('${E(a.id)}','rejeitada')">Rejeitar</button>` : `<button class="b" onclick="plv3.assoc('${E(a.id)}','sugerida')">Desfazer</button>`}</td></tr>`;
    const medias = as.filter(a => a.confianca === 'media' && a.status === 'sugerida' && !a.obsoleta).length;
    return `<h2>Plano integrado</h2><div class="sub">Faculdade e residência no mesmo plano. Quando um assunto aparece nas duas trilhas, a teoria é feita uma vez (sessão compartilhada) e só o que é específico de cada prova fica separado.</div>
      <div class="kv"><div><b>${c.faculdade}</b><span>exclusivas da faculdade</span></div><div><b>${c.residencia}</b><span>exclusivas da residência</span></div><div><b>${c.compartilhada}</b><span>compartilhadas</span></div><div><b>${ig.minutosEconomizados || 0} min</b><span>de teoria repetida evitados</span></div></div>
      <div class="card"><h3>Associações sugeridas — revise</h3><p class="muted" style="margin:0 0 8px">Só temas com termos específicos em comum entram. “Alta” é aplicada automaticamente (você pode rejeitar); “média” só vale depois que você confirma. Palavras parecidas não bastam.</p>
      ${as.length ? `<table class="l"><thead><tr><th>Faculdade</th><th>Residência</th><th>Confiança</th><th></th></tr></thead><tbody>${as.filter(a => !a.obsoleta).map(lin).join('')}</tbody></table>` : '<p class="muted">Nenhum assunto em comum encontrado neste período.</p>'}
      ${medias ? `<div class="row" style="margin-top:8px"><button class="b" onclick="plv3.parecerIA()"><i class="ph ph-sparkle"></i> Pedir parecer da IA sobre ${medias} par(es) de média confiança</button></div>` : ''}</div>
      <h3 style="font-size:14px;margin:14px 0 8px">Próximos 14 dias — tudo junto</h3>${tabela(proximos(pl, () => true), 'Nada agendado nos próximos 14 dias.')}`;
  }

  function secCalendario(pl) {
    const p = perfilMotor(); const provas = (p.provasFaculdade || []).slice().sort((a, b) => a.data.localeCompare(b.data));
    const linha = (x, i) => `<tr data-i="${i}"><td><input class="cd-d" value="${E(x.disciplina)}"></td><td><input class="cd-t" value="${E(x.tipo || 'Prova')}" style="width:90px"></td><td><input class="cd-data" type="date" value="${E(x.data)}"></td><td class="muted">${x.data ? diasAte(x.data) + ' dias' : ''}</td><td><button class="b" onclick="this.closest('tr').remove()" title="Remover"><i class="ph ph-trash"></i></button></td></tr>`;
    return `<h2>Calendário de provas</h2><div class="sub">Provas da faculdade e a prova de residência. Ao salvar, o plano é replanejado daqui para frente, sem perder o que você já fez.</div>
      <div class="card"><h3>Provas da faculdade</h3><div style="overflow-x:auto"><table class="l" id="plv3-provas"><thead><tr><th>Disciplina</th><th>Tipo</th><th>Data</th><th>Faltam</th><th></th></tr></thead><tbody>${provas.map(linha).join('')}</tbody></table></div>
      <div class="row" style="margin-top:8px"><button class="b" onclick="plv3.novaProva()"><i class="ph ph-plus"></i> Adicionar prova</button><button class="b pri" onclick="plv3.salvarProvas()"><i class="ph ph-floppy-disk"></i> Salvar e replanejar</button></div>
      <p class="muted">Os assuntos de cada prova vêm do cronograma importado e são preservados quando a disciplina e a data não mudam.</p></div>
      <div class="card"><h3>Prova de residência</h3><p class="muted" style="margin:0">${p.dataProva ? `${E(p.alvo || 'Prova-alvo')}: <b>${fmtBr(p.dataProva)}</b> (${diasAte(p.dataProva)} dias).` : 'Nenhuma data definida. Defina na seção Residência.'}</p></div>`;
  }

  function secHoje(pl) {
    const h = hoje(); const hojeTs = pl.tarefas.filter(t => ativa(t) && t.data === h);
    const atras = pl.tarefas.filter(t => ativa(t) && t.data < h && t.status !== 'feito' && t.tipo !== 'prova');
    const feitas = hojeTs.filter(t => t.status === 'feito').length;
    return `<h2>Tarefas do dia</h2><div class="sub">Conclua, adie, edite ou cancele. Se o dia saiu do controle, replaneje: o restante do plano é reorganizado e o histórico é mantido.</div>
      <div class="kv"><div><b>${feitas}/${hojeTs.length}</b><span>tarefas de hoje concluídas</span></div><div><b>${atras.length}</b><span>atrasadas</span></div></div>
      <div class="row" style="margin-bottom:10px"><button class="b pri" onclick="plv3.imprevisto()"><i class="ph ph-arrows-clockwise"></i> Tive um imprevisto — replanejar</button></div>
      ${atras.length ? `<h3 style="font-size:14px;margin:6px 0 8px">Atrasadas</h3>${tabela(atras)}` : ''}
      <h3 style="font-size:14px;margin:6px 0 8px">Hoje</h3>${tabela(hojeTs, 'Nada agendado para hoje — dia livre. 🎉')}`;
  }

  function secRevisoes(pl) {
    const des = desempenho(); const linhas = Object.entries(des).filter(([, v]) => v.total >= 5).sort((a, b) => (1 - b[1].acertos / b[1].total) - (1 - a[1].acertos / a[1].total));
    const rev = proximos(pl, t => ['revisao', 'erros', 'simulado'].includes(t.tipo), 21);
    const hist = (pl.historico || []).slice(-12).reverse();
    const nome = { concluir: 'Concluída', reabrir: 'Reaberta', adiar: 'Adiada', editar: 'Editada', cancelar: 'Cancelada', replanejar: 'Replanejamento' };
    return `<h2>Revisões e desempenho</h2><div class="sub">Baseado no seu histórico de questões neste aparelho/conta. Com menos de 5 respostas na matéria, o desempenho é tratado como neutro.</div>
      <div class="card"><h3>Desempenho por matéria</h3>${linhas.length ? `<table class="l"><thead><tr><th>Matéria</th><th>Respostas</th><th>Acerto</th><th>Erro</th></tr></thead><tbody>${linhas.map(([k, v]) => { const er = Math.round((1 - v.acertos / v.total) * 100); return `<tr><td>${E(k)}</td><td>${v.total}</td><td>${100 - er}%</td><td style="min-width:120px"><div class="bar"><i style="width:${er}%"></i></div> <span class="muted">${er}%${er >= 35 ? ' · ⚠️ dificuldade' : ''}</span></td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">Ainda não há respostas suficientes (mínimo de 5 por matéria). Resolva questões no Treino ou nos Simulados.</p>'}</div>
      <div class="card"><h3>Revisões programadas (21 dias)</h3>${rev.length ? tabela(rev) : '<p class="muted">Nenhuma revisão nos próximos 21 dias.</p>'}</div>
      <div class="card"><h3>Histórico recente</h3>${hist.length ? `<table class="l"><tbody>${hist.map(x => `<tr><td class="muted" style="white-space:nowrap">${E((x.ts || '').slice(0, 16).replace('T', ' '))}</td><td>${E(nome[x.acao] || x.acao)}</td><td>${E(x.titulo || x.motivo || '')}${x.para ? ' → ' + fmtBr(x.para) : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sem ações registradas ainda.</p>'}</div>`;
  }

  function secPerfil() {
    const pa = perfilAc(), p = perfilMotor(); const horas = p.horas || [0, 120, 120, 120, 120, 120, 0]; const W = Object.assign({}, PESOS_PADRAO, pa.pesos || {});
    const DS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    return `<h2>Perfil e configurações</h2><div class="sub">Preencha aos poucos — nada aqui é obrigatório. Os dados ficam neste aparelho${window.__plv3Offline ? '' : ' e, quando disponível, na sua conta (sincroniza entre dispositivos)'}.</div>
      <div class="card"><h3>Perfil acadêmico</h3><div class="grid"><div><label>Semestre/período atual</label><input id="pf-periodo" value="${E(pa.periodo)}" placeholder="Ex.: 7º período"></div><div><label>Instituição</label><input id="pf-inst" value="${E(pa.instituicao)}"></div><div><label>Duração preferida dos blocos</label><select id="pf-bloco">${[25, 45, 50, 60, 90].map(m => `<option value="${m}" ${+pa.blocoMin === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></div></div>
      <label>Disciplinas do semestre (separe por vírgula)</label><input id="pf-disc" style="width:100%" value="${E((pa.disciplinas || []).join(', '))}"><label>Objetivos acadêmicos</label><textarea id="pf-obj" rows="2" style="width:100%">${E(pa.objetivosAcademicos)}</textarea><label>Preferências de organização</label><textarea id="pf-pref" rows="2" style="width:100%" placeholder="Ex.: estudo melhor de manhã; plantão às quartas">${E(pa.preferencias)}</textarea></div>
      <div class="card"><h3>Disponibilidade para estudar (minutos por dia)</h3><div class="row">${DS.map((n, i) => `<div><label>${n}</label><input type="number" min="0" max="960" step="5" id="pf-h${i}" value="${+horas[i] || 0}" style="width:80px"></div>`).join('')}</div><p class="muted">O plano respeita esses limites e não preenche todos os horários livres.</p></div>
      <div class="card"><h3>Critérios de prioridade</h3><p class="muted" style="margin:0 0 6px">Heurística de organização do estudo — <b>não é um modelo validado cientificamente</b>. Ajuste os pesos (0–100) ao seu gosto.</p><div class="grid">${Object.keys(PESOS_ROTULO).map(k => `<div><label>${PESOS_ROTULO[k]}</label><input type="number" min="0" max="100" id="pw-${k}" value="${W[k]}" style="width:90px"></div>`).join('')}</div><div class="row" style="margin-top:8px"><button class="b" onclick="plv3.pesosPadrao()">Restaurar padrão</button></div></div>
      <div class="row"><button class="b pri" onclick="plv3.salvarPerfil(false)"><i class="ph ph-floppy-disk"></i> Salvar</button><button class="b" onclick="plv3.salvarPerfil(true)"><i class="ph ph-arrows-clockwise"></i> Salvar e replanejar</button></div>`;
  }

  /* ───────── janelas ───────── */
  function tirarJanela() { const d = document.getElementById('plv3-ov'); if (d) d.remove(); }
  function overlay(html) { tirarJanela(); const d = document.createElement('div'); d.className = 'plv3-ov'; d.id = 'plv3-ov'; d.innerHTML = `<div role="dialog" aria-modal="true">${html}</div>`; d.addEventListener('mousedown', e => { if (e.target === d) fechar(); }); document.body.appendChild(d); css(); return d; }
  function fechar() { tirarJanela(); imp = null; }

  function adiar(id) {
    const t = plano().tarefas.find(x => x.id === id); if (!t) return;
    overlay(`<h3>Adiar tarefa</h3><p class="muted">${E(t.titulo)}</p><button class="b pri" onclick="plv3._adiar('${E(id)}')">Próximo dia com tempo livre</button><label>Ou escolha uma data</label><input type="date" id="plv3-adiar-d" min="${hoje()}"><div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end"><button class="b" onclick="plv3.fechar()">Cancelar</button><button class="b" onclick="plv3._adiar('${E(id)}',true)">Usar esta data</button></div>`);
  }
  function _adiar(id, manual) { const v = (document.getElementById('plv3-adiar-d') || {}).value; if (manual && !v) return toast('Escolha uma data.', 'warning'); fechar(); acao('adiar', id, manual ? { para: v } : {}); }
  function editar(id) {
    const t = plano().tarefas.find(x => x.id === id); if (!t) return;
    overlay(`<h3>Editar tarefa</h3><label>Título</label><input id="ed-t" style="width:100%" value="${E(t.titulo)}"><div class="row"><div><label>Data</label><input type="date" id="ed-d" value="${E(t.data)}"></div><div><label>Minutos</label><input type="number" id="ed-m" min="5" max="480" step="5" value="${+t.minutos || 30}" style="width:90px"></div><div><label>Trilha</label><select id="ed-tr">${['faculdade', 'residencia', 'compartilhada'].map(x => `<option ${t.trilha === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div><label>Observações</label><textarea id="ed-o" rows="3" style="width:100%">${E(t.observacoes || '')}</textarea><div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end"><button class="b" onclick="plv3.fechar()">Cancelar</button><button class="b pri" onclick="plv3._editar('${E(id)}')">Salvar</button></div>`);
  }
  function _editar(id) {
    const v = i => document.getElementById(i).value;
    const campos = { titulo: v('ed-t').trim(), data: v('ed-d'), minutos: parseInt(v('ed-m'), 10), observacoes: v('ed-o'), trilha: v('ed-tr') };
    fechar(); acao('editar', id, { campos });
  }
  function cancelar(id) { const t = plano().tarefas.find(x => x.id === id); if (t && confirm('Cancelar esta tarefa? Ela sai do plano, mas fica no histórico e não volta ao replanejar.\n\n' + t.titulo)) acao('cancelar', id, {}); }
  async function imprevisto() { if (!confirm('Replanejar o restante do plano? Concluídas, canceladas e suas edições são mantidas; tarefas atrasadas voltam ao plano.')) return; await I().gerar({ perfil: perfilMotor(), motivo: 'imprevisto' }); }

  /* ───────── associações ───────── */
  async function assoc(id, status) {
    const pa = perfilAc(); const pl = plano();
    const lista = (pl.associacoes || pa.associacoes || []).map(a => a.id === id ? Object.assign({}, a, { status }) : a);
    salvarPerfilAc({ associacoes: lista.map(slimAssoc) });
    try { const novo = await anotar(pl); set('planner-v2-plan', novo); I().sync(); agendarNuvem(); I().renderPlano(); toast(status === 'confirmada' ? 'Associação confirmada.' : status === 'rejeitada' ? 'Associação rejeitada — tarefas separadas.' : 'Associação restaurada.', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function parecerIA() {
    const pl = plano(); const pares = (pl.associacoes || []).filter(a => a.confianca === 'media' && a.status === 'sugerida');
    toast('Pedindo parecer da IA…', 'info');
    try {
      const j = await post('/refinar-associacoes', { associacoes: pares });
      if (!j.ia) return toast('IA indisponível (configure a GROQ_API_KEY). Revise os pares manualmente.', 'warning');
      let n = 0; const lista = (pl.associacoes || []).map(a => { const v = (j.veredictos || {})[a.id]; if (v && v.equivalente) { n++; return Object.assign({}, a, { confianca: 'alta', origem: 'ia' }); } return a; });
      salvarPerfilAc({ associacoes: lista.map(slimAssoc) });
      const novo = await anotar(Object.assign({}, pl, { associacoes: lista })); set('planner-v2-plan', novo); I().sync(); agendarNuvem(); I().renderPlano();
      toast(n ? `A IA considerou ${n} par(es) equivalente(s). Revise na lista.` : 'A IA não considerou os pares equivalentes; nada foi mesclado.', n ? 'success' : 'info');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ───────── importação com conferência ───────── */
  function importar(trilha, manual) {
    imp = { trilha, rascunho: manual ? (trilha === 'residencia' ? { itens: [{ semana: null, data: '', disciplina: '', tema: '' }] } : { provas: [], aulas: [] }) : null, ambiguidades: [], faltando: [], origem: manual ? 'manual' : '', driveId: '' };
    telaImport();
  }
  function telaImport() {
    const t = imp.trilha; const titulo = t === 'faculdade' ? 'Cronograma da faculdade' : 'Cronograma de residência';
    if (!imp.rascunho) {
      overlay(`<h3>${titulo}</h3><p class="muted">Cole o texto ou envie um arquivo (.txt, .md ou PDF com texto selecionável). Nada é salvo até você conferir e confirmar.</p><textarea id="im-txt" rows="9" style="width:100%" placeholder="${t === 'faculdade' ? '1. Infectologia\\n * 21/10: Sepse e choque séptico\\n * 05/11: Prova PR1' : '21/10: Sepse e choque séptico\\n22/10: Insuficiência cardíaca'}"></textarea><div class="row" style="margin-top:8px"><input type="file" id="im-file" accept=".pdf,.txt,.md,application/pdf,text/plain"></div><div id="im-st" class="muted"></div><div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end"><button class="b" onclick="plv3.fechar()">Cancelar</button><button class="b pri" id="im-ler" onclick="plv3._ler()">Ler cronograma</button></div>`);
      return;
    }
    const r = imp.rascunho; let corpoT = '';
    if (t === 'faculdade') {
      corpoT = `<h4 style="margin:8px 0 4px">Provas (${r.provas.length})</h4><table><thead><tr><th>Disciplina</th><th>Tipo</th><th>Data</th><th>Assuntos (um por linha)</th><th></th></tr></thead><tbody>${r.provas.map((p, i) => `<tr><td><input value="${E(p.disciplina)}" onchange="plv3._imp('provas',${i},'disciplina',this.value)"></td><td><input style="width:70px" value="${E(p.tipo)}" onchange="plv3._imp('provas',${i},'tipo',this.value)"></td><td><input type="date" value="${E(p.data)}" onchange="plv3._imp('provas',${i},'data',this.value)"></td><td><textarea rows="2" onchange="plv3._imp('provas',${i},'assuntos',this.value)">${E((p.assuntos || []).join('\n'))}</textarea></td><td><button class="b" onclick="plv3._impDel('provas',${i})">✕</button></td></tr>`).join('')}</tbody></table><div><button class="b" onclick="plv3._impAdd('provas')">+ prova</button></div>
        <h4 style="margin:10px 0 4px">Aulas com data (${r.aulas.length})</h4><div style="max-height:160px;overflow:auto"><table><tbody>${r.aulas.map((a, i) => `<tr><td>${E(a.disciplina)}</td><td>${fmtBr(a.data)}</td><td>${E(a.tema)}</td><td><button class="b" onclick="plv3._impDel('aulas',${i})">✕</button></td></tr>`).join('')}</tbody></table></div>`;
    } else {
      const semData = r.itens.some(i => !i.data);
      corpoT = `<table><thead><tr><th>Semana</th><th>Data</th><th>Disciplina</th><th>Tema</th><th></th></tr></thead><tbody>${r.itens.map((p, i) => `<tr><td><input type="number" style="width:60px" min="1" max="120" value="${p.semana || ''}" onchange="plv3._imp('itens',${i},'semana',this.value)"></td><td><input type="date" value="${E(p.data || '')}" onchange="plv3._imp('itens',${i},'data',this.value)"></td><td><input value="${E(p.disciplina)}" onchange="plv3._imp('itens',${i},'disciplina',this.value)"></td><td><input style="width:100%" value="${E(p.tema)}" onchange="plv3._imp('itens',${i},'tema',this.value)"></td><td><button class="b" onclick="plv3._impDel('itens',${i})">✕</button></td></tr>`).join('')}</tbody></table><div><button class="b" onclick="plv3._impAdd('itens')">+ tema</button></div>
        ${semData ? `<div class="alerta">Há itens só com semana. Informe a data de início da <b>semana 1</b>: eles serão distribuídos nos dias em que você disse poder estudar.<br><input type="date" id="im-ini1" style="margin-top:4px"></div>` : ''}`;
    }
    const av = (imp.ambiguidades || []).concat(imp.faltando || []).map(a => `<div class="alerta">⚠️ ${E(a.msg)}</div>`).join('');
    overlay(`<h3>Conferir: ${titulo}</h3><p class="muted">Origem: <b>${imp.origem === 'ia' ? 'leitura por IA (pode errar)' : imp.origem === 'manual' ? 'criação manual' : 'leitura automática por regras'}</b>. Corrija o que for preciso e confirme. Só então o plano é atualizado.</p>${imp.aviso ? `<div class="alerta">${E(imp.aviso)}</div>` : ''}${av}${corpoT}<div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button class="b" onclick="plv3.fechar()">Cancelar</button><button class="b" onclick="plv3._reler()">Ler outro</button>${t === 'faculdade' ? '<button class="b" onclick="plv3._confirmar(\'substituir\')">Confirmar (substituir o que existe)</button>' : ''}<button class="b pri" onclick="plv3._confirmar(\'mesclar\')">Confirmar e atualizar plano</button></div>`);
  }
  async function _ler() {
    const st = document.getElementById('im-st'), btn = document.getElementById('im-ler');
    const texto = (document.getElementById('im-txt') || {}).value || ''; const f = ((document.getElementById('im-file') || {}).files || [])[0];
    let corpo = { trilha: imp.trilha, hoje: hoje() };
    try {
      if (imp.driveId) { corpo.driveId = imp.driveId; corpo.nome = imp.driveNome; }
      else if (f) { if (f.size > 18 * 1024 * 1024) return toast('Arquivo muito grande (máx. 18 MB).', 'error'); corpo.base64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = no; r.readAsDataURL(f); }); corpo.mime = f.type; corpo.nome = f.name; }
      else if (texto.trim().length >= 30) corpo.texto = texto; else return toast('Cole o cronograma ou escolha um arquivo.', 'warning');
      btn.disabled = true; st.textContent = 'Lendo… (PDF e IA podem levar até 1 minuto)';
      const j = await post('/conferir', corpo);
      imp.rascunho = j.rascunho; imp.ambiguidades = j.ambiguidades || []; imp.faltando = j.faltando || []; imp.origem = j.origem; imp.aviso = j.aviso;
      if (imp.trilha === 'faculdade' && !imp.rascunho.provas) imp.rascunho = { provas: [], aulas: [] };
      if (imp.trilha === 'residencia' && !(imp.rascunho.itens || []).length && j.origem === 'nenhuma') { st.textContent = ''; btn.disabled = false; return toast((imp.ambiguidades[0] || {}).msg || 'Não consegui ler este formato.', 'warning'); }
      telaImport();
    } catch (e) { if (btn) btn.disabled = false; if (st) st.textContent = ''; toast('Não consegui ler: ' + e.message, 'error'); }
  }
  function _reler() { const t = imp.trilha; imp = { trilha: t, rascunho: null, ambiguidades: [], faltando: [] }; telaImport(); }
  function _imp(lista, i, campo, v) {
    const r = imp.rascunho[lista][i]; if (!r) return;
    if (campo === 'assuntos') r.assuntos = String(v).split(/\n/).map(x => x.trim()).filter(Boolean);
    else if (campo === 'semana') r.semana = parseInt(v, 10) || null; else r[campo] = v;
  }
  function _impDel(lista, i) { imp.rascunho[lista].splice(i, 1); telaImport(); }
  function _impAdd(lista) { imp.rascunho[lista].push(lista === 'provas' ? { disciplina: '', tipo: 'Prova', data: '', assuntos: [] } : { semana: null, data: '', disciplina: '', tema: '' }); telaImport(); }
  async function _confirmar(modo) {
    try {
      let j;
      if (imp.trilha === 'faculdade') j = await post('/confirmar-faculdade', { rascunho: imp.rascunho, perfil: perfilMotor(), modo, hoje: hoje() });
      else {
        const ini = (document.getElementById('im-ini1') || {}).value;
        j = await post('/confirmar-residencia', { itens: imp.rascunho.itens, inicioSemana1: ini || undefined, perfil: perfilMotor(), dataProva: perfilMotor().dataProva || undefined, alvo: perfilMotor().alvo || undefined });
      }
      const resumo = j.resumo || {}; fechar();
      toast('Cronograma confirmado' + (resumo.provas != null ? `: ${resumo.provas} provas, ${resumo.aulas} aulas.` : resumo.itens != null ? `: ${resumo.itens} temas.` : '.'), 'success');
      await aplicarPerfil(j.perfil, 'importação de cronograma');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function acervoPdf() {
    try {
      const r = await fetch(V + '/acervo-cronogramas'); const j = await r.json(); const it = j.itens || [];
      overlay(`<h3>PDFs de cronograma no acervo</h3><p class="muted">São PDFs (não dados estruturados). O texto é extraído e você confere o resultado antes de virar plano. Leitura de PDFs de tabela pode ser imperfeita.</p>${it.length ? `<div style="max-height:50vh;overflow:auto">${it.map(x => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--border-subtle)"><div style="flex:1"><b>${E(x.nome)}</b><div class="muted">${E(x.curso)} · ${E(x.pasta)}</div></div><button class="b" onclick="plv3._pdf('${E(x.id)}','${E(x.nome).replace(/'/g, '')}')">Usar</button></div>`).join('')}</div>` : '<p class="muted">Nenhum PDF de cronograma encontrado no catálogo atual.</p>'}<div style="margin-top:10px;text-align:right"><button class="b" onclick="plv3.fechar()">Fechar</button></div>`);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function _pdf(id, nome) {
    imp = { trilha: 'residencia', rascunho: null, ambiguidades: [], faltando: [], driveId: id, driveNome: nome };
    overlay(`<h3>Lendo “${E(nome)}”…</h3><p class="muted">Baixando o PDF e extraindo o texto. Pode levar até 1 minuto.</p>`);
    try {
      const j = await post('/conferir', { trilha: 'residencia', driveId: id, nome, hoje: hoje() });
      imp.rascunho = j.rascunho; imp.ambiguidades = j.ambiguidades || []; imp.faltando = j.faltando || []; imp.origem = j.origem; imp.aviso = j.aviso; imp.driveId = '';
      if (!(imp.rascunho.itens || []).length) { fechar(); return toast((imp.ambiguidades && imp.ambiguidades[0] && imp.ambiguidades[0].msg) || 'Não consegui extrair temas deste PDF. Cole o texto manualmente.', 'warning'); }
      telaImport();
    } catch (e) { fechar(); toast('Não consegui ler o PDF: ' + e.message, 'error'); }
  }

  /* ───────── formulários ───────── */
  async function salvarResidencia() {
    const v = i => (document.getElementById(i) || {}).value || '';
    const pa = perfilAc();
    salvarPerfilAc({ residencia: Object.assign({}, pa.residencia, { especialidade: v('plv3-esp').trim(), instituicoes: v('plv3-inst').trim(), provaAlvo: v('plv3-alvo').trim() }) });
    try {
      const patch = { alvo: v('plv3-alvo').trim() || undefined }; if (v('plv3-dprova')) patch.dataProva = v('plv3-dprova');
      const base = perfilMotor(); if (base.objetivo === 'graduacao') patch.objetivo = 'ambos'; else if (!base.objetivo) patch.objetivo = 'residencia';
      await aplicarPerfil(await editarPerfilMotor(patch), 'objetivo de residência');
    } catch (e) { toast(e.message, 'error'); }
  }
  function novaProva() { const tb = document.querySelector('#plv3-provas tbody'); if (!tb) return; const tr = document.createElement('tr'); tr.innerHTML = '<td><input class="cd-d"></td><td><input class="cd-t" value="Prova" style="width:90px"></td><td><input class="cd-data" type="date"></td><td></td><td><button class="b" onclick="this.closest(\'tr\').remove()"><i class="ph ph-trash"></i></button></td>'; tb.appendChild(tr); }
  async function salvarProvas() {
    const antigas = perfilMotor().provasFaculdade || [];
    const linhas = [...document.querySelectorAll('#plv3-provas tbody tr')].map(tr => ({ disciplina: tr.querySelector('.cd-d').value.trim(), tipo: tr.querySelector('.cd-t').value.trim() || 'Prova', data: tr.querySelector('.cd-data').value })).filter(x => x.disciplina && x.data);
    const provas = linhas.map(x => { const a = antigas.find(o => o.disciplina.toLowerCase() === x.disciplina.toLowerCase() && (o.data === x.data || (o.tipo || '') === x.tipo)); return Object.assign({}, x, { assuntos: a ? a.assuntos || [] : [] }); });
    try { const perfil = await editarPerfilMotor({ provasFaculdade: provas }); toast('Provas salvas. Replanejando…', 'success'); await aplicarPerfil(perfil, 'ajuste do calendário de provas'); }
    catch (e) { toast(e.message, 'error'); }
  }
  function pesosPadrao() { salvarPerfilAc({ pesos: {} }); I().renderPlano(); toast('Pesos restaurados ao padrão.', 'success'); }
  async function salvarPerfil(replan) {
    const v = i => (document.getElementById(i) || {}).value || '';
    const pesos = {}; Object.keys(PESOS_ROTULO).forEach(k => { const n = parseFloat(v('pw-' + k)); if (Number.isFinite(n) && n >= 0 && n <= 100 && n !== PESOS_PADRAO[k]) pesos[k] = n; });
    salvarPerfilAc({ periodo: v('pf-periodo').trim(), instituicao: v('pf-inst').trim(), blocoMin: parseInt(v('pf-bloco'), 10) || 50, disciplinas: v('pf-disc').split(',').map(x => x.trim()).filter(Boolean).slice(0, 30), objetivosAcademicos: v('pf-obj').trim(), preferencias: v('pf-pref').trim(), pesos });
    const horas = [0, 1, 2, 3, 4, 5, 6].map(i => Math.max(0, Math.min(960, parseInt(v('pf-h' + i), 10) || 0)));
    try {
      const atual = perfilMotor().horas || [];
      const mudouHoras = horas.some((h, i) => h !== (atual[i] || 0)) && horas.some(h => h > 0);
      if (mudouHoras) { const perfil = await editarPerfilMotor({ horas }); const st = chat(); st.perfil = perfil; set('planner-v2-chat', st); if (replan && plano()) return aplicarPerfil(perfil, 'nova disponibilidade'); }
      if (replan && plano()) { const novo = await anotar(plano()); set('planner-v2-plan', novo); I().sync(); }
      toast('Perfil salvo' + (replan ? ' e plano recalculado' : '') + '.', 'success'); I().renderPlano();
    } catch (e) { toast(e.message, 'error'); }
  }

  window.plv3 = { nav, ir, corpo, depois, secao: () => sec, anotar, regerar, acao, adiar, _adiar, editar, _editar, cancelar, imprevisto, assoc, parecerIA, importar, _ler, _reler, _imp, _impDel, _impAdd, _confirmar, acervoPdf, _pdf, fechar, salvarResidencia, novaProva, salvarProvas, pesosPadrao, salvarPerfil, salvarNuvem, agendar: agendarNuvem, carregarNuvem, desempenho, perfilAc };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('plv3-ov')) fechar(); });
  setTimeout(() => { try { if (localStorage.getItem('cuscuz_token')) carregarNuvem(); } catch (_) {} }, 2500);
})();
