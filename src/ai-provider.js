// Camada única de IA generativa com DUAL PROVIDER: Groq (compatível com OpenAI) + Google Gemini.
// Uma só API (formato Gemini: contents/config) e o roteador decide quem executa, com fallback mútuo.
// A chave NUNCA sai do servidor e nunca é registrada em log.
//
// Variáveis de ambiente:
//   AI_PROVIDER        "auto" (padrão quando as 2 chaves existem), "groq" ou "gemini".
//                      No modo auto: prompt PEQUENO vai à Groq (rápida, TPM renova a cada minuto) e
//                      prompt GRANDE ao Gemini (janela de contexto ~1M tokens); quem falhar/estourar
//                      limite passa a bola para o outro.
//   GROQ_API_KEY       chave da Groq
//   GROQ_MODEL         modelo de texto (padrão openai/gpt-oss-120b — suporta json_schema)
//   GROQ_STT_MODEL     modelo de transcrição (padrão whisper-large-v3-turbo)
//   GROQ_BASE_URL      padrão https://api.groq.com/openai/v1
//   GROQ_TIMEOUT_MS    timeout por tentativa (padrão 45000)
//   GROQ_MAX_RETRIES   tentativas extras em 429/5xx/timeout (padrão 2)
//   GROQ_MAX_OUTPUT_TOKENS  teto de saída (padrão 8192)
//   GROQ_TPM           teto de tokens por minuto do plano (padrão 8000 — free tier do gpt-oss-120b;
//                      usado para dimensionar janelas de requisição que não estouram o limite)
//   GEMINI_API_KEY     chave do Google AI Studio (activa o provedor Gemini)
//   GEMINI_MODEL       padrão gemini-3.8-flash
//   GEMINI_BASE_URL    padrão https://generativelanguage.googleapis.com/v1beta
//   GEMINI_TIMEOUT_MS  timeout por tentativa (padrão 60000)
//   GEMINI_MAX_RETRIES tentativas extras (padrão 2)
//   GEMINI_MAX_OUTPUT_TOKENS  teto de saída (padrão 8192)
//   GEMINI_MAX_PROMPT_CHARS  teto de caracteres de prompt enviado ao Gemini (padrão 300000)
//   AI_ORDER           ordem de preferência no modo auto, ex.: "gemini,groq,openrouter" (padrão groq,gemini,openrouter)
//   AI_LOG             "0" silencia a linha de log por chamada (provedor, modelo, ms, resultado — nunca o conteúdo)
//   OPENROUTER_API_KEY chave da OpenRouter (3º provedor, compatível com OpenAI). No modo auto entra como
//                      ÚLTIMO recurso (depois de Groq/Gemini); com AI_PROVIDER=openrouter vira o único.
//   OPENROUTER_MODEL   padrão nvidia/nemotron-3.5-super-vl:free (modelos ":free" têm cotas diárias baixas
//                      e podem registrar prompts — veja docs/MENTOR-IA.md)
//   OPENROUTER_BASE_URL padrão https://openrouter.ai/api/v1
//   OPENROUTER_TIMEOUT_MS / OPENROUTER_MAX_RETRIES / OPENROUTER_MAX_OUTPUT_TOKENS (padrões 90000 / 2 / 8192)
//   OPENROUTER_MAX_PROMPT_CHARS teto de caracteres de prompt enviado à OpenRouter (padrão 120000)
//   OPENROUTER_SITE_URL / OPENROUTER_APP_NAME cabeçalhos opcionais de atribuição (HTTP-Referer / X-Title)

export const Type = { OBJECT: 'object', ARRAY: 'array', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean' };

const cfg = () => ({
  provider: String(process.env.AI_PROVIDER || '').toLowerCase(), // '' → resolve pelas chaves
  groq: {
    key: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    stt: process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
    base: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    timeout: Math.max(5000, parseInt(process.env.GROQ_TIMEOUT_MS, 10) || 45000),
    retries: Math.min(4, Math.max(0, process.env.GROQ_MAX_RETRIES == null || process.env.GROQ_MAX_RETRIES === '' ? 2 : parseInt(process.env.GROQ_MAX_RETRIES, 10) || 0)),
    maxOut: Math.max(256, parseInt(process.env.GROQ_MAX_OUTPUT_TOKENS, 10) || 8192),
    tpm: Math.max(2000, parseInt(process.env.GROQ_TPM, 10) || 8000)
  },
  gemini: {
    key: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    base: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
    timeout: Math.max(5000, parseInt(process.env.GEMINI_TIMEOUT_MS, 10) || 60000),
    retries: Math.min(4, Math.max(0, process.env.GEMINI_MAX_RETRIES == null || process.env.GEMINI_MAX_RETRIES === '' ? 2 : parseInt(process.env.GEMINI_MAX_RETRIES, 10) || 0)),
    maxOut: Math.max(256, parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) || 8192),
    janelaMax: Math.max(16000, parseInt(process.env.GEMINI_MAX_PROMPT_CHARS, 10) || 300000)
  },
  openrouter: {
    key: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-super-vl:free',
    base: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    timeout: Math.max(5000, parseInt(process.env.OPENROUTER_TIMEOUT_MS, 10) || 90000),
    retries: Math.min(4, Math.max(0, process.env.OPENROUTER_MAX_RETRIES == null || process.env.OPENROUTER_MAX_RETRIES === '' ? 2 : parseInt(process.env.OPENROUTER_MAX_RETRIES, 10) || 0)),
    maxOut: Math.max(256, parseInt(process.env.OPENROUTER_MAX_OUTPUT_TOKENS, 10) || 8192),
    janelaMax: Math.max(8000, parseInt(process.env.OPENROUTER_MAX_PROMPT_CHARS, 10) || 120000),
    site: process.env.OPENROUTER_SITE_URL || '',
    app: process.env.OPENROUTER_APP_NAME || 'Cuscuz-MED'
  }
});

// ── estado por provedor (disjuntores independentes) ──
const bloqueadoAte = { groq: 0, gemini: 0, openrouter: 0 };
const bloquear = (nome, ms, maxMs = 6 * 3600e3) => { bloqueadoAte[nome] = Date.now() + Math.min(Math.max(ms, 0), maxMs); };
const disponivel = (nome) => Date.now() >= bloqueadoAte[nome];

// ── saúde por provedor: alimenta a ordem da fila e o /api/health (sem guardar conteúdo de prompt) ──
const novaSaude = () => ({ chamadas: 0, ok: 0, falhas: 0, seguidas: 0, ultimaFalha: 0, ultimoErro: '', latMs: 0 });
const saude = { groq: novaSaude(), gemini: novaSaude(), openrouter: novaSaude() };
function registrar(nome, ok, ms, err, modelo) {
  const h = saude[nome]; h.chamadas++;
  if (ok) { h.ok++; h.seguidas = 0; h.latMs = h.latMs ? Math.round(h.latMs * 0.7 + ms * 0.3) : ms; }
  else { h.falhas++; h.seguidas++; h.ultimaFalha = Date.now(); h.ultimoErro = String((err && err.code) || 'erro'); }
  if (process.env.AI_LOG !== '0') console.log(`[ia] ${nome} ${modelo || ''} ${ok ? 'ok' : 'falhou(' + h.ultimoErro + ')'} ${ms}ms`);
}
// Rebaixa (não exclui) quem falhou 2x seguidas no último minuto: dá chance ao próximo sem esperar timeout de novo.
const rebaixado = (nome) => saude[nome].seguidas >= 2 && Date.now() - saude[nome].ultimaFalha < 60000;

const ROTEADO = { GROQ: 'groq', GEMINI: 'gemini' };
// Resolve o modo efetivo e as chaves presentes.
function roteador() {
  const c = cfg();
  const temGroq = !!c.groq.key, temGem = !!c.gemini.key, temOR = !!c.openrouter.key;
  const qtd = (temGroq ? 1 : 0) + (temGem ? 1 : 0) + (temOR ? 1 : 0);
  const modo = ['auto', 'groq', 'gemini', 'openrouter'].includes(c.provider)
    ? c.provider
    : (qtd > 1 ? 'auto' : temGroq ? 'groq' : temGem ? 'gemini' : temOR ? 'openrouter' : '');
  return { c, modo, temGroq, temGem, temOR };
}

export function aiProviderName() { return roteador().modo || 'desligado'; }
export function aiConfigured() { const r = roteador(); return !!r.modo && ((r.modo === 'groq' && r.temGroq) || (r.modo === 'gemini' && r.temGem) || (r.modo === 'openrouter' && r.temOR) || (r.modo === 'auto' && (r.temGroq || r.temGem || r.temOR))); }
export function aiStatus() {
  const r = roteador();
  return {
    provider: r.modo || 'desligado',
    configured: aiConfigured(),
    model: r.modo === 'gemini' ? r.c.gemini.model : r.modo === 'openrouter' ? r.c.openrouter.model : r.c.groq.model,
    sttModel: r.c.groq.stt,
    tpm: r.c.groq.tpm,
    gemini: !!r.c.gemini.key, groq: !!r.c.groq.key,
    geminiModel: r.c.gemini.model,
    openrouter: !!r.c.openrouter.key, openrouterModel: r.c.openrouter.model,
    provedores: Object.fromEntries(['groq', 'gemini', 'openrouter'].map(n => [n, {
      configurado: n === 'groq' ? r.temGroq : n === 'gemini' ? r.temGem : r.temOR,
      modelo: r.c[n].model,
      limiteAte: disponivel(n) ? null : bloqueadoAte[n],
      rebaixado: rebaixado(n),
      ...saude[n]
    }])),
    bloqueado: r.modo === 'auto'
      ? (['groq', 'gemini', 'openrouter'].some(n => (n === 'groq' ? r.temGroq : n === 'gemini' ? r.temGem : r.temOR) && disponivel(n)) ? null : Math.min(...['groq', 'gemini', 'openrouter'].filter(n => (n === 'groq' ? r.temGroq : n === 'gemini' ? r.temGem : r.temOR)).map(n => bloqueadoAte[n])))
      : (disponivel(r.modo) ? null : bloqueadoAte[r.modo])
  };
}
// Teto de tokens por minuto (TPM) da Groq — usado para dimensionar janelas de prompt.
export function aiTpm() { return cfg().groq.tpm; }

// Orçamento de CARACTERES de prompt por requisição, consciente do roteamento: com o Gemini no fluxo
// (auto com as 2 chaves, ou gemini fixado), a janela é ampla (aula inteira em 1 chamada); sem Gemini,
// a janela raramente exceda o teto de TPM da Groq (evita o 413 "Request too large").
export function aiJanelaChars(reservaTokens = 0) {
  const r = roteador();
  if (r.modo === 'gemini' || (r.modo === 'auto' && r.c.gemini.key && r.c.gemini.janelaMax > 0)) return r.c.gemini.janelaMax;
  if (r.modo === 'openrouter' || (r.modo === 'auto' && !r.c.groq.key && r.c.openrouter.key)) return r.c.openrouter.janelaMax;
  const CARACTERES_POR_TOKEN = 3.4; // PT-BR falado rende ~3,6 caracteres por token — margem apertada de propósito
  return Math.max(1600, Math.round(Math.max((r.c.groq.tpm || 8000) * 0.85 - Math.max(reservaTokens, 600), 1000) * CARACTERES_POR_TOKEN));
}

export class AIError extends Error {
  constructor(msg, { status = 500, code = 'ai_error', retryAfterMs = null, provider = null } = {}) { super(msg); this.name = 'AIError'; this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; this.provider = provider; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_INLINE_WAIT_MS = 8000;      // espera máxima dentro da requisição para um 429 comum
const MAX_INLINE_WAIT_TPM_MS = 70000; // 429 de TPM/janela curta: vale esperar virar (o retry-after diz quando)

function parseRetryAfter(h) {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.round(n * 1000);
  const d = Date.parse(h); return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}
// retryDelay ISO-8601 do Gemini ("30s" / "1.5s").
const parseRetryDelay = (texto) => {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(texto) || /retry in (\d+(?:\.\d+)?)s/i.exec(texto);
  return m ? Math.round(parseFloat(m[1]) * 1000) : null;
};

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

// Ajusta o JSON Schema ao dialeto do Gemini: tipos em MAIÚSCULAS, sem additionalProperties, uniões de tipos colapsadas.
function schemaGemini(s) {
  if (Array.isArray(s)) return s.map(schemaGemini);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') { out.type = String(Array.isArray(v) ? v[0] : v).toUpperCase(); continue; }
    if (k === 'properties') { out.properties = {}; for (const [pk, pv] of Object.entries(v)) out.properties[pk] = schemaGemini(pv); continue; }
    if (k === 'items') { out.items = schemaGemini(v); continue; }
    out[k] = v;
  }
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

function rotuloVoz(nome) { return nome === 'gemini' ? 'Gemini' : nome === 'openrouter' ? 'OpenRouter' : 'Groq'; }
function chaveNome(nome) { return nome === 'gemini' ? 'GEMINI_API_KEY' : nome === 'openrouter' ? 'OPENROUTER_API_KEY' : 'GROQ_API_KEY'; }

// Camada de HTTP compartilhada com tratamento de 429/413/5xx e disjuntor POR provedor.
async function chamar(url, init, opts, rotulo) {
  const nome = opts.nome || 'groq';
  const voz = rotuloVoz(nome);
  let ultimo = null;
  for (let tent = 0; tent <= opts.retries; tent++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout);
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok) return r;
      const corpo = await r.text().catch(() => '');
      let detalhe = ''; try { detalhe = JSON.parse(corpo).error?.message || ''; } catch (_) { detalhe = corpo.slice(0, 200); }
      const retryMs = parseRetryAfter(r.headers.get('retry-after')) ?? parseRetryDelay(corpo);
      if (r.status === 401 || r.status === 403) throw new AIError(`A ${chaveNome(nome)} configurada não é válida ou não tem permissão.`, { status: 502, code: 'auth', provider: nome });
      if (r.status === 429) {
        const janelaCurta = nome === 'groq'
          ? (/tokens per minute|\bTPM\b/i.test(detalhe) && !/per day|TPD|RPD/i.test(detalhe))
          : /per minute|PerMinute|per-min/i.test(corpo); // Gemini/OpenRouter: cota por minuto (ex.: RPM de free tier)
        const diario = /per day|PerDay|per-day|free-models-per-day/i.test(corpo) || (nome === 'gemini' && /RESOURCE_EXHAUSTED/i.test(detalhe) && !/per minute|PerMinute|per-min/i.test(corpo));
        const limiteEspera = janelaCurta ? MAX_INLINE_WAIT_TPM_MS : MAX_INLINE_WAIT_MS;
        const espera = retryMs != null ? Math.max(retryMs, 1000) : 2000 * (tent + 1);
        if (diario || espera > limiteEspera) bloquear(nome, espera);
        ultimo = new AIError(`Limite de uso do ${voz} atingido${retryMs ? ` — tenta em ~${Math.ceil(espera / 1000)}s` : ''}.`, { status: 429, code: 'rate_limit', retryAfterMs: retryMs, provider: nome });
        if (tent < opts.retries && espera <= limiteEspera) { await sleep(espera + Math.floor(Math.random() * 250)); continue; }
        throw ultimo;
      }
      if (r.status >= 500) { ultimo = new AIError(`${voz} indisponível (${r.status}).`, { status: 503, code: 'upstream', provider: nome }); if (tent < opts.retries) { await sleep(500 * 2 ** tent); continue; } throw ultimo; }
      if (nome === 'groq' && r.status === 413 && /tokens per minute|\bTPM\b/i.test(detalhe) && tent < opts.retries) {
        // A Groq devolve 413 (com mensagem de TPM) quando a requisição inteira excede o teto de tokens por minuto.
        const espera = Math.min(retryMs != null ? Math.max(retryMs, 1000) : 2000 * 2 ** tent, 15000);
        ultimo = new AIError(`A requisição excedeu o limite de tokens por minuto do ${voz}.`, { status: 429, code: 'rate_limit', retryAfterMs: espera, provider: nome });
        if (espera <= MAX_INLINE_WAIT_TPM_MS) { await sleep(espera + Math.floor(Math.random() * 250)); continue; }
        throw ultimo;
      }
      const e = new AIError(`${voz} recusou a requisição (${r.status}): ${detalhe}`.slice(0, 400), { status: 502, code: r.status === 400 ? 'bad_request' : 'upstream', provider: nome });
      e.httpStatus = r.status; e.detalhe = detalhe; throw e;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AIError) throw err;
      const abort = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
      ultimo = new AIError(abort ? `A IA demorou mais de ${Math.round(opts.timeout / 1000)}s para responder (${rotulo}).` : `Falha de rede ao chamar o ${voz}: ${String(err.message || err).slice(0, 120)}`, { status: abort ? 504 : 502, code: abort ? 'timeout' : 'network', provider: nome });
      if (tent < opts.retries) { await sleep(500 * 2 ** tent); continue; }
      throw ultimo;
    }
  }
  throw ultimo || new AIError(`Falha desconhecida ao chamar o ${voz}.`, { provider: nome });
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

// ── PROVEDOR GROQ (OpenAI-compatível) ──
async function rodarGroq(messages, conf, schema, querJson, c, params) {
  const model = params.model || c.model;
  const base = { model, messages, temperature: conf.temperature ?? 0.4, max_completion_tokens: Math.min(conf.maxOutputTokens || c.maxOut, c.maxOut) };
  if (nomeDoModelo(model)) base.reasoning_effort = 'low';
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key };
  const url = c.base + '/chat/completions';

  const rodar = async (body, rotulo) => {
    const r = await chamar(url, { method: 'POST', headers, body: JSON.stringify(body) }, { ...c, nome: 'groq' }, rotulo);
    const j = await r.json();
    const choice = j.choices && j.choices[0];
    const text = (choice && choice.message && choice.message.content) || '';
    if (choice && choice.finish_reason === 'length' && querJson) throw new AIError('A resposta da IA foi cortada por limite de tamanho.', { status: 502, code: 'truncated', provider: 'groq' });
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
      if (err instanceof AIError && !['bad_request', 'truncated'].includes(err.code)) throw err; // rede/limite/chave: não mascarar (o roteador pode cair para o Gemini)
    }
  }
  throw (ultimoErro instanceof AIError ? ultimoErro : new AIError('A IA não devolveu uma resposta JSON válida: ' + (ultimoErro && ultimoErro.message), { status: 502, code: 'invalid_json', provider: 'groq' }));
}

// ── PROVEDOR GEMINI (generateContent) ──
async function rodarGemini(messages, conf, schema, querJson, c, params) {
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const body = {
    contents,
    ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
    generationConfig: {
      temperature: conf.temperature ?? 0.4,
      maxOutputTokens: Math.min(conf.maxOutputTokens || c.maxOut, c.maxOut),
      ...(querJson ? { responseMimeType: 'application/json' } : {}),
      ...(schema ? { responseSchema: schemaGemini(schema) } : {})
    }
  };
  const url = `${c.base}/models/${c.model}:generateContent`;
  const r = await chamar(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.key }, body: JSON.stringify(body) }, { ...c, nome: 'gemini' }, 'texto/json');
  const j = await r.json();
  const cand = (j.candidates || [])[0];
  const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
  if (j.promptFeedback && j.promptFeedback.blockReason) throw new AIError(`O Gemini recusou o conteúdo por política de segurança (${j.promptFeedback.blockReason}).`, { status: 502, code: 'bad_request', provider: 'gemini' });
  if (cand && cand.finishReason === 'MAX_TOKENS' && querJson) throw new AIError('A resposta da IA foi cortada por limite de tamanho.', { status: 502, code: 'truncated', provider: 'gemini' });
  if (!text && !schema && !querJson) { /* permitido (resposta vazia) — comportamento idêntico ao da Groq */ }
  const usage = j.usageMetadata ? { prompt_tokens: j.usageMetadata.promptTokenCount, completion_tokens: j.usageMetadata.candidatesTokenCount, total_tokens: j.usageMetadata.totalTokenCount } : null;
  return { text, usage, model: c.model, provider: 'gemini' };
}

// ── PROVEDOR OPENROUTER (OpenAI-compatível; ex.: NVIDIA Nemotron) ──
// Modelos de raciocínio podem devolver <think>…</think> ou content nulo; limpamos e validamos como nos demais.
async function rodarOpenRouter(messages, conf, schema, querJson, c, params) {
  const model = params.model || c.model;
  const base = { model, messages, temperature: conf.temperature ?? 0.4, max_tokens: Math.min(conf.maxOutputTokens || c.maxOut, c.maxOut), reasoning: { effort: 'low' } };
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key, 'X-Title': c.app, ...(c.site ? { 'HTTP-Referer': c.site } : {}) };
  const url = c.base + '/chat/completions';
  const limpar = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const rodar = async (body, rotulo) => {
    const r = await chamar(url, { method: 'POST', headers, body: JSON.stringify(body) }, { ...c, nome: 'openrouter' }, rotulo);
    const j = await r.json();
    if (j.error) throw new AIError(`OpenRouter: ${String(j.error.message || 'erro').slice(0, 200)}`, { status: 502, code: /rate|limit|quota/i.test(String(j.error.message)) || j.error.code === 429 ? 'rate_limit' : 'upstream', provider: 'openrouter' });
    const choice = j.choices && j.choices[0];
    const text = limpar(choice && choice.message && choice.message.content);
    if (choice && choice.finish_reason === 'length' && querJson) throw new AIError('A resposta da IA foi cortada por limite de tamanho.', { status: 502, code: 'truncated', provider: 'openrouter' });
    if (!text && querJson) throw new AIError('A IA não devolveu conteúdo (o modelo gastou o limite pensando).', { status: 502, code: 'invalid_json', provider: 'openrouter' });
    return { text, usage: j.usage || null, model: j.model || model, provider: 'openrouter' };
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
  if (schema) tentativas.push({ ...base, response_format: { type: 'json_schema', json_schema: { name: 'resposta', strict: false, schema } } });
  tentativas.push(comoJsonObject());
  for (const body of tentativas) {
    try { const out = await rodar(body, 'json'); validarJson(out.text, schema); return out; }
    catch (err) {
      ultimoErro = err;
      if (err instanceof AIError && !['bad_request', 'truncated', 'invalid_json'].includes(err.code)) throw err;
    }
  }
  throw (ultimoErro instanceof AIError ? ultimoErro : new AIError('A IA não devolveu uma resposta JSON válida: ' + (ultimoErro && ultimoErro.message), { status: 502, code: 'invalid_json', provider: 'openrouter' }));
}

// Erros que VALEM a troca de provedor (fallback no roteador).
const TROCA_DE_PROVEDOR = new Set(['rate_limit', 'upstream', 'timeout', 'network', 'auth', 'truncated', 'invalid_json', 'bad_request']);

// Estimativa de tokens (heurística: ~4 caracteres por token) para decidir Groq × Gemini no modo auto.
const tokensEst = (obj) => Math.max(1, Math.round(JSON.stringify(obj).length / 4));

// API principal. Retorna { text, usage, model, provider }.
export async function generateAI(params) {
  const r = roteador();
  if (!r.modo || (!r.temGroq && !r.temGem && !r.temOR)) throw new AIError('Configure GROQ_API_KEY, GEMINI_API_KEY e/ou OPENROUTER_API_KEY no servidor.', { status: 503, code: 'no_key' });
  if (!aiConfigured()) throw new AIError(`AI_PROVIDER "${r.modo}" exige a chave correspondente no servidor.`, { status: 503, code: 'no_key' });

  const conf = params.config || {};
  const schema = conf.responseSchema ? toJsonSchema(conf.responseSchema) : null;
  const querJson = !!schema || /json/i.test(conf.responseMimeType || '');
  const messages = await montarMensagens(params, r.c);

  // ── ROTEAMENTO (modo auto) ──
  // 1) elegibilidade por tamanho: Groq só se o prompt cabe no TPM do minuto; Gemini/OpenRouter pelo teto de
  //    caracteres. 2) ordem de preferência (AI_ORDER; padrão Groq → Gemini → OpenRouter) entre os elegíveis.
  // 3) provedor rebaixado (2 falhas seguidas no último minuto) vai para o fim. 4) quem não cabe só entra como
  //    último recurso (o OpenRouter grande demais é pulado). Limites diários/de janela já ficam no disjuntor.
  const tokens = tokensEst(params); const chars = JSON.stringify(messages).length;
  let fila = [];
  if (r.modo === 'auto') {
    const tem = { groq: r.temGroq, gemini: r.temGem, openrouter: r.temOR };
    const env = String(process.env.AI_ORDER || '').toLowerCase().split(/[\s,>]+/).filter(n => n in tem);
    const base = [...new Set([...env, 'groq', 'gemini', 'openrouter'])].filter(n => tem[n]);
    const cabe = (n) => n === 'groq' ? tokens <= r.c.groq.tpm * 0.72 : chars <= r.c[n].janelaMax;
    const ordenar = (lista) => [...lista.filter(n => !rebaixado(n)), ...lista.filter(n => rebaixado(n))];
    fila = [...ordenar(base.filter(cabe)), ...ordenar(base.filter(n => !cabe(n)))];
  } else {
    fila = [r.modo];
  }

  let ultimo = null; let todosBloqueados = true; const trilha = [];
  for (let i = 0; i < fila.length; i++) {
    const nome = fila[i];
    if (!disponivel(nome)) { trilha.push({ provider: nome, pulado: 'limite' }); ultimo = ultimo || new AIError(`Limite do ${rotuloVoz(nome)} atingido — tente de novo em ~${Math.ceil((bloqueadoAte[nome] - Date.now()) / 60000)} min.`, { status: 429, code: 'rate_limit', retryAfterMs: bloqueadoAte[nome] - Date.now(), provider: nome }); continue; }
    todosBloqueados = false;
    const base = nome === 'gemini' ? r.c.gemini : nome === 'openrouter' ? r.c.openrouter : r.c.groq;
    if (nome === 'openrouter' && r.modo === 'auto' && chars > base.janelaMax) { trilha.push({ provider: nome, pulado: 'grande' }); ultimo = ultimo || new AIError('Prompt grande demais para o OpenRouter.', { status: 413, code: 'upstream', provider: nome }); continue; }
    // Falha rápida: havendo outro provedor livre na fila, gasta no máximo 1 retry aqui e passa a bola.
    const temProximo = fila.slice(i + 1).some(n => disponivel(n) && !(n === 'openrouter' && chars > r.c.openrouter.janelaMax));
    const cc = temProximo ? { ...base, retries: Math.min(base.retries, 1) } : base;
    const t0 = Date.now();
    try {
      const out = nome === 'gemini'
        ? await rodarGemini(messages, conf, schema, querJson, cc, params)
        : nome === 'openrouter'
          ? await rodarOpenRouter(messages, conf, schema, querJson, cc, params)
          : await rodarGroq(messages, conf, schema, querJson, cc, params);
      registrar(nome, true, Date.now() - t0, null, out.model);
      trilha.push({ provider: nome, ok: true });
      return { ...out, tentativas: trilha };
    } catch (err) {
      ultimo = err; registrar(nome, false, Date.now() - t0, err, base.model); trilha.push({ provider: nome, ok: false, code: err.code });
      if (err.code === 'unsupported_media' || err.code === 'pdf_unavailable' || err.code === 'pdf_sem_texto') throw err; // independe do provedor
      if (!(err instanceof AIError) || !TROCA_DE_PROVEDOR.has(err.code)) throw err;
    }
  }
  if (todosBloqueados && fila.length > 1) {
    const ms = Math.max(Math.min(...fila.map(n => bloqueadoAte[n] - Date.now())), 1000);
    throw new AIError(`Nenhum provedor de IA livre agora (${fila.map(rotuloVoz).join('/')} em limite) — tente de novo em ~${Math.ceil(ms / 60000)} min.`, { status: 429, code: 'rate_limit', retryAfterMs: ms });
  }
  throw (ultimo || new AIError('Nenhum provedor de IA disponível.', { status: 503, code: 'no_key' }));
}

// Transcrição de áudio (Groq Whisper). audioBase64 sem prefixo data:.
// Com timestamps:true usa verbose_json e devolve { texto, segmentos: [{ ini, fim, text }] } — é o que
// sincroniza o "karaoke" da Aula do Dia; sem a flag, segue devolvendo só o texto (compatibilidade).
export async function transcribeAudio({ audioBase64, mime = 'audio/webm', prompt = '', language = 'pt', timestamps = false }) {
  const c = cfg().groq;
  if (!c.key) throw new AIError('GROQ_API_KEY não configurada no servidor (transcrição usa o Whisper da Groq).', { status: 503, code: 'no_key' });
  if (!disponivel('groq')) throw new AIError('Limite da Groq atingido — tente novamente em instantes.', { status: 429, code: 'rate_limit', provider: 'groq' });
  const ext = ({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac' })[mime] || 'webm';
  const buf = Buffer.from(audioBase64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `trecho.${ext}`);
  form.append('model', c.stt);
  form.append('language', language);
  form.append('temperature', '0');
  form.append('response_format', timestamps ? 'verbose_json' : 'json');
  if (prompt) form.append('prompt', String(prompt).slice(0, 800)); // Whisper aceita um prompt curto (glossário / contexto)
  const r = await chamar(c.base + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + c.key }, body: form }, { ...c, nome: 'groq', timeout: Math.max(c.timeout, 60000) }, 'transcrição');
  const j = await r.json();
  const texto = String(j.text || '').trim();
  if (!timestamps) return texto;
  const segmentos = (Array.isArray(j.segments) ? j.segments : [])
    .map(s => ({ ini: Number(s.start) || 0, fim: Number(s.end) || 0, text: String(s.text || '').replace(/[\r\n]+/g, ' ').trim() }))
    .filter(s => s.text && fimIni(s.fim, s.ini) >= 0);
  return { texto, segmentos };
}
const fimIni = (fim, ini) => fim - ini;

export function _resetForTests() { for (const n of ['groq', 'gemini', 'openrouter']) { bloqueadoAte[n] = 0; saude[n] = novaSaude(); } }
