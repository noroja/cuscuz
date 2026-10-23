// Testes do provedor de IA contra um servidor Groq FALSO (não há chamada real à Groq aqui).
import http from 'http';
import assert from 'assert/strict';
const calls = []; let modo = 'ok';
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization, body: b.startsWith('{') ? JSON.parse(b) : b.slice(0, 40), cru: b.slice(0, 4000) });
    const j = (st, o, h = {}) => { res.writeHead(st, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/audio/transcriptions')) return j(200, { text: 'transcrito', segments: [{ start: 0, end: 1.5, text: 'olá', avg_logprob: -1.2, no_speech_prob: 0.1 }, { start: 1.5, end: 2.5, text: '' }] });
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
process.env.AI_LOG = '0'; process.env.GROQ_TIMEOUT_MS = '5000'; process.env.GROQ_MAX_RETRIES = '2';

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
// Servidor OpenRouter FALSO.
let omode = 'ok'; const ocalls = [];
const osrv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const body = b.startsWith('{') ? JSON.parse(b) : {};
    ocalls.push({ url: req.url, auth: req.headers.authorization, title: req.headers['x-title'], body });
    const j = (st, o, h = {}) => { res.writeHead(st, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (omode === 'dia') return j(429, { error: { message: 'Rate limit exceeded: free-models-per-day. Add credits' } }, { 'retry-after': '1' });
    if (omode === 'think') return j(200, { choices: [{ message: { content: '<think>hmm</think>' + JSON.stringify({ ok: true, itens: [2] }) }, finish_reason: 'stop' }], model: 'nvidia/nemotron-3.5-super-vl:free' });
    if (omode === 'vazio') return j(200, { choices: [{ message: { content: null }, finish_reason: 'length' }] });
    if (omode === 'schema400' && body.response_format?.type === 'json_schema') return j(400, { error: { message: 'response_format unsupported' } });
    if (omode === 'fallback') return j(200, { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], model: body.models?.[1] || body.model });
    j(200, { choices: [{ message: { content: JSON.stringify({ ok: true, itens: [1] }) }, finish_reason: 'stop' }], usage: { total_tokens: 5 }, model: 'nvidia/nemotron-3.5-super-vl:free' });
  });
});
await new Promise(r => osrv.listen(0, r));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${osrv.address().port}/api/v1`;
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
await teste('transcrição de áudio usa /audio/transcriptions', async () => { reset('ok'); const t1 = await P.transcribeAudio({ audioBase64: Buffer.from('abc').toString('base64'), mime: 'audio/webm;codecs=opus'.split(';')[0] }); assert.equal(t1, 'transcrito'); assert.ok(calls[0].url.endsWith('/audio/transcriptions')); assert.ok(!String(calls[0].cru).includes('verbose_json')); });
await teste('transcrição aceita Buffer binário sem exigir base64', async () => { reset('ok'); const r = await P.transcribeAudio({ audioBuffer: Buffer.from('audio-binario'), mime: 'audio/mpeg' }); assert.equal(r, 'transcrito'); assert.ok(calls[0].url.endsWith('/audio/transcriptions')); });
await teste('transcrição com timestamps: verbose_json + segmentos [ini,fim,text]', async () => {
  reset('ok');
  const r = await P.transcribeAudio({ audioBase64: Buffer.from('abc').toString('base64'), mime: 'audio/webm', timestamps: true });
  assert.equal(r.texto, 'transcrito');
  assert.deepEqual(r.segmentos, [{ ini: 0, fim: 1.5, text: 'olá', avgLogprob: -1.2, noSpeechProb: 0.1 }]); // confiança e segmento vazio/filtra fora
  assert.ok(String(calls[0].cru || calls[0].body).includes('verbose_json'));
});
await teste('imagem/áudio inline em generateAI: rejeita com 415 claro', async () => { reset('ok'); try { await P.generateAI({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }, { text: 'x' }] }] }); assert.fail(); } catch (e) { assert.equal(e.status, 415); } });

// ── modos híbridos (GEMINI_API_KEY ativada de aqui em diante) ──
process.env.GEMINI_API_KEY = 'gm_teste_segredo';
await teste('transcrição pode priorizar Gemini e converter Buffer para inline quando pequeno', async () => {
  reset('ok'); process.env.GEMINI_STT_MODEL = 'off';
  try {
    const audioBuffer = Buffer.from('audio-gemini-binario');
    await P.transcribeAudio({ audioBuffer, mime: 'audio/mpeg', preferGemini: true });
    assert.equal(calls.length, 0, 'não deve enviar o áudio à Groq');
    assert.ok(gcalls[0].url.includes(':generateContent'));
    assert.equal(gcalls[0].body.contents[0].parts[1].inlineData.data, audioBuffer.toString('base64'));
  } finally { delete process.env.GEMINI_STT_MODEL; }
});
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
const comOR = async (fn) => { process.env.OPENROUTER_API_KEY = 'sk-or-segredo'; try { await fn(); } finally { delete process.env.OPENROUTER_API_KEY; delete process.env.AI_PROVIDER; } };
const resetOR = (m) => { reset('ok'); omode = m; ocalls.length = 0; };
await teste('openrouter fixado: usa Nemotron :free, json_schema, chave só no header', async () => comOR(async () => {
  process.env.AI_PROVIDER = 'openrouter'; resetOR('ok');
  assert.equal(P.aiConfigured(), true); assert.equal(P.aiStatus().model, 'nvidia/nemotron-3.5-super-vl:free');
  const r = await P.generateAI({ contents: 'oi', config: { systemInstruction: 'sys', responseSchema: schema } });
  assert.equal(r.provider, 'openrouter'); assert.equal(JSON.parse(r.text).ok, true);
  assert.equal(ocalls[0].auth, 'Bearer sk-or-segredo'); assert.equal(ocalls[0].url, '/api/v1/chat/completions');
  assert.equal(ocalls[0].body.response_format.type, 'json_schema');
  assert.ok(!JSON.stringify(ocalls[0].body).includes('sk-or-segredo'));
  assert.equal(calls.length, 0); assert.equal(gcalls.length, 0);
}));
await teste('openrouter: remove <think> e cai para json_object se o modelo recusa json_schema', async () => comOR(async () => {
  process.env.AI_PROVIDER = 'openrouter'; resetOR('think');
  assert.deepEqual(JSON.parse((await P.generateAI({ contents: 'x', config: { responseSchema: schema } })).text).itens, [2]);
  resetOR('schema400');
  const r = await P.generateAI({ contents: 'x', config: { responseSchema: schema } });
  assert.equal(ocalls.length, 2); assert.equal(ocalls[1].body.response_format.type, 'json_object'); assert.equal(JSON.parse(r.text).ok, true);
}));
await teste('openrouter: lista prioritária sem duplicados e modelo efetivamente usado na resposta', async () => comOR(async () => {
  process.env.AI_PROVIDER = 'openrouter';
  process.env.OPENROUTER_MODELS = ' modelo/primeiro:free, modelo/reserva:free,modelo/primeiro:free ';
  try {
    resetOR('fallback');
    const r = await P.generateAI({ contents: 'teste', config: { responseSchema: schema } });
    assert.deepEqual(ocalls[0].body.models, ['modelo/primeiro:free', 'modelo/reserva:free']);
    assert.equal(ocalls[0].body.model, undefined);
    assert.equal(r.model, 'modelo/reserva:free');
    assert.deepEqual(P.aiStatus().provedores.openrouter.modelos, ['modelo/primeiro:free', 'modelo/reserva:free']);
    assert.equal(calls.length, 0); assert.equal(gcalls.length, 0);
  } finally { delete process.env.OPENROUTER_MODELS; }
}));
await teste('openrouter: lista permanece na tentativa json_object; modelo explícito restringe a seleção', async () => comOR(async () => {
  process.env.AI_PROVIDER = 'openrouter'; process.env.OPENROUTER_MODELS = 'modelo/a:free,modelo/b:free';
  try {
    resetOR('schema400');
    await P.generateAI({ contents: 'teste', config: { responseSchema: schema } });
    assert.equal(ocalls.length, 2); assert.deepEqual(ocalls[1].body.models, ['modelo/a:free', 'modelo/b:free']);
    assert.equal(ocalls[1].body.response_format.type, 'json_object');
    resetOR('ok'); await P.generateAI({ contents: 'teste', model: 'modelo/explicito:free' });
    assert.equal(ocalls[0].body.model, 'modelo/explicito:free'); assert.equal(ocalls[0].body.models, undefined);
  } finally { delete process.env.OPENROUTER_MODELS; }
}));
await teste('openrouter: lista vazia preserva a configuração singular e o limite é tratado no provedor', async () => comOR(async () => {
  process.env.AI_PROVIDER = 'openrouter'; process.env.OPENROUTER_MODELS = ' , '; process.env.OPENROUTER_MODEL = 'modelo/legado:free';
  try {
    resetOR('ok'); await P.generateAI({ contents: 'teste' });
    assert.equal(ocalls[0].body.model, 'modelo/legado:free');
    process.env.OPENROUTER_MODELS = 'modelo/a:free,modelo/b:free'; resetOR('dia');
    await assert.rejects(() => P.generateAI({ contents: 'teste' }), e => e.code === 'rate_limit');
    assert.deepEqual(ocalls[0].body.models, ['modelo/a:free', 'modelo/b:free']);
    const total = ocalls.length;
    await assert.rejects(() => P.generateAI({ contents: 'teste' }), e => e.code === 'rate_limit');
    assert.equal(ocalls.length, total);
  } finally { delete process.env.OPENROUTER_MODELS; delete process.env.OPENROUTER_MODEL; }
}));
await teste('openrouter: resposta vazia (limite de raciocínio) vira erro explícito', async () => comOR(async () => {
  process.env.AI_PROVIDER = 'openrouter'; resetOR('vazio');
  await assert.rejects(() => P.generateAI({ contents: 'x', config: { responseSchema: schema } }), e => e.provider === 'openrouter' && ['truncated', 'invalid_json'].includes(e.code));
}));
await teste('auto: OpenRouter é o último recurso quando Groq e Gemini falham', async () => comOR(async () => {
  resetOR('ok'); modo = '401'; gmode = '403key';
  const r = await P.generateAI({ contents: 'oi' });
  assert.equal(r.provider, 'openrouter'); assert.equal(ocalls.length, 1);
}));
await teste('auto: com Groq saudável o OpenRouter nem é chamado', async () => comOR(async () => {
  resetOR('ok'); const r = await P.generateAI({ contents: 'oi' });
  assert.equal(r.provider, 'groq'); assert.equal(ocalls.length, 0);
}));
await teste('openrouter: cota diária (free-models-per-day) liga o disjuntor, sem esperar', async () => comOR(async () => {
  process.env.AI_PROVIDER = 'openrouter'; resetOR('dia');
  await assert.rejects(() => P.generateAI({ contents: 'x' }), e => e.code === 'rate_limit' && e.provider === 'openrouter');
  const n = ocalls.length;
  await assert.rejects(() => P.generateAI({ contents: 'x' }), e => e.code === 'rate_limit');
  assert.equal(ocalls.length, n, 'segunda chamada deve ser barrada pelo disjuntor');
}));
await teste('fluxo: prompt grande pula a Groq; trilha registra quem respondeu', async () => comOR(async () => {
  resetOR('ok'); const r = await P.generateAI({ contents: 'x'.repeat(45000) });
  assert.equal(r.provider, 'gemini'); assert.equal(calls.length, 0); assert.equal(ocalls.length, 0);
  assert.deepEqual(r.tentativas, [{ provider: 'gemini', ok: true }]);
}));
await teste('fluxo: cadeia completa Groq(401) → Gemini(403) → OpenRouter, com trilha', async () => comOR(async () => {
  resetOR('ok'); modo = '401'; gmode = '403key';
  const r = await P.generateAI({ contents: 'oi' });
  assert.deepEqual(r.tentativas.map(x => x.provider + ':' + (x.ok ? 'ok' : x.code)), ['groq:auth', 'gemini:auth', 'openrouter:ok']);
}));
await teste('fluxo: AI_ORDER muda a preferência', async () => comOR(async () => {
  resetOR('ok'); process.env.AI_ORDER = 'openrouter,gemini';
  try { const r = await P.generateAI({ contents: 'oi' }); assert.equal(r.provider, 'openrouter'); assert.equal(calls.length, 0); }
  finally { delete process.env.AI_ORDER; }
}));
await teste('fluxo: provedor com 2 falhas seguidas é rebaixado (não gasta tempo de novo)', async () => comOR(async () => {
  resetOR('ok'); modo = '500'; process.env.GROQ_MAX_RETRIES = '0';
  try {
    await P.generateAI({ contents: 'a' }); await P.generateAI({ contents: 'b' });
    assert.equal(P.aiStatus().provedores.groq.rebaixado, true);
    calls.length = 0; modo = 'ok';
    const r = await P.generateAI({ contents: 'c' });
    assert.equal(r.provider, 'gemini'); assert.equal(calls.length, 0, 'groq rebaixada não deve ser a primeira');
  } finally { process.env.GROQ_MAX_RETRIES = '2'; }
}));
await teste('fluxo: status expõe saúde por provedor sem vazar chaves', async () => comOR(async () => {
  resetOR('ok'); await P.generateAI({ contents: 'oi' });
  const st = P.aiStatus(); assert.equal(st.provedores.groq.ok, 1); assert.equal(st.provedores.openrouter.configurado, true);
  assert.ok(!JSON.stringify(st).includes('sk-or-segredo') && !JSON.stringify(st).includes('gsk_teste_segredo'));
}));
await teste('tarefas: mapa usa Gemini e conversa usa Groq; modelo fixo continua respeitado', async () => comOR(async () => {
  resetOR('ok');
  const mapa = await P.generateAI({ task: 'aula_mapa', contents: 'trecho fictício' });
  assert.equal(mapa.provider, 'gemini'); assert.equal(mapa.task, 'aula_mapa'); assert.equal(calls.length, 0);
  resetOR('ok'); assert.equal((await P.generateAI({ task: 'mentor_chat', contents: 'oi' })).provider, 'groq');
  resetOR('ok'); process.env.AI_PROVIDER = 'groq';
  assert.equal((await P.generateAI({ task: 'aula_mapa', contents: 'oi' })).provider, 'groq');
}));
await teste('tarefas: modelos do OpenRouter mudam por função e mantêm os candidatos configurados', async () => comOR(async () => {
  process.env.OPENROUTER_MODELS = 'nvidia/teste:free,minimax/teste:free,google/gemma-teste:free';
  try {
    for (const [task, expected] of [['aula_capitulo','nvidia/teste:free'],['aula_fechamento','minimax/teste:free'],['aula_flashcards','google/gemma-teste:free']]) {
      resetOR('ok'); const r = await P.generateAI({ task, contents: 'trecho fictício' });
      assert.equal(r.provider, 'openrouter'); assert.equal(ocalls[0].body.models[0], expected);
      assert.equal(ocalls[0].body.models.length, 3);
    }
  } finally { delete process.env.OPENROUTER_MODELS; }
}));
await teste('tarefas: falha mantém fallback, contexto grande pula Groq e ordem específica pode ser configurada', async () => comOR(async () => {
  resetOR('ok'); gmode = '403key';
  assert.equal((await P.generateAI({ task: 'documento', contents: 'trecho fictício' })).provider, 'openrouter');
  resetOR('ok'); assert.equal((await P.generateAI({ task: 'mentor_chat', contents: 'x'.repeat(26000) })).provider, 'gemini');
  resetOR('ok'); process.env.AI_ORDER_MENTOR_CHAT = 'OPENROUTER,groq';
  try { assert.equal((await P.generateAI({ task: 'mentor_chat', contents: 'oi' })).provider, 'openrouter'); }
  finally { delete process.env.AI_ORDER_MENTOR_CHAT; }
}));
osrv.closeAllConnections?.(); osrv.close();
gsrv.closeAllConnections?.(); gsrv.close();
srv.closeAllConnections?.(); srv.close();
srv.closeAllConnections?.(); srv.close();
for (const l of t) console.log(l.join(' — '));
process.exit(t.some(l => l[0] !== 'OK ') ? 1 : 0);
