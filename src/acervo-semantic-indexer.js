import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sentenceVectors } from './embedding-utils.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUCKET = 'acervo';
const BATCH_SIZE = 96;
const MAX_BATCHES_PER_REQUEST = 8;
const COHERE_REQUEST_INTERVAL_MS = 13_000;

export function semanticEmbeddingConfig() {
  if (process.env.COHERE_API_KEY) {
    const model = process.env.COHERE_EMBEDDING_MODEL || 'embed-multilingual-v3.0';
    return { provider: 'cohere', model, indexModel: `cohere:${model}`, token: process.env.COHERE_API_KEY };
  }
  const model = process.env.HF_EMBEDDING_MODEL || 'google/embeddinggemma-300m';
  return { provider: 'huggingface', model, indexModel: model, token: process.env.HF_TOKEN || '' };
}

export function semanticIndexPrefix(config = semanticEmbeddingConfig()) {
  return config.provider === 'cohere' && process.env.VERCEL_ENV === 'preview'
    ? 'semantic-index/preview-cohere'
    : 'semantic-index';
}

function catalogItem(item, tipo) {
  const pathText = String(item.path || '');
  return {
    id: String(item.id || ''),
    tipo,
    titulo: String(item.t || item.d || 'Material do acervo').trim().slice(0, 240),
    curso: String(item.course || 'Geral').trim().slice(0, 120),
    disciplina: pathText.split('/').map(part => part.trim()).filter(Boolean).slice(-2, -1)[0] || '',
    path: pathText.slice(0, 1000)
  };
}

async function carregarCatalogo(supabase) {
  const { data, error } = await supabase.storage.from(BUCKET).download('acervo-manifest.json');
  if (!error && data) return JSON.parse(await data.text());
  const fallback = path.join(ROOT, 'acervo-manifest.json');
  try { return JSON.parse(await fs.readFile(fallback, 'utf8')); }
  catch { throw new Error('Catálogo não encontrado no Storage nem no bundle.'); }
}

async function embedHuggingFace(texts, config) {
  const url = `https://router.huggingface.co/hf-inference/models/${config.model}/pipeline/feature-extraction`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: texts, normalize: true }),
    signal: AbortSignal.timeout(90000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Falha no Hugging Face Inference (${response.status}).`);
  const vectors = sentenceVectors(data, texts.length);
  if (vectors && vectors.every(vector => vector.length === vectors[0].length)) return vectors;
  throw new Error('EmbeddingGemma devolveu vetores em formato ou dimensão inesperados.');
}

async function embedCohere(texts, config, limiter) {
  const wait = limiter.nextRequestAt - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  const startedAt = Date.now();
  limiter.nextRequestAt = startedAt + COHERE_REQUEST_INTERVAL_MS;
  const response = await fetch('https://api.cohere.com/v2/embed', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      texts,
      input_type: 'search_document',
      embedding_types: ['float']
    }),
    signal: AbortSignal.timeout(90000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Falha no Cohere Embed (${response.status}).`);
  const vectors = data?.embeddings?.float;
  if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every(vector => Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite))) {
    throw new Error('Cohere devolveu vetores em formato ou dimensão inesperados.');
  }
  return vectors;
}

function quantize(vectors) {
  const dimensions = vectors[0]?.length || 0;
  if (!dimensions || vectors.some(vector => vector.length !== dimensions)) throw new Error('O provedor devolveu vetores com dimensões diferentes.');
  const bytes = Buffer.alloc(vectors.length * dimensions);
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    for (let j = 0; j < dimensions; j++) bytes.writeInt8(Math.round(Math.max(-1, Math.min(1, vector[j] / norm)) * 127), i * dimensions + j);
  }
  return { bytes, dimensions };
}

async function downloadState(supabase, statePath) {
  const { data, error } = await supabase.storage.from(BUCKET).download(statePath);
  if (error || !data) return null;
  return JSON.parse(await data.text());
}

async function saveState(supabase, statePath, state) {
  const { error } = await supabase.storage.from(BUCKET).upload(statePath, JSON.stringify(state), {
    contentType: 'application/json', upsert: true
  });
  if (error) throw new Error(`Não foi possível salvar o progresso do índice: ${error.message}`);
}

export async function indexAcervoSemantic(supabase, {
  runId,
  offset = 0,
  onProgress = () => {}
} = {}) {
  const config = semanticEmbeddingConfig();
  if (!config.token) throw new Error(config.provider === 'cohere'
    ? 'Configure COHERE_API_KEY no Preview.'
    : 'Configure HF_TOKEN com permissão Inference Providers e aceite a licença Gemma no Hugging Face.');
  if (!supabase) throw new Error('Storage do Supabase não está configurado.');
  if (!/^[a-f0-9-]{36}$/i.test(String(runId || ''))) throw new Error('Identificador de geração inválido.');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Posição de retomada inválida.');

  const prefix = semanticIndexPrefix(config);
  const buildPrefix = `${prefix}/.build-${runId}`;
  const statePath = `${buildPrefix}/state.json`;
  const catalog = await carregarCatalogo(supabase);
  const seen = new Set();
  const items = [
    ...(catalog.videos || []).map(item => catalogItem(item, 'video')),
    ...(catalog.materials || []).map(item => catalogItem(item, 'material'))
  ].filter(item => item.id && item.titulo).filter(item => {
    const key = `${item.tipo}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!items.length) throw new Error('O catálogo não contém itens indexáveis.');
  if (offset > items.length) throw new Error('Posição de retomada maior que o catálogo.');
  if (offset !== items.length && offset % BATCH_SIZE !== 0) throw new Error('Posição de retomada inválida.');

  let state = await downloadState(supabase, statePath);
  if (state?.complete) return state.result;
  if (state && (state.modelo !== config.indexModel || state.catalogoGeradoEm !== String(catalog.generatedAt || ''))) {
    throw new Error('O catálogo ou modelo mudou durante a indexação. Inicie uma nova geração.');
  }
  if (state && offset !== state.nextOffset) {
    if (offset < state.nextOffset) return { complete: false, runId, nextOffset: state.nextOffset, quantidade: items.length };
    throw new Error('A etapa anterior do índice ainda não foi salva.');
  }
  if (!state && offset !== 0) throw new Error('Progresso da geração não encontrado. Inicie uma nova geração.');
  if (!state) {
    state = {
      runId,
      modelo: config.indexModel,
      catalogoGeradoEm: String(catalog.generatedAt || ''),
      nextOffset: 0,
      dimensoes: 0,
      parts: []
    };
  }

  const end = Math.min(items.length, offset + BATCH_SIZE * MAX_BATCHES_PER_REQUEST);
  const vectors = [];
  const limiter = { nextRequestAt: 0 };
  for (let start = offset; start < end; start += BATCH_SIZE) {
    const batch = items.slice(start, Math.min(start + BATCH_SIZE, end));
    const docs = batch.map(item => `title: ${item.titulo || 'none'} | text: ${item.curso}. ${item.path}`);
    const embedded = config.provider === 'cohere'
      ? await embedCohere(docs, config, limiter)
      : await embedHuggingFace(docs, config);
    vectors.push(...embedded);
    const processed = Math.min(items.length, start + batch.length);
    onProgress(`Vetores processados: ${processed}/${items.length}`);
  }

  let partBytes = Buffer.alloc(0);
  if (vectors.length) {
    const packed = quantize(vectors);
    if (state.dimensoes && state.dimensoes !== packed.dimensions) throw new Error('O provedor mudou a dimensão dos vetores durante a geração.');
    state.dimensoes = packed.dimensions;
    partBytes = packed.bytes;
    const partPath = `${buildPrefix}/vectors-${String(offset).padStart(8, '0')}.bin`;
    const { error } = await supabase.storage.from(BUCKET).upload(partPath, partBytes, {
      contentType: 'application/octet-stream', upsert: true
    });
    if (error) throw new Error(`Não foi possível salvar uma etapa dos vetores: ${error.message}`);
    state.parts.push(partPath);
    state.nextOffset = end;
    await saveState(supabase, statePath, state);
  }

  if (end < items.length) {
    return { complete: false, runId, nextOffset: end, quantidade: items.length };
  }

  if (state.nextOffset !== items.length || !state.parts.length) throw new Error('As etapas de vetores não cobrem o catálogo completo.');
  const parts = await Promise.all(state.parts.map(async partPath => {
    if (partPath === `${buildPrefix}/vectors-${String(offset).padStart(8, '0')}.bin`) return partBytes;
    const { data, error } = await supabase.storage.from(BUCKET).download(partPath);
    if (error || !data) throw new Error('Uma etapa salva dos vetores não foi encontrada.');
    return Buffer.from(await data.arrayBuffer());
  }));
  const vectorBytes = Buffer.concat(parts);
  if (vectorBytes.length !== items.length * state.dimensoes) throw new Error('O índice gerado não cobre todos os itens do catálogo.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const vectorsPath = `${prefix}/vectors-${stamp}.bin`;
  const meta = {
    versao: 1,
    modelo: config.indexModel,
    dimensoes: state.dimensoes,
    itens: items,
    quantidade: items.length,
    geradoEm: new Date().toISOString(),
    catalogoGeradoEm: String(catalog.generatedAt || ''),
    vectorsPath
  };
  const vectorUpload = await supabase.storage.from(BUCKET).upload(vectorsPath, vectorBytes, {
    contentType: 'application/octet-stream', upsert: true
  });
  if (vectorUpload.error) throw new Error(`Não foi possível enviar os vetores ao Storage: ${vectorUpload.error.message}`);
  const metaUpload = await supabase.storage.from(BUCKET).upload(`${prefix}/meta.json`, JSON.stringify(meta), {
    contentType: 'application/json', upsert: true
  });
  if (metaUpload.error) throw new Error(`Não foi possível publicar o índice semântico: ${metaUpload.error.message}`);

  const result = {
    complete: true,
    runId,
    nextOffset: items.length,
    quantidade: items.length,
    dimensoes: state.dimensoes,
    kilobytes: Math.round(vectorBytes.length / 1024),
    vectorsPath
  };
  state.complete = true;
  state.result = result;
  await saveState(supabase, statePath, state);

  const { data: oldFiles } = await supabase.storage.from(BUCKET).list(prefix);
  const obsolete = (oldFiles || [])
    .filter(file => file.name.startsWith('vectors-') && file.name !== path.posix.basename(vectorsPath))
    .map(file => `${prefix}/${file.name}`);
  if (obsolete.length) {
    const { error } = await supabase.storage.from(BUCKET).remove(obsolete);
    if (error) console.warn('[Busca semântica] O índice antigo não foi removido:', error.message);
  }
  if (state.parts.length) {
    const { error } = await supabase.storage.from(BUCKET).remove(state.parts);
    if (error) console.warn('[Busca semântica] As etapas temporárias não foram removidas:', error.message);
  }

  return result;
}

export const semanticIndexBatchSize = BATCH_SIZE;
