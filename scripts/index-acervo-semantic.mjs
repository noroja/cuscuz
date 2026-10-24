import '../src/load-env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { sentenceVectors } from '../src/embedding-utils.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUCKET = 'acervo';
const META_PATH = 'semantic-index/meta.json';
const BATCH_SIZE = 32;
const MODEL = process.env.HF_EMBEDDING_MODEL || 'google/embeddinggemma-300m';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  catch { throw new Error(`Catálogo não encontrado no Storage nem em ${fallback}.`); }
}

async function embed(texts) {
  const url = `https://router.huggingface.co/hf-inference/models/${MODEL}/pipeline/feature-extraction`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: texts, normalize: true }),
      signal: AbortSignal.timeout(90000)
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      const vectors = sentenceVectors(data, texts.length);
      if (vectors && vectors.every(vector => vector.length === vectors[0].length)) return vectors;
      throw new Error('EmbeddingGemma devolveu vetores em formato ou dimensão inesperados.');
    }
    const retrySeconds = Number(data?.estimated_time) || Number(response.headers.get('retry-after')) || 0;
    if (attempt < 2 && (response.status === 503 || (response.status === 429 && retrySeconds > 0))) {
      await wait(Math.min(Math.max(retrySeconds, 2), 30) * 1000);
      continue;
    }
    throw new Error(`Falha no Hugging Face Inference (${response.status}).`);
  }
  throw new Error('EmbeddingGemma permaneceu indisponível após 3 tentativas.');
}

if (!process.env.HF_TOKEN) throw new Error('Configure HF_TOKEN com permissão Inference Providers e aceite a licença Gemma no Hugging Face.');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para publicar o índice privado.');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
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

const vectors = [];
for (let i = 0; i < items.length; i += BATCH_SIZE) {
  const batch = items.slice(i, i + BATCH_SIZE);
  const docs = batch.map(item => `title: ${item.titulo || 'none'} | text: ${item.curso}. ${item.path}`);
  vectors.push(...await embed(docs));
  if ((i + batch.length) % 512 < BATCH_SIZE || i + batch.length === items.length) {
    console.log(`[Busca semântica] Vetores processados: ${i + batch.length}/${items.length}`);
  }
}

const dimensions = vectors[0].length;
const vectorBytes = Buffer.alloc(items.length * dimensions);
for (let i = 0; i < vectors.length; i++) {
  const vector = vectors[i];
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  for (let j = 0; j < dimensions; j++) vectorBytes.writeInt8(Math.round(Math.max(-1, Math.min(1, vector[j] / norm)) * 127), i * dimensions + j);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const vectorsPath = `semantic-index/vectors-${stamp}.bin`;
const meta = {
  versao: 1,
  modelo: MODEL,
  dimensoes: dimensions,
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
const metaUpload = await supabase.storage.from(BUCKET).upload(META_PATH, JSON.stringify(meta), {
  contentType: 'application/json', upsert: true
});
if (metaUpload.error) throw new Error(`Não foi possível publicar o índice semântico: ${metaUpload.error.message}`);

const { data: oldFiles } = await supabase.storage.from(BUCKET).list('semantic-index');
const obsolete = (oldFiles || [])
  .filter(file => file.name.startsWith('vectors-') && file.name !== path.posix.basename(vectorsPath))
  .map(file => `semantic-index/${file.name}`);
if (obsolete.length) {
  const { error } = await supabase.storage.from(BUCKET).remove(obsolete);
  if (error) console.warn('[Busca semântica] O índice antigo não foi removido:', error.message);
}

console.log(`[Busca semântica] Índice publicado: ${items.length} itens, ${dimensions} dimensões, ${Math.round(vectorBytes.length / 1024)} KB de vetores.`);
