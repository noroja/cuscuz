// Aula do dia (servidor): /status coerente com os provedores configurados e prompt do Whisper com continuidade.
// Groq simulado (nenhuma chamada real).
import http from 'node:http';
import express from 'express';
import assert from 'node:assert/strict';
const capt = [];
let groqFalha = 0;
const fake = http.createServer((req, res) => {
  const partes = []; req.on('data', d => partes.push(d)); req.on('end', () => {
    if (groqFalha) { res.writeHead(groqFalha, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'limite' } })); return; }
    capt.push({ url: req.url, corpo: Buffer.concat(partes).toString('latin1') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'ola mundo', segments: [{ start: 0, end: 1, text: 'ola mundo' }] }));
  });
});
await new Promise(r => fake.listen(0, r));
process.env.GROQ_BASE_URL = `http://127.0.0.1:${fake.address().port}/openai/v1`;
process.env.AI_LOG = '0';
const capGem = [];
let gemDedicado = false; const capDed = [];
const fakeGem = http.createServer((req, res) => { const p = []; req.on('data', d => p.push(d)); req.on('end', () => {
  if (gemDedicado) {
    const porta = fakeGem.address().port;
    if (req.url === '/upload/v1beta/files') { capDed.push({ passo: 'start', h: req.headers, corpo: Buffer.concat(p).toString() }); res.writeHead(200, { 'x-goog-upload-url': `http://127.0.0.1:${porta}/upload-dados/1` }); return res.end('{}'); }
    if (req.url === '/upload-dados/1') { capDed.push({ passo: 'dados', h: req.headers, bytes: Buffer.concat(p).length }); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ file: { uri: 'https://files.fake/abc', name: 'files/abc' } })); }
    if (req.url === '/v1beta/interactions') { const corpo = JSON.parse(Buffer.concat(p).toString()); capDed.push({ passo: 'interactions', corpo, key: req.headers['x-goog-api-key'] });
      const ts = !!(corpo.generation_config.transcription_config.timestamp_granularities);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ output_text: 'Olá turma. Hoje vemos sepse.', steps: ts ? [{ content: [{ annotations: [{ type: 'word_info', text: 'Olá', start_offset: '0.0s', end_offset: '0.4s' }, { type: 'word_info', text: 'turma.', start_offset: '0.4s', end_offset: '1.1s' }, { type: 'word_info', text: 'Hoje', start_offset: '1.5s', end_offset: '1.8s' }, { type: 'word_info', text: 'vemos', start_offset: '1.8s', end_offset: '2.1s' }, { type: 'word_info', text: 'sepse.', start_offset: '2.1s', end_offset: '2.6s' }] }] }] : [] })); }
  }
  if (!req.url.includes('generateContent')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"nao"}}'); }
  capGem.push({ url: req.url, key: req.headers['x-goog-api-key'], corpo: JSON.parse(Buffer.concat(p).toString()) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'texto do gemini' }] } }] })); }); });
await new Promise(r => fakeGem.listen(0, r));
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${fakeGem.address().port}/v1beta`;
process.env.GROQ_MAX_RETRIES = '0';
const limpa = () => { for (const k of ['AI_PROVIDER', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k]; };
const { registerAula, promptWhisper } = await import('../../src/aula.js');
const { generateAI, aiConfigured } = await import('../../src/ai-provider.js');
const app = express(); app.use(express.json({ limit: '40mb' })); registerAula(app, { generateAI, aiConfigured });
const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
const B = `http://127.0.0.1:${srv.address().port}`;
const st = async () => (await fetch(B + '/api/aula/status')).json();
const t = []; const teste = async (n, fn) => { try { await fn(); t.push(['OK ', n]); } catch (e) { t.push(['FALHOU', n, e.message]); } };

await teste('status: só Groq → transcrição sim, paralelo 1 (respeita TPM)', async () => {
  limpa(); process.env.GROQ_API_KEY = 'gsk_x'; const j = await st();
  assert.equal(j.transcricao, true); assert.equal(j.texto, true); assert.equal(j.paralelo, 1);
});
await teste('status: Groq + Gemini → paralelo 3', async () => {
  limpa(); process.env.GROQ_API_KEY = 'gsk_x'; process.env.GEMINI_API_KEY = 'g'; const j = await st();
  assert.equal(j.transcricao, true); assert.equal(j.paralelo, 3);
});
await teste('status: só Gemini → transcrição pela reserva; só OpenRouter → NÃO', async () => {
  limpa(); process.env.GEMINI_API_KEY = 'g'; let j = await st(); assert.equal(j.texto, true); assert.equal(j.transcricao, true); assert.equal(j.transcricaoReserva, false); assert.equal(j.paralelo, 3);
  limpa(); process.env.OPENROUTER_API_KEY = 'o'; j = await st(); assert.equal(j.transcricao, false); assert.equal(j.gemini, true);
});
await teste('status: nada configurado → tudo falso', async () => {
  limpa(); const j = await st(); assert.equal(j.texto, false); assert.equal(j.transcricao, false);
});
await teste('promptWhisper: glossário antes, ponta do trecho anterior por último, ≤ 700 caracteres, sem cortar palavra', async () => {
  const anterior = 'x'.repeat(500) + ' fim da frase anterior sobre lítio e valproato';
  const p = promptWhisper({ disciplina: 'Psiquiatria', tema: 'Humor', termos: ['lítio', 'valproato'], anterior });
  assert.ok(p.length <= 700, String(p.length)); assert.ok(p.startsWith('Aula de Psiquiatria: Humor.'));
  assert.ok(p.endsWith('valproato')); assert.ok(p.indexOf('Termos:') < p.indexOf('fim da frase'));
  assert.equal(promptWhisper({}), '');
  const longo = promptWhisper({ disciplina: 'D', termos: Array.from({ length: 80 }, (_, i) => 'termo' + i), anterior: 'ponta final' });
  assert.ok(longo.length <= 700 && longo.endsWith('ponta final'));
});
await teste('/transcrever envia o trecho anterior no prompt do Whisper', async () => {
  limpa(); process.env.GROQ_API_KEY = 'gsk_x';
  const audio = Buffer.alloc(5000, 1).toString('base64');
  const r = await fetch(B + '/api/aula/transcrever', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio, mime: 'audio/webm', disciplina: 'Clínica', tema: 'Sepse', anterior: 'o paciente evoluiu com hipotensão refratária', glossario: ['lactato'] }) });
  assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.success, true);
  const c = capt.find(x => x.url.endsWith('/audio/transcriptions'));
  assert.ok(c, 'chamada ao Whisper simulado'); assert.ok(c.corpo.includes('hipotensão refratária') || c.corpo.includes('hipotens'), 'prompt deve conter o fim do trecho anterior');
  assert.ok(c.corpo.includes('lactato'));
});

const audioB64 = Buffer.alloc(5000, 1).toString('base64');
const trans = () => fetch(B + '/api/aula/transcrever', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio: audioB64, mime: 'audio/webm;codecs=opus', disciplina: 'Cardio' }) }).then(async r => ({ status: r.status, j: await r.json() }));
await teste('transcrição: só Gemini → usa o Gemini com o áudio inline, sem segmentos', async () => {
  limpa(); process.env.GEMINI_API_KEY = 'g'; capGem.length = 0;
  const { status, j } = await trans(); assert.equal(status, 200); assert.equal(j.texto, 'texto do gemini'); assert.deepEqual(j.segmentos, []);
  assert.equal(capGem[0].key, 'g'); assert.equal(capGem[0].corpo.contents[0].parts[1].inlineData.mimeType, 'audio/webm');
  assert.ok(capGem[0].corpo.contents[0].parts[1].inlineData.data.length > 100);
});
await teste('transcrição: Groq no limite (429) com Gemini configurado → cai para o Gemini', async () => {
  limpa(); process.env.GROQ_API_KEY = 'gsk_x'; process.env.GEMINI_API_KEY = 'g'; capGem.length = 0; groqFalha = 429;
  const { status, j } = await trans(); groqFalha = 0;
  assert.equal(status, 200); assert.equal(j.texto, 'texto do gemini'); assert.equal(capGem.length, 1);
  const s2 = await st(); assert.equal(s2.transcricaoReserva, true);
});
await teste('transcrição: Groq ok → não chama o Gemini (segmentos preservados)', async () => {
  limpa(); process.env.GROQ_API_KEY = 'gsk_x'; process.env.GEMINI_API_KEY = 'g'; capGem.length = 0; groqFalha = 0;
  const { j } = await trans(); assert.equal(capGem.length, 0); assert.equal(j.segmentos.length, 1);
});
await teste('transcrição: Groq falha e sem Gemini → erro (sem reserva)', async () => {
  limpa(); process.env.GROQ_API_KEY = 'gsk_x'; groqFalha = 429; const { status } = await trans(); groqFalha = 0; assert.ok(status >= 400);
});

await teste('transcrição Gemini dedicada: upload (Files API) + /interactions com áudio, modo verbatim e sem marcas de tempo por padrão', async () => {
  limpa(); process.env.GEMINI_API_KEY = 'g'; gemDedicado = true; capDed.length = 0; capGem.length = 0;
  try { const { status, j } = await trans(); assert.equal(status, 200); assert.equal(j.texto, 'Olá turma. Hoje vemos sepse.'); assert.deepEqual(j.segmentos, []);
    assert.deepEqual(capDed.map(x => x.passo), ['start', 'dados', 'interactions']); assert.equal(capDed[0].h['x-goog-upload-command'], 'start'); assert.equal(capDed[1].h['x-goog-upload-command'], 'upload, finalize'); assert.equal(capDed[1].bytes, 5000);
    const i = capDed[2]; assert.equal(i.key, 'g'); assert.equal(i.corpo.model, 'gemini-3.5-transcribe'); assert.deepEqual(i.corpo.input[0], { type: 'audio', uri: 'https://files.fake/abc', mime_type: 'audio/webm' });
    assert.equal(i.corpo.generation_config.transcription_config.mode.type, 'verbatim'); assert.equal(capGem.length, 0, 'não deve cair no generateContent'); }
  finally { gemDedicado = false; }
});
await teste('transcrição Gemini dedicada com GEMINI_STT_TIMESTAMPS=1: palavras viram segmentos para o karaokê', async () => {
  limpa(); process.env.GEMINI_API_KEY = 'g'; process.env.GEMINI_STT_TIMESTAMPS = '1'; gemDedicado = true;
  try { const { j } = await trans(); assert.equal(j.segmentos.length, 2); assert.deepEqual(j.segmentos[0], { ini: 0, fim: 1.1, text: 'Olá turma.' }); assert.equal(j.segmentos[1].text, 'Hoje vemos sepse.'); }
  finally { gemDedicado = false; delete process.env.GEMINI_STT_TIMESTAMPS; }
});
await teste('transcrição Gemini: se o modelo dedicado falhar (sem URL de upload), cai no generateContent', async () => {
  limpa(); process.env.GEMINI_API_KEY = 'g'; gemDedicado = false; capGem.length = 0;
  const { status, j } = await trans(); assert.equal(status, 200); assert.equal(j.texto, 'texto do gemini'); assert.equal(capGem.length, 1);
});
await teste('transcrição Gemini: GEMINI_STT_MODEL=off usa direto o generateContent', async () => {
  limpa(); process.env.GEMINI_API_KEY = 'g'; process.env.GEMINI_STT_MODEL = 'off'; gemDedicado = true; capDed.length = 0; capGem.length = 0;
  try { const { j } = await trans(); assert.equal(j.texto, 'texto do gemini'); assert.equal(capDed.length, 0); } finally { gemDedicado = false; delete process.env.GEMINI_STT_MODEL; }
});

// ── Fase 2: extração única → derivar sem rereler ──
const tarefas = []; let promptsDerivados = [];
const gaiFake = async ({ task, contents }) => {
  tarefas.push(task);
  if (task === 'aula_extrair') { global.__ultimoExtrair = contents; }
  if (task === 'aula_extrair') return { text: JSON.stringify({ fatos: [{ tipo: 'dose', texto: 'Adrenalina 1 mg a cada 3-5 min', capitulo: 'PCR' }, { tipo: 'conduta', texto: 'Choque em ritmo chocável', capitulo: 'PCR' }], sintese: ['Ritmo define a conduta'], termos: [{ termo: 'FV', definicao: 'fibrilação ventricular' }], caiNaProva: ['dose da adrenalina'], duvidas: [], assuntosCobertos: ['PCR', 'Inexistente'] }) };
  promptsDerivados.push(contents);
  if (task === 'aula_flashcards') return { text: JSON.stringify([{ frente: 'Dose de adrenalina na PCR?', verso: '1 mg a cada 3-5 min', tema: 'PCR' }]) };
  return { text: JSON.stringify({ titulo: 'PCR', resumo: 'r', topicos: [{ titulo: 'a', pontos: ['x'] }] }) };
};
const app2 = express(); app2.use(express.json({ limit: '40mb' })); registerAula(app2, { generateAI: gaiFake, aiConfigured: () => true });
const srv2 = await new Promise(r => { const s2 = app2.listen(0, () => r(s2)); });
const B2 = `http://127.0.0.1:${srv2.address().port}`;
const post2 = async (u, c) => (await fetch(B2 + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })).json();
const aulaTxt = 'Na parada cardiorrespiratória a adrenalina 1 mg a cada 3 a 5 minutos. '.repeat(10);
let base;
await teste('/extrair devolve a base e filtra assuntosCobertos que não estão no plano', async () => {
  const j = await post2('/api/aula/extrair', { transcricao: aulaTxt, area: 'Emergência', assuntosPlano: ['PCR'] });
  assert.equal(j.success, true); base = j.base; assert.equal(base.fatos.length, 2); assert.deepEqual(base.assuntosCobertos, ['PCR']);
});
await teste('/extrair rejeita transcrição curta', async () => { assert.equal((await fetch(B2 + '/api/aula/extrair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcricao: 'curta' }) })).status, 400); });
await teste('/extrair leva as dúvidas marcadas (❓) ao prompt', async () => {
  const antes = promptsDerivados.length; tarefas.length = 0; const ps = [];
  const j = await post2('/api/aula/extrair', { transcricao: aulaTxt + '\n\n❓ [05:10]\n\n' + aulaTxt, duvidasMarcas: ['05:10'] });
  assert.equal(j.success, true);
  assert.ok(global.__ultimoExtrair.includes('❓ [mm:ss]') && global.__ultimoExtrair.includes('05:10'), 'prompt deve citar a dúvida');
});
await teste('/fechamento com base: sem IA, usa sínteses e fatos', async () => {
  tarefas.length = 0; const j = await post2('/api/aula/fechamento', { transcricao: aulaTxt, base });
  assert.equal(j.success, true); assert.equal(j.semIA, true); assert.equal(tarefas.length, 0);
  assert.ok(j.markdown.includes('Ritmo define a conduta') && j.markdown.includes('Adrenalina 1 mg') && j.markdown.includes('Revisão Final'));
});
await teste('/flashcards com base: prompt contém os fatos, não a transcrição', async () => {
  promptsDerivados = []; const j = await post2('/api/aula/flashcards', { transcricao: aulaTxt, base });
  assert.equal(j.success, true); assert.equal(j.flashcards.length, 1);
  assert.ok(promptsDerivados[0].includes('Adrenalina 1 mg a cada 3-5 min')); assert.ok(!promptsDerivados[0].includes('parada cardiorrespiratória'));
});
await teste('/processar com base: 1 chamada, copia cai na prova/termos e filtra assuntos', async () => {
  tarefas.length = 0; promptsDerivados = []; const j = await post2('/api/aula/processar', { transcricao: aulaTxt, assuntosPlano: ['PCR'], base });
  assert.equal(j.success, true); assert.equal(j.semLerAula, true); assert.equal(tarefas.length, 1);
  assert.deepEqual(j.resultado.caiNaProva, ['dose da adrenalina']); assert.equal(j.resultado.termos[0].termo, 'FV'); assert.deepEqual(j.resultado.assuntosCobertos, ['PCR']);
  assert.ok(!promptsDerivados[0].includes('parada cardiorrespiratória'));
});
await teste('sem base, o caminho antigo continua funcionando (fechamento usa IA)', async () => {
  tarefas.length = 0; await post2('/api/aula/fechamento', { transcricao: aulaTxt + aulaTxt }); assert.ok(tarefas.includes('aula_fechamento'));
});
srv2.close();

// ── Estilo do resumo: pedagógico (padrão) x Crônicas ──
let ultimoCap = '';
const gaiCap = async ({ task, contents }) => { if (task === 'aula_capitulo') ultimoCap = contents; return { text: '## 1.0 — Tema\n\nconteúdo' }; };
const app3 = express(); app3.use(express.json({ limit: '40mb' })); registerAula(app3, { generateAI: gaiCap, aiConfigured: () => true });
const srv3 = await new Promise(r => { const s3 = app3.listen(0, () => r(s3)); });
const post3 = async (u, c) => (await fetch(`http://127.0.0.1:${srv3.address().port}${u}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })).json();
const capBody = { transcricao: aulaTxt, area: 'Emergência', capitulo: { titulo: 'PCR', pontos: ['adrenalina'] }, numero: 1, total: 1 };
await teste('capítulo: padrão é o estilo pedagógico (conceito → mecanismo → aplicação → prova), com complemento externo sinalizado', async () => {
  const j = await post3('/api/aula/capitulo', capBody); assert.equal(j.success, true);
  for (const x of ['### Conceito central', '### Fundamentos', '### Mecanismo explicado', 'Causa → Mecanismo', '### Aplicação clínica', '### Pontos para a prova', '### Revisão final do capítulo', 'Complemento (não dito na aula)', 'Não invente diretrizes']) assert.ok(ultimoCap.includes(x), x);
  assert.ok(!ultimoCap.includes('CAIXA-HISTÓRIA') && !ultimoCap.includes('Cor de Magia'), 'sem o formato Crônicas');
});
await teste('capítulo: estilo "cronicas" continua disponível', async () => {
  await post3('/api/aula/capitulo', { ...capBody, estilo: 'cronicas' }); assert.ok(ultimoCap.includes('CAIXA-HISTÓRIA') && ultimoCap.includes('Cor de Magia'));
});
await teste('fechamento com base: rodapé das Crônicas só no estilo cronicas', async () => {
  const ped = await post3('/api/aula/fechamento', { transcricao: aulaTxt, base }); const cro = await post3('/api/aula/fechamento', { transcricao: aulaTxt, base, estilo: 'cronicas' });
  assert.ok(!ped.markdown.includes('Crônicas')); assert.ok(cro.markdown.includes('Crônicas'));
});
srv3.close();
srv.close(); fake.closeAllConnections?.(); fake.close(); fakeGem.closeAllConnections?.(); fakeGem.close();
for (const l of t) console.log(l.join(' — '));
process.exit(t.every(l => l[0] === 'OK ') ? 0 : 1);
