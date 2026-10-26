import { sentenceVectors } from './embedding-utils.js';
import { semanticEmbeddingConfig } from './acervo-semantic-indexer.js';
import { ISC_VECTOR_DIMENSIONS } from './isc-core.js';

function validVectors(vectors, count) {
  return Array.isArray(vectors) && vectors.length === count && vectors.length > 0 &&
    vectors.every(vector => Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite));
}

export function normalizeIscVector(vector) {
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite) || vector.length > ISC_VECTOR_DIMENSIONS) {
    throw new Error(`Embedding inválido; o índice ISC aceita até ${ISC_VECTOR_DIMENSIONS} dimensões.`);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  const normalized = vector.map(value => value / norm);
  return normalized.concat(new Array(ISC_VECTOR_DIMENSIONS - normalized.length).fill(0));
}

export async function embedIscTexts(texts, {
  purpose = 'document', config = semanticEmbeddingConfig(), fetchImpl = fetch,
  signal = AbortSignal.timeout(90000), limiter = null
} = {}) {
  if (!config.token) throw new Error('Configure um provedor de embeddings já usado pelo projeto para indexar o ISC.');
  if (!Array.isArray(texts) || !texts.length || texts.some(text => typeof text !== 'string' || !text.trim())) {
    throw new Error('Envie ao menos um segmento de texto para gerar embeddings.');
  }

  const waitMs = limiter ? Math.max(0, Number(limiter.nextRequestAt || 0) - Date.now()) : 0;
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  const startedAt = Date.now();
  const google = config.provider === 'google';
  const cohere = config.provider === 'cohere';
  const body = cohere
    ? { model: config.model, texts, input_type: purpose === 'query' ? 'search_query' : 'search_document', embedding_types: ['float'] }
    : google
      ? { requests: texts.map(text => ({
        model: `models/${config.model}`,
        content: { parts: [{ text: purpose === 'query' ? `task: search result | query: ${text}` : text }] },
        embedContentConfig: { outputDimensionality: 768 }
      })) }
      : { inputs: texts.map(text => purpose === 'query' ? `task: search result | query: ${text}` : text), normalize: true };
  const url = cohere
    ? 'https://api.cohere.com/v2/embed'
    : google
      ? `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:batchEmbedContents`
      : `https://router.huggingface.co/hf-inference/models/${config.model}/pipeline/feature-extraction`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: google
      ? { 'x-goog-api-key': config.token, 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Provedor de embeddings indisponível (${response.status}).`);

  const vectors = cohere
    ? data?.embeddings?.float
    : google
      ? data?.embeddings?.map(embedding => embedding?.values)
      : sentenceVectors(data, texts.length);
  if (!validVectors(vectors, texts.length)) throw new Error('O provedor retornou embeddings com formato ou quantidade inesperados.');

  if (limiter) {
    if (google) {
      const promptTokens = Number(data?.usageMetadata?.promptTokenCount) || 0;
      limiter.nextRequestAt = startedAt + Math.max(12_000, promptTokens ? Math.ceil(promptTokens * 60_000 / 30_000 * 1.15) : 12_000);
    } else if (cohere) limiter.nextRequestAt = startedAt + 13_000;
  }
  return vectors.map(normalizeIscVector);
}

export { semanticEmbeddingConfig };
