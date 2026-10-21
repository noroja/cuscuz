// Rotas do Mentor IA acadêmico (Faculdade + Residência). NÃO substituem as rotas /api/planner/* existentes:
// somente acrescentam /api/planner/v3/*. Regras de negócio ficam aqui no backend; a IA só devolve JSON
// que é validado (campos conhecidos, datas reais) antes de virar dado do plano.
import * as PE from './planner-engine.js';
import * as PA from './planner-academico.js';
import { Type, pdfParaTexto } from './ai-provider.js';
import { enableSSE, okHoje } from './planner-routes.js';

const MAX_TEXTO = 150000;
const MAX_TAREFAS = 4000;
const MAX_ESTADO_BYTES = 4 * 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const falha = (res, status, msg, extra = {}) => res.status(status).json({ success: false, msg, ...extra });

function sanePlano(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.tarefas)) return null;
  if (p.tarefas.length > MAX_TAREFAS) return null;
  const tarefas = p.tarefas.filter(t => t && typeof t.id === 'string' && ISO.test(String(t.data || '')) && typeof t.tipo === 'string');
  return { ...p, tarefas, perfil: PE.sanePerfil(null, p.perfil || {}) };
}
function saneDesempenho(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  for (const [k, v] of Object.entries(d).slice(0, 200)) {
    const total = Math.max(0, Math.min(100000, parseInt(v && v.total, 10) || 0)), acertos = Math.max(0, Math.min(total, parseInt(v && v.acertos, 10) || 0));
    if (total) out[PE.norm(k).slice(0, 80)] = { acertos, total };
  }
  return out;
}
const saneAssoc = a => (Array.isArray(a) ? a : []).filter(x => x && typeof x.id === 'string' && ['sugerida', 'confirmada', 'rejeitada'].includes(x.status)).slice(0, 500)
  .map(x => ({ id: x.id.slice(0, 120), status: x.status, confianca: x.confianca === 'media' ? 'media' : 'alta', origem: x.origem === 'ia' ? 'ia' : 'automatica', fac: x.fac, res: x.res }));

/* Esquemas de extração pela IA (conferidos depois por validarExtracao) */
const S = Type.STRING;
const ESQ_FAC = { type: Type.OBJECT, required: ['provas', 'aulas'], properties: {
  provas: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['disciplina', 'data'], properties: { disciplina: { type: S }, data: { type: S, description: 'YYYY-MM-DD' }, tipo: { type: S }, assuntos: { type: Type.ARRAY, items: { type: S } } } } },
  aulas: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['disciplina', 'data', 'tema'], properties: { disciplina: { type: S }, data: { type: S, description: 'YYYY-MM-DD' }, tema: { type: S }, detalhe: { type: S } } } }
} };
const ESQ_RES = { type: Type.OBJECT, required: ['itens'], properties: { itens: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['tema'], properties: { semana: { type: Type.INTEGER }, data: { type: S, description: 'YYYY-MM-DD ou vazio' }, disciplina: { type: S }, tema: { type: S } } } } } };

function saneItensResidencia(itens) {
  const out = [];
  for (const it of Array.isArray(itens) ? itens : []) {
    const tema = String((it && it.tema) || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (tema.length < 3) continue;
    const semana = Number.isInteger(it.semana) && it.semana >= 1 && it.semana <= 120 ? it.semana : null;
    const data = ISO.test(String(it.data || '')) && !Number.isNaN(Date.parse(it.data)) ? it.data : null;
    const dd = PE.detectDisc(it.disciplina || tema);
    out.push({ semana, data, disciplina: String(it.disciplina || '').trim().slice(0, 60) || (dd ? (dd.go ? 'Obstetrícia' : dd.nome) : ''), tema });
  }
  return out.slice(0, 600);
}

// Semanas -> datas reais, respeitando os dias em que o aluno declarou poder estudar (uma tarefa por dia, em ordem)
export function distribuirSemanas(itens, inicioSemana1, horas) {
  const h = Array.isArray(horas) && horas.length === 7 ? horas : [0, 120, 120, 120, 120, 120, 0];
  const porSemana = new Map();
  for (const it of itens) if (!it.data && it.semana) { if (!porSemana.has(it.semana)) porSemana.set(it.semana, []); porSemana.get(it.semana).push(it); }
  for (const [sem, lista] of porSemana) {
    const base = PE.addDias(inicioSemana1, (sem - 1) * 7);
    const dias = []; for (let i = 0; i < 7; i++) { const d = PE.addDias(base, i); if ((h[PE.parseIso(d).getUTCDay()] || 0) >= 40) dias.push(d); }
    if (!dias.length) dias.push(base);
    lista.forEach((it, i) => { it.data = dias[Math.min(i, dias.length - 1)]; it.distribuida = true; });
  }
  return itens;
}

export function registerPlannerV3(app, { generateAI, aiConfigured, getBank, getSupabase, listarCronogramasAcervo, baixarArquivoDrive }) {
  const P = '/api/planner/v3';

  app.get(`${P}/status`, (_req, res) => res.json({
    success: true, ia: !!aiConfigured(), persistencia: getSupabase && getSupabase() ? 'supabase' : 'local',
    pesosPadrao: PA.PESOS_PADRAO, formatosSuportados: ['texto colado', '.txt', '.md', 'PDF com texto selecionável'], naoSuportados: ['imagens/PDF escaneado', '.docx']
  }));

  // Cronogramas do acervo (PDFs). O acervo NÃO tem cronogramas estruturados: o aluno escolhe um PDF e passa pela conferência.
  app.get(`${P}/acervo-cronogramas`, (_req, res) => {
    try { res.json({ success: true, estruturado: false, itens: listarCronogramasAcervo ? listarCronogramasAcervo() : [] }); }
    catch (e) { res.json({ success: true, estruturado: false, itens: [], msg: e.message }); }
  });

  /* 1) Conferência: lê o cronograma e devolve um RASCUNHO. Não altera plano nem perfil. */
  app.post(`${P}/conferir`, async (req, res) => {
    const trilha = req.body && req.body.trilha;
    if (!['faculdade', 'residencia'].includes(trilha)) return falha(res, 400, 'Trilha inválida.');
    const hoje = okHoje(req.body.hoje);
    enableSSE(req, res);
    try {
      let texto = String(req.body.texto || '').slice(0, MAX_TEXTO), fonte = 'texto colado';
      if (!texto && req.body.base64) {
        const b64 = String(req.body.base64); if (b64.length > 25 * 1024 * 1024) return falha(res, 413, 'Arquivo grande demais (máx. ~18 MB).');
        const mime = String(req.body.mime || '').toLowerCase(), nome = String(req.body.nome || '');
        fonte = nome || 'arquivo';
        if (mime === 'application/pdf' || /\.pdf$/i.test(nome)) texto = (await pdfParaTexto(b64)).slice(0, MAX_TEXTO);
        else if (mime.startsWith('text/') || /\.(txt|md)$/i.test(nome)) texto = Buffer.from(b64, 'base64').toString('utf8').slice(0, MAX_TEXTO);
        else return falha(res, 415, 'Formato não suportado. Envie PDF com texto selecionável, .txt/.md ou cole o texto.');
      }
      if (!texto && req.body.driveId && baixarArquivoDrive) {
        const buf = await baixarArquivoDrive(String(req.body.driveId));
        fonte = String(req.body.nome || 'PDF do acervo');
        texto = (await pdfParaTexto(buf.toString('base64'))).slice(0, MAX_TEXTO);
      }
      if (texto.trim().length < 30) return falha(res, 400, 'Texto vazio ou curto demais para ler um cronograma.');
      const ano = hoje.slice(0, 4);
      const comIA = async (esquema, instrucao) => {
        const r = await generateAI({ contents: `${instrucao}\n\nREGRAS: extraia SOMENTE o que está escrito no texto. Não invente datas, disciplinas, temas nem provas. Datas sem ano usam ${ano}. Deixe vazio o que não constar. Datas no formato YYYY-MM-DD.\n\nTEXTO:\n${texto.slice(0, 60000)}`, config: { temperature: 0, responseMimeType: 'application/json', responseSchema: esquema } });
        return JSON.parse(String(r.text).trim());
      };
      if (trilha === 'faculdade') {
        let origem = 'regras', det = null;
        try { det = PE.parseCronograma(texto, hoje); } catch (_) { det = null; }
        let bruto = det && ((det.provas || []).length || (det.aulas || []).length) ? { provas: det.provas, aulas: det.aulas } : null;
        if (!bruto) {
          if (!aiConfigured()) return res.json({ success: true, origem: 'nenhuma', iaDisponivel: false, rascunho: PA.validarExtracao({}, { hoje }), ambiguidades: [{ tipo: 'formato', msg: 'Não reconheci o formato do cronograma e a IA não está configurada (GROQ_API_KEY). Use linhas como "1. Disciplina" seguidas de "* dd/mm: conteúdo".' }], faltando: [] });
          bruto = await comIA(ESQ_FAC, 'Você lê cronogramas de faculdade de Medicina. Extraia as avaliações (provas) com disciplina, data e assuntos, e as aulas com disciplina, data e tema.'); origem = 'ia';
        }
        const v = PA.validarExtracao(bruto, { hoje });
        return res.json({ success: true, origem, trilha, fonte, rascunho: { provas: v.provas, aulas: v.aulas, disciplinas: v.disciplinas }, ambiguidades: v.ambiguidades, faltando: v.faltando,
          aviso: origem === 'ia' ? 'Extraído por IA: confira cada linha antes de confirmar.' : undefined });
      }
      // residência
      let origem = 'regras'; let itens = PA.parseCronogramaResidencia(texto, hoje).itens;
      if (!itens.length) {
        if (!aiConfigured()) return res.json({ success: true, origem: 'nenhuma', iaDisponivel: false, trilha, fonte, rascunho: { itens: [] }, ambiguidades: [{ tipo: 'formato', msg: 'Não reconheci o formato e a IA não está configurada. Use linhas "dd/mm: tema" ou crie o cronograma manualmente.' }], faltando: [] });
        itens = saneItensResidencia((await comIA(ESQ_RES, 'Você lê cronogramas de preparação para residência médica. Extraia cada tema de estudo com a semana (número) e/ou a data, e a disciplina.')).itens); origem = 'ia';
      } else itens = saneItensResidencia(itens);
      const semData = itens.filter(i => !i.data).length;
      return res.json({ success: true, origem, trilha, fonte, rascunho: { itens }, ambiguidades: semData ? [{ tipo: 'sem_data', msg: `${semData} item(ns) só têm a semana. Informe a data de início da semana 1 para distribuir nos seus dias de estudo.` }] : [],
        faltando: itens.length ? [] : [{ tipo: 'vazio', msg: 'Nenhum tema identificado.' }], aviso: origem === 'ia' ? 'Extraído por IA: confira cada linha antes de confirmar.' : undefined });
    } catch (e) {
      console.warn('[Planner v3 conferir]', e.message);
      return res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ success: false, msg: e.message, codigo: e.code });
    }
  });

  /* 2) Confirmação: o aluno revisou/corrigiu o rascunho → gera o perfil atualizado (ainda sem plano) */
  app.post(`${P}/confirmar-faculdade`, (req, res) => {
    try {
      const hoje = okHoje(req.body.hoje);
      const v = PA.validarExtracao(req.body.rascunho || {}, { hoje });
      if (!v.provas.length && !v.aulas.length) return falha(res, 400, 'Nada para confirmar: o rascunho está vazio.');
      const base = PE.sanePerfil(null, req.body.perfil || {});
      const objetivo = base.objetivo || 'graduacao';
      let perfil;
      if (req.body.modo === 'substituir') {
        perfil = { ...base, provasFaculdade: [], aulasFaculdade: [], disciplinasConfirmadas: [] };
        perfil = PE.sanePerfil(perfil, { objetivo, provasFaculdade: v.provas, aulasFaculdade: v.aulas, semProvas: !v.provas.length, semConteudo: false, manualNome: 'Cronograma da faculdade' });
      } else {
        perfil = PE.mesclarCronograma({ ...base, objetivo }, { disciplina: v.disciplinas.join(', '), disciplinas: v.disciplinas, provas: v.provas, aulas: v.aulas });
      }
      perfil = PE.sanePerfil(perfil, { objetivo, conteudoConfirmado: true, disciplinasConfirmadas: v.disciplinas });
      res.json({ success: true, perfil, resumo: { provas: v.provas.length, aulas: v.aulas.length, disciplinas: v.disciplinas.length }, faltando: v.faltando });
    } catch (e) { falha(res, 500, e.message); }
  });

  app.post(`${P}/confirmar-residencia`, (req, res) => {
    try {
      const base = PE.sanePerfil(null, req.body.perfil || {});
      let itens = saneItensResidencia(req.body.itens);
      if (!itens.length) return falha(res, 400, 'Nada para confirmar: nenhum tema válido.');
      if (itens.some(i => !i.data)) {
        const ini = req.body.inicioSemana1;
        if (!ISO.test(String(ini || '')) || Number.isNaN(Date.parse(ini))) return falha(res, 400, 'Há itens só com semana: informe a data de início da semana 1.');
        itens = distribuirSemanas(itens, ini, base.horas);
      }
      const comData = itens.filter(i => i.data);
      const descartados = itens.length - comData.length;
      const objetivo = base.objetivo === 'graduacao' ? 'ambos' : (base.objetivo || 'residencia');
      const patch = { objetivo, cronogramaResidencia: comData.map(i => ({ data: i.data, tema: i.tema, disciplina: i.disciplina })) };
      if (ISO.test(String(req.body.dataProva || ''))) patch.dataProva = req.body.dataProva;
      if (typeof req.body.alvo === 'string' && req.body.alvo.trim()) patch.alvo = req.body.alvo.trim();
      const perfil = PE.sanePerfil(base, patch);
      res.json({ success: true, perfil, resumo: { itens: comData.length, distribuidos: itens.filter(i => i.distribuida).length, descartados } });
    } catch (e) { falha(res, 500, e.message); }
  });

  // Edição simples do perfil do motor (campos conhecidos, sempre sanitizados pelo mesmo validador do chat)
  app.post(`${P}/perfil`, (req, res) => {
    try {
      const base = PE.sanePerfil(null, req.body.perfil || {});
      const patch = req.body.patch && typeof req.body.patch === 'object' ? req.body.patch : {};
      const permitidos = ['objetivo', 'alvo', 'dataProva', 'semData', 'provasFaculdade', 'semProvas', 'horas', 'dificuldades', 'fortes', 'semDificuldades', 'metodo', 'cursos', 'anseios'];
      const filtrado = {}; for (const k of permitidos) if (k in patch) filtrado[k] = patch[k];
      if ('provasFaculdade' in filtrado && Array.isArray(filtrado.provasFaculdade) && !filtrado.provasFaculdade.length) { filtrado.semProvas = true; delete filtrado.provasFaculdade; }
      res.json({ success: true, perfil: PE.sanePerfil(base, filtrado) });
    } catch (e) { falha(res, 500, e.message); }
  });

  /* 3) Integração / priorização de um plano existente */
  const contexto = body => ({ hoje: okHoje(body.hoje), associacoes: saneAssoc(body.associacoes), desempenho: saneDesempenho(body.desempenho), pesos: body.pesos });

  app.post(`${P}/integrar`, (req, res) => {
    const plano = sanePlano(req.body.plano); if (!plano) return falha(res, 400, 'Plano inválido.');
    try {
      PA.anotarPlano(plano, contexto(req.body));
      res.json({ success: true, plano });
    } catch (e) { falha(res, 500, e.message); }
  });

  app.post(`${P}/acao`, (req, res) => {
    const plano = sanePlano(req.body.plano); if (!plano) return falha(res, 400, 'Plano inválido.');
    const ctx = contexto(req.body);
    const r = PA.aplicarAcao(plano, req.body.acao, { hoje: ctx.hoje });
    if (!r.ok) return falha(res, 422, r.msg);
    try { PA.anotarPlano(r.plano, { ...ctx, associacoes: (r.plano.associacoes && r.plano.associacoes.length ? r.plano.associacoes : ctx.associacoes) }); } catch (_) { /* a ação já foi aplicada */ }
    res.json({ success: true, plano: r.plano, aviso: r.aviso, para: r.para });
  });

  app.post(`${P}/replanejar`, (req, res) => {
    const plano = sanePlano(req.body.plano); if (!plano) return falha(res, 400, 'Plano inválido.');
    if (!plano.perfil || !plano.perfil.objetivo) return falha(res, 400, 'Perfil incompleto: falta o objetivo.');
    try {
      const ctx = contexto(req.body);
      const dias = req.body.dias ? Math.max(7, Math.min(120, +req.body.dias)) : undefined;
      const novo = PA.replanejar({ plano, hoje: ctx.hoje, banco: typeof getBank === 'function' ? getBank() : null, associacoes: ctx.associacoes, desempenho: ctx.desempenho, pesos: ctx.pesos, dias, motivo: req.body.motivo });
      res.json({ success: true, plano: novo });
    } catch (e) { console.error('[Planner v3 replanejar]', e); falha(res, 500, e.message); }
  });

  /* 4) IA opcional: julga se pares de média confiança são o MESMO conteúdo. Só um booleano por par volta ao backend. */
  app.post(`${P}/refinar-associacoes`, async (req, res) => {
    enableSSE(req, res);
    try {
      if (!aiConfigured()) return res.json({ success: true, ia: false, veredictos: {} });
      const pares = (Array.isArray(req.body.associacoes) ? req.body.associacoes : []).filter(a => a && a.confianca === 'media' && a.status === 'sugerida' && a.fac && a.res).slice(0, 20);
      if (!pares.length) return res.json({ success: true, ia: true, veredictos: {} });
      const ids = new Set(pares.map(a => a.id));
      const lista = pares.map(a => `- id=${a.id} | faculdade (${String(a.fac.materia).slice(0, 60)}): ${String(a.fac.tema).slice(0, 140)} | residência (${String(a.res.materia).slice(0, 60)}): ${String(a.res.tema).slice(0, 140)}`).join('\n');
      const r = await generateAI({
        contents: `Para cada par, decida se o tema da faculdade e o da residência exigem estudar essencialmente o MESMO conteúdo (mesma doença/conceito, profundidade compatível). Palavras parecidas não bastam. Em caso de dúvida, responda false.\n${lista}`,
        config: { temperature: 0, responseMimeType: 'application/json', responseSchema: { type: Type.OBJECT, required: ['veredictos'], properties: { veredictos: { type: Type.ARRAY, items: { type: Type.OBJECT, required: ['id', 'equivalente'], properties: { id: { type: S }, equivalente: { type: Type.BOOLEAN }, motivo: { type: S } } } } } } }
      });
      const j = JSON.parse(String(r.text).trim());
      const veredictos = {};
      for (const v of Array.isArray(j.veredictos) ? j.veredictos : []) if (v && ids.has(v.id) && typeof v.equivalente === 'boolean') veredictos[v.id] = { equivalente: v.equivalente, motivo: String(v.motivo || '').slice(0, 160) };
      res.json({ success: true, ia: true, veredictos });
    } catch (e) { res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ success: false, msg: e.message, codigo: e.code }); }
  });

  /* 5) Persistência por usuário (sobrevive à troca de dispositivo). Sem Supabase: responde offline e o app segue só com o armazenamento local. */
  app.get(`${P}/estado`, async (req, res) => {
    const sb = getSupabase && getSupabase();
    if (!sb) return res.json({ success: false, offline: true });
    try {
      const { data, error } = await sb.from('planner_estado').select('estado, atualizado').eq('username', req.user.username).maybeSingle();
      if (error) return res.json({ success: false, offline: true, msg: error.message });
      res.json({ success: true, dados: data ? { estado: data.estado || {}, atualizado: Number(data.atualizado) || 0 } : null });
    } catch (e) { res.json({ success: false, offline: true, msg: e.message }); }
  });
  app.put(`${P}/estado`, async (req, res) => {
    const sb = getSupabase && getSupabase();
    if (!sb) return res.json({ success: false, offline: true });
    const e = req.body && req.body.estado;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return falha(res, 400, 'Estado inválido.');
    const estado = {};
    for (const k of ['perfilAcademico', 'plano']) if (e[k] && typeof e[k] === 'object') estado[k] = e[k];
    if (estado.plano && !sanePlano(estado.plano)) return falha(res, 400, 'Plano inválido.');
    if (Buffer.byteLength(JSON.stringify(estado)) > MAX_ESTADO_BYTES) return falha(res, 413, 'Estado grande demais.');
    try {
      const { error } = await sb.from('planner_estado').upsert({ username: req.user.username, estado, atualizado: Number(req.body.atualizado) || Date.now() }, { onConflict: 'username' });
      if (error) return res.json({ success: false, offline: true, msg: error.message });
      res.json({ success: true });
    } catch (err) { res.json({ success: false, offline: true, msg: err.message }); }
  });
}
