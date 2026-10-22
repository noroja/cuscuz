// Aula do dia (servidor): /status coerente com os provedores configurados e prompt do Whisper com continuidade.
// Groq simulado (nenhuma chamada real).
import http from 'node:http';
import express from 'express';
import assert from 'node:assert/strict';
const capt = [];
const fake = http.createServer((req, res) => {
  const partes = []; req.on('data', d => partes.push(d)); req.on('end', () => {
    capt.push({ url: req.url, corpo: Buffer.concat(partes).toString('latin1') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'ola mundo', segments: [{ start: 0, end: 1, text: 'ola mundo' }] }));
  });
});
await new Promise(r => fake.listen(0, r));
process.env.GROQ_BASE_URL = `http://127.0.0.1:${fake.address().port}/openai/v1`;
process.env.AI_LOG = '0';
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
await teste('status: só Gemini/OpenRouter → texto sim, transcrição NÃO (Whisper é da Groq)', async () => {
  limpa(); process.env.GEMINI_API_KEY = 'g'; let j = await st(); assert.equal(j.texto, true); assert.equal(j.transcricao, false); assert.equal(j.paralelo, 3);
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

// ── Fase 2: extração única → derivar sem rereler ──
const tarefas = []; let promptsDerivados = [];
const gaiFake = async ({ task, contents }) => {
  tarefas.push(task);
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
srv.close(); fake.closeAllConnections?.(); fake.close();
for (const l of t) console.log(l.join(' — '));
process.exit(t.every(l => l[0] === 'OK ') ? 0 : 1);
