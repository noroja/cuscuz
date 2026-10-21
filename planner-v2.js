/* Planejador v2 — chat adaptativo + cronograma em tabela (Tarefa | Passo a passo | Materiais | Observações) */
(function () {
  'use strict';
  const K_PLAN = 'planner-v2-plan', K_CHAT = 'planner-v2-chat';
  const legacyRender = typeof window.renderPlannerIA === 'function' ? window.renderPlannerIA : null;
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = () => document.getElementById('planner-ia-root');
  const get = (k, d) => {
    try {
      if (typeof window !== 'undefined' && typeof window.lsGet === 'function') return window.lsGet(k, d);
      const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v;
    } catch (_) { return d; }
  };
  const set = (k, v) => {
    try {
      if (typeof window !== 'undefined' && typeof window.lsSet === 'function') { window.lsSet(k, v); return; }
      localStorage.setItem(k, JSON.stringify(v));
    } catch (_) { if (window.toast) toast('Armazenamento cheio — exporte um backup', 'error'); }
  };
  const rem = (k) => {
    try {
      if (typeof window !== 'undefined' && typeof window.lsRemove === 'function') { window.lsRemove(k); return; }
      localStorage.removeItem(k);
    } catch (_) {}
  };
  const sync = () => { try { if (typeof pushCloud === 'function') pushCloud(); } catch (_) {} try { if (window.plv3 && plv3.agendar) plv3.agendar(); } catch (_) {} };
  const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
  const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const fmtDia = iso => { const d = new Date(iso + 'T00:00:00Z'); return DIAS[d.getUTCDay()] + ', ' + iso.slice(8, 10) + '/' + iso.slice(5, 7); };
  const fmtBr = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  const fmtMin = m => m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? String(m % 60).padStart(2, '0') : '') : m + ' min';
  const ICON = { aula: 'ph-video-camera', resumo: 'ph-notebook', questoes: 'ph-list-checks', flashcards: 'ph-cards', erros: 'ph-warning-circle', simulado: 'ph-timer', prova: 'ph-flag' };
  const NOME = { aula: 'Aula', resumo: 'Resumo', questoes: 'Questões', flashcards: 'Flashcards', erros: 'Erros', simulado: 'Simulado', prova: 'Prova' };
  const COR = { estudo: 'var(--teal)', revisao: 'var(--violet)', simulado: 'var(--amber)', erros: 'var(--rose)', prova: 'var(--rose)' };
  const ativa = t => !!t && t.status !== 'cancelado' && t.status !== 'reagendada';
  let tab = 'hoje', busy = false;

  function css() {
    if (document.getElementById('plv2-css')) return;
    const s = document.createElement('style'); s.id = 'plv2-css';
    s.textContent = `
.plv2{max-width:1180px;margin:0 auto}
.plv2-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:14px}
.plv2-bar h2{margin:0;font-size:20px;color:var(--text-primary)}
.plv2-sub{font-size:12px;color:var(--text-secondary)}
.plv2-btns{display:flex;flex-wrap:wrap;gap:6px}
.plv2 .b{background:var(--bg-surface);border:1px solid var(--border-muted);color:var(--text-primary);border-radius:var(--radius-md);padding:7px 11px;font-size:12.5px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.plv2 .b:hover{border-color:var(--teal-border);background:var(--teal-dim)}
.plv2 .b.pri{background:var(--teal);color:var(--text-inverse);border-color:var(--teal);font-weight:700}
.plv2 .b:disabled{opacity:.5;cursor:default}
.plv2-chat{background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);display:flex;flex-direction:column;min-height:60vh;max-height:78vh}
.plv2-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.plv2-m{max-width:86%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.plv2-m.bot{background:var(--bg-elevated);border:1px solid var(--border-subtle);align-self:flex-start;color:var(--text-primary)}
.plv2-m.me{background:var(--teal-dim);border:1px solid var(--teal-border);align-self:flex-end;color:var(--text-primary)}
.plv2-q{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 8px}
.plv2-q button{background:transparent;border:1px solid var(--teal-border);color:var(--teal);border-radius:var(--radius-full);padding:6px 12px;font-size:12.5px;cursor:pointer}
.plv2-q button:hover{background:var(--teal-dim)}
.plv2-in{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--border-subtle)}
.plv2-in textarea{flex:1;resize:none;background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-muted);border-radius:var(--radius-md);padding:9px 11px;font:inherit;font-size:16px;min-height:42px;max-height:120px}
.plv2-sum{margin:0 16px 10px;padding:10px 12px;background:var(--bg-base);border:1px dashed var(--teal-border);border-radius:var(--radius-md);font-size:12.5px;color:var(--text-secondary)}
.plv2-sum li{margin:2px 0}
.plv2-tabs{display:flex;gap:6px;margin-bottom:12px;overflow-x:auto}
.plv2-tabs button{white-space:nowrap}
.plv2-tabs .on{background:var(--teal-dim);border-color:var(--teal-border);color:var(--teal)}
.plv2-day{margin-bottom:18px}
.plv2-dh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:8px 12px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-md) var(--radius-md) 0 0;font-weight:700;font-size:14px;color:var(--text-primary);text-transform:capitalize}
.plv2-dh span{font-weight:500;font-size:12px;color:var(--text-secondary);text-transform:none}
.plv2-dh.hoje{border-color:var(--teal-border);color:var(--teal)}
.plv2-t{width:100%;border-collapse:collapse;background:var(--bg-surface);border:1px solid var(--border-subtle)}
.plv2-t th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);text-align:left;padding:7px 10px;border-bottom:1px solid var(--border-subtle);background:var(--bg-base)}
.plv2-t td{vertical-align:top;padding:10px;border-bottom:1px solid var(--border-subtle);font-size:13px;color:var(--text-primary);line-height:1.5}
.plv2-t tr.feito td{opacity:.5}
.plv2-t .tt{font-weight:700;font-size:13.5px}
.plv2-t .mt{font-size:11.5px;color:var(--text-secondary);margin-top:3px}
.plv2-pill{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:99px;border:1px solid;margin-bottom:5px}
.plv2-st{display:flex;gap:7px;margin-bottom:8px}
.plv2-st i{font-size:16px;margin-top:2px;color:var(--teal);flex:none}
.plv2-st b{font-size:12px;color:var(--text-secondary)}
.plv2-rec{display:flex;gap:6px;align-items:center;width:100%;text-align:left;background:var(--bg-base);border:1px solid var(--border-muted);color:var(--text-primary);border-radius:var(--radius-sm);padding:6px 8px;margin-bottom:5px;font-size:12px;cursor:pointer}
.plv2-rec:hover{border-color:var(--teal-border);background:var(--teal-dim)}
.plv2-rec span{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.plv2-obs{font-size:12px;color:var(--text-secondary)}
.plv2-done{margin-top:8px}
.plv2-empty{padding:30px;text-align:center;color:var(--text-secondary);background:var(--bg-surface);border:1px dashed var(--border-muted);border-radius:var(--radius-lg)}
.plv2-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.plv2-chips em{font-style:normal;font-size:10.5px;color:var(--text-secondary);border:1px solid var(--border-muted);border-radius:99px;padding:1px 7px}
.plv2-overview{max-width:1180px;margin:0 auto 20px}
.plv2-overview-head{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap;margin:4px 0 14px}
.plv2-overview-head h1,.plv2-overview-head h2{margin:0 0 6px;font-size:clamp(24px,2.4vw,32px);line-height:1.12;letter-spacing:-.045em;color:var(--text-primary)}
.plv2-overview-head p{margin:0;color:var(--text-secondary);font-size:13px;line-height:1.5}
.plv2-mode{display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:5px 9px;border:1px solid var(--teal-border);border-radius:8px;background:var(--teal-dim);color:var(--teal);font-size:11px;font-weight:700}
.plv2-start{min-height:44px;padding:0 16px;border:0;border-radius:10px;background:linear-gradient(105deg,#00a389,#0e6b5f);color:#fff;font-size:13px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:transform .15s ease,filter .15s ease}
.plv2-start:hover{transform:translateY(-1px);filter:brightness(1.06)}
.plv2-today{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,.34fr);background:var(--bg-surface);border:1px solid var(--border-muted);border-radius:16px;overflow:hidden;margin-bottom:12px}
.plv2-today-main{padding:21px 23px;min-width:0}
.plv2-eyebrow{display:flex;align-items:center;gap:7px;margin-bottom:9px;color:var(--teal);font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.plv2-today-main h2{margin:0 0 5px;font-size:clamp(21px,2.1vw,27px);line-height:1.18;letter-spacing:-.035em;color:var(--text-primary)}
.plv2-today-date{color:var(--text-secondary);font-size:12.5px;text-transform:capitalize}
.plv2-today-focus{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-top:19px;padding-top:16px;border-top:1px solid var(--border-subtle)}
.plv2-today-topic{font-size:17px;font-weight:750;line-height:1.35;color:var(--text-primary)}
.plv2-today-copy{margin:5px 0 0;color:var(--text-secondary);font-size:12.5px;line-height:1.55;max-width:62ch}
.plv2-flow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:15px;color:var(--text-secondary);font-size:10.5px;font-weight:650}
.plv2-flow span{display:inline-flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--border-subtle);border-radius:7px;background:var(--bg-elevated)}
.plv2-flow i{color:var(--teal)}
.plv2-today-side{padding:20px;background:var(--bg-elevated);border-left:1px solid var(--border-subtle);display:flex;flex-direction:column;justify-content:center}
.plv2-progress-label{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;color:var(--text-primary);font-size:12px;font-weight:700}
.plv2-progress-label span:last-child{color:var(--teal);font-variant-numeric:tabular-nums}
.plv2-progress{height:7px;border-radius:99px;background:var(--bg-hover);overflow:hidden}
.plv2-progress span{display:block;height:100%;border-radius:inherit;background:var(--teal);transition:width .25s ease}
.plv2-today-stats{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:15px}
.plv2-today-stat{padding-top:9px;border-top:1px solid var(--border-subtle)}
.plv2-today-stat b{display:block;font-size:17px;font-variant-numeric:tabular-nums;color:var(--text-primary)}
.plv2-today-stat span{font-size:10.5px;color:var(--text-muted)}
.plv2-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-bottom:12px}
.plv2-kpi{min-width:0;padding:12px 14px;background:var(--bg-surface);border:1px solid var(--border-muted);border-radius:11px}
.plv2-kpi b{display:block;overflow:hidden;text-overflow:ellipsis;font-size:19px;line-height:1.25;font-variant-numeric:tabular-nums;color:var(--text-primary)}
.plv2-kpi span{display:block;margin-top:4px;color:var(--text-muted);font-size:10.5px;line-height:1.4}
.plv2-week{padding:15px 17px;background:var(--bg-surface);border:1px solid var(--border-muted);border-radius:13px}
.plv2-week h2{display:flex;align-items:center;gap:8px;margin:0 0 9px;font-size:14px;color:var(--text-primary)}
.plv2-week h2 i{color:var(--teal)}
.plv2-week-empty{display:flex;gap:10px;padding:12px;border-radius:9px;background:var(--bg-elevated);color:var(--text-secondary);font-size:12px;line-height:1.5}
.plv2-week-empty>i{flex:none;margin-top:2px;color:var(--teal);font-size:17px}
.plv2-week-empty b{display:block;margin-bottom:2px;color:var(--text-primary)}
.plv2-week-list{display:grid;gap:5px}
.plv2-week-row{width:100%;display:grid;grid-template-columns:64px minmax(0,1fr) auto;align-items:center;gap:9px;text-align:left;padding:8px 10px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--bg-elevated);color:var(--text-primary);font:inherit;cursor:pointer}
.plv2-week-row:hover{border-color:var(--teal-border);background:var(--teal-dim)}
.plv2-week-row.done .plv2-week-topic{text-decoration:line-through;opacity:.65}
.plv2-week-date{color:var(--text-muted);font-size:10.5px;font-variant-numeric:tabular-nums}
.plv2-week-topic{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:650}
.plv2-week-row i{color:var(--teal)}
.plv2-overview+.plv2{scroll-margin-top:18px}
@media(max-width:820px){
 .plv2-t thead{display:none}
 .plv2-t,.plv2-t tbody,.plv2-t tr,.plv2-t td{display:block;width:100%}
 .plv2-t tr{border-bottom:6px solid var(--bg-void)}
 .plv2-t td{border-bottom:0;padding:8px 12px}
 .plv2-t td::before{content:attr(data-l);display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:4px}
 .plv2-m{max-width:94%}
 .plv2-today{grid-template-columns:1fr}
 .plv2-today-side{border-left:0;border-top:1px solid var(--border-subtle);padding:15px 18px}
 .plv2-today-main{padding:18px}
 .plv2-today-focus{align-items:stretch;flex-direction:column}
 .plv2-start{width:100%}
 .plv2-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
}`;
    document.head.appendChild(s);
  }

  async function api(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json' },
      body: JSON.stringify(body)
    });
    const ct = String(r.headers.get('content-type') || '');
    let j = {};
    if (ct.includes('text/event-stream') && r.body && r.body.getReader) {
      // A rota manteve a conexão aberta com keep-alives e mandou o JSON final em event: result
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let corte;
        while ((corte = buf.indexOf('\n\n')) >= 0) {
          const bloco = buf.slice(0, corte);
          buf = buf.slice(corte + 2);
          const dados = bloco.split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim())
            .join('\n');
          if (!dados) continue;
          try {
            const obj = JSON.parse(dados);
            if (obj && typeof obj === 'object') j = obj;
          } catch (_) { /* ignora fragmento incompleto */ }
        }
      }
    } else {
      j = await r.json().catch(() => ({}));
    }
    if (!r.ok || j.success === false) throw new Error(j.msg || j.error || ('Erro ' + r.status));
    return j;
  }

  /* ───────────── Chat ───────────── */
  const chatState = () => get(K_CHAT, { msgs: [], perfil: null, asking: '', jaExtras: false, quick: [], pronto: false, resumo: [] });

  function renderOverview(st, plano) {
    const h = hoje();
    const hasPlan = !!(plano && Array.isArray(plano.tarefas));
    const perfil = (plano && plano.perfil) || st.perfil || {};
    const tarefas = plano && Array.isArray(plano.tarefas) ? plano.tarefas.filter(ativa) : [];
    const doDia = tarefas.filter(t => t.data === h);
    const feitas = doDia.filter(t => t.status === 'feito').length;
    const pendentes = doDia.filter(t => t.status !== 'feito' && t.tipo !== 'prova');
    const proxima = pendentes[0] || doDia.find(t => t.tipo === 'prova');
    const total = tarefas.filter(t => t.tipo !== 'prova').length;
    const concluidas = tarefas.filter(t => t.tipo !== 'prova' && t.status === 'feito').length;
    const percentual = doDia.length ? Math.round(feitas / doDia.length * 100) : 0;
    const minutos = pendentes.reduce((sum, t) => sum + (Number(t.minutos) || 0), 0);
    const fimSemana = new Date(h + 'T00:00:00Z'); fimSemana.setUTCDate(fimSemana.getUTCDate() + 7);
    const semana = tarefas.filter(t => t.data >= h && t.data < fimSemana.toISOString().slice(0, 10) && t.tipo !== 'prova').sort((a, b) => a.data.localeCompare(b.data));
    const objetivo = ({ graduacao: 'Foco na graduação', residencia: 'Foco na residência', ambos: 'Graduação + residência' })[perfil.objetivo] || 'Objetivo a definir';
    const dataProva = perfil.dataProva ? perfil.dataProva.split('-').reverse().slice(0, 2).join('/') : '—';
    const hojeLongo = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(h + 'T12:00:00'));
    const nome = (document.getElementById('sidebar-user-name')?.textContent || '').trim().split(/\s+/)[0];
    const titulo = hasPlan ? (proxima ? proxima.titulo : doDia.length ? 'Seu dia está em dia.' : 'Um dia com espaço para você.') : 'Uma rotina possível. Um passo de cada vez.';
    const copy = hasPlan ? (proxima ? 'Siga os passos e os materiais da próxima tarefa do seu cronograma.' : 'Confira os próximos dias ou ajuste seu plano com o Mentor.') : 'Seu tempo, suas provas e seu acervo. O Mentor reúne tudo para montar uma semana que faz sentido para você.';
    const cta = hasPlan ? (proxima ? 'Continuar meu estudo' : 'Ver minha semana') : 'Montar meu plano';
    const acao = hasPlan ? (proxima ? "onclick=\"plv2.irParaLista('hoje')\"" : "onclick=\"plv2.irParaLista('semana')\"") : 'id="plv2-start"';
    const semanaHtml = semana.length
      ? '<div class="plv2-week-list">' + semana.slice(0, 5).map(t => '<button type="button" class="plv2-week-row ' + (t.status === 'feito' ? 'done' : '') + '" onclick="plv2.irParaLista(\'semana\')"><span class="plv2-week-date">' + E(t.data.slice(8, 10) + '/' + t.data.slice(5, 7)) + '</span><span class="plv2-week-topic">' + E(t.titulo) + '</span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></button>').join('') + '</div>'
      : '<div class="study-week-empty"><i class="ph ph-calendar-blank" aria-hidden="true"></i><div><b>Sua semana começa com um plano.</b><p>' + (hasPlan ? 'Não há tarefas nos próximos sete dias. Ajuste o período no cronograma.' : 'Defina seu objetivo e os horários disponíveis. Seus blocos de estudo aparecem aqui.') + '</p></div></div>';
    const metric = (label, value, note) => '<div class="plv2-kpi"><span>' + label + '</span><b>' + value + '</b><small>' + note + '</small></div>';
    return '<section class="plv2-overview" aria-labelledby="plv2-overview-title">' +
      '<header class="plv2-overview-head"><div><h2 id="plv2-overview-title">' + (nome ? 'Seu próximo passo, ' + E(nome) + '.' : 'Seu próximo passo.') + '</h2><p>' + E(hojeLongo) + ' <span aria-hidden="true">·</span> ' + E(objetivo) + '</p></div><button class="study-text-action" type="button" onclick="go(\'view-calendario\')">Ver calendário <i class="ph ph-arrow-up-right" aria-hidden="true"></i></button></header>' +
      '<div class="plv2-kpis"' + (hasPlan ? '' : ' hidden') + '>' + metric('Hoje', hasPlan ? doDia.filter(t => t.tipo !== 'prova').length : '—', hasPlan ? 'tarefas no seu ritmo' : 'a definir com você') + metric('Concluídas', hasPlan ? concluidas : '—', 'no cronograma completo') + metric('Revisões', hasPlan ? tarefas.filter(t => t.tipo === 'revisao').length : '—', 'programadas no plano') + metric('Próxima prova', E(dataProva), perfil.dataProva ? 'data cadastrada por você' : 'nenhuma data cadastrada') + '</div>' +
      '<div class="study-grid"><section class="plv2-today" aria-label="Seu próximo estudo"><div class="plv2-today-main"><div class="plv2-eyebrow"><span class="study-dot" aria-hidden="true"></span> ' + (hasPlan ? 'Seu plano de hoje' : 'Seu ponto de partida') + '</div><h3>' + E(titulo) + '</h3><p class="plv2-today-copy">' + copy + '</p><button type="button" class="plv2-start" ' + acao + '>' + cta + ' <i class="ph ph-arrow-right" aria-hidden="true"></i></button><div class="study-session-note">' + (hasPlan ? (doDia.length ? feitas + ' de ' + doDia.length + ' tarefas concluídas hoje' : 'Sem tarefas para hoje') : 'Comece pelo seu objetivo. O resto, organizamos juntos.') + '</div></div></section>' +
      '<aside class="study-cycle" aria-labelledby="study-cycle-title"><h3 id="study-cycle-title">Conhecer. Aplicar. Reter.</h3><p>Um ciclo completo de estudo.</p><ol><li><span>01</span><div><b>Entenda o tema</b><small>Aulas e materiais do acervo</small></div></li><li><span>02</span><div><b>Teste o raciocínio</b><small>Questões sobre o que estudou</small></div></li><li><span>03</span><div><b>Volte no momento certo</b><small>Revisão ativa no cronograma</small></div></li></ol></aside>' +
      '<section class="plv2-week" aria-labelledby="plv2-week-title"><div class="study-section-head"><h3 id="plv2-week-title">Próximos sete dias</h3><span>' + semana.length + ' tarefas</span></div>' + semanaHtml + '</section>' +
      '<section class="study-shortcuts" aria-labelledby="study-shortcuts-title"><h3 id="study-shortcuts-title">Abra espaço para aprender</h3><button type="button" onclick="go(\'view-acervo\')"><i class="ph ph-books" aria-hidden="true"></i><span><b>Explorar meu acervo</b><small>Encontre uma aula ou um material</small></span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></button><button type="button" onclick="go(\'view-treino\')"><i class="ph ph-exam" aria-hidden="true"></i><span><b>Praticar questões</b><small>Treine por tema ou revise seus erros</small></span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></button></section></div></section>';
  }

  function renderChat() {
    const st = chatState(); const r = root(); if (!r) return;
    const plano = get(K_PLAN, null);
    r.innerHTML = (window.plv3 && plano ? plv3.nav() : '') + renderOverview(st, plano) + `<div class="plv2"><div class="plv2-bar"><div><h2> ${plano ? 'Ajustar seu plano com o Mentor' : 'Vamos desenhar sua rotina'}</h2><div class="plv2-sub">Conte seu objetivo ao Mentor. Seu plano usa as aulas e os materiais do seu acervo.</div></div>
      <div class="plv2-btns">${plano ? '<button class="b" onclick="plv2.voltar()"><i class="ph ph-calendar"></i> Ver cronograma</button>' : ''}<button class="b" onclick="plv2.reiniciar()"><i class="ph ph-arrow-counter-clockwise"></i> Recomeçar</button></div></div>
      <div class="plv2-chat"><div class="plv2-msgs" id="plv2-msgs">${st.msgs.map(m => `<div class="plv2-m ${m.role === 'user' ? 'me' : 'bot'}">${E(m.content)}</div>`).join('')}</div>
      ${st.resumo.length > 1 ? `<div class="plv2-sum"><b>O que entendi de você:</b><ul style="margin:6px 0 0 16px;padding:0">${st.resumo.map(x => `<li>${E(x)}</li>`).join('')}</ul></div>` : ''}
      <div class="plv2-q" id="plv2-q">${(st.pronto ? ['Quero ajustar algo'] : []).concat(st.quick.filter(q => !st.pronto || !/gerar/i.test(q))).map(q => `<button onclick="plv2.enviar(${E(JSON.stringify(JSON.stringify(q)))})">${E(q)}</button>`).join('')}${st.pronto ? '<button class="b pri" style="border-radius:99px;background:var(--teal);color:var(--text-inverse);font-weight:700" onclick="plv2.gerar()"><i class="ph ph-magic-wand"></i> Gerar meu cronograma</button>' : ''}</div>
      <div class="plv2-in"><input type="file" id="plv2-file" accept=".pdf,.txt,.md,application/pdf,text/plain" style="display:none" onchange="plv2.anexar(this)"><button class="b" title="Anexar manual do aluno / ementa (PDF)" onclick="document.getElementById('plv2-file').click()"><i class="ph ph-paperclip" aria-hidden="true"></i></button><textarea aria-label="Sua resposta para o Mentor" id="plv2-txt" rows="1" placeholder="Escreva sua resposta…" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();plv2.enviar()}"></textarea><button class="b pri" aria-label="Enviar resposta" id="plv2-send" onclick="plv2.enviar()"><i class="ph ph-paper-plane-tilt"></i></button></div></div></div>`;
    r.querySelectorAll('#plv2-start, #plv2-start-top').forEach(start => start.addEventListener('click', () => {
      const chat = r.querySelector('.plv2');
      if (chat) chat.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const input = document.getElementById('plv2-txt');
      if (input) setTimeout(() => input.focus(), 250);
    }));
    const box = document.getElementById('plv2-msgs'); if (box) box.scrollTop = box.scrollHeight;
  }

  async function turno(texto, extra) {
    if (busy) return; busy = true;
    const st = chatState();
    if (texto) st.msgs.push({ role: 'user', content: texto });
    st.quick = []; set(K_CHAT, st); renderChat();
    const box = document.getElementById('plv2-msgs');
    if (box) { const d = document.createElement('div'); d.className = 'plv2-m bot'; d.id = 'plv2-typing'; d.textContent = 'Pensando…'; box.appendChild(d); box.scrollTop = box.scrollHeight; }
    try {
      const j = await api('/api/planner/chat', Object.assign({ messages: st.msgs, perfil: st.perfil, asking: st.asking, jaExtras: st.jaExtras, hoje: hoje() }, extra || {}));
      st.perfil = j.perfil; st.asking = j.asking || ''; st.jaExtras = !!j.jaExtras; st.quick = j.quickReplies || []; st.pronto = !!j.pronto; st.resumo = j.resumo || [];
      st.msgs.push({ role: 'model', content: j.reply });
    } catch (e) {
      st.msgs.push({ role: 'model', content: 'Não consegui falar com o servidor agora (' + e.message + '). Tente de novo em instantes.' });
    }
    set(K_CHAT, st); busy = false; renderChat();
  }

  /* ───────────── Cronograma ───────────── */
  async function gerar(opts) {
    if (busy) return; busy = true;
    const st = chatState(); const antigo = get(K_PLAN, null);
    if (window.toast) toast('Montando seu cronograma com as aulas do acervo…', 'info');
    try {
      const perfilUsado = (opts && opts.perfil) || st.perfil || (antigo && antigo.perfil);
      let j;
      if (antigo && window.plv3 && plv3.regerar) {
        // já existe plano: replaneja daqui para frente preservando concluídas, canceladas, edições e histórico
        j = { plan: await plv3.regerar(antigo, perfilUsado, opts && opts.dias, opts && opts.motivo) };
      } else {
        const textos = (st.msgs || []).filter(m => m.role === 'user' && String(m.content).length > 300).map(m => m.content).slice(-6);
        j = await api('/api/planner/generate-tasks', { perfil: perfilUsado, textos, hoje: hoje(), dias: opts && opts.dias, retidas: antigo ? antigo.tarefas.filter(t => t.status === 'feito') : [] });
        if (window.plv3 && plv3.anotar) { try { j.plan = await plv3.anotar(j.plan); } catch (_) { /* segue sem anotações */ } }
      }
      set(K_PLAN, j.plan); sync();
      tab = 'hoje'; busy = false; renderPlano();
      (j.plan.avisos || []).forEach(a => { if (window.toast) toast('⚠️ ' + a, 'warning'); });
      enriquecer(true);
    } catch (e) { busy = false; if (window.toast) toast('Erro ao gerar: ' + e.message, 'error'); }
  }

  let enriquecendo = false;
  async function enriquecer(silencioso) {
    if (enriquecendo) return; enriquecendo = true;
    let total = 0, ia = true;
    try {
      // lotes de 8 tarefas de estudo, das mais próximas para as mais distantes (até ~40 tarefas por vez)
      for (let volta = 0; volta < 5; volta++) {
        const plano = get(K_PLAN, null); if (!plano) break;
        const alvo = plano.tarefas.filter(t => ativa(t) && t.tipo === 'estudo' && t.status !== 'feito' && !t.ia && !t._iaTentou && t.data >= hoje()).sort((x, y) => x.data.localeCompare(y.data)).slice(0, 8);
        if (!alvo.length) break;
        let j = null;
        const pedidos = (chatState().msgs || []).filter(m => m.role === 'user').map(m => String(m.content).slice(0, 400)).slice(-6);
        try { j = await api('/api/planner/enrich', { perfil: plano.perfil, tarefas: alvo, pedidos }); } catch (_) { break; }
        ia = !!j.ia;
        const p2 = get(K_PLAN, null); if (!p2) break;
        const ids = new Set(alvo.map(t => t.id));
        p2.tarefas.forEach(t => {
          if (!ids.has(t.id)) return;
          const it = (j.itens || {})[t.id];
          if (!it) { t._iaTentou = true; return; }
          t.passos.forEach((s, i) => (s.texto = it.passos[i]));
          if (it.observacoes) t.observacoes = it.observacoes + (t.observacoes ? ' ' + (t.observacoes.match(/Revisões automáticas[^]*$/) || [''])[0] : '');
          t.ia = true; total++;
        });
        set(K_PLAN, p2); sync(); if (document.getElementById('plv2-lista')) renderPlano();
        if (!j.ia) break;
      }
    } finally { enriquecendo = false; }
    if (!silencioso && window.toast) toast(total ? total + ' tarefas detalhadas pela IA ✨' : (ia ? 'Tudo já está detalhado.' : 'IA indisponível: mantive o passo a passo padrão.'), total ? 'success' : 'warning');
  }

  // Liga a tarefa às aulas que você mesmo gravou (Aula do dia): resumo, flashcards e transcrição daquele conteúdo
  const nrm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function gravadasDe(t) {
    let l = []; try { l = JSON.parse(localStorage.getItem('aula-dia-sessoes') || '[]'); } catch (_) {}
    if (!l.length || t.tipo !== 'estudo') return [];
    const tt = new Set(nrm((t.tema || '') + ' ' + (t.modulo || '') + ' ' + (t.titulo || '')).split(/[^a-z0-9]+/).filter(w => w.length > 4));
    return l.filter(s => s.pronto || s.revisada).filter(s => {
      const dOk = nrm(t.titulo + ' ' + (t.materia || '')).includes(nrm(s.disciplina || '').slice(0, 6)) && nrm(s.disciplina).length > 2;
      const toks = nrm(s.tema).split(/[^a-z0-9]+/).filter(w => w.length > 4);
      return dOk && toks.some(w => tt.has(w));
    }).slice(0, 2);
  }

  function tarefaRow(t) {
    const cor = COR[t.tipo] || 'var(--teal)';
    const passos = (t.passos || []).map(s => `<div class="plv2-st"><i class="ph ${ICON[s.acao] || 'ph-check'}"></i><div><b>${E(NOME[s.acao] || s.acao)}${s.minutos ? ' · ' + s.minutos + ' min' : ''}</b><div>${E(s.texto)}</div></div></div>`).join('');
    const extras = gravadasDe(t).map(g => ({ tipo: 'aulagravada', id: g.id, titulo: [g.disciplina, g.tema, g.parte !== 'Única' ? g.parte : ''].filter(Boolean).join(' — ') }));
    const recs = (t.recursos || []).concat(extras).map((r, i) => {
      const ic = r.tipo === 'aulagravada' ? 'ph-microphone-stage' : r.tipo === 'video' ? 'ph-play-circle' : r.tipo === 'pdf' ? 'ph-file-pdf' : r.tipo === 'questoes' || r.tipo === 'simulado' ? 'ph-list-checks' : r.tipo === 'erros' ? 'ph-warning-circle' : 'ph-cards';
      const rot = r.tipo === 'aulagravada' ? 'Sua aula gravada' : r.tipo === 'video' ? 'Aula' : r.tipo === 'pdf' ? (r.rotulo || 'Resumo/PDF') : r.tipo === 'questoes' ? 'Questões' : r.tipo === 'simulado' ? 'Simulado' : r.tipo === 'erros' ? 'Caderno de erros' : 'Flashcards';
      return `<button class="plv2-rec" onclick="plv2.abrir('${E(t.id)}',${i})"><i class="ph ${ic}" style="color:var(--teal);font-size:16px"></i><span><b>${rot}:</b> ${E(String(r.titulo).replace(/^(Questões|Flashcards|Aula): /, ''))}</span></button>`;
    }).join('');
    const est = t.estrategia || {}; const chips = Object.entries(est).filter(([, v]) => v).map(([k, v]) => `<em>${E(NOME[k] || k)} ${v}′</em>`).join('');
    return `<tr class="${t.status === 'feito' ? 'feito' : ''}"><td data-l="Tarefa"><span class="plv2-pill" style="color:${cor};border-color:${cor}">${({ estudo: 'ESTUDO', revisao: 'REVISÃO', simulado: 'SIMULADO', erros: 'ERROS', prova: 'PROVA' })[t.tipo] || 'TAREFA'}</span>${t.trilha ? `<span class="plv2-trilha t-${E(t.trilha)}" title="${t.trilha === 'compartilhada' ? 'Vale para a faculdade e para a residência' : 'Exclusiva desta trilha'}">${({ faculdade: 'FACULDADE', residencia: 'RESIDÊNCIA', compartilhada: 'COMPARTILHADA' })[t.trilha] || ''}</span>` : ''}<div class="tt">${E(t.titulo)}</div><div class="mt">${t.minutos ? fmtMin(t.minutos) : ''}${t.ia ? ' · ✨ detalhado por IA' : ''}${t.editadaManual ? ' · ✏️ ajustada por você' : ''}${t.adiadaDe && t.adiadaDe.length ? ' · adiada de ' + E(fmtBr(t.adiadaDe[t.adiadaDe.length - 1])) : ''}</div>${t.prioridade != null && t.tipo !== 'prova' ? `<div class="mt" title="Heurística de organização, não validada cientificamente">Prioridade ${t.prioridade}/100 — ${E(t.justificativa || '')}</div>` : ''}<div class="plv2-chips">${chips}</div>
      ${t.tipo !== 'prova' ? `<div class="plv2-done"><button class="b" onclick="plv2.feito('${E(t.id)}')">${t.status === 'feito' ? '<i class="ph ph-check-circle" style="color:var(--green)"></i> Concluída' : '<i class="ph ph-circle"></i> Marcar como feita'}</button>${window.plv3 && t.status !== 'feito' ? ` <button class="b" onclick="plv3.adiar('${E(t.id)}')" title="Adiar"><i class="ph ph-clock-clockwise"></i></button> <button class="b" onclick="plv3.editar('${E(t.id)}')" title="Editar"><i class="ph ph-pencil-simple"></i></button> <button class="b" onclick="plv3.cancelar('${E(t.id)}')" title="Cancelar"><i class="ph ph-x-circle"></i></button>` : ''}</div>` : ''}</td>
      <td data-l="Passo a passo">${passos}</td><td data-l="Materiais">${recs || '<span class="plv2-obs">—</span>'}</td><td data-l="Observações"><div class="plv2-obs">${E(t.observacoes || '')}</div></td></tr>`;
  }

  let _enrAuto = false;
  function renderPlano() {
    if (!_enrAuto) { _enrAuto = true; setTimeout(() => enriquecer(true), 1500); } // completa o detalhamento das tarefas que ainda estão no texto padrão
    const r = root(); if (!r) return; css();
    const plano = get(K_PLAN, null);
    if (!plano) return renderChat();
    const h = hoje();
    let ts = plano.tarefas.filter(ativa);
    const atrasadas = ts.filter(t => t.data < h && t.status !== 'feito' && t.tipo !== 'prova');
    if (tab === 'hoje') ts = ts.filter(t => t.data === h);
    else if (tab === 'semana') { const fim = new Date(h + 'T00:00:00Z'); fim.setUTCDate(fim.getUTCDate() + 7); ts = ts.filter(t => t.data >= h && t.data < fim.toISOString().slice(0, 10)); }
    else if (tab === 'atrasadas') ts = atrasadas;
    else ts = ts.filter(t => t.data >= h);
    const porDia = {}; ts.forEach(t => (porDia[t.data] = porDia[t.data] || []).push(t));
    const dias = Object.keys(porDia).sort();
    const done = plano.tarefas.filter(t => ativa(t) && t.status === 'feito' && t.tipo !== 'prova').length, tot = plano.tarefas.filter(t => ativa(t) && t.tipo !== 'prova').length;
    const tabs = [['hoje', 'Hoje'], ['semana', 'Próximos 7 dias'], ['tudo', 'Tudo'], ['atrasadas', 'Atrasadas' + (atrasadas.length ? ' (' + atrasadas.length + ')' : '')]];
    if (window.plv3 && plv3.secao() !== 'visao') { r.innerHTML = plv3.nav() + plv3.corpo(plano); plv3.depois(); return; }
    r.innerHTML = (window.plv3 ? plv3.nav() : '') + renderOverview(chatState(), plano) + `<div class="plv2"><div class="plv2-bar"><div><h2>Seu cronograma</h2><div class="plv2-sub">${done}/${tot} tarefas concluídas · de ${plano.inicio.split('-').reverse().slice(0, 2).join('/')} a ${plano.fim.split('-').reverse().slice(0, 2).join('/')}${plano.perfil && plano.perfil.dataProva ? ' · prova ' + plano.perfil.dataProva.split('-').reverse().slice(0, 2).join('/') : ''}</div></div>
      <div class="plv2-btns"><button class="b pri" onclick="plv2.conversar()"><i class="ph ph-chats-circle"></i> Conversar / ajustar</button><button class="b" onclick="plv2.colar()"><i class="ph ph-clipboard-text"></i> Colar cronograma da faculdade</button><button class="b" onclick="plv2.exportar()"><i class="ph ph-export"></i> Exportar</button><button class="b" onclick="plv2.maisSemanas()"><i class="ph ph-calendar-plus"></i> +4 semanas</button><button class="b" onclick="plv2.ia()"><i class="ph ph-sparkle"></i> Detalhar com IA</button>${atrasadas.length ? '<button class="b" onclick="plv2.reagendar()"><i class="ph ph-arrows-clockwise"></i> Reagendar atrasadas</button>' : ''}${legacyRender ? '<button class="b" onclick="plv2.antigo()"><i class="ph ph-clock-counter-clockwise"></i> Planner antigo</button>' : ''}</div></div>
      <div class="plv2-tabs">${tabs.map(([k, n]) => `<button class="b ${tab === k ? 'on' : ''}" onclick="plv2.aba('${k}')">${n}</button>`).join('')}</div>
      <div id="plv2-lista">${dias.length ? dias.map(d => { const lst = porDia[d]; const m = lst.reduce((a, t) => a + (t.minutos || 0), 0); return `<div class="plv2-day"><div class="plv2-dh ${d === h ? 'hoje' : ''}">${fmtDia(d)}${d === h ? ' · hoje' : ''}<span>${m ? fmtMin(m) + ' planejados' : ''}</span></div><table class="plv2-t"><thead><tr><th style="width:21%">Tarefa</th><th style="width:36%">Passo a passo</th><th style="width:23%">Materiais</th><th>Observações</th></tr></thead><tbody>${lst.map(tarefaRow).join('')}</tbody></table></div>`; }).join('') : `<div class="plv2-empty">${tab === 'hoje' ? 'Nada agendado para hoje — dia livre no seu cronograma. 🎉' : tab === 'atrasadas' ? 'Nenhuma tarefa atrasada.' : 'Nada por aqui.'}</div>`}</div></div>`;
  }

  /* ───────────── Abrir materiais ───────────── */
  function abrir(tid, idx) {
    const plano = get(K_PLAN, null); if (!plano) return;
    const t = plano.tarefas.find(x => x.id === tid); if (!t) return;
    let rec = t.recursos[idx];
    if (!rec) { const g = gravadasDe(t)[idx - t.recursos.length]; if (g) rec = { tipo: 'aulagravada', id: g.id }; }
    if (!rec) return;
    try {
      if (rec.tipo === 'video') {
        abrirPastaDoVideo(rec.id);
      } else if (rec.tipo === 'pdf') {
        window.cuscuzAbrirPdf(rec.id);
      } else if (rec.tipo === 'questoes') {
        iniciarSimuladoDoTema(rec.tema || t.tema, rec.disc || t.materia, [], rec.modulo || '');
      } else if (rec.tipo === 'flashcards') {
        go('view-treino'); setTimeout(() => { try { startFC(); } catch (_) {} }, 150);
      } else if (rec.tipo === 'erros') {
        go('view-treino'); setTimeout(() => { try { startWrongQuiz(); } catch (_) {} }, 150);
      } else if (rec.tipo === 'simulado') {
        go('view-simulados');
      } else if (rec.tipo === 'aulagravada') {
        go('view-auladia'); setTimeout(() => { try { auladia.abrir(rec.id); } catch (_) {} }, 350);
      }
    } catch (e) { if (window.toast) toast('Não consegui abrir: ' + e.message, 'error'); }
  }

  /* ───────────── API pública ───────────── */
  window.plv2 = {
    enviar(txt) { const el = document.getElementById('plv2-txt'); let v = txt !== undefined ? JSON.parse(txt) : (el ? el.value.trim() : ''); if (!v) return; if (/^gerar meu cronograma$/i.test(v)) return gerar(); turno(v); },
    gerar() { gerar(); },
    exportar() {
      const p = get(K_PLAN, null); if (!p || !(p.tarefas || []).length) return toast && toast('Gere o cronograma primeiro.', 'warning');
      openModal('<div class="modal-title">Exportar cronograma<button class="modal-close"><i class="ph ph-x"></i></button></div>' +
        '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">' + p.tarefas.length + ' tarefas, de ' + fmtBr(p.tarefas[0].data) + ' a ' + fmtBr(p.tarefas[p.tarefas.length - 1].data) + '.</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px">' +
        '<button class="btn-primary" onclick="plv2.baixar(\'ics\')"><i class="ph ph-calendar-plus"></i> Calendário (.ics) — Apple, Google, Outlook</button>' +
        '<button class="btn-outline" onclick="plv2.baixar(\'pdf\')"><i class="ph ph-file-pdf"></i> PDF / imprimir</button>' +
        '<button class="btn-outline" onclick="plv2.baixar(\'csv\')"><i class="ph ph-table"></i> Planilha (.csv) — Excel, Google Sheets</button>' +
        '<button class="btn-outline" onclick="plv2.baixar(\'txt\')"><i class="ph ph-note"></i> Texto (.txt) — NotebookLM, Notion, Anki</button></div>');
    },
    baixar(fmt) {
      const p = get(K_PLAN, null); if (!p) return;
      const T = p.tarefas.filter(ativa).sort((x, y) => x.data.localeCompare(y.data));
      const ok = ['pendente', 'feito'];
      const passos = t => (t.passos || []).map(s => s.n + '. ' + s.texto + (s.minutos ? ' (' + s.minutos + ' min)' : '')).join('\n');
      const baixa = (nome, tipo, conteudo) => { const u = URL.createObjectURL(new Blob([conteudo], { type: tipo + ';charset=utf-8' })); const a = document.createElement('a'); a.href = u; a.download = nome; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
      if (fmt === 'ics') {
        const esc = x => String(x || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
        const dobra = l => { const o = []; let r = l; while (r.length > 74) { o.push(r.slice(0, 74)); r = ' ' + r.slice(74); } o.push(r); return o.join('\r\n'); };
        const dia = (iso, add) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (add || 0)); return d.toISOString().slice(0, 10).replace(/-/g, ''); };
        const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
        const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cuscuz-MED//Planner//PT-BR', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Cronograma Cuscuz-MED'];
        T.forEach(t => {
          L.push('BEGIN:VEVENT', 'UID:' + t.id + '@cuscuz-med', 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + dia(t.data), 'DTEND;VALUE=DATE:' + dia(t.data, 1),
            dobra('SUMMARY:' + esc((t.tipo === 'prova' ? '🎯 ' : '') + t.titulo + (t.minutos ? ' (' + fmtMin(t.minutos) + ')' : ''))),
            dobra('DESCRIPTION:' + esc(passos(t) + (t.observacoes ? '\n\n' + t.observacoes : ''))), 'TRANSP:TRANSPARENT', 'END:VEVENT');
        });
        L.push('END:VCALENDAR');
        baixa('cronograma-cuscuz-med.ics', 'text/calendar', L.join('\r\n'));
      } else if (fmt === 'csv') {
        const c = x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
        const rows = [['Data', 'Dia', 'Tipo', 'Disciplina', 'Tarefa', 'Tema', 'Minutos', 'Passo a passo', 'Observações', 'Status']];
        T.forEach(t => rows.push([fmtBr(t.data), DIAS[new Date(t.data + 'T00:00:00Z').getUTCDay()], t.tipo, t.materia, t.titulo, t.tema, t.minutos, passos(t), t.observacoes, t.status]));
        baixa('cronograma-cuscuz-med.csv', 'text/csv', '\ufeff' + rows.map(r => r.map(c).join(';')).join('\r\n'));
      } else if (fmt === 'txt') {
        let ult = '';
        const out = ['CRONOGRAMA CUSCUZ-MED', ''];
        T.forEach(t => { if (t.data !== ult) { out.push('', '== ' + fmtDia(t.data) + ' =='); ult = t.data; } out.push('', '• ' + t.titulo + (t.minutos ? ' — ' + fmtMin(t.minutos) : ''), passos(t), t.observacoes ? 'Obs.: ' + t.observacoes : ''); });
        baixa('cronograma-cuscuz-med.txt', 'text/plain', out.join('\n'));
      } else if (fmt === 'pdf') {
        let ult = '', h = '';
        T.forEach(t => {
          if (t.data !== ult) { h += '<h2>' + E(fmtDia(t.data)) + '</h2>'; ult = t.data; }
          h += '<div class="t"><b>' + E(t.titulo) + '</b>' + (t.minutos ? ' <i>(' + E(fmtMin(t.minutos)) + ')</i>' : '') + '<ol>' + (t.passos || []).map(s => '<li>' + E(s.texto) + (s.minutos ? ' <i>(' + s.minutos + ' min)</i>' : '') + '</li>').join('') + '</ol>' + (t.observacoes ? '<p class="o">' + E(t.observacoes) + '</p>' : '') + '</div>';
        });
        const w = window.open('', '_blank');
        if (!w) return toast && toast('Permita pop-ups para gerar o PDF.', 'warning');
        w.document.write('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cronograma Cuscuz-MED</title><style>body{font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;max-width:800px;margin:20px auto;padding:0 16px;color:#111}h1{font-size:22px}h2{font-size:15px;margin:22px 0 6px;padding:6px 10px;background:#e6f7f5;border-left:4px solid #007a6c;break-after:avoid}.t{margin:0 0 10px 6px;break-inside:avoid}ol{margin:4px 0 4px 20px;padding:0}.o{margin:4px 0;color:#555;font-size:12.5px}@media print{body{margin:0}}</style><h1>Cronograma Cuscuz-MED</h1>' + h + '<script>setTimeout(function(){window.print()},400)<\/script>');
        w.document.close();
      }
      if (window.closeModals) closeModals();
    },
    aba(k) { tab = k; renderPlano(); },
    irParaLista(k) { tab = k; renderPlano(); setTimeout(() => { const lista = document.querySelector('.plv2-tabs'); if (lista) lista.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 0); },
    feito(id) { const p = get(K_PLAN, null); const t = p && p.tarefas.find(x => x.id === id); if (!t) return; t.status = t.status === 'feito' ? 'pendente' : 'feito'; if (t.status === 'feito') t.feitoEm = new Date().toISOString(); else delete t.feitoEm; p.historico = (p.historico || []).concat([{ ts: new Date().toISOString(), acao: t.status === 'feito' ? 'concluir' : 'reabrir', id: t.id, titulo: t.titulo }]).slice(-500); set(K_PLAN, p); sync(); renderPlano(); },
    conversar() {
      const p = get(K_PLAN, null); const st = chatState();
      st.perfil = (p && p.perfil) || st.perfil; st.pronto = false; st.asking = ''; st.jaExtras = true;
      st.msgs.push({ role: 'model', content: 'Claro! O que mudou ou o que você quer ajustar? (horário, prova nova, matéria que está pesando, cansaço…) Vou adaptar o cronograma daqui para frente e manter o que você já fez.' });
      st.quick = ['Mudou meu tempo disponível', 'Tenho uma prova nova', 'Quero mais questões', 'Quero focar numa matéria']; set(K_CHAT, st); renderChat();
    },
    async anexar(inp) {
      const f = inp.files && inp.files[0]; inp.value = ''; if (!f || busy) return;
      if (f.size > 18 * 1024 * 1024) { if (window.toast) toast('Arquivo muito grande (máx. 18 MB). Envie só as páginas de ementa/avaliações.', 'error'); return; }
      const st = chatState(); st.msgs.push({ role: 'user', content: '📎 ' + f.name + ' (manual do aluno)' }); st.quick = []; set(K_CHAT, st); renderChat();
      busy = true;
      const box = document.getElementById('plv2-msgs'); if (box) { const d = document.createElement('div'); d.className = 'plv2-m bot'; d.textContent = 'Lendo o manual… (pode levar até 1 minuto)'; box.appendChild(d); box.scrollTop = box.scrollHeight; }
      try {
        const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = no; r.readAsDataURL(f); });
        const j = await api('/api/planner/manual', { nome: f.name, mime: f.type, base64: b64, perfil: st.perfil, hoje: hoje() });
        st.perfil = j.perfil; st.resumo = j.resumo || []; set(K_CHAT, st); busy = false;
        await turno(null, { anexo: true, nota: j.reply });
      } catch (e) {
        busy = false; const s2 = chatState(); s2.msgs.push({ role: 'model', content: 'Não consegui ler o arquivo (' + e.message + '). Você pode digitar o conteúdo de cada prova aqui no chat.' }); set(K_CHAT, s2); renderChat();
      }
    },
    ajustar(txt) { this.conversar(); setTimeout(() => this.enviar(JSON.stringify(String(txt))), 50); },
    voltar() { renderPlano(); },
    reiniciar() { if (!confirm('Recomeçar a conversa? (seu cronograma atual é mantido até você gerar outro)')) return; rem(K_CHAT); init(true); },
    maisSemanas() { const p = get(K_PLAN, null); if (!p) return; const dias = Math.round((new Date(p.fim) - new Date(hoje())) / 864e5) + 1 + 28; gerar({ dias: Math.min(120, Math.max(28, dias)) }); },
    reagendar() { gerar({}); },
    ia() { enriquecer(false); },
    // Caminho direto: cola o cronograma da faculdade, o app lê (disciplinas, provas, aulas com data) e refaz o plano na hora
    colar() {
      if (document.getElementById('plv2-colar')) return;
      const d = document.createElement('div'); d.id = 'plv2-colar';
      d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
      d.innerHTML = '<div style="background:var(--bg-surface,#111);border:1px solid var(--border-muted,#333);border-radius:14px;padding:16px;max-width:640px;width:100%;max-height:90vh;display:flex;flex-direction:column;gap:10px"><b>Cole aqui o cronograma da faculdade</b><div style="font-size:12px;opacity:.75">Com as disciplinas, as datas das provas e das aulas e o conteúdo de cada aula. Eu leio tudo e refaço o plano.</div><textarea id="plv2-colar-txt" style="flex:1;min-height:240px;background:var(--bg-base,#000);color:inherit;border:1px solid var(--border-muted,#333);border-radius:10px;padding:10px;font-size:13px" placeholder="1. Emergências Médicas\n * 04/08/26: Atendimento inicial…\n2. Terapia Intensiva\n…"></textarea><div style="display:flex;gap:8px;justify-content:flex-end"><button class="b" onclick="document.getElementById(\'plv2-colar\').remove()">Cancelar</button><button class="b pri" id="plv2-colar-ok" onclick="plv2.colarOk()">Ler e refazer o plano</button></div></div>';
      document.body.appendChild(d);
    },
    async colarOk() {
      const el = document.getElementById('plv2-colar-txt'); const tx = el ? el.value.trim() : '';
      if (tx.length < 80) { if (window.toast) toast('Cole o cronograma completo (texto).', 'warning'); return; }
      const ok = document.getElementById('plv2-colar-ok'); if (ok) { ok.disabled = true; ok.textContent = 'Lendo…'; }
      try {
        const antigo = get(K_PLAN, null); const st = chatState();
        const base = (antigo && antigo.perfil) || st.perfil || { objetivo: 'graduacao' };
        const j = await api('/api/planner/chat', { messages: [{ role: 'user', content: tx }], perfil: base, hoje: hoje() });
        st.perfil = j.perfil; st.resumo = j.resumo || []; st.msgs.push({ role: 'user', content: tx }); st.msgs.push({ role: 'model', content: j.reply }); set(K_CHAT, st);
        const f = document.getElementById('plv2-colar'); if (f) f.remove();
        if (window.toast) toast('✅ ' + String(j.reply).split('\n')[0].slice(0, 220), 'success');
        await gerar({ perfil: j.perfil });
      } catch (e) { if (ok) { ok.disabled = false; ok.textContent = 'Ler e refazer o plano'; } if (window.toast) toast('Não consegui ler: ' + e.message, 'error'); }
    },
    antigo() { if (legacyRender) legacyRender(); },
    abrir
  };

  window.plv2._i = { get, set, rem, sync, hoje, E, tarefaRow, fmtMin, fmtBr, fmtDia, api, renderPlano, renderChat, chatState, gerar, css, root, ativa, DIAS };

  function init(forceChat) {
    css();
    const plano = get(K_PLAN, null);
    if (plano && !forceChat) return renderPlano();
    const st = chatState();
    if (!st.msgs.length) { renderChat(); turno(''); } else renderChat();
  }
  window.renderPlannerIA = function () { init(false); };
})();
