import assert from 'node:assert/strict';

// Limite previsível para verificar várias janelas sem chamar provedores externos.
process.env.AI_PROVIDER = 'openrouter';
process.env.OPENROUTER_API_KEY = 'test-only';
process.env.OPENROUTER_MAX_PROMPT_CHARS = '16000';
process.env.AI_LOG = '0';

const { registerAula, promptWhisper } = await import('../../src/aula.js');
const { aiJanelaChars } = await import('../../src/ai-provider.js');
const janela = aiJanelaChars(1400);
const capturas = { revisar: [], mapa: [], consolidacao: [], capitulo: [], mente: [], resumo: [], extrair: [], cards: [], processar: [] };
let omitirConsolidacao = false;
let omitirCapitulos = false;
let omitirMapaMental = false;
let resumoVazio = false;
let capituloVazio = false;
let fechamentoSemSintese = false;
const fakeAI = async ({ task, contents }) => {
  if (task === 'aula_revisar') { capturas.revisar.push(contents); return { text: 'Transcrição revisada.' }; }
  if (task === 'aula_mapa' && contents.includes('Inventarie os tópicos')) {
    capturas.mapa.push(contents);
    if (omitirCapitulos) return { text: JSON.stringify({ capitulos: [], temQuestoes: false }) };
    return { text: JSON.stringify({ capitulos: [{ titulo: `Tópico ${capturas.mapa.length}`, pontos: [`Ponto ${capturas.mapa.length}`], paragrafoFim: 9999 }], temQuestoes: false }) };
  }
  if (task === 'aula_mapa_consolidar') {
    const pos = contents.indexOf('FRAGMENTOS:\n') + 'FRAGMENTOS:\n'.length;
    const frags = JSON.parse(contents.slice(pos));
    capturas.consolidacao.push(contents);
    return { text: JSON.stringify({ capitulos: omitirConsolidacao ? frags.slice(0, 1) : frags }) };
  }
  if (task === 'aula_capitulo') {
    capturas.capitulo.push(contents);
    if (capituloVazio) return { text: '' };
    return { text: `Capítulo janela ${capturas.capitulo.length}` };
  }
  if (task === 'aula_fechamento') return { text: fechamentoSemSintese ? 'sem títulos' : '### Síntese do trecho\n- Síntese teste\n### Memória do trecho\n- Fato teste' };
  if (task === 'aula_mapa_mental') {
    capturas.mente.push(contents);
    if (omitirMapaMental) return { text: JSON.stringify({}) };
    return { text: JSON.stringify({ t: 'Tema', f: [{ t: `Trecho ${capturas.mente.length}`, f: [{ t: 'Subtema', f: [{ t: `Folha ${capturas.mente.length}` }] }] }] }) };
  }
  if (task === 'aula_resumo') {
    capturas.resumo.push(contents);
    if (resumoVazio) return { text: '' };
    return { text: `# Seção ${capturas.resumo.length}\n\nResumo janela ${capturas.resumo.length}` };
  }
  if (task === 'aula_processar') {
    capturas.processar.push(contents);
    return { text: JSON.stringify({ titulo: 'Aula teste', resumo: 'Resumo fiel.', topicos: [] }) };
  }
  if (task === 'aula_extrair') {
    capturas.extrair.push(contents);
    const n = capturas.extrair.length;
    return { text: JSON.stringify({ fatos: [{ texto: `Fato janela ${n}`, tipo: 'definicao' }], sintese: [`Síntese janela ${n}`] }) };
  }
  if (task === 'aula_flashcards') {
    capturas.cards.push(contents);
    const cards = Array.from({ length: 101 }, (_, i) => ({ frente: `Pergunta ${capturas.cards.length}-${i}`, verso: `Resposta ${i}`, dificuldade: i === 0 ? 'facil' : 'inválida' }));
    return { text: JSON.stringify(cards) };
  }
  throw new Error(`Tarefa inesperada: ${task}`);
};

const handlers = {};
const app = { get() {}, post(route, handler) { handlers[route] = handler; } };
registerAula(app, { aiConfigured: () => true, generateAI: fakeAI });
const invoke = async (route, body) => {
  let status = 200, json;
  const res = { status(n) { status = n; return this; }, json(value) { json = value; return this; } };
  await handlers[`/api/aula/${route}`]({ body }, res);
  return { status, json };
};
const post = async (route, body) => {
  const { status, json } = await invoke(route, body);
  assert.equal(status, 200, `${route}: ${json?.msg || status}`);
  return json;
};
const fonteDosPrompts = (items, marker) => items.map(x => x.slice(x.lastIndexOf(marker) + marker.length));
const preferencia = { tipoAula: 'Seminário', preferenciaMaterial: 'conciso' };

try {
  const whisperPrompt = promptWhisper({ disciplina: 'Clínica', tipoAula: preferencia.tipoAula });
  assert.ok(whisperPrompt.includes('Tipo de aula: Seminário'));
  assert.ok(whisperPrompt.includes('Transcreva literalmente'));
  assert.ok(!whisperPrompt.includes('material conciso'), 'preferência de tamanho não pode resumir a transcrição');
  await post('revisar', { texto: 'Transcrição clínica com dados preservados.', area: 'Clínica', ...preferencia });
  assert.ok(capturas.revisar[0].includes('tipo de aula Seminário; material conciso'));
  assert.ok(!capturas.revisar[0].includes('Material enxuto'), 'tamanho do material não pode alterar a transcrição revisada');

  const fonteLonga = `\n\nINÍCIO ${'x'.repeat(janela * 16)} MARCADOR_DO_MEIO ${'y'.repeat(janela * 2)} FIM_DA_AULA \n`;
  const mapa = await post('mapa', { transcricao: fonteLonga, area: 'Clínica', ...preferencia });
  const textosMapa = fonteDosPrompts(capturas.mapa, 'FONTE DO TRECHO:\n');
  assert.ok(textosMapa.length > 14, `esperava mais de 14 janelas, recebeu ${textosMapa.length}`);
  assert.equal(textosMapa.join(''), fonteLonga, 'janelas do mapa devem reconstruir a fonte sem lacunas');
  assert.ok(capturas.mapa.every(p => p.includes('tipo de aula Seminário; material conciso')));
  const caps = mapa.mapa.capitulos;
  assert.ok(caps.length > 14, 'o mapa não deve truncar capítulos após 14');
  assert.equal(caps[0].de, 0);
  assert.equal(caps.at(-1).ate, fonteLonga.length);
  assert.ok(caps.every((c, i) => i === 0 || caps[i - 1].ate === c.de), 'offsets do mapa precisam cobrir a fonte sem lacunas nem sobreposição');
  assert.equal(caps.map(c => fonteLonga.slice(c.de, c.ate)).join(''), fonteLonga, 'offsets devem reconstruir a transcrição exatamente');
  assert.ok(caps.at(-1).pontos.includes(`Ponto ${capturas.mapa.length}`), 'o conteúdo da última janela deve permanecer no mapa');

  omitirCapitulos = true;
  const mapaSemCapitulos = await invoke('mapa', { transcricao: `AULA ${'conteúdo '.repeat(60)}` });
  omitirCapitulos = false;
  assert.equal(mapaSemCapitulos.status, 502, 'sem capítulos, o endpoint deve falhar sem presumir cobertura');
  assert.equal(mapaSemCapitulos.json.success, false);
  assert.equal(mapaSemCapitulos.json.mapa, undefined, 'não deve retornar mapa vazio como se a fonte estivesse coberta');

  capturas.mapa.length = 0; capturas.consolidacao.length = 0; omitirConsolidacao = true;
  const fonteConsolidacao = `INÍCIO ${'c'.repeat(janela * 0.8)} FIM`;
  const mapaComConsolidacaoIncompleta = await post('mapa', { transcricao: fonteConsolidacao, ...preferencia });
  omitirConsolidacao = false;
  const capsFallback = mapaComConsolidacaoIncompleta.mapa.capitulos;
  assert.equal(capturas.consolidacao.length, 1, 'o caso de omissão precisa executar a etapa de consolidação');
  assert.equal(capsFallback.length, capturas.mapa.length, 'consolidação que omite janelas deve ser rejeitada');
  assert.equal(capsFallback[0].de, 0);
  assert.equal(capsFallback.at(-1).ate, fonteConsolidacao.length);
  assert.ok(capsFallback.every((c, i) => i === 0 || capsFallback[i - 1].ate === c.de));
  assert.equal(capsFallback.map(c => fonteConsolidacao.slice(c.de, c.ate)).join(''), fonteConsolidacao);

  capturas.capitulo.length = 0;
  const fonteCapitulo = `INÍCIO_CAPÍTULO ${'mecanismo clínico '.repeat(janela / 4)} MARCADOR_DO_MEIO ${'dados e exceções '.repeat(janela / 4)} FIM_CAPÍTULO`;
  const inicioCapitulo = 23, fimCapitulo = fonteCapitulo.length - 19;
  const capitulo = await post('capitulo', { transcricao: fonteCapitulo, capitulo: { titulo: 'Tema', de: inicioCapitulo, ate: fimCapitulo, pontos: [] }, ...preferencia });
  const trechosCap = fonteDosPrompts(capturas.capitulo, 'TRECHO DA TRANSCRIÇÃO (fonte única — cobre integralmente este capítulo):\n');
  assert.ok(trechosCap.length > 1);
  assert.equal(trechosCap.join(''), fonteCapitulo.slice(inicioCapitulo, fimCapitulo), 'o capítulo deve usar seus offsets exatos sem lacunas, sobreposição ou margem duplicada');
  assert.ok(capitulo.markdown.includes(`Capítulo janela ${trechosCap.length}`));
  assert.ok(!capturas.capitulo.some(p => p.includes('trecho do meio omitido')));
  capituloVazio = true;
  const capituloIncompleto = await invoke('capitulo', { transcricao: fonteCapitulo, capitulo: { titulo: 'Tema', de: inicioCapitulo, ate: fimCapitulo }, ...preferencia });
  capituloVazio = false;
  assert.equal(capituloIncompleto.status, 502, 'capítulo não deve mascarar uma janela vazia');
  assert.equal(capituloIncompleto.json.markdown, undefined);
  capturas.capitulo.length = 0;
  const capFallback = await post('capitulo', { transcricao: fonteCapitulo, capitulo: { titulo: 'Tema sem offsets', pontos: [] }, ...preferencia });
  const trechosFallback = fonteDosPrompts(capturas.capitulo, 'TRECHO DA TRANSCRIÇÃO (fonte única — cobre integralmente este capítulo):\n');
  assert.equal(trechosFallback.join(''), fonteCapitulo, 'mapa antigo sem offsets também precisa percorrer toda a fonte');
  assert.ok(capFallback.markdown.includes(`Capítulo janela ${trechosFallback.length}`));

  capturas.mente.length = 0;
  const fonteMente = `INÍCIO_MENTE ${'conteúdo temático '.repeat(janela / 6)} MARCADOR_DO_MEIO ${'fim temático '.repeat(janela / 7)} FIM_MENTE`;
  const mente = await post('mapa-mental', { transcricao: fonteMente, ...preferencia });
  const textosMente = fonteDosPrompts(capturas.mente, 'FONTE:\n');
  assert.ok(textosMente.length > 1);
  assert.equal(textosMente.join(''), fonteMente);
  assert.ok(capturas.mente.every(p => p.includes('tipo de aula Seminário; material conciso')));
  assert.equal(mente.raiz.f.length, textosMente.length, 'o mapa mental deve reunir ramos de todas as janelas');
  assert.equal(mente.estrutura.versao, 1);
  assert.equal(mente.estrutura.nos[0].id, mente.estrutura.raizId);
  assert.equal(new Set(mente.estrutura.nos.map(n => n.id)).size, mente.estrutura.nos.length, 'IDs do JSON do mapa mental devem ser únicos');
  assert.ok(mente.estrutura.relacoes.every(e => mente.estrutura.nos.some(n => n.id === e.de) && mente.estrutura.nos.some(n => n.id === e.para) && e.tipo === 'hierarquia'));
  assert.ok(mente.estrutura.nos.filter(n => n.id !== mente.estrutura.raizId).every(n => Number.isInteger(n.origem.inicio) && Number.isInteger(n.origem.fim) && n.origem.fim > n.origem.inicio));
  assert.ok(capturas.mente.every(p => p.includes('Material enxuto')), 'preferência concisa deve mudar a extensão dos materiais derivados');
  omitirMapaMental = true;
  const mapaMentalParcial = await invoke('mapa-mental', { transcricao: fonteMente, ...preferencia });
  omitirMapaMental = false;
  assert.equal(mapaMentalParcial.status, 502, 'mapa mental não deve retornar árvore parcial quando um trecho está sem estrutura');
  assert.equal(mapaMentalParcial.json.raiz, undefined);

  capturas.resumo.length = 0;
  const resumo = await post('resumo-geral', { transcricao: fonteMente, ...preferencia });
  assert.equal(fonteDosPrompts(capturas.resumo, 'FONTE (transcrição da aula):\n').join(''), fonteMente);
  assert.ok(resumo.markdown.includes(`Seção ${capturas.resumo.length}`), 'o resumo deve preservar a última seção');
  assert.ok(capturas.resumo.every(p => p.includes('tipo de aula Seminário; material conciso')));
  resumoVazio = true;
  const resumoIncompleto = await invoke('resumo-geral', { transcricao: fonteMente, ...preferencia });
  resumoVazio = false;
  assert.equal(resumoIncompleto.status, 502, 'resumo não deve ocultar uma janela vazia');
  assert.equal(resumoIncompleto.json.markdown, undefined);

  fechamentoSemSintese = true;
  const fechamentoIncompleto = await invoke('fechamento', { transcricao: fonteMente, ...preferencia });
  fechamentoSemSintese = false;
  assert.equal(fechamentoIncompleto.status, 502, 'fechamento não deve ocultar janela sem síntese');

  capturas.processar.length = 0;
  const fonteProcessar = `AULA CLÍNICA ${'dados e mecanismos relevantes '.repeat(8)}`;
  await post('processar', { transcricao: fonteProcessar, ...preferencia });
  assert.equal(capturas.processar.length, 1);
  assert.ok(capturas.processar[0].includes(fonteProcessar));
  assert.ok(capturas.processar[0].includes('tipo de aula Seminário; material conciso'));

  capturas.extrair.length = 0;
  const extracao = await post('extrair', { transcricao: fonteMente, ...preferencia });
  assert.equal(fonteDosPrompts(capturas.extrair, 'TRECHO:\n').join(''), fonteMente);
  assert.equal(extracao.base.fatos.length, capturas.extrair.length);
  assert.ok(extracao.base.fatos.at(-1).texto === `Fato janela ${capturas.extrair.length}`);
  assert.ok(extracao.base.fatos.every(f => f.origem.tipo === 'transcricao' && f.origem.inicio >= 0 && f.origem.fim <= fonteMente.length && f.origem.fim > f.origem.inicio));
  assert.ok(capturas.extrair.every(p => p.includes('tipo de aula Seminário; material conciso')));

  capturas.cards.length = 0;
  const cards = await post('flashcards', { transcricao: fonteMente, ...preferencia });
  assert.ok(cards.flashcards.length > 100, `retornou apenas ${cards.flashcards.length} cartões`);
  assert.equal(fonteDosPrompts(capturas.cards, 'TRECHO:\n').join(''), fonteMente);
  assert.ok(cards.flashcards.every(c => ['facil', 'media', 'dificil'].includes(c.dificuldade)));
  assert.equal(cards.flashcards[0].origem.tipo, 'transcricao');
  assert.equal(cards.flashcards[0].origem.inicio, 0);
  assert.equal(cards.flashcards[0].origem.fim, fonteDosPrompts(capturas.cards, 'TRECHO:\n')[0].length);
  assert.equal(cards.flashcards[0].dificuldade, 'facil');
  assert.equal(cards.flashcards[1].dificuldade, 'media', 'dificuldade fora da lista permitida cai em media');
  assert.ok(cards.flashcards.at(-1).origem.fim > cards.flashcards.at(-1).origem.inicio);
  assert.ok(capturas.cards.every(p => p.includes('tipo de aula Seminário; material conciso')));

  capturas.cards.length = 0;
  const cardsBase = await post('flashcards', { transcricao: fonteMente, base: extracao.base, ...preferencia });
  assert.ok(cardsBase.flashcards.every(c => c.origem.tipo === 'transcricao' && c.origem.inicio >= 0 && c.origem.fim <= fonteMente.length && c.origem.fim > c.origem.inicio), 'cartões derivados da base devem apontar à janela da transcrição, não ao texto intermediário');

  console.log('OK — janelas contíguas, offsets sem lacunas, capítulos completos, mapa mental e derivados sem cortes, preferências, e flashcards sem teto artificial com dificuldade/origem validadas.');
} finally {
  delete process.env.AI_PROVIDER; delete process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_MAX_PROMPT_CHARS; delete process.env.AI_LOG;
}
