import { sentenceVectors } from './embedding-utils.js';
import { indexAcervoSemantic } from './acervo-semantic-indexer.js';

const BUCKET = 'acervo';
const META_PATH = 'semantic-index/meta.json';
const VECTOR_PATH = 'semantic-index/vectors.bin';
const INDEX_VERSION = 1;
const INDEX_BRANCH = 'codex/cuscuz-full-update-preview';

let indexPromise = null;
let indexLoadedAt = 0;
let indexJobPromise = null;

const textoDocumento = item => `title: ${item.titulo || 'none'} | text: ${item.curso || ''}. ${item.path || ''}`.trim();

async function lerIndex(supabase) {
  if (indexPromise) {
    if (!indexLoadedAt || Date.now() - indexLoadedAt < 10 * 60 * 1000) return indexPromise;
    indexLoadedAt = 0;
  }
  indexPromise = (async () => {
    const metaResult = await supabase.storage.from(BUCKET).download(META_PATH);
    if (metaResult.error || !metaResult.data) throw new Error('Índice semântico ausente. Gere com npm run index:acervo-semantico.');
    const meta = JSON.parse(await metaResult.data.text());
    const vectorResult = await supabase.storage.from(BUCKET).download(meta.vectorsPath || VECTOR_PATH);
    if (vectorResult.error || !vectorResult.data) throw new Error('Vetores do índice semântico ausentes. Gere com npm run index:acervo-semantico.');
    const vectors = Buffer.from(await vectorResult.data.arrayBuffer());
    if (meta.versao !== INDEX_VERSION || meta.modelo !== (process.env.HF_EMBEDDING_MODEL || 'google/embeddinggemma-300m')) {
      throw new Error('Índice semântico incompatível. Regenere com npm run index:acervo-semantico.');
    }
    if (!Array.isArray(meta.itens) || !Number.isInteger(meta.dimensoes) || meta.dimensoes < 1 || vectors.length !== meta.itens.length * meta.dimensoes) {
      throw new Error('Índice semântico incompleto. Regenere com npm run index:acervo-semantico.');
    }
    indexLoadedAt = Date.now();
    return { meta, vectors };
  })().catch(error => { indexPromise = null; indexLoadedAt = 0; throw error; });
  return indexPromise;
}
async function embeddingConsulta(query) {
  const token = process.env.HF_TOKEN || '';
  const model = process.env.HF_EMBEDDING_MODEL || 'google/embeddinggemma-300m';
  const url = `https://router.huggingface.co/hf-inference/models/${model}/pipeline/feature-extraction`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: [`task: search result | query: ${query}`], normalize: true }),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`EmbeddingGemma indisponível (${response.status}).`);
  const vector = sentenceVectors(data, 1)?.[0];
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) throw new Error('EmbeddingGemma devolveu um vetor inválido.');
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

function buscarVizinhos(index, queryVector, limit) {
  const { meta, vectors } = index;
  if (queryVector.length !== meta.dimensoes) throw new Error('Dimensão do vetor não corresponde ao índice; regenere o índice semântico.');
  const resultados = [];
  for (let i = 0; i < meta.itens.length; i++) {
    const inicio = i * meta.dimensoes;
    let dot = 0, norma = 0;
    for (let j = 0; j < meta.dimensoes; j++) {
      const value = vectors.readInt8(inicio + j) / 127;
      dot += queryVector[j] * value;
      norma += value * value;
    }
    resultados.push({ item: meta.itens[i], score: norma ? dot / Math.sqrt(norma) : 0 });
  }
  return resultados.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function rerank(query, candidatos, topN) {
  const response = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.COHERE_RERANK_MODEL || 'rerank-v5.0-fast',
      query,
      documents: candidatos.map(({ item }) => textoDocumento(item)),
      top_n: topN
    }),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.results)) throw new Error(`Reranker indisponível (${response.status}).`);
  return data.results
    .filter(result => Number.isInteger(result.index) && candidatos[result.index])
    .map(result => ({ ...candidatos[result.index], rerankScore: result.relevance_score }));
}

export function registerAcervoSemantic(app, { getCatalog, supabase, supabaseServiceRole = false }) {
  app.post('/api/admin/acervo/indexar-semantico', async (req, res) => {
    if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== INDEX_BRANCH) {
      return res.status(404).json({ success: false, msg: 'Operação indisponível.' });
    }
    if (!['admin', 'super_admin'].includes(req.user?.role)) {
      return res.status(403).json({ success: false, msg: 'Apenas administradores podem gerar o índice.' });
    }
    if (req.body?.confirm !== true) return res.status(400).json({ success: false, msg: 'Confirme a geração do índice.' });
    if (!process.env.HF_TOKEN) return res.status(503).json({ success: false, msg: 'Hugging Face não está configurado no Preview.' });
    if (!supabase || !supabaseServiceRole) return res.status(503).json({ success: false, msg: 'Storage privado não está configurado no servidor.' });
    if (indexJobPromise) return res.status(409).json({ success: false, msg: 'A geração do índice já está em andamento.' });

    try {
      indexJobPromise = indexAcervoSemantic(supabase, {
        onProgress: progress => console.info(`[Busca semântica] ${progress}`)
      });
      const result = await indexJobPromise;
      return res.json({ success: true, ...result });
    } catch (error) {
      console.error('[Busca semântica] Falha ao gerar índice:', error.message);
      return res.status(502).json({ success: false, msg: 'Não foi possível gerar o índice semântico.' });
    } finally {
      indexJobPromise = null;
    }
  });

  app.post('/api/acervo/busca-semantica', async (req, res) => {
    const query = String(req.body?.query || '').trim().slice(0, 180);
    if (query.length < 3) return res.status(400).json({ success: false, msg: 'Digite ao menos 3 caracteres para buscar.' });
    if (!process.env.HF_TOKEN) {
      return res.status(503).json({ success: false, msg: 'Busca semântica ainda não configurada no servidor.' });
    }
    if (!supabase || !supabaseServiceRole) {
      return res.status(503).json({ success: false, msg: 'A busca semântica precisa do Storage privado configurado no servidor.' });
    }
    try {
      const index = await lerIndex(supabase);
      const catalog = getCatalog?.();
      const generatedAt = String(catalog?.generatedAt || '');
      if (generatedAt && index.meta.catalogoGeradoEm && generatedAt !== index.meta.catalogoGeradoEm) {
        return res.status(409).json({ success: false, msg: 'O índice do acervo está desatualizado. Regenere com npm run index:acervo-semantico.' });
      }
      const queryVector = await embeddingConsulta(query);
      const candidatos = buscarVizinhos(index, queryVector, 40);
      let resultados = candidatos;
      let rerankerAtivo = false;
      if (process.env.COHERE_API_KEY) {
        try {
          resultados = await rerank(query, candidatos, 12);
          rerankerAtivo = true;
        } catch (error) {
          console.warn('[Busca semântica] Reranker indisponível; usando similaridade vetorial:', error.message);
          resultados = candidatos.slice(0, 12);
        }
      } else {
        resultados = candidatos.slice(0, 12);
      }
      return res.json({
        success: true,
        modeloEmbedding: index.meta.modelo,
        reranker: rerankerAtivo ? (process.env.COHERE_RERANK_MODEL || 'rerank-v5.0-fast') : null,
        itens: resultados.map(({ item, score, rerankScore }) => ({ ...item, score: rerankScore ?? score }))
      });
    } catch (error) {
      console.error('[Busca semântica]', error.message);
      return res.status(502).json({ success: false, msg: 'Não foi possível buscar por significado agora.' });
    }
  });
}
