// Testes do Mentor IA acadêmico. Groq e Supabase são SIMULADOS (nenhuma chamada real a serviços externos).
import http from 'http';
import express from 'express';
import assert from 'assert/strict';

// ── Groq falso ────────────────────────────────────────────────────────────────
let groqModo = 'fac';
const groq = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const j = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: typeof o === 'string' ? o : JSON.stringify(o) }, finish_reason: 'stop' }], model: 'fake' })); };
    if (groqModo === 'invalido') return j('isto não é json');
    if (groqModo === 'fac') return j({ provas: [{ disciplina: 'Nefrologia', data: '2026-11-10', tipo: 'P1', assuntos: ['DRC', 'Glomerulopatias'] }, { disciplina: 'Nefrologia', data: '2026/99/99', assuntos: [] }], aulas: [{ disciplina: 'Nefrologia', data: '2026-10-28', tema: 'Injúria renal aguda' }], extra_perigoso: 'DROP TABLE' });
    if (groqModo === 'assoc') { const m = JSON.parse(b).messages.at(-1).content.match(/id=([^\s|]+)/g) || []; return j({ veredictos: [...m.map(x => ({ id: x.slice(3), equivalente: true, motivo: 'mesmo conteúdo' })), { id: 'id-inventado', equivalente: true }] }); }
    j({});
  });
});
await new Promise(r => groq.listen(0, r));
process.env.GROQ_BASE_URL = `http://127.0.0.1:${groq.address().port}/v1`;
process.env.GROQ_API_KEY = 'gsk_fake'; process.env.GROQ_MAX_RETRIES = '0';

const PE = await import('../../src/planner-engine.js');
const PA = await import('../../src/planner-academico.js');
const { registerPlannerV3 } = await import('../../src/planner-v3-routes.js');
const { registerPlanner } = await import('../../src/planner-routes.js');
const AI = await import('../../src/ai-provider.js');

// ── Supabase falso (em memória) ──────────────────────────────────────────────
const tabela = new Map();
const fakeSb = { from: () => ({
  select: () => ({ eq: (_c, u) => ({ maybeSingle: async () => ({ data: tabela.get(u) || null, error: null }) }) }),
  upsert: async (row) => { tabela.set(row.username, { estado: row.estado, atualizado: row.atualizado }); return { error: null }; }
}) };

const app = express(); app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => { req.user = { username: req.headers['x-user'] || 'ana' }; next(); });
let comIA = true;
registerPlannerV3(app, { generateAI: AI.generateAI, aiConfigured: () => comIA, getBank: () => null, getSupabase: () => fakeSb, listarCronogramasAcervo: () => [{ id: 'x', nome: 'Cronograma Extensivo', curso: 'MED', pasta: 'p' }], baixarArquivoDrive: async () => { throw new Error('sem drive no teste'); } });
registerPlanner(app, { generateAI: AI.generateAI, aiConfigured: () => comIA, getBank: () => null });
const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/planner/v3`;
const post = async (rota, body, user = 'ana', method = 'POST') => { const r = await fetch(base + rota, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const get = async (rota, user = 'ana') => { const r = await fetch(base + rota, { headers: { 'x-user': user } }); return { status: r.status, j: await r.json().catch(() => ({})) }; };

const hoje = '2026-10-20';
const CRON_FAC = `1. Infectologia\n * 21/10/26: Sepse e choque séptico; Pneumonia comunitária\n * 23/10/26: HIV e infecções oportunistas\n * 05/11/26: Prova PR1\n2. Cardiologia\n * 22/10/26: Insuficiência cardíaca\n * 06/11/26: Prova PR1`;
const gerar = (extra = {}, dias = 21) => { const perfil = PE.sanePerfil(null, { objetivo: 'ambos', dataProva: '2027-01-15', horas: [0, 120, 120, 120, 120, 120, 60], ...extra }); return PE.gerarTarefas({ perfil: PE.mesclarCronograma(perfil, PE.parseCronograma(CRON_FAC, hoje)), hoje, inicio: hoje, dias, retidas: [], banco: null }); };
const ativas = p => p.tarefas.filter(PA.ativa);

const res = []; const teste = async (nome, fn) => { try { await fn(); res.push(['OK ', nome]); } catch (e) { res.push(['FALHOU', nome, String(e.message).split('\n')[0] + ' @linha ' + ((String(e.stack).match(/test\.mjs:(\d+)/) || [])[1] || '?')]); } };

// 9 ── importação e correção de cronogramas
await teste('9a. conferir (faculdade, regras) devolve rascunho sem alterar nada', async () => {
  const { j } = await post('/conferir', { trilha: 'faculdade', texto: CRON_FAC, hoje });
  assert.equal(j.success, true); assert.equal(j.origem, 'regras');
  assert.equal(j.documento.texto, CRON_FAC); assert.equal(j.documento.nome, 'texto colado');
  assert.equal(j.rascunho.provas.length, 2); assert.ok(j.rascunho.aulas.length >= 3);
});
await teste('9b. detecta ambiguidades: prova no passado e sem conteúdo', async () => {
  const v = PA.validarExtracao({ provas: [{ disciplina: 'Física', data: '2026-01-10', assuntos: [] }, { disciplina: '', data: '2026-11-01' }, { disciplina: 'X', data: 'xx' }] }, { hoje });
  assert.ok(v.ambiguidades.some(a => a.tipo === 'prova_no_passado')); assert.ok(v.ambiguidades.some(a => a.tipo === 'prova_sem_disciplina')); assert.ok(v.ambiguidades.some(a => a.tipo === 'prova_sem_data')); assert.ok(v.faltando.some(a => a.tipo === 'prova_sem_conteudo'));
});
await teste('9c. IA como extrator: valida datas, descarta campos desconhecidos e linhas inválidas', async () => {
  groqModo = 'fac';
  const { j } = await post('/conferir', { trilha: 'faculdade', texto: 'Nefro: prova primeira em novembro, aula de IRA no fim de outubro. '.repeat(3), hoje });
  assert.equal(j.origem, 'ia'); assert.equal(j.rascunho.provas.length, 1); assert.equal(j.rascunho.provas[0].data, '2026-11-10');
  assert.ok(!JSON.stringify(j).includes('DROP TABLE'));
});
await teste('9d. IA devolvendo JSON inválido: erro explícito, sem inventar plano', async () => {
  groqModo = 'invalido';
  const { status, j } = await post('/conferir', { trilha: 'faculdade', texto: 'texto livre sem formato nenhum de cronograma '.repeat(4), hoje });
  assert.equal(j.success, false); assert.ok(status >= 400);
});
await teste('9e. sem IA e formato desconhecido: orienta o aluno (sem falhar)', async () => {
  comIA = false;
  const { j } = await post('/conferir', { trilha: 'faculdade', texto: 'texto livre sem formato nenhum de cronograma '.repeat(4), hoje });
  comIA = true;
  assert.equal(j.success, true); assert.equal(j.iaDisponivel, false); assert.ok(j.ambiguidades.length);
});
await teste('9f. formato não suportado (docx/imagem) é recusado com mensagem', async () => {
  const { j } = await post('/conferir', { trilha: 'faculdade', base64: 'AAAA', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', nome: 'a.docx', hoje });
  assert.equal(j.success, false); assert.match(j.msg, /Formato não suportado/);
});
await teste('9g. correção manual: confirmar-faculdade usa o rascunho EDITADO pelo aluno', async () => {
  const { j: c } = await post('/conferir', { trilha: 'faculdade', texto: CRON_FAC, hoje });
  const r = c.rascunho; r.provas[0].data = '2026-11-09'; r.provas = r.provas.filter(p => !/Cardio/i.test(p.disciplina));
  const { j } = await post('/confirmar-faculdade', { rascunho: r, perfil: { objetivo: 'graduacao' }, modo: 'substituir', hoje });
  assert.equal(j.success, true); assert.equal(j.perfil.provasFaculdade.length, 1); assert.equal(j.perfil.provasFaculdade[0].data, '2026-11-09'); assert.equal(j.perfil.conteudoConfirmado, true);
});
await teste('9h. residência: linhas "dd/mm: tema" + semanas distribuídas nos dias de estudo', async () => {
  const { j } = await post('/conferir', { trilha: 'residencia', texto: '21/10: Sepse e choque séptico\n22/10: Insuficiência cardíaca', hoje });
  assert.equal(j.rascunho.itens.length, 2);
  const sem = await post('/confirmar-residencia', { perfil: { objetivo: 'residencia', horas: [0, 120, 120, 120, 120, 120, 0] }, itens: [{ semana: 1, tema: 'Sepse' }, { semana: 1, tema: 'ICC' }, { semana: 2, tema: 'DPOC' }] });
  assert.equal(sem.j.success, false); // falta início da semana 1
  const ok = await post('/confirmar-residencia', { perfil: { objetivo: 'residencia', horas: [0, 120, 120, 120, 120, 120, 0] }, itens: [{ semana: 1, tema: 'Sepse' }, { semana: 1, tema: 'ICC' }, { semana: 2, tema: 'DPOC' }], inicioSemana1: '2026-10-19' });
  assert.equal(ok.j.perfil.cronogramaResidencia.length, 3);
  const dias = ok.j.perfil.cronogramaResidencia.map(i => PE.parseIso(i.data).getUTCDay()); assert.ok(dias.every(d => d >= 1 && d <= 5), 'só dias com disponibilidade');
});
await teste('9i. resposta longa com conteúdos por disciplina não cai no fallback de cronograma', async () => {
  comIA = false;
  const perfil = PE.sanePerfil(null, { objetivo: 'graduacao', provasFaculdade: [
    { disciplina: 'Doenças Infectoparasitárias', data: '2026-11-10', assuntos: [] },
    { disciplina: 'IESC VIII', data: '2026-11-11', assuntos: [] },
    { disciplina: 'Emergência e Terapia Intensiva', data: '2026-11-12', assuntos: [] }
  ] });
  const texto = '«Emergência: CAD, EHH e Hipoglicemia, Atendimento Inicial ao Trauma, TCE, Paciente queimado, Afogamento, Intoxicações exógenas; Terapia Intensiva: Distúrbios Hidroeletrolíticos e ácido base, Injúria renal e prescrição de diluições, Aspectos éticos e cuidados paliativos, Sedação e analgesia, POCUS em terapia intensiva; Imagenologia: Imagens radiológicas no trauma, Imagens em patologias abdominais, geniturinárias e mamárias, Imagens radiológicas em obstetrícia; Saúde Mental: Transtornos de ansiedade, TOC, TEPT, Emergências psiquiátricas, agitação e contenção, Transtornos alimentares, Transtornos relacionados ao uso de substâncias psicoativas, Psiquiatria da infância e da adolescência; HMP VIII: esquecimento, delirium, depressão e demência, dispneia, Asma, DPOC, IC, dor crônica, Atenção domiciliar e complicações em idosos domiciliados; Doenças Infectoparasitárias: IST, Protozooses, Helmintíases, Acidentes por animais peçonhentos, infecção em contextos de imunossupressão, Infecções relacionadas aos cuidados à saúde; IESC VIII: Todo o conteúdo até a data»';
  const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/planner/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hoje, asking: 'conteudo', perfil, messages: [{ role: 'user', content: texto }] }) });
  const j = await r.json(); comIA = true;
  assert.equal(j.success, true); assert.equal(j.ia, false);
  assert.ok(!j.reply.includes('não consegui identificar com segurança'));
  assert.ok(j.perfil.provasFaculdade.find(p => p.disciplina === 'Doenças Infectoparasitárias').assuntos.some(a => /Protozooses/.test(a)));
  assert.ok(j.perfil.provasFaculdade.find(p => p.disciplina === 'IESC VIII').assuntos.some(a => /Todo o conteúdo/.test(a)));
  assert.ok(j.perfil.provasFaculdade.find(p => p.disciplina === 'Emergência e Terapia Intensiva').assuntos.some(a => /Hipoglicemia/.test(a)));
});

// 10 / 11 ── planos por trilha
await teste('10. plano de faculdade: tudo na trilha faculdade, com provas', async () => {
  const perfil = PE.mesclarCronograma(PE.sanePerfil(null, { objetivo: 'graduacao', horas: [0, 120, 120, 120, 120, 120, 60] }), PE.parseCronograma(CRON_FAC, hoje));
  const p = PE.gerarTarefas({ perfil, hoje, inicio: hoje, dias: 21, retidas: [], banco: null }); PA.anotarPlano(p, { hoje });
  assert.ok(p.tarefas.length > 5); assert.ok(p.tarefas.every(t => t.trilha === 'faculdade')); assert.ok(p.tarefas.some(t => t.tipo === 'prova'));
});
await teste('11. plano de residência com cronograma do aluno: tarefas nas datas marcadas', async () => {
  const perfil = PE.sanePerfil(null, { objetivo: 'residencia', dataProva: '2027-01-15', horas: [0, 120, 120, 120, 120, 120, 60], cronogramaResidencia: [{ data: '2026-10-21', tema: 'Sepse e choque séptico', disciplina: 'Infectologia' }, { data: '2026-10-22', tema: 'Insuficiência cardíaca', disciplina: 'Cardiologia' }] });
  const p = PE.gerarTarefas({ perfil, hoje, inicio: hoje, dias: 10, retidas: [], banco: null }); PA.anotarPlano(p, { hoje });
  const a = p.tarefas.find(t => /Sepse/.test(t.titulo)), b = p.tarefas.find(t => /Insuficiência/.test(t.titulo));
  assert.equal(a.data, '2026-10-21'); assert.equal(b.data, '2026-10-22'); assert.ok(p.tarefas.every(t => t.trilha === 'residencia'));
});

// 12 ── integração sem duplicação
await teste('12a. assunto comum vira sessão compartilhada e a teoria não é duplicada', async () => {
  const p = gerar(); const semInteg = JSON.parse(JSON.stringify(p));
  PA.anotarPlano(p, { hoje });
  assert.ok(p.integracao.aplicadas.length >= 1);
  for (const ap of p.integracao.aplicadas) {
    const prin = p.tarefas.find(t => t.id === ap.principal), sec = p.tarefas.find(t => t.id === ap.secundaria);
    assert.equal(prin.trilha, 'compartilhada');
    assert.ok(sec.status === 'reagendada' || !(sec.passos || []).some(s => s.acao === 'aula' || s.acao === 'resumo'), 'sem teoria repetida');
  }
  const min = x => x.tarefas.filter(PA.ativa).reduce((a, t) => a + (t.minutos || 0), 0);
  assert.ok(min(p) < min(semInteg), 'tempo não contado duas vezes');
  assert.ok(p.integracao.minutosEconomizados > 0);
});
await teste('12b. palavras parecidas NÃO bastam: temas diferentes não são associados', async () => {
  assert.equal(PA.compararTemas('Hipertensão arterial sistêmica', 'Cardiologia', 'Hipertensão intracraniana', 'Neurologia').confianca, null);
  assert.equal(PA.compararTemas('Sepse e choque séptico', 'Infectologia', 'Sepse e choque séptico', 'Infectologia').confianca, 'alta');
});
await teste('12c. rejeitar a associação restaura as tarefas originais (reversível)', async () => {
  const p = gerar(); const orig = JSON.parse(JSON.stringify(p.tarefas));
  PA.anotarPlano(p, { hoje });
  const rejeitadas = p.associacoes.map(a => ({ ...a, status: 'rejeitada' }));
  PA.anotarPlano(p, { hoje, associacoes: rejeitadas });
  assert.equal(p.integracao.aplicadas.length, 0);
  for (const o of orig) { const t = p.tarefas.find(x => x.id === o.id); assert.ok(t, 'tarefa existe'); assert.equal(t.minutos, o.minutos); assert.equal(t.passos.length, o.passos.length); assert.ok(PA.ativa(t)); }
});
await teste('12d. associação de média confiança só é aplicada depois que o aluno confirma', async () => {
  const prep = () => { const x = gerar(); PA.classificarTrilhas(x); return x; };
  const alvo = PA.sugerirAssociacoes(prep())[0]; assert.ok(alvo);
  assert.equal(PA.integrar(prep(), [{ ...alvo, confianca: 'media', status: 'sugerida' }]).aplicadas.length, 0);
  assert.equal(PA.integrar(prep(), [{ ...alvo, confianca: 'media', status: 'confirmada' }]).aplicadas.length, 1);
  assert.equal(PA.integrar(prep(), [{ ...alvo, confianca: 'alta', status: 'rejeitada' }]).aplicadas.length, 0);
});
await teste('12e. priorização: pesos configuráveis e justificativa em português', async () => {
  const p = gerar(); PA.anotarPlano(p, { hoje, desempenho: { infectologia: { acertos: 2, total: 10 } } });
  const t = p.tarefas.find(x => x.tipo === 'estudo' && /Infectologia/.test(x.materia));
  assert.ok(t.prioridade >= 0 && t.prioridade <= 100); assert.ok(t.justificativa.length > 10); assert.match(t.justificativa, /erro|prova|sessão|conteúdo|material|útil/i);
  const w = PA.normalizarPesos({ prova: 500, desempenho: -3, material: 'x' }); assert.equal(w.prova, PA.PESOS_PADRAO.prova); assert.equal(w.desempenho, PA.PESOS_PADRAO.desempenho);
  const a = gerar(); PA.anotarPlano(a, { hoje, pesos: { prova: 100, desempenho: 0, revisao: 0, volume: 0, conteudo: 0, sinergia: 0, material: 0 } });
  const b = gerar(); PA.anotarPlano(b, { hoje, pesos: { prova: 0, desempenho: 0, revisao: 0, volume: 0, conteudo: 0, sinergia: 0, material: 100 } });
  assert.notDeepEqual(a.tarefas.map(x => x.prioridade), b.tarefas.map(x => x.prioridade));
});
await teste('12f. IA refina associações: só vereditos de ids conhecidos (id inventado é ignorado)', async () => {
  groqModo = 'assoc';
  const { j } = await post('/refinar-associacoes', { associacoes: [{ id: 'a1', confianca: 'media', status: 'sugerida', fac: { materia: 'A', tema: 'x' }, res: { materia: 'B', tema: 'y' } }] });
  assert.deepEqual(Object.keys(j.veredictos), ['a1']);
});

// 13 ── concluir, adiar, editar, cancelar, replanejar
await teste('13a. concluir/adiar/editar/cancelar com histórico', async () => {
  const p = gerar(); PA.anotarPlano(p, { hoje });
  const [t1, t2, t3] = p.tarefas.filter(t => t.tipo === 'estudo' && PA.ativa(t) && t.data >= hoje);
  let r = PA.aplicarAcao(p, { tipo: 'concluir', id: t1.id }, { hoje }); assert.ok(r.ok); assert.equal(t1.status, 'feito');
  const de = t2.data; r = PA.aplicarAcao(p, { tipo: 'adiar', id: t2.id }, { hoje }); assert.ok(r.ok, r.msg); assert.ok(t2.data > de); assert.deepEqual(t2.adiadaDe, [de]);
  r = PA.aplicarAcao(p, { tipo: 'editar', id: t3.id, campos: { minutos: 30, titulo: 'Meu título' } }, { hoje }); assert.ok(r.ok); assert.equal(t3.minutos, 30);
  r = PA.aplicarAcao(p, { tipo: 'editar', id: t3.id, campos: { status: 'feito' } }, { hoje }); assert.equal(r.ok, false); // campo não editável
  r = PA.aplicarAcao(p, { tipo: 'editar', id: t3.id, campos: { minutos: 9999 } }, { hoje }); assert.equal(r.ok, false);
  r = PA.aplicarAcao(p, { tipo: 'adiar', id: t3.id, para: '2020-01-01' }, { hoje }); assert.equal(r.ok, false);
  r = PA.aplicarAcao(p, { tipo: 'cancelar', id: t3.id, motivo: 'não preciso' }, { hoje }); assert.ok(r.ok); assert.equal(t3.status, 'cancelado');
  assert.deepEqual(p.historico.map(h => h.acao), ['concluir', 'adiar', 'editar', 'cancelar']);
});
await teste('13b. replanejar preserva concluídas/canceladas, não duplica e guarda histórico', async () => {
  const p = gerar({}, 28); PA.anotarPlano(p, { hoje });
  const futuras = p.tarefas.filter(t => t.tipo === 'estudo' && PA.ativa(t) && t.data >= hoje);
  const feita = futuras[0], cancelada = futuras[3], editada = futuras[5];
  PA.aplicarAcao(p, { tipo: 'concluir', id: feita.id }, { hoje });
  PA.aplicarAcao(p, { tipo: 'cancelar', id: cancelada.id }, { hoje });
  PA.aplicarAcao(p, { tipo: 'editar', id: editada.id, campos: { titulo: 'Fixa do aluno' } }, { hoje });
  const antigaPassada = { ...p.tarefas[0], id: 'v2-antiga', data: '2026-10-15', status: 'pendente', tipo: 'estudo', titulo: 'Atrasada', materia: 'Pediatria', tema: 'Atrasado' }; p.tarefas.unshift(antigaPassada);
  const novo = PA.replanejar({ plano: p, hoje: '2026-10-22', banco: null, motivo: 'imprevisto' });
  const ids = novo.tarefas.map(t => t.id); assert.equal(new Set(ids).size, ids.length, 'ids únicos');
  assert.equal(novo.tarefas.find(t => t.id === feita.id).status, 'feito');
  assert.equal(novo.tarefas.find(t => t.id === cancelada.id).status, 'cancelado');
  assert.ok(!novo.tarefas.some(t => PA.ativa(t) && t.id !== cancelada.id && PA.chaveTarefa(t) === PA.chaveTarefa(cancelada) && t.data >= '2026-10-22'), 'cancelada não ressuscita');
  assert.equal(novo.tarefas.find(t => t.id === editada.id).titulo, 'Fixa do aluno');
  assert.equal(novo.tarefas.find(t => t.id === 'v2-antiga').status, 'reagendada');
  assert.ok(novo.historico.some(h => h.acao === 'replanejar') && novo.historico.some(h => h.acao === 'concluir'));
  const idem = novo.tarefas.filter(PA.ativa).map(t => t.data + '|' + t.titulo);
  assert.equal(new Set(idem).size, idem.length, 'nenhuma tarefa idêntica (mesmo dia e título) repetida');
  const minDia = {}; novo.tarefas.filter(t => PA.ativa(t) && t.data >= '2026-10-22' && t.tipo !== 'prova').forEach(t => { minDia[t.data] = (minDia[t.data] || 0) + (t.minutos || 0); });
  const horas = novo.perfil.horas; for (const [d, m] of Object.entries(minDia)) if (!novo.tarefas.some(t => t.data === d && t.editadaManual)) assert.ok(m <= (horas[PE.parseIso(d).getUTCDay()] || 0) + 5, `dia ${d} acima da disponibilidade (${m} min)`);
});
await teste('13c. rotas /acao e /replanejar via HTTP', async () => {
  const p = gerar(); PA.anotarPlano(p, { hoje });
  const t = p.tarefas.find(x => x.tipo === 'estudo' && x.data >= hoje);
  const a = await post('/acao', { plano: p, acao: { tipo: 'concluir', id: t.id }, hoje }); assert.equal(a.j.success, true); assert.equal(a.j.plano.tarefas.find(x => x.id === t.id).status, 'feito');
  const bad = await post('/acao', { plano: p, acao: { tipo: 'apagar-tudo', id: t.id }, hoje }); assert.equal(bad.status, 422);
  const r = await post('/replanejar', { plano: a.j.plano, hoje }); assert.equal(r.j.success, true); assert.ok(r.j.plano.tarefas.length > 3);
  const inv = await post('/acao', { plano: { tarefas: 'x' }, acao: {}, hoje }); assert.equal(inv.status, 400);
});

// 14 / 15 ── persistência e isolamento
await teste('14/15. estado persistido por usuário e isolado entre usuários', async () => {
  const eA = { perfilAcademico: { periodo: '5º', instituicao: 'UFX' }, plano: { tarefas: [{ id: 'a', data: '2026-10-21', tipo: 'estudo' }] } };
  assert.equal((await post('/estado', { estado: eA, atualizado: 111 }, 'ana', 'PUT')).j.success, true);
  assert.equal((await post('/estado', { estado: { perfilAcademico: { periodo: '9º' } }, atualizado: 222 }, 'bia', 'PUT')).j.success, true);
  const a = (await get('/estado', 'ana')).j, b = (await get('/estado', 'bia')).j, c = (await get('/estado', 'carla')).j;
  assert.equal(a.dados.estado.perfilAcademico.periodo, '5º'); assert.equal(a.dados.atualizado, 111);
  assert.equal(b.dados.estado.perfilAcademico.periodo, '9º'); assert.ok(!b.dados.estado.plano);
  assert.equal(c.dados, null);
  assert.equal((await post('/estado', { estado: { perfilAcademico: {}, plano: { tarefas: 'x' } } }, 'ana', 'PUT')).status, 400);
  assert.equal((await post('/estado', { estado: [1] }, 'ana', 'PUT')).status, 400);
});
await teste('14b. sem Supabase: resposta offline (o app segue com o armazenamento local)', async () => {
  const app2 = express(); app2.use(express.json()); app2.use((req, _r, n) => { req.user = { username: 'x' }; n(); });
  registerPlannerV3(app2, { generateAI: AI.generateAI, aiConfigured: () => false, getBank: () => null, getSupabase: () => null });
  const s2 = await new Promise(r => { const s = app2.listen(0, () => r(s)); });
  const j = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/planner/v3/estado`)).json();
  s2.close(); assert.equal(j.offline, true);
});
await teste('perfil: só campos permitidos e sempre sanitizados', async () => {
  const { j } = await post('/perfil', { perfil: { objetivo: 'graduacao' }, patch: { horas: [0, 60, 60, 60, 60, 60, 0], dataProva: '2027-02-01', materiais: [{ texto: 'x'.repeat(100) }], objetivo: 'invalido', alvo: 'ENARE' } });
  assert.deepEqual(j.perfil.horas, [0, 60, 60, 60, 60, 60, 0]); assert.equal(j.perfil.dataProva, '2027-02-01'); assert.equal(j.perfil.alvo, 'ENARE');
  assert.equal(j.perfil.objetivo, 'graduacao'); assert.equal((j.perfil.materiais || []).length, 0);
});
await teste('acervo: lista PDFs de cronograma e declara que não há dados estruturados', async () => {
  const { j } = await get('/acervo-cronogramas'); assert.equal(j.estruturado, false); assert.equal(j.itens.length, 1);
});

srv.close(); groq.closeAllConnections?.(); groq.close();
for (const l of res) console.log(l.join(' — '));
process.exit(res.some(l => l[0] !== 'OK ') ? 1 : 0);
