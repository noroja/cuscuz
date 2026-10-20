// Camada única de IA generativa. Hoje o único provedor suportado é a Groq (API compatível com OpenAI).
// Nenhum outro provedor é usado como reserva silenciosa: se a Groq falhar, o erro volta ao chamador.
// A chave NUNCA sai do servidor e nunca é registrada em log.
//
// Variáveis de ambiente:
//   AI_PROVIDER        (padrão "groq")
//   GROQ_API_KEY       chave da Groq (obrigatória para IA)
//   GROQ_MODEL         modelo de texto (padrão openai/gpt-oss-120b — suporta json_schema)
//   GROQ_STT_MODEL     modelo de transcrição (padrão whisper-large-v3-turbo)
//   GROQ_BASE_URL      padrão https://api.groq.com/openai/v1
//   GROQ_TIMEOUT_MS    timeout por tentativa (padrão 45000)
//   GROQ_MAX_RETRIES   tentativas extras em 429/5xx/timeout (padrão 2)
//   GROQ_MAX_OUTPUT_TOKENS  teto de saída (padrão 8192)

export const Type = { OBJECT: 'object', ARRAY: 'array', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean' };

const cfg = () => ({
  provider: String(process.env.AI_PROVIDER || 'groq').toLowerCase(),
  key: process.env.GROQ_API_KEY || '',
  model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  stt: process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
  base: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
  timeout: Math.max(5000, parseInt(process.env.GROQ_TIMEOUT_MS, 10) || 45000),
  retries: Math.min(4, Math.max(0, process.env.GROQ_MAX_RETRIES == null || process.env.GROQ_MAX_RETRIES === '' ? 2 : parseInt(process.env.GROQ_MAX_RETRIES, 10) || 0)),
  maxOut: Math.max(256, parseInt(process.env.GROQ_MAX_OUTPUT_TOKENS, 10) || 8192)
});

export function aiProviderName() { return cfg().provider; }
export function aiConfigured() { const c = cfg(); return c.provider === 'groq' && !!c.key; }
export function aiStatus() { const c = cfg(); return { provider: c.provider, configured: c.provider === 'groq' && !!c.key, model: c.model, sttModel: c.stt }; }

export class AIError extends Error {
  constructor(msg, { status = 500, code = 'ai_error', retryAfterMs = null } = {}) { super(msg); this.name = 'AIError'; this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_INLINE_WAIT_MS = 8000;      // espera máxima dentro da requisição para um 429
let blockedUntil = 0;                 // disjuntor: só para limites diários / esperas longas

function parseRetryAfter(h) {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.round(n * 1000);
  const d = Date.parse(h); return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

// Converte o schema (estilo Gemini ou JSON Schema) para JSON Schema padrão.
export function toJsonSchema(s) {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'propertyOrdering' || k === 'nullable' || k === 'format' && s.type && /string/i.test(s.type) && v === 'enum') continue;
    if (k === 'type') out.type = Array.isArray(v) ? v.map(x => String(x).toLowerCase()) : String(v).toLowerCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    else if (k === 'items') out.items = toJsonSchema(v);
    else out[k] = v;
  }
  if (s.nullable && out.type && !Array.isArray(out.type)) out.type = [out.type, 'null'];
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

function nomeDoModelo(model) { return /gpt-oss/i.test(model); }

// Aceita o formato { contents, config:{ systemInstruction, temperature, responseMimeType, responseSchema, maxOutputTokens } }
async function montarMensagens(params, c) {
  const msgs = [];
  const conf = params.config || {};
  let sys = conf.systemInstruction;
  if (sys && typeof sys === 'object') sys = (sys.parts || []).map(p => p.text || '').join('\n') || sys.text;
  if (sys) msgs.push({ role: 'system', content: String(sys) });
  const contents = params.contents;
  const lista = typeof contents === 'string' ? [{ role: 'user', parts: [{ text: contents }] }]
    : Array.isArray(contents) ? contents.map(x => (x && x.parts) ? x : { role: 'user', parts: Array.isArray(x) ? x : [typeof x === 'string' ? { text: x } : x] })
    : (contents && contents.parts) ? [contents] : [];
  for (const item of lista) {
    const role = item.role === 'model' || item.role === 'assistant' ? 'assistant' : 'user';
    const textos = [];
    for (const p of item.parts || []) {
      if (p == null) continue;
      if (typeof p === 'string') { textos.push(p); continue; }
      if (p.text != null) { textos.push(String(p.text)); continue; }
      if (p.inlineData) {
        const mime = String(p.inlineData.mimeType || '').toLowerCase();
        if (mime === 'application/pdf') textos.unshift('[Conteúdo extraído do PDF anexado]\n' + await pdfParaTexto(p.inlineData.data));
        else if (mime.startsWith('text/')) textos.unshift(Buffer.from(p.inlineData.data, 'base64').toString('utf8'));
        else throw new AIError(`Tipo de arquivo não suportado pelo provedor de IA (${mime || 'desconhecido'}). Use PDF ou texto; para áudio use a transcrição.`, { status: 415, code: 'unsupported_media' });
      }
    }
    msgs.push({ role, content: textos.join('\n\n') });
  }
  return msgs;
}

export async function pdfParaTexto(b64) {
  let pdfParse;
  try { pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default; }
  catch (_) { throw new AIError('Leitura de PDF indisponível: dependência "pdf-parse" não instalada no servidor.', { status: 501, code: 'pdf_unavailable' }); }
  const r = await pdfParse(Buffer.from(b64, 'base64'));
  const t = String(r.text || '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (t.length < 40) throw new AIError('Não consegui extrair texto deste PDF (pode ser escaneado/imagem). Envie um PDF com texto selecionável.', { status: 422, code: 'pdf_sem_texto' });
  return t.length > 60000 ? t.slice(0, 60000) + '\n[…texto truncado…]' : t;
}

async function chamar(url, init, c, rotulo) {
  let ultimo = null;
  for (let tent = 0; tent <= c.retries; tent++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), c.timeout);
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok) return r;
      const corpo = await r.text().catch(() => '');
      let detalhe = ''; try { detalhe = JSON.parse(corpo).error?.message || ''; } catch (_) { detalhe = corpo.slice(0, 200); }
      const retryMs = parseRetryAfter(r.headers.get('retry-after'));
      if (r.status === 401 || r.status === 403) throw new AIError('A GROQ_API_KEY configurada não é válida ou não tem permissão.', { status: 502, code: 'auth' });
      if (r.status === 429) {
        const espera = retryMs != null ? retryMs : 2000 * (tent + 1);
        if (/per day|TPD|RPD/i.test(detalhe) || espera > 60000) blockedUntil = Date.now() + Math.min(espera, 6 * 3600e3);
        ultimo = new AIError(`Limite de uso da Groq atingido${retryMs ? ` — tente em ~${Math.ceil(retryMs / 1000)}s` : ''}.`, { status: 429, code: 'rate_limit', retryAfterMs: retryMs });
        if (tent < c.retries && espera <= MAX_INLINE_WAIT_MS) { await sleep(espera + Math.floor(Math.random() * 250)); continue; }
        throw ultimo;
      }
      if (r.status >= 500) { ultimo = new AIError(`Groq indisponível (${r.status}).`, { status: 503, code: 'upstream' }); if (tent < c.retries) { await sleep(500 * 2 ** tent); continue; } throw ultimo; }
      const e = new AIError(`Groq recusou a requisição (${r.status}): ${detalhe}`.slice(0, 400), { status: 502, code: r.status === 400 ? 'bad_request' : 'upstream' });
      e.httpStatus = r.status; e.detalhe = detalhe; throw e;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AIError) throw err;
      const abort = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
      ultimo = new AIError(abort ? `A IA demorou mais de ${Math.round(c.timeout / 1000)}s para responder (${rotulo}).` : `Falha de rede ao chamar a Groq: ${String(err.message || err).slice(0, 120)}`, { status: abort ? 504 : 502, code: abort ? 'timeout' : 'network' });
      if (tent < c.retries) { await sleep(500 * 2 ** tent); continue; }
      throw ultimo;
    }
  }
  throw ultimo || new AIError('Falha desconhecida ao chamar a Groq.');
}

function validarJson(texto, schema) {
  let j;
  try { j = JSON.parse(String(texto).trim()); }
  catch (_) {
    const m = String(texto).match(/[\[{][\s\S]*[\]}]/);
    if (!m) throw new Error('A IA não retornou JSON.');
    j = JSON.parse(m[0]);
  }
  const t = schema && schema.type;
  if (t === 'array' && !Array.isArray(j)) throw new Error('A IA retornou um JSON que não é lista.');
  if (t === 'object' && (j === null || typeof j !== 'object' || Array.isArray(j))) throw new Error('A IA retornou um JSON que não é objeto.');
  if (t === 'object' && Array.isArray(schema.required)) for (const k of schema.required) if (!(k in j)) throw new Error(`Campo obrigatório ausente na resposta da IA: ${k}`);
  return j;
}

// API principal. Retorna { text, usage, model, provider }.
export async function generateAI(params) {
  const c = cfg();
  if (c.provider !== 'groq') throw new AIError(`AI_PROVIDER "${c.provider}" não suportado. Use "groq".`, { status: 500, code: 'provider' });
  if (!c.key) throw new AIError('GROQ_API_KEY não configurada no servidor.', { status: 503, code: 'no_key' });
  if (Date.now() < blockedUntil) throw new AIError(`Limite da Groq atingido — tente novamente em ~${Math.ceil((blockedUntil - Date.now()) / 60000)} min.`, { status: 429, code: 'rate_limit', retryAfterMs: blockedUntil - Date.now() });

  const conf = params.config || {};
  const messages = await montarMensagens(params, c);
  const schema = conf.responseSchema ? toJsonSchema(conf.responseSchema) : null;
  const querJson = !!schema || /json/i.test(conf.responseMimeType || '');
  const model = params.model || c.model;
  const base = { model, messages, temperature: conf.temperature ?? 0.4, max_completion_tokens: Math.min(conf.maxOutputTokens || c.maxOut, c.maxOut) };
  if (nomeDoModelo(model)) base.reasoning_effort = 'low';
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key };
  const url = c.base + '/chat/completions';

  const rodar = async (body, rotulo) => {
    const r = await chamar(url, { method: 'POST', headers, body: JSON.stringify(body) }, c, rotulo);
    const j = await r.json();
    const choice = j.choices && j.choices[0];
    const text = (choice && choice.message && choice.message.content) || '';
    if (choice && choice.finish_reason === 'length' && querJson) throw new AIError('A resposta da IA foi cortada por limite de tamanho.', { status: 502, code: 'truncated' });
    return { text, usage: j.usage || null, model: j.model || model, provider: 'groq' };
  };

  if (!querJson) return rodar(base, 'texto');

  const comoJsonObject = () => {
    const extra = schema ? `\n\nResponda APENAS com JSON válido que obedeça a este JSON Schema:\n${JSON.stringify(schema)}` : '\n\nResponda APENAS com JSON válido.';
    const msgs = base.messages.map(m => ({ ...m }));
    const i = msgs.map(m => m.role).lastIndexOf('user');
    if (i >= 0) msgs[i].content += extra; else msgs.push({ role: 'user', content: extra.trim() });
    return { ...base, messages: msgs, response_format: { type: 'json_object' } };
  };

  let ultimoErro = null;
  const tentativas = [];
  if (schema && /gpt-oss|qwen3|muse-spark/i.test(model)) tentativas.push({ ...base, response_format: { type: 'json_schema', json_schema: { name: 'resposta', strict: false, schema } } });
  tentativas.push(comoJsonObject());
  for (const body of tentativas) {
    try {
      const out = await rodar(body, 'json');
      validarJson(out.text, schema);
      return out;
    } catch (err) {
      ultimoErro = err;
      if (err instanceof AIError && !['bad_request', 'truncated'].includes(err.code)) throw err; // rede/limite/chave: não mascarar
    }
  }
  throw (ultimoErro instanceof AIError ? ultimoErro : new AIError('A IA não devolveu uma resposta JSON válida: ' + (ultimoErro && ultimoErro.message), { status: 502, code: 'invalid_json' }));
}

// Transcrição de áudio (Groq Whisper). audioBase64 sem prefixo data:.
export async function transcribeAudio({ audioBase64, mime = 'audio/webm', prompt = '', language = 'pt' }) {
  const c = cfg();
  if (!c.key) throw new AIError('GROQ_API_KEY não configurada no servidor.', { status: 503, code: 'no_key' });
  if (Date.now() < blockedUntil) throw new AIError('Limite da Groq atingido — tente novamente em instantes.', { status: 429, code: 'rate_limit' });
  const ext = ({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac' })[mime] || 'webm';
  const buf = Buffer.from(audioBase64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `trecho.${ext}`);
  form.append('model', c.stt);
  form.append('language', language);
  form.append('temperature', '0');
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', String(prompt).slice(0, 800)); // Whisper aceita um prompt curto (glossário / contexto)
  const r = await chamar(c.base + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + c.key }, body: form }, { ...c, timeout: Math.max(c.timeout, 60000) }, 'transcrição');
  const j = await r.json();
  return String(j.text || '').trim();
}

export function _resetForTests() { blockedUntil = 0; }
