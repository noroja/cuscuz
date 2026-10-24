import assert from 'node:assert/strict';
import { registerAcervoSemantic } from '../../src/acervo-semantic.js';
import { indexAcervoSemantic } from '../../src/acervo-semantic-indexer.js';

const saved = {
  hf: process.env.HF_TOKEN,
  cohere: process.env.COHERE_API_KEY,
  model: process.env.HF_EMBEDDING_MODEL,
  vercelEnv: process.env.VERCEL_ENV,
  vercelRef: process.env.VERCEL_GIT_COMMIT_REF,
  fetch: globalThis.fetch
};

try {
  process.env.HF_TOKEN = 'hf_test_token';
  delete process.env.COHERE_API_KEY;
  process.env.HF_EMBEDDING_MODEL = 'google/embeddinggemma-300m';

  const vectors = Buffer.alloc(2);
  vectors.writeInt8(127, 0);
  vectors.writeInt8(0, 1);
  const meta = {
    versao: 1,
    modelo: process.env.HF_EMBEDDING_MODEL,
    dimensoes: 2,
    itens: [{ id: 'material-1', tipo: 'material', titulo: 'Insuficiência cardíaca', curso: 'Cardiologia', path: 'Cardiologia/IC.pdf' }],
    vectorsPath: 'semantic-index/vectors-test.bin'
  };
  const blobs = new Map([
    ['semantic-index/meta.json', new Blob([JSON.stringify(meta)])],
    ['semantic-index/vectors-test.bin', new Blob([vectors])]
  ]);
  const uploaded = new Map();
  let removedFiles = [];
  const downloaded = [];
  const supabase = {
    storage: {
      from(bucket) {
        assert.equal(bucket, 'acervo');
        return {
          download: async key => {
            downloaded.push(key);
            if (key === 'acervo-manifest.json') return { data: new Blob([JSON.stringify({ generatedAt: 'catalog-v1', videos: [], materials: [{ id: 'material-2', t: 'Cardiologia', course: 'Medicina', path: 'Clínica/Cardiologia.pdf' }] })]), error: null };
            return { data: blobs.get(key) || null, error: blobs.has(key) ? null : new Error('missing') };
          },
          upload: async (key, body) => {
            uploaded.set(key, body);
            blobs.set(key, new Blob([body]));
            return { data: { path: key }, error: null };
          },
          list: async () => ({ data: [{ name: 'vectors-old.bin' }], error: null }),
          remove: async files => {
            removedFiles.push(...files);
            for (const file of files) blobs.delete(file);
            return { data: files, error: null };
          }
        };
      }
    }
  };

  const handlers = new Map();
  const app = {
    get(path, callback) { handlers.set(`GET ${path}`, callback); },
    post(path, callback) { handlers.set(`POST ${path}`, callback); }
  };
  registerAcervoSemantic(app, { getCatalog: () => ({ generatedAt: '' }), supabase, supabaseServiceRole: true });

  const chamadas = [];
  globalThis.fetch = async (url, options) => {
    chamadas.push({ url: String(url), options });
    return new Response(JSON.stringify([[1, 0]]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set() { return this; },
    type() { return this; },
    send(body) { this.body = body; return this; }
  };

  await handlers.get('POST /api/acervo/busca-semantica')({ body: { query: 'insuficiência cardíaca' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.reranker, null, 'Cohere ausente deve manter a busca vetorial ativa');
  assert.equal(res.body.itens.length, 1);
  assert.equal(res.body.itens[0].id, 'material-1');
  assert.ok(res.body.itens[0].score > 0.99);
  assert.equal(chamadas.length, 1, 'sem chave Cohere, só consulta o embedding');
  assert.match(chamadas[0].url, /huggingface\.co\/hf-inference\/models\/google\/embeddinggemma-300m/);
  assert.equal(chamadas[0].options.headers.Authorization, 'Bearer hf_test_token');

  process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_GIT_COMMIT_REF = 'main';
  const deniedRes = { ...res, statusCode: 200, body: null };
  await handlers.get('POST /api/admin/acervo/indexar-semantico')({ user: { role: 'admin' }, body: { confirm: true } }, deniedRes);
  assert.equal(deniedRes.statusCode, 404, 'indexação administrativa deve ficar indisponível fora da branch Preview autorizada');
  const deniedPageRes = { ...res, statusCode: 200, body: null };
  await handlers.get('GET /api/admin/acervo/indexar-semantico')({ user: { role: 'admin' } }, deniedPageRes);
  assert.equal(deniedPageRes.statusCode, 404, 'a página de indexação também deve ficar indisponível fora do Preview autorizado');

  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_REF = 'codex/cuscuz-full-update-preview';
  const userRes = { ...res, statusCode: 200, body: null };
  await handlers.get('POST /api/admin/acervo/indexar-semantico')({ user: { role: 'user' }, body: { confirm: true } }, userRes);
  assert.equal(userRes.statusCode, 403, 'usuário comum não pode gerar o índice');
  const userPageRes = { ...res, statusCode: 200, body: null };
  await handlers.get('GET /api/admin/acervo/indexar-semantico')({ user: { role: 'user' } }, userPageRes);
  assert.equal(userPageRes.statusCode, 403, 'a página de indexação deve ser apenas para administradores');
  const pageRes = { ...res, statusCode: 200, body: null };
  await handlers.get('GET /api/admin/acervo/indexar-semantico')({ user: { role: 'admin' } }, pageRes);
  assert.equal(pageRes.statusCode, 200);
  assert.match(pageRes.body, /Gerar índice semântico/);
  assert.match(pageRes.body, /Continuar geração/);
  const unconfirmedRes = { ...res, statusCode: 200, body: null };
  await handlers.get('POST /api/admin/acervo/indexar-semantico')({ user: { role: 'admin' }, body: {} }, unconfirmedRes);
  assert.equal(unconfirmedRes.statusCode, 400, 'a operação exige confirmação explícita');
  const indexRes = { ...res, statusCode: 200, body: null };
  const hfRunId = '11111111-1111-4111-8111-111111111111';
  await handlers.get('POST /api/admin/acervo/indexar-semantico')({ user: { role: 'admin' }, body: { confirm: 'true', runId: hfRunId, offset: 0 } }, indexRes);
  assert.equal(indexRes.statusCode, 200);
  assert.equal(indexRes.body.success, true);
  assert.equal(indexRes.body.complete, true);
  assert.equal(indexRes.body.quantidade, 1);
  assert.ok(uploaded.has('semantic-index/meta.json'));
  assert.ok([...uploaded.keys()].some(key => key.startsWith('semantic-index/vectors-')));
  assert.ok(removedFiles.includes('semantic-index/vectors-old.bin'));
  assert.ok(removedFiles.includes(`semantic-index/.build-${hfRunId}/vectors-00000000.bin`));
  assert.equal(chamadas.length, 2, 'a indexação deve usar Hugging Face uma vez para o item de teste');

  process.env.COHERE_API_KEY = 'cohere_test_token';
  globalThis.fetch = async (url, options) => {
    chamadas.push({ url: String(url), options });
    if (String(url).endsWith('/v2/embed')) {
      const body = JSON.parse(options.body);
      if (body.input_type === 'search_query') return new Response(JSON.stringify({ embeddings: { float: [[1, 0]] } }), { status: 200 });
      return new Response(JSON.stringify({ embeddings: { float: [[1, 0]] } }), { status: 200 });
    }
    if (String(url).endsWith('/v2/rerank')) {
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 });
    }
    throw new Error(`URL inesperada: ${url}`);
  };
  const cohereRunId = '22222222-2222-4222-8222-222222222222';
  const cohereIndexRes = { ...res, statusCode: 200, body: null };
  await handlers.get('POST /api/admin/acervo/indexar-semantico')({ user: { role: 'admin' }, body: { confirm: 'true', runId: cohereRunId, offset: 0 } }, cohereIndexRes);
  assert.equal(cohereIndexRes.statusCode, 200);
  assert.equal(cohereIndexRes.body.complete, true);
  assert.ok(uploaded.has('semantic-index/preview-cohere/meta.json'), 'a chave Cohere de Preview deve publicar em prefixo isolado');
  assert.ok(!uploaded.has('semantic-index/preview-cohere/vectors-00000000.bin'), 'etapas temporárias devem ser removidas após publicar');
  assert.equal(JSON.parse(await blobs.get('semantic-index/preview-cohere/meta.json').text()).modelo, 'cohere:embed-multilingual-v3.0');

  const cohereSearchRes = { ...res, statusCode: 200, body: null };
  await handlers.get('POST /api/acervo/busca-semantica')({ body: { query: 'insuficiência cardíaca' } }, cohereSearchRes);
  assert.equal(cohereSearchRes.statusCode, 200);
  assert.equal(cohereSearchRes.body.success, true);
  assert.equal(cohereSearchRes.body.modeloEmbedding, 'cohere:embed-multilingual-v3.0');
  assert.equal(cohereSearchRes.body.reranker, process.env.COHERE_RERANK_MODEL || 'rerank-v5.0-fast');
  assert.ok(downloaded.includes('semantic-index/preview-cohere/meta.json'), 'Preview deve ler o índice isolado do Cohere');
  const cohereEmbeddingCall = chamadas.find(call => call.url.endsWith('/v2/embed') && JSON.parse(call.options.body).input_type === 'search_query');
  assert.equal(cohereEmbeddingCall.options.headers.Authorization, 'Bearer cohere_test_token');

  const chunkFiles = new Map();
  const chunkSupabase = {
    storage: {
      from(bucket) {
        assert.equal(bucket, 'acervo');
        return {
          download: async key => {
            if (key === 'acervo-manifest.json') {
              const materials = Array.from({ length: 769 }, (_, index) => ({ id: `m-${index}`, t: `Material ${index}`, path: 'Clínica/material.pdf' }));
              return { data: new Blob([JSON.stringify({ generatedAt: 'catalog-large', materials })]), error: null };
            }
            return { data: chunkFiles.get(key) || null, error: chunkFiles.has(key) ? null : new Error('missing') };
          },
          upload: async (key, body) => {
            chunkFiles.set(key, new Blob([body]));
            return { data: { path: key }, error: null };
          },
          list: async () => ({ data: [], error: null }),
          remove: async files => {
            for (const file of files) chunkFiles.delete(file);
            return { data: files, error: null };
          }
        };
      }
    }
  };
  const originalSetTimeout = globalThis.setTimeout;
  const chunkCalls = [];
  globalThis.setTimeout = callback => { callback(); return 0; };
  globalThis.fetch = async (url, options) => {
    chunkCalls.push({ url: String(url), options });
    const count = JSON.parse(options.body).texts.length;
    return new Response(JSON.stringify({ embeddings: { float: Array.from({ length: count }, () => [1, 0]) } }), { status: 200 });
  };
  try {
    const chunkRunId = '33333333-3333-4333-8333-333333333333';
    const firstChunk = await indexAcervoSemantic(chunkSupabase, { runId: chunkRunId, offset: 0 });
    assert.equal(firstChunk.complete, false);
    assert.equal(firstChunk.nextOffset, 768, 'cada chamada deve respeitar o limite de oito lotes');
    assert.equal(chunkCalls.length, 8);
    const lastChunk = await indexAcervoSemantic(chunkSupabase, { runId: chunkRunId, offset: firstChunk.nextOffset });
    assert.equal(lastChunk.complete, true);
    assert.equal(lastChunk.quantidade, 769);
    assert.equal(chunkCalls.length, 9);
    assert.ok(chunkFiles.has('semantic-index/preview-cohere/meta.json'));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  console.log('OK — busca semântica usa Hugging Face ou Cohere conforme o modelo do índice.');
  console.log('OK — indexação Cohere fica isolada no Preview e retoma lotes sem duplicá-los.');
} finally {
  for (const [key, value] of Object.entries({ HF_TOKEN: saved.hf, COHERE_API_KEY: saved.cohere, HF_EMBEDDING_MODEL: saved.model, VERCEL_ENV: saved.vercelEnv, VERCEL_GIT_COMMIT_REF: saved.vercelRef })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = saved.fetch;
}
