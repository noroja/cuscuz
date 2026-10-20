// Planejamento acadêmico integrado (Faculdade + Residência).
// Estende src/planner-engine.js — NÃO é um segundo gerador de cronograma: recebe o plano que o
// motor já produz (gerarTarefas) e (1) classifica as tarefas por trilha, (2) sugere associações
// faculdade↔residência para o aluno revisar, (3) evita duplicar teoria e tempo, (4) prioriza com
// critérios configuráveis e justificativa, (5) aplica ações do aluno (concluir/adiar/editar/cancelar)
// e replaneja sem perder o histórico. Funções puras: não acessam rede, disco nem IA.
import * as PE from './planner-engine.js';

const { norm, tokens, diffDias, addDias, parseIso, mesmaDisc, detectDisc } = PE;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export const TRILHAS = ['faculdade', 'residencia', 'compartilhada'];
export const STATUS_INATIVOS = new Set(['cancelado', 'reagendada']);
export const ativa = t => !!t && !STATUS_INATIVOS.has(t.status);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoValido = s => typeof s === 'string' && ISO.test(s) && !Number.isNaN(parseIso(s).getTime()) && parseIso(s).toISOString().slice(0, 10) === s;

/* ───────────────────────── Critérios de priorização (CONFIGURÁVEIS) ─────────────────────────
   Estes pesos são uma heurística de organização do estudo, NÃO um modelo validado cientificamente.
   O aluno pode alterá-los em Perfil e configurações (perfil.pesos). Cada fator vale de 0 a 1. */
export const PESOS_PADRAO = Object.freeze({
  prova: 30,       // proximidade da prova (faculdade: até 45 dias; residência: até 180 dias)
  desempenho: 20,  // taxa de erro em questões da matéria (só com ≥ 5 respostas; senão neutro)
  revisao: 15,     // tempo desde a última tarefa concluída do mesmo tema (30 dias = máximo)
  volume: 10,      // participação da matéria no conteúdo ainda pendente
  conteudo: 10,    // incidência da matéria em provas de residência (campo `peso` de DISCS; aproximado)
  sinergia: 10,    // tema útil para as duas trilhas
  material: 5      // há aula/PDF/questões do acervo vinculados
});
const JANELA_PROVA_FAC = 45, JANELA_PROVA_RES = 180, MIN_RESPOSTAS = 5;

export function normalizarPesos(p) {
  const out = { ...PESOS_PADRAO };
  if (p && typeof p === 'object') for (const k of Object.keys(PESOS_PADRAO)) { const v = Number(p[k]); if (Number.isFinite(v) && v >= 0 && v <= 100) out[k] = v; }
  if (!Object.values(out).some(v => v > 0)) return { ...PESOS_PADRAO };
  return out;
}

/* ───────────────────────── Utilidades ───────────────────────── */
export function chaveTarefa(t) {
  const base = [t.tipo, norm(t.materia), norm(t.tema)].join('|');
  return ['estudo', 'prova'].includes(t.tipo) ? base : base + '|' + t.data;
}
const GENERICAS = new Set(['tratamento', 'diagnostico', 'doenca', 'doencas', 'quadro', 'clinico', 'clinica', 'conduta', 'abordagem', 'introducao', 'aula', 'revisao', 'questoes', 'sindrome', 'sindromes', 'geral', 'principais', 'manejo', 'avaliacao', 'fisiopatologia', 'epidemiologia', 'prova', 'estudo', 'casos', 'caso']);
const tokensTema = s => new Set(tokens(s).filter(w => !GENERICAS.has(w)).map(w => w.slice(0, 7)));
const partesTema = s => String(s || '').split(/;|\s[-–—]\s|\be\b(?=\s+[A-ZÀ-Ú])/).map(x => x.trim()).filter(x => x.length > 2);
const dataTarefa = t => t.data;

function discCompativel(a, b) {
  if (!a || !b) return false;
  if (mesmaDisc(a, b)) return true;
  const x = detectDisc(a), y = detectDisc(b);
  return !!(x && y && x.nome === y.nome);
}

/* Compara dois temas. Retorna { confianca: 'alta'|'media'|null, comuns:[...] }.
   alta  = ≥2 termos específicos em comum e cobrem ≥60% do menor tema.
   media = ≥1 termo específico em comum com disciplina compatível (precisa de confirmação do aluno). */
export function compararTemas(temaA, discA, temaB, discB) {
  let melhor = { confianca: null, comuns: [], pontos: 0 };
  for (const pa of [temaA, ...partesTema(temaA)]) {
    const A = tokensTema(pa); if (!A.size) continue;
    for (const pb of [temaB, ...partesTema(temaB)]) {
      const B = tokensTema(pb); if (!B.size) continue;
      const comuns = [...A].filter(w => B.has(w));
      if (!comuns.length) continue;
      const cont = comuns.length / Math.min(A.size, B.size);
      const disc = discCompativel(discA, discB);
      let conf = null;
      if (comuns.length >= 2 && cont >= 0.6) conf = 'alta';
      else if (comuns.length >= 1 && disc && cont >= 0.5) conf = 'media';
      const pontos = (conf === 'alta' ? 2 : conf === 'media' ? 1 : 0) + cont;
      if (conf && pontos > melhor.pontos) melhor = { confianca: conf, comuns, pontos };
    }
  }
  return melhor;
}

const idAssoc = (f, r) => 'as-' + [norm(f.materia), norm(f.tema), norm(r.materia), norm(r.tema)].join('|').replace(/[^a-z0-9|]+/g, '').slice(0, 90);

/* ───────────────────────── 1) Trilhas ───────────────────────── */
export function classificarTrilhas(plano) {
  const obj = plano.perfil && plano.perfil.objetivo;
  const padrao = t => obj === 'graduacao' ? 'faculdade' : obj === 'residencia' ? 'residencia' : (['erros', 'simulado'].includes(t.tipo) ? 'compartilhada' : 'residencia');
  for (const t of plano.tarefas) if (!(t.trilha && TRILHAS.includes(t.trilha)) && t.tipo !== 'revisao') t.trilha = padrao(t);
  // revisão espaçada herda a trilha dos temas que revisa (só é compartilhada se revisa temas das duas)
  const estudos = plano.tarefas.filter(t => t.tipo === 'estudo' && t.trilha);
  for (const t of plano.tarefas) {
    if (t.tipo !== 'revisao' || (t.trilha && TRILHAS.includes(t.trilha))) continue;
    const alvo = String(t.tema || '').split(/;|,/).map(x => norm(x).trim()).filter(x => x.length > 3);
    const achadas = new Set();
    for (const a of alvo) for (const e of estudos) { const n = norm(e.tema); if (n && (n.includes(a) || a.includes(n))) achadas.add(e.trilha); }
    t.trilha = achadas.size === 0 ? padrao(t) : achadas.size === 1 ? [...achadas][0] : 'compartilhada';
  }
  return plano;
}

/* ───────────────────────── 2) Associações faculdade ↔ residência ─────────────────────────
   `salvas` são as associações que o aluno já revisou (confirmada/rejeitada) — a decisão dele vale sempre. */
export function sugerirAssociacoes(plano, salvas = []) {
  const porId = new Map((salvas || []).filter(a => a && a.id).map(a => [a.id, a]));
  const fac = plano.tarefas.filter(t => ativa(t) && t.tipo === 'estudo' && t.trilha === 'faculdade' && t.status !== 'feito');
  const res = plano.tarefas.filter(t => ativa(t) && t.tipo === 'estudo' && t.trilha === 'residencia' && t.status !== 'feito');
  const out = [], vistos = new Set();
  for (const f of fac) for (const r of res) {
    const c = compararTemas(f.tema, f.materia, r.tema, r.materia);
    if (!c.confianca) continue;
    const id = idAssoc(f, r);
    if (vistos.has(id)) continue; vistos.add(id);
    const ant = porId.get(id);
    out.push({
      id, confianca: c.confianca, comuns: c.comuns,
      fac: { materia: f.materia, tema: f.tema, data: dataTarefa(f), tarefa: f.id },
      res: { materia: r.materia, tema: r.tema, data: dataTarefa(r), tarefa: r.id },
      status: ant && ['confirmada', 'rejeitada'].includes(ant.status) ? ant.status : 'sugerida',
      origem: ant && ant.origem ? ant.origem : 'automatica'
    });
  }
  // decisões do aluno sobre pares que não aparecem mais (ex.: tarefa já concluída) continuam registradas
  for (const a of porId.values()) if (!vistos.has(a.id) && ['confirmada', 'rejeitada'].includes(a.status)) out.push({ ...a, obsoleta: true });
  return out;
}

const aplicavel = a => !a.obsoleta && (a.status === 'confirmada' || (a.status === 'sugerida' && a.confianca === 'alta'));

/* ───────────────────────── 3) Integração sem duplicar ───────────────────────── */
const PASSOS_TEORIA = new Set(['aula', 'resumo']);
const CAMPOS_ORIG = ['passos', 'minutos', 'titulo', 'observacoes', 'trilha', 'status'];
const guardarOrig = t => { if (!t._orig) t._orig = JSON.parse(JSON.stringify(Object.fromEntries(CAMPOS_ORIG.map(k => [k, t[k]])))); };
// Reverte integrações anteriores (para reintegrar após o aluno confirmar/rejeitar associações). Não mexe em tarefas concluídas nem editadas pelo aluno.
export function desfazerIntegracao(plano) {
  for (const t of plano.tarefas) {
    if (!t._orig) continue;
    const statusDaIntegracao = t.status === 'pendente' || (t.status === 'reagendada' && /compartilhada/.test(t.motivoRemocao || ''));
    if (t.status !== 'feito' && !t.editadaManual) for (const k of CAMPOS_ORIG) { if (k === 'status' && !statusDaIntegracao) continue; t[k] = JSON.parse(JSON.stringify(t._orig[k] === undefined ? null : t._orig[k])); }
    ['_orig', 'integrado', 'associacao', 'compartilhadoCom', 'motivoRemocao', 'trilhas'].forEach(k => delete t[k]);
    if (t.trilha == null) delete t.trilha;
  }
  plano.integracao = { aplicadas: [], removidas: [], minutosEconomizados: 0 };
  return plano;
}

export function integrar(plano, associacoes, { janelaDias = 7 } = {}) {
  const integ = { aplicadas: [], removidas: [], minutosEconomizados: 0 };
  const porId = new Map(plano.tarefas.map(t => [t.id, t]));
  for (const a of associacoes || []) {
    if (!aplicavel(a)) continue;
    const f = porId.get(a.fac.tarefa), r = porId.get(a.res.tarefa);
    if (!f || !r || !ativa(f) || !ativa(r)) continue;
    if (f.integrado || r.integrado || f.status === 'feito' || r.status === 'feito' || f.editadaManual || r.editadaManual) continue;
    if (Math.abs(diffDias(f.data, r.data)) > janelaDias) continue;
    const [principal, secundaria] = (f.data <= r.data) ? [f, r] : [r, f];
    const antes = secundaria.minutos || 0;
    guardarOrig(principal); guardarOrig(secundaria);
    principal.trilha = 'compartilhada'; principal.trilhas = ['faculdade', 'residencia']; principal.integrado = true;
    principal.associacao = a.id;
    principal.observacoes = ((principal.observacoes || '') + ` Sessão compartilhada: cobre "${a.fac.tema}" (faculdade) e "${a.res.tema}" (residência) — teoria feita uma única vez.`).trim();
    const restantes = (secundaria.passos || []).filter(s => !PASSOS_TEORIA.has(s.acao));
    secundaria.integrado = true; secundaria.associacao = a.id; secundaria.compartilhadoCom = principal.id;
    if (!restantes.length) {
      secundaria.status = 'reagendada'; // sai do plano ativo, mas fica registrada para auditoria
      secundaria.motivoRemocao = `Teoria já coberta pela sessão compartilhada de ${principal.data}.`;
      integ.removidas.push({ id: secundaria.id, titulo: secundaria.titulo, motivo: secundaria.motivoRemocao });
      integ.minutosEconomizados += antes;
    } else {
      secundaria.passos = restantes.map((s, i) => ({ ...s, n: i + 1 }));
      secundaria.minutos = restantes.reduce((x, s) => x + (Number(s.minutos) || 0), 0);
      secundaria.titulo = secundaria.titulo.replace(/^Prévia da aula/, 'Questões da aula') + ' (sem teoria repetida)';
      secundaria.observacoes = ((secundaria.observacoes || '') + ` Teoria deste tema está na sessão compartilhada de ${principal.data}; aqui só a parte específica da ${secundaria.trilha === 'faculdade' ? 'prova da faculdade' : 'residência'}.`).trim();
      integ.minutosEconomizados += Math.max(0, antes - secundaria.minutos);
    }
    integ.aplicadas.push({ associacao: a.id, principal: principal.id, secundaria: secundaria.id });
  }
  return integ;
}

/* ───────────────────────── 4) Priorização com justificativa ───────────────────────── */
// desempenho: { "<matéria normalizada>": { acertos, total } }  — vem do app (histórico de questões)
export function priorizar(plano, { hoje, desempenho = {}, pesos } = {}) {
  const W = normalizarPesos(pesos), soma = Object.values(W).reduce((a, b) => a + b, 0);
  const ts = plano.tarefas.filter(ativa);
  const provas = ((plano.perfil && plano.perfil.provasFaculdade) || []).filter(p => p.data >= hoje);
  const dataRes = plano.perfil && plano.perfil.dataProva && plano.perfil.dataProva >= hoje ? plano.perfil.dataProva : null;
  const pend = ts.filter(t => t.status !== 'feito' && t.tipo !== 'prova');
  const minPend = pend.reduce((a, t) => a + (t.minutos || 0), 0) || 1;
  const minPorMateria = {}; pend.forEach(t => { const k = norm(t.materia); minPorMateria[k] = (minPorMateria[k] || 0) + (t.minutos || 0); });
  const ultima = {}; ts.filter(t => t.status === 'feito' && t.tipo === 'estudo').forEach(t => { const k = norm(t.materia) + '|' + norm(t.tema); const d = t.feitoEm ? t.feitoEm.slice(0, 10) : t.data; if (!ultima[k] || d > ultima[k]) ultima[k] = d; });
  const maxPesoDisc = Math.max(...PE.DISCS.map(d => d.peso || 0), 1);

  for (const t of ts) {
    if (t.tipo === 'prova') { t.prioridade = 100; t.justificativa = 'Dia de avaliação.'; continue; }
    const f = {}, why = [];
    // prova (faculdade e/ou residência; tarefa compartilhada usa a mais próxima)
    let fp = 0;
    if (t.trilha !== 'residencia') {
      const pr = provas.filter(p => discCompativel(p.disciplina, t.materia)).sort((a, b) => a.data.localeCompare(b.data))[0];
      if (pr) { const d = diffDias(t.data > hoje ? t.data : hoje, pr.data); if (d >= 0) { fp = clamp(1 - d / JANELA_PROVA_FAC, 0, 1); if (fp > 0.3) why.push(`prova de ${pr.disciplina} em ${diffDias(hoje, pr.data)} dia(s)`); } }
    }
    if (dataRes && t.trilha !== 'faculdade') { const d = diffDias(hoje, dataRes); const fr = clamp(1 - d / JANELA_PROVA_RES, 0, 1) * 0.6; if (fr > fp) { fp = fr; if (fr > 0.25) why.push(`prova de residência em ${d} dia(s)`); } }
    f.prova = fp;
    // desempenho
    const des = desempenho[norm(t.materia)];
    if (des && des.total >= MIN_RESPOSTAS) { const erro = 1 - des.acertos / des.total; f.desempenho = clamp(erro / 0.6, 0, 1); if (erro >= 0.35) why.push(`${Math.round(erro * 100)}% de erro em questões da matéria`); }
    else f.desempenho = 0.5;
    // tempo desde a última revisão
    const ult = ultima[norm(t.materia) + '|' + norm(t.tema)];
    f.revisao = ult ? clamp(diffDias(ult, hoje) / 30, 0, 1) : 0.6;
    if (ult && f.revisao >= 0.7) why.push(`${diffDias(ult, hoje)} dias desde a última sessão deste tema`);
    // volume pendente
    f.volume = clamp((minPorMateria[norm(t.materia)] || 0) / minPend * 3, 0, 1);
    if (f.volume >= 0.7) why.push('muito conteúdo pendente nesta matéria');
    // incidência (aproximada) em residência
    const dd = detectDisc(t.materia);
    f.conteudo = dd ? clamp((dd.peso || 0) / maxPesoDisc, 0, 1) : 0.3;
    if (dd && f.conteudo >= 0.8 && t.trilha !== 'faculdade') why.push('alta incidência em provas de residência');
    // sinergia
    f.sinergia = t.trilha === 'compartilhada' ? 1 : 0;
    if (f.sinergia) why.push('tema útil para faculdade e residência');
    // material do acervo
    f.material = (t.recursos || []).some(r => ['video', 'pdf', 'questoes', 'flashcards'].includes(r.tipo)) ? 1 : 0;
    if (f.material) why.push('há material do acervo vinculado');
    let s = 0; for (const k of Object.keys(W)) s += W[k] * (f[k] || 0);
    t.prioridade = Math.round(s / soma * 100);
    t.fatores = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(v * 100) / 100]));
    t.justificativa = why.length ? why.slice(0, 3).join('; ') + '.' : 'Prioridade padrão: sem prova próxima nem dados de desempenho.';
  }
  return plano;
}

/* ───────────────────────── Orquestração ───────────────────────── */
export function anotarPlano(plano, { hoje, associacoes = [], desempenho = {}, pesos } = {}) {
  desfazerIntegracao(plano);
  classificarTrilhas(plano);
  const assoc = sugerirAssociacoes(plano, associacoes);
  plano.integracao = integrar(plano, assoc);
  plano.associacoes = assoc;
  priorizar(plano, { hoje, desempenho, pesos });
  // dentro do dia: prova primeiro, depois maior prioridade (ordem estável nos empates)
  const idx = new Map(plano.tarefas.map((t, i) => [t, i]));
  plano.tarefas.sort((a, b) => a.data.localeCompare(b.data) || (b.tipo === 'prova') - (a.tipo === 'prova') || ((b.prioridade || 0) - (a.prioridade || 0)) || idx.get(a) - idx.get(b));
  plano.versao3 = true;
  return plano;
}

/* ───────────────────────── 5) Ações do aluno + histórico ───────────────────────── */
const EDITAVEIS = { titulo: v => typeof v === 'string' && v.trim().length >= 3 && v.length <= 160, data: isoValido, minutos: v => Number.isInteger(v) && v >= 5 && v <= 480, observacoes: v => typeof v === 'string' && v.length <= 1000, trilha: v => TRILHAS.includes(v) };
const MAX_HIST = 500;
const registrar = (plano, ev) => { plano.historico = (plano.historico || []).concat([{ ts: new Date().toISOString(), ...ev }]).slice(-MAX_HIST); };

function minutosDoDia(plano, d, ignorarId) { return plano.tarefas.filter(t => ativa(t) && t.data === d && t.id !== ignorarId && t.tipo !== 'prova').reduce((a, t) => a + (t.minutos || 0), 0); }
const horasDoPerfil = plano => (plano.perfil && Array.isArray(plano.perfil.horas) && plano.perfil.horas.length === 7) ? plano.perfil.horas : [0, 120, 120, 120, 120, 120, 0];

// Procura o dia (até `limite` dias à frente, antes da prova a que a tarefa se destina) que comporta a tarefa.
// Se nenhum comporta, devolve o menos sobrecarregado com o excedente em minutos — o chamador avisa o aluno.
export function diaLivre(plano, tarefa, hoje, { aPartirDe, limite = 14 } = {}) {
  const horas = horasDoPerfil(plano);
  const ini = aPartirDe || (tarefa.data > hoje ? tarefa.data : hoje);
  const provaFac = tarefa.trilha !== 'residencia' ? ((plano.perfil && plano.perfil.provasFaculdade) || []).filter(p => p.data >= hoje && discCompativel(p.disciplina, tarefa.materia)).map(p => p.data).sort()[0] : null;
  let melhor = null;
  for (let i = 1; i <= limite; i++) {
    const d = addDias(ini, i);
    if (provaFac && d >= provaFac) break; // não adia para depois da prova a que a tarefa se destina
    if (plano.tarefas.some(t => ativa(t) && t.tipo === 'prova' && t.data === d)) continue;
    const disp = horas[parseIso(d).getUTCDay()] || 0;
    if (disp <= 0) continue; // dia em que o aluno disse que não estuda
    const sobra = disp - minutosDoDia(plano, d, tarefa.id) - (tarefa.minutos || 0);
    if (sobra >= 0) return { data: d, excedente: 0 };
    if (!melhor || -sobra < melhor.excedente) melhor = { data: d, excedente: -sobra };
  }
  return melhor;
}

// acao: { tipo: 'concluir'|'reabrir'|'adiar'|'editar'|'cancelar', id, ... } — retorna { ok, plano?, msg?, aviso? }
export function aplicarAcao(plano, acao, { hoje } = {}) {
  if (!plano || !Array.isArray(plano.tarefas)) return { ok: false, msg: 'Plano inválido.' };
  if (!acao || typeof acao !== 'object') return { ok: false, msg: 'Ação inválida.' };
  const t = plano.tarefas.find(x => x.id === acao.id);
  if (!t) return { ok: false, msg: 'Tarefa não encontrada.' };
  const base = { id: t.id, chave: chaveTarefa(t), titulo: t.titulo };
  if (!ativa(t) && acao.tipo !== 'reabrir') return { ok: false, msg: 'Esta tarefa já foi cancelada ou reagendada.' };
  switch (acao.tipo) {
    case 'concluir':
      if (t.tipo === 'prova') return { ok: false, msg: 'Provas não são marcadas como concluídas.' };
      t.status = 'feito'; t.feitoEm = new Date().toISOString();
      if (Number.isInteger(acao.minutosReais) && acao.minutosReais > 0 && acao.minutosReais <= 600) t.minutosReais = acao.minutosReais;
      registrar(plano, { acao: 'concluir', ...base }); return { ok: true, plano };
    case 'reabrir':
      if (t.status !== 'feito' && t.status !== 'cancelado') return { ok: false, msg: 'Só tarefas concluídas ou canceladas podem ser reabertas.' };
      t.status = 'pendente'; delete t.feitoEm; delete t.canceladoEm;
      registrar(plano, { acao: 'reabrir', ...base }); return { ok: true, plano };
    case 'adiar': {
      if (t.tipo === 'prova') return { ok: false, msg: 'Provas não podem ser adiadas por aqui; edite o calendário de provas.' };
      if (t.status === 'feito') return { ok: false, msg: 'Tarefa já concluída.' };
      let para = acao.para, aviso;
      if (para !== undefined && para !== null && para !== '') {
        if (!isoValido(para)) return { ok: false, msg: 'Data inválida.' };
        if (hoje && para < hoje) return { ok: false, msg: 'Escolha uma data de hoje em diante.' };
        const cap = (horasDoPerfil(plano)[parseIso(para).getUTCDay()] || 0) - minutosDoDia(plano, para, t.id);
        if (cap < (t.minutos || 0)) aviso = `Atenção: ${para.split('-').reverse().join('/')} fica acima do tempo que você declarou disponível.`;
      } else {
        const d = diaLivre(plano, t, hoje || t.data);
        if (!d) return { ok: false, msg: 'Não encontrei um dia de estudo disponível nos próximos 14 dias antes da prova. Escolha uma data manualmente ou aumente sua disponibilidade.' };
        para = d.data;
        if (d.excedente > 0) aviso = `Todos os dias próximos já estão cheios: ${para.split('-').reverse().slice(0, 2).join('/')} ficou ${d.excedente} min acima da sua disponibilidade. Use "Replanejar" para reorganizar.`;
      }
      const de = t.data; t.adiadaDe = (t.adiadaDe || []).concat([de]).slice(-10); t.data = para; t.status = 'pendente'; t.editadaManual = true;
      registrar(plano, { acao: 'adiar', ...base, de, para });
      plano.tarefas.sort((a, b) => a.data.localeCompare(b.data));
      return { ok: true, plano, aviso, para };
    }
    case 'editar': {
      const campos = acao.campos;
      if (!campos || typeof campos !== 'object' || Array.isArray(campos)) return { ok: false, msg: 'Nada para editar.' };
      const chaves = Object.keys(campos);
      if (!chaves.length) return { ok: false, msg: 'Nada para editar.' };
      for (const k of chaves) { if (!EDITAVEIS[k]) return { ok: false, msg: `Campo não editável: ${k}.` }; if (!EDITAVEIS[k](campos[k])) return { ok: false, msg: `Valor inválido para ${k}.` }; }
      if (t.tipo === 'prova') return { ok: false, msg: 'Edite provas no calendário de provas.' };
      const antes = {}; for (const k of chaves) { antes[k] = t[k]; t[k] = typeof campos[k] === 'string' ? campos[k].trim() : campos[k]; }
      if ('minutos' in campos && t.estrategia) delete t.estrategia; // chips de tempo deixam de valer
      t.editadaManual = true; registrar(plano, { acao: 'editar', ...base, antes, depois: Object.fromEntries(chaves.map(k => [k, t[k]])) });
      plano.tarefas.sort((a, b) => a.data.localeCompare(b.data));
      return { ok: true, plano };
    }
    case 'cancelar':
      if (t.tipo === 'prova') return { ok: false, msg: 'Provas são removidas no calendário de provas.' };
      t.status = 'cancelado'; t.canceladoEm = new Date().toISOString(); t.motivoCancelamento = String(acao.motivo || '').slice(0, 200);
      registrar(plano, { acao: 'cancelar', ...base, motivo: t.motivoCancelamento }); return { ok: true, plano };
    default: return { ok: false, msg: 'Ação desconhecida.' };
  }
}

/* Replaneja daqui para frente. Preserva: concluídas, canceladas, reagendadas, edições manuais futuras.
   Atrasadas pendentes viram "reagendada" (ficam no histórico) e o conteúdo volta ao plano. Nada é duplicado:
   tarefas novas com a mesma chave de uma preservada (ou cancelada) são descartadas. */
export function replanejar({ plano, hoje, banco = null, associacoes = [], desempenho = {}, pesos, dias, motivo = '' }) {
  desfazerIntegracao(plano); // parte do plano original; a integração é recalculada no fim
  const perfil = plano.perfil;
  const antigas = plano.tarefas || [];
  const passadasFeitas = antigas.filter(t => t.status === 'feito' && t.data < hoje);
  const preservadas = antigas.filter(t => !passadasFeitas.includes(t) && (
    t.status === 'feito' || t.status === 'cancelado' || t.status === 'reagendada' || (t.editadaManual && t.data >= hoje && t.tipo !== 'prova')));
  let reagendadas = 0, descartadas = 0;
  for (const t of antigas) {
    if (passadasFeitas.includes(t) || preservadas.includes(t)) continue;
    if (t.data < hoje && t.tipo !== 'prova') { t.status = 'reagendada'; t.reagendadaEm = new Date().toISOString(); t.motivoRemocao = 'Atrasada: conteúdo reposto no novo plano.'; preservadas.push(t); reagendadas++; }
    else if (t.data >= hoje || t.tipo === 'prova') descartadas++; // tarefas futuras automáticas são recriadas pelo motor
  }
  const novo = PE.gerarTarefas({ perfil, hoje, inicio: hoje, dias, retidas: passadasFeitas.map(t => ({ ...t })), banco });
  novo.tarefas.forEach(t => delete t._vids);
  const bloqueadas = new Set(preservadas.filter(t => t.status === 'cancelado' || t.status === 'feito' || t.editadaManual).map(chaveTarefa));
  const idsMantidas = new Set(passadasFeitas.map(t => t.id));
  const revisao = (plano.revisao || 0) + 1;
  const recriadas = [];
  for (const t of novo.tarefas) {
    if (idsMantidas.has(t.id) && t.data < hoje) continue; // as concluídas do passado já entram abaixo, sem alteração
    if (bloqueadas.has(chaveTarefa(t))) continue;          // cancelada/feita/editada pelo aluno: não ressuscita
    recriadas.push({ ...t, id: `${t.id}-r${revisao}` });  // id único entre replanejamentos
  }
  const todas = [...passadasFeitas, ...preservadas, ...recriadas].sort((a, b) => a.data.localeCompare(b.data));
  const plano2 = { ...novo, tarefas: todas, historico: plano.historico || [], associacoes: plano.associacoes || [], revisao };
  registrar(plano2, { acao: 'replanejar', motivo: String(motivo).slice(0, 200), reagendadas, descartadasFuturas: descartadas, novas: recriadas.length });
  plano2.replanejadoEm = new Date().toISOString();
  anotarPlano(plano2, { hoje, associacoes, desempenho, pesos });
  return plano2;
}

/* ───────────────────────── Conferência de cronogramas (entrada validada) ─────────────────────────
   Recebe o que o parser determinístico ou a IA extraiu e devolve só campos conhecidos e válidos,
   mais a lista de ambiguidades que o aluno precisa resolver antes de virar plano. */
export function validarExtracao(x, { hoje } = {}) {
  const amb = [], faltando = [];
  const str = (v, n = 160) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const provas = [], aulas = [];
  for (const p of Array.isArray(x && x.provas) ? x.provas : []) {
    const disc = str(p && p.disciplina, 80);
    if (!disc) { amb.push({ tipo: 'prova_sem_disciplina', msg: 'Há uma prova sem nome de disciplina.', data: p && p.data }); continue; }
    if (!isoValido(p.data)) { amb.push({ tipo: 'prova_sem_data', msg: `A prova de ${disc} está sem data válida.` }); continue; }
    const assuntos = (Array.isArray(p.assuntos) ? p.assuntos : []).map(a => str(a, 140)).filter(Boolean).slice(0, 80);
    if (!assuntos.length) faltando.push({ tipo: 'prova_sem_conteudo', msg: `Sem conteúdo informado para a prova de ${disc} (${p.data.split('-').reverse().join('/')}).` });
    if (hoje && p.data < hoje) amb.push({ tipo: 'prova_no_passado', msg: `A prova de ${disc} está em ${p.data.split('-').reverse().join('/')}, que já passou. Confirme o ano.` });
    provas.push({ disciplina: disc, data: p.data, tipo: str(p.tipo, 30) || 'Prova', assuntos });
  }
  for (const a of Array.isArray(x && x.aulas) ? x.aulas : []) {
    const disc = str(a && a.disciplina, 80), tema = str(a && a.tema, 140);
    if (!tema) continue;
    if (!isoValido(a.data)) { amb.push({ tipo: 'aula_sem_data', msg: `A aula "${tema}" está sem data válida.` }); continue; }
    aulas.push({ disciplina: disc || 'Disciplina', data: a.data, tema, detalhe: str(a.detalhe, 600) });
  }
  const vistos = new Set();
  for (const p of provas) { const k = norm(p.disciplina) + p.data; if (vistos.has(k)) amb.push({ tipo: 'prova_duplicada', msg: `Prova duplicada: ${p.disciplina} em ${p.data}.` }); vistos.add(k); }
  const disciplinas = [...new Set([...provas.map(p => p.disciplina), ...aulas.map(a => a.disciplina)])];
  if (!provas.length) faltando.push({ tipo: 'sem_provas', msg: 'Nenhuma prova com data foi identificada.' });
  return { provas, aulas, disciplinas, ambiguidades: amb, faltando };
}

// Residência: "dd/mm[/aa] — tema" por linha (parser determinístico simples)
export function parseCronogramaResidencia(texto, hoje) {
  const ano = String(hoje || new Date().toISOString()).slice(0, 4);
  const itens = [];
  for (const l0 of String(texto || '').split(/\r?\n/)) {
    const l = l0.trim().replace(/^[*•\-–]\s*/, ''); if (!l) continue;
    const m = l.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*[:\-–—]?\s*(.+)$/);
    if (!m) continue;
    const a = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : ano;
    const data = `${a}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const tema = m[4].replace(/\s+/g, ' ').trim();
    if (isoValido(data) && tema.length >= 3) { const dd = detectDisc(tema); itens.push({ data, tema: tema.slice(0, 140), disciplina: dd ? (dd.go ? 'Obstetrícia' : dd.nome) : '' }); }
  }
  return { itens };
}
