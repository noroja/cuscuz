// Testes do provedor de IA contra um servidor Groq FALSO (não há chamada real à Groq aqui).
import http from 'http';
import assert from 'assert/strict';
const calls = []; let modo = 'ok';
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization, body: b.startsWith('{') ? JSON.parse(b) : b.slice(0, 40) });
    const j = (st, o, h = {}) => { res.writeHead(st, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/audio/transcriptions')) return j(200, { text: 'transcrito' });
    if (modo === '429') return j(429, { error: { message: 'rate limit' } }, { 'retry-after': '120' });
    if (modo === '429curto' && calls.length < 2) return j(429, { error: { message: 'rate' } }, { 'retry-after': '0' });
    if (modo === '401') return j(401, { error: { message: 'bad' } });
    if (modo === '500') return j(500, {});
    if (modo === 'hang') return;
    if (modo === 'lixo') return j(200, { choices: [{ message: { content: 'não é json' }, finish_reason: 'stop' }] });
    if (modo === 'schema400' && JSON.parse(b).response_format?.type === 'json_schema') return j(400, { error: { message: 'json_validate_failed' } });
    j(200, { choices: [{ message: { content: JSON.stringify({ ok: true, itens: [1] }) }, finish_reason: 'stop' }], usage: { total_tokens: 5 }, model: 'x' });
  });
});
await new Promise(r => srv.listen(0, r));
process.env.GROQ_BASE_URL = `http://127.0.0.1:${srv.address().port}/openai/v1`;
process.env.GROQ_API_KEY = 'gsk_teste_segredo';
process.env.GROQ_TIMEOUT_MS = '5000'; process.env.GROQ_MAX_RETRIES = '2';
const P = await import('../../src/ai-provider.js');
const schema = { type: P.Type.OBJECT, required: ['ok'], properties: { ok: { type: P.Type.BOOLEAN }, itens: { type: P.Type.ARRAY, items: { type: P.Type.INTEGER } } } };
const reset = (m) => { modo = m; calls.length = 0; P._resetForTests(); };
const t = []; const teste = async (nome, fn) => { try { await fn(); t.push(['OK ', nome]); } catch (e) { t.push(['FALHOU', nome, e.message]); } };

await teste('JSON estruturado: schema vira json_schema, chave só no header', async () => {
  reset('ok'); const r = await P.generateAI({ contents: 'oi', config: { systemInstruction: 'sys', responseSchema: schema } });
  assert.equal(JSON.parse(r.text).ok, true);
  assert.equal(calls[0].auth, 'Bearer gsk_teste_segredo');
  assert.equal(calls[0].body.response_format.type, 'json_schema');
  assert.equal(calls[0].body.response_format.json_schema.schema.type, 'object');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.ok(!JSON.stringify(calls[0].body).includes('gsk_teste_segredo'));
});
await teste('sem chave: erro claro 503, sem chamar a rede', async () => {
  reset('ok'); const k = process.env.GROQ_API_KEY; delete process.env.GROQ_API_KEY;
  try { await P.generateAI({ contents: 'x' }); assert.fail('deveria falhar'); } catch (e) { assert.equal(e.code, 'no_key'); assert.equal(e.status, 503); assert.equal(calls.length, 0); assert.equal(P.aiConfigured(), false); }
  process.env.GROQ_API_KEY = k;
});
await teste('429 com retry-after longo: não espera, devolve 429 e liga o disjuntor', async () => {
  reset('429'); const t0 = Date.now();
  try { await P.generateAI({ contents: 'x' }); assert.fail(); } catch (e) { assert.equal(e.status, 429); assert.equal(e.code, 'rate_limit'); assert.ok(Date.now() - t0 < 3000); }
  assert.equal(calls.length, 1);
  try { await P.generateAI({ contents: 'x' }); assert.fail(); } catch (e) { assert.equal(e.status, 429); }
  assert.equal(calls.length, 1, 'disjuntor evita nova chamada');
});
await teste('429 curto: retenta e conclui', async () => { reset('429curto'); const r = await P.generateAI({ contents: 'x' }); assert.ok(r.text); assert.equal(calls.length, 2); });
await teste('401: erro de chave, sem retry', async () => { reset('401'); try { await P.generateAI({ contents: 'x' }); assert.fail(); } catch (e) { assert.equal(e.code, 'auth'); assert.equal(calls.length, 1); } });
await teste('5xx: retenta e falha com 503', async () => { reset('500'); try { await P.generateAI({ contents: 'x' }); assert.fail(); } catch (e) { assert.equal(e.status, 503); assert.equal(calls.length, 3); } });
await teste('timeout: aborta e devolve 504', async () => {
  reset('hang'); process.env.GROQ_TIMEOUT_MS = '5000'; process.env.GROQ_MAX_RETRIES = '0';
  const t0 = Date.now();
  try { await P.generateAI({ contents: 'x' }); assert.fail(); } catch (e) { assert.equal(e.code, 'timeout'); assert.equal(e.status, 504); assert.ok(Date.now() - t0 >= 4500); }
  process.env.GROQ_MAX_RETRIES = '2';
});
await teste('JSON inválido: erro invalid_json (sem inventar resposta)', async () => { reset('lixo'); try { await P.generateAI({ contents: 'x', config: { responseSchema: schema } }); assert.fail(); } catch (e) { assert.equal(e.code, 'invalid_json'); } });
await teste('400 no json_schema: cai para json_object com o schema no prompt', async () => {
  reset('schema400'); const r = await P.generateAI({ contents: 'x', config: { responseSchema: schema } });
  assert.equal(JSON.parse(r.text).ok, true); assert.equal(calls[1].body.response_format.type, 'json_object'); assert.ok(calls[1].body.messages.at(-1).content.includes('JSON Schema'));
});
await teste('transcrição de áudio usa /audio/transcriptions', async () => { reset('ok'); const t1 = await P.transcribeAudio({ audioBase64: Buffer.from('abc').toString('base64'), mime: 'audio/webm;codecs=opus'.split(';')[0] }); assert.equal(t1, 'transcrito'); assert.ok(calls[0].url.endsWith('/audio/transcriptions')); });
await teste('imagem/áudio inline em generateAI: rejeita com 415 claro', async () => { reset('ok'); try { await P.generateAI({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }, { text: 'x' }] }] }); assert.fail(); } catch (e) { assert.equal(e.status, 415); } });
srv.closeAllConnections?.(); srv.close();
for (const l of t) console.log(l.join(' — '));
process.exit(t.some(l => l[0] !== 'OK ') ? 1 : 0);
