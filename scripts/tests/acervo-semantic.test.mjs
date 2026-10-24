import assert from 'node:assert/strict';
import { registerAcervoSemantic } from '../../src/acervo-semantic.js';

const saved = {
  hf: process.env.HF_TOKEN,
  cohere: process.env.COHERE_API_KEY,
  model: process.env.HF_EMBEDDING_MODEL,
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
  const supabase = {
    storage: {
      from(bucket) {
        assert.equal(bucket, 'acervo');
        return { download: async key => ({ data: blobs.get(key) || null, error: blobs.has(key) ? null : new Error('missing') }) };
      }
    }
  };

  let handler;
  const app = { post(path, callback) { assert.equal(path, '/api/acervo/busca-semantica'); handler = callback; } };
  registerAcervoSemantic(app, { getCatalog: () => ({ generatedAt: '' }), supabase, supabaseServiceRole: true });

  const chamadas = [];
  globalThis.fetch = async (url, options) => {
    chamadas.push({ url: String(url), options });
    return new Response(JSON.stringify([[1, 0]]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };

  await handler({ body: { query: 'insuficiência cardíaca' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.reranker, null, 'Cohere ausente deve manter a busca vetorial ativa');
  assert.equal(res.body.itens.length, 1);
  assert.equal(res.body.itens[0].id, 'material-1');
  assert.ok(res.body.itens[0].score > 0.99);
  assert.equal(chamadas.length, 1, 'sem chave Cohere, só consulta o embedding');
  assert.match(chamadas[0].url, /huggingface\.co\/hf-inference\/models\/google\/embeddinggemma-300m/);
  assert.equal(chamadas[0].options.headers.Authorization, 'Bearer hf_test_token');

  console.log('OK — busca semântica usa similaridade vetorial quando Cohere não está configurada.');
} finally {
  for (const [key, value] of Object.entries({ HF_TOKEN: saved.hf, COHERE_API_KEY: saved.cohere, HF_EMBEDDING_MODEL: saved.model })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = saved.fetch;
}
