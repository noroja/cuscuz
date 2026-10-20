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
    if (modo === 'tpm' && calls.length % 2 === 1) return j(429, { error: { message: 'Rate limit reached on tokens per minute (TPM): Limit 8000, Requested 12425, please reduce your message size and try again' } }, { 'retry-after': '1' });
    if (modo === 'tpmlongo') return j(429, { error: { message: 'Request too large on tokens per minute (TPM): Limit 8000, Requested 12425' } }, { 'retry-after': '80' });
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

// Servidor Gemini FALSO (mesma ideia: só testa o roteador, sem rede real).
let gmode = 'ok'; const gcalls = [];
const gsrv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    gcalls.push({ url: req.url, key: req.headers['x-goog-api-key'], body: b.startsWith('{') ? JSON.parse(b) : b.slice(0, 40) });
    const j = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (gmode === '403key') return j(403, { error: { code: 403, message: 'API key not valid. Please pass a valid API key.', status: 'PERMISSION_DENIED' } });
    if (gmode === '429min' && gcalls.length < 2) return j(429, { error: { code: 429, message: "Quota exceeded for metric and limit 'per-minute'; Please retry in 2s. Requests per minute", status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }] } });
    j(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ ok: true, itens: [1] }) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } });
  });
});
await new Promise(r => gsrv.listen(0, r));
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${gsrv.address().port}`;
const P = await import('../../src/ai-provider.js');
const schema = { type: P.Type.OBJECT, required: ['ok'], properties: { ok: { type: P.Type.BOOLEAN }, itens: { type: P.Type.ARRAY, items: { type: P.Type.INTEGER } } } };
const reset = (m) => { modo = m; calls.length = 0; gmode = 'ok'; gcalls.length = 0; P._resetForTests(); };
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
await teste('429/413 de TPM curto: espera o retry-after e conclui', async () => { reset('tpm'); const t0 = Date.now(); const r = await P.generateAI({ contents: 'x' }); assert.ok(r.text); assert.equal(calls.length, 2); assert.ok(Date.now() - t0 >= 900, 'deve esperar a janela de TPM'); });
await teste('TPM sem janela viável (retry-after 80s): disjuntor, sem segunda chamada', async () => {
  reset('tpmlongo'); const t0 = Date.now();
  try { await P.generateAI({ contents: 'x' }); assert.fail(); } catch (e) { assert.equal(e.status, 429); assert.ok(Date.now() - t0 < 3000); }
  assert.equal(calls.length, 1);
  try { await P.generateAI({ contents: 'x' }); assert.fail(); } catch (_) { /* bloqueado sem rede */ }
  assert.equal(calls.length, 1, 'disjuntor evita nova chamada');
});
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

// ── modos híbridos (GEMINI_API_KEY ativada de aqui em diante) ──
process.env.GEMINI_API_KEY = 'gm_teste_segredo';
await teste('auto híbrido: prompt GRANDE vai ao Gemini, sem tocar na Groq', async () => {
  reset('ok');
  const r = await P.generateAI({ contents: 'x'.repeat(45000), config: { responseMimeType: 'application/json', responseSchema: schema } });
  assert.equal(JSON.parse(r.text).ok, true);
  assert.equal(r.provider, 'gemini');
  assert.equal(calls.length, 0, 'Groq não é chamada');
  assert.equal(gcalls.length, 1);
  assert.ok(gcalls[0].url.includes(':generateContent'));
  assert.equal(gcalls[0].key, 'gm_teste_segredo');
  assert.equal(gcalls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(gcalls[0].body.generationConfig.responseSchema.type, 'OBJECT');
  assert.ok(!JSON.stringify(gcalls[0].body).includes('gm_teste_segredo'));
});
await teste('auto híbrido: prompt curto vai à Groq primeiro', async () => {
  reset('ok');
  const r = await P.generateAI({ contents: 'oi' });
  assert.equal(r.provider, 'groq');
  assert.equal(gcalls.length, 0, 'Gemini não é chamada');
});
await teste('fallback: Groq em limite → resposta sai do Gemini', async () => {
  reset('429'); // retry-after 120 → disjuntor da Groq
  const r = await P.generateAI({ contents: 'oi' });
  assert.equal(r.provider, 'gemini');
  assert.equal(calls.length, 1);
  assert.equal(gcalls.length, 1);
});
await teste('fallback: chave do Gemini inválida → cai para a Groq', async () => {
  reset('ok'); gmode = '403key';
  const r = await P.generateAI({ contents: 'x'.repeat(45000) }); // grande → Gemini primeiro
  assert.equal(r.provider, 'groq');
  assert.equal(gcalls.length, 1);
  assert.equal(calls.length, 1);
});
await teste('429 de minuto no Gemini: espera o retryDelay e conclui', async () => {
  reset('ok'); gmode = '429min';
  const t0 = Date.now();
  const r = await P.generateAI({ contents: 'x'.repeat(45000) }); // grande → Gemini
  assert.equal(r.provider, 'gemini');
  assert.equal(gcalls.length, 2);
  assert.ok(Date.now() - t0 >= 1900, 'deve esperar o retryDelay de 2s');
});
await teste('gemini fixado: pequeno e grande vão todos ao Gemini', async () => {
  reset('ok'); process.env.AI_PROVIDER = 'gemini';
  try {
    const a = await P.generateAI({ contents: 'oi' });
    const bb = await P.generateAI({ contents: 'x'.repeat(45000) });
    assert.equal(a.provider, 'gemini'); assert.equal(bb.provider, 'gemini');
    assert.equal(calls.length, 0); assert.equal(gcalls.length, 2);
  } finally { delete process.env.AI_PROVIDER; }
});
gsrv.closeAllConnections?.(); gsrv.close();
srv.closeAllConnections?.(); srv.close();
srv.closeAllConnections?.(); srv.close();
for (const l of t) console.log(l.join(' — '));
process.exit(t.some(l => l[0] !== 'OK ') ? 1 : 0);
