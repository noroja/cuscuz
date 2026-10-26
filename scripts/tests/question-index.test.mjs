import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  QUESTION_INDEX_VERSION, buildQuestionIndexPlan, buildQuestionIndexRow, filterQuestionsByIndexRows,
  indexQuestionBank, searchPersistedQuestionIndex, assertQuestionIndexTarget, QUESTION_INDEX_STAGING_REF
} from '../../src/question-index.js';

const taxonomy = {
  version: 3,
  nodes: [
    { id: 'med.cardiologia', kind: 'subject', name: 'Cardiologia', synonyms: [], canonical: true, origin: 'curated' },
    { id: 'med.cardiologia.ic', kind: 'subtopic', parentId: 'med.cardiologia', name: 'Insuficiência cardíaca', synonyms: ['IC'], canonical: true, origin: 'curated' },
    { id: 'med.cardiologia.ic.peptideos', kind: 'learning_objective', parentId: 'med.cardiologia.ic', name: 'Peptídeos natriuréticos', synonyms: ['BNP'], canonical: true, origin: 'curated' },
    { id: 'med.fake', kind: 'subtopic', name: 'Cardiologia geral', synonyms: [], canonical: false, origin: 'curated' },
    { id: 'path.fake', kind: 'subtopic', name: 'Insuficiência cardíaca', synonyms: [], canonical: true, origin: 'catalog_path' }
  ]
};
const sourceQuestion = {
  id: 'q-1', statement: 'Paciente com insuficiência cardíaca. Qual marcador pode auxiliar?',
  options: ['A) BNP', 'B) Troponina'], correctIndex: -1, correctLetter: 'A',
  explanation: 'O BNP é um peptídeo natriurético.', difficulty: 'Médio', year: 2024,
  specialty: 'Cardiologia', tags: ['Insuficiência cardíaca']
};

const row = buildQuestionIndexRow(sourceQuestion, taxonomy);
assert.equal(row.question_id, 'q-1');
assert.equal(row.correct_index, 0, 'normaliza gabarito por letra');
assert.ok(row.canonical_topic_ids.includes('med.cardiologia.ic'));
assert.ok(row.canonical_topic_ids.includes('med.cardiologia'), 'inclui pai canônico para ampliar a busca curricular');
assert.ok(row.topic_evidence.some(item => item.topicId === 'med.cardiologia.ic' && item.sourceField === 'statement'));
assert.ok(row.topic_evidence.every(item => item.validation === 'heuristic_unreviewed' && item.confidence === null));
assert.ok(!row.canonical_topic_ids.includes('med.fake') && !row.canonical_topic_ids.includes('path.fake'));
assert.equal(buildQuestionIndexRow({ id: 'without-statement' }, taxonomy), null);

const plan = buildQuestionIndexPlan([sourceQuestion, { ...sourceQuestion, id: 'q-2' }, sourceQuestion], taxonomy);
assert.equal(plan.stats.inputCount, 3);
assert.equal(plan.stats.indexedCount, 2);
assert.equal(plan.stats.duplicateIdCount, 1);
assert.equal(plan.sourceHash, buildQuestionIndexPlan([sourceQuestion, { ...sourceQuestion, id: 'q-2' }], taxonomy).sourceHash);
assert.notEqual(plan.sourceHash, buildQuestionIndexPlan([sourceQuestion, { ...sourceQuestion, id: 'q-2' }], {
  ...taxonomy, nodes: taxonomy.nodes.map(node => node.id === 'med.cardiologia.ic' ? { ...node, synonyms: [...node.synonyms, 'falência cardíaca'] } : node)
}).sourceHash, 'mudança na taxonomia invalida o índice para evitar tópicos obsoletos');
assert.notEqual(row.source_hash, buildQuestionIndexRow({ ...sourceQuestion, statement: `${sourceQuestion.statement} Nova informação.` }, taxonomy).source_hash);
assert.deepEqual(filterQuestionsByIndexRows([sourceQuestion, { id: 'q-3' }], [{ questionId: 'q-3' }]).map(item => item.id), ['q-3']);
assert.equal(assertQuestionIndexTarget(`https://${QUESTION_INDEX_STAGING_REF}.supabase.co`, QUESTION_INDEX_STAGING_REF), QUESTION_INDEX_STAGING_REF);
assert.throws(() => assertQuestionIndexTarget('https://production-project.supabase.co', 'production-project'), /restrita ao staging/);
assert.throws(() => assertQuestionIndexTarget(`https://${QUESTION_INDEX_STAGING_REF}.supabase.co`, ''), /--target-ref=/);
assert.throws(() => assertQuestionIndexTarget(`http://${QUESTION_INDEX_STAGING_REF}.supabase.co`, QUESTION_INDEX_STAGING_REF), /restrita ao staging/);

let rpcArgs;
const indexedSearch = await searchPersistedQuestionIndex({
  rpc: async (name, args) => {
    assert.equal(name, 'search_isc_questions');
    rpcArgs = args;
    return { data: [{ index_ready: true, question_id: 'q-1', canonical_topic_ids: ['med.cardiologia.ic'], topic_evidence: row.topic_evidence, search_rank: 1, semantic_score: 0.9, text_score: 0.2 }], error: null };
  }
}, { query: 'insuficiência cardíaca', topicIds: ['med.cardiologia.ic'], sourceHash: 'hash-ok', limit: 20, queryEmbedding: [1, 0], embeddingModel: 'fake:v1' });
assert.equal(indexedSearch.ready, true);
assert.deepEqual(indexedSearch.rows.map(item => item.questionId), ['q-1']);
assert.equal(indexedSearch.rows[0].semanticScore, 0.9);
assert.equal(indexedSearch.semanticEnabled, true);
assert.equal(rpcArgs.p_indexer_version, QUESTION_INDEX_VERSION);
assert.deepEqual(rpcArgs.p_topic_ids, ['med.cardiologia.ic']);
assert.deepEqual(rpcArgs.p_query_embedding, [1, 0]);
assert.equal(rpcArgs.p_embedding_model, 'fake:v1');

const staleSearch = await searchPersistedQuestionIndex({ rpc: async () => ({ data: [{ index_ready: false, question_id: null }], error: null }) }, { sourceHash: 'stale' });
assert.equal(staleSearch.ready, false);
assert.equal(staleSearch.reason, 'stale_or_incomplete');
const lexicalSearch = await searchPersistedQuestionIndex({ rpc: async () => ({ data: [{ index_ready: true, question_id: 'q-1', canonical_topic_ids: [], topic_evidence: [], search_rank: 1, semantic_score: null, text_score: 0.6 }], error: null }) }, { query: 'BNP', sourceHash: 'ready' });
assert.equal(lexicalSearch.ready, true);
assert.equal(lexicalSearch.semanticEnabled, false, 'não anuncia busca vetorial se a consulta caiu no fallback lexical');
assert.equal(lexicalSearch.rows[0].textScore, 0.6);
const failedSearch = await searchPersistedQuestionIndex({ rpc: async () => ({ data: null, error: { message: 'migration missing' } }) }, { sourceHash: 'no-migration' });
assert.equal(failedSearch.reason, 'query_failed');

function fakeSupabase() {
  const rows = new Map();
  const embeddings = new Map();
  const states = new Map();
  const calls = { upserts: 0, embeddingUpserts: 0, deactivations: 0, stateWrites: 0 };
  return {
    rows, embeddings, states, calls,
    from(table) {
      if (table === 'isc_question_index') return {
        select() {
          const filter = { sourceCollection: null };
          return {
            eq(_column, value) { filter.sourceCollection = value; return this; },
            order() { return this; },
            async range(start, end) {
              const all = [...rows.values()].filter(item => item.source_collection === filter.sourceCollection).sort((a, b) => a.question_id.localeCompare(b.question_id));
              return { data: all.slice(start, end + 1), error: null };
            }
          };
        },
        async upsert(batch) { calls.upserts++; for (const item of batch) rows.set(item.question_id, item); return { error: null }; },
        update(patch) {
          const filter = { sourceCollection: null, ids: [] };
          return {
            eq(_column, value) { filter.sourceCollection = value; return this; },
            async in(_column, ids) {
              calls.deactivations++;
              for (const id of ids) {
                const item = rows.get(id);
                if (item && item.source_collection === filter.sourceCollection) rows.set(id, { ...item, ...patch });
              }
              return { error: null };
            }
          };
        }
      };
      if (table === 'isc_question_index_state') return {
        async upsert(state) { calls.stateWrites++; states.set(state.source_collection, state); return { error: null }; }
      };
      if (table === 'isc_question_embeddings') return {
        select() {
          return {
            order() { return this; },
            async range(start, end) { const all = [...embeddings.values()].sort((a, b) => a.question_id.localeCompare(b.question_id)); return { data: all.slice(start, end + 1), error: null }; }
          };
        },
        async upsert(batch) { calls.embeddingUpserts++; for (const item of batch) embeddings.set(item.question_id, item); return { error: null }; }
      };
      throw new Error(`Unexpected table ${table}`);
    }
  };
}

const fake = fakeSupabase();
const firstIndex = await indexQuestionBank(fake, [sourceQuestion, { ...sourceQuestion, id: 'q-2' }], taxonomy, { apply: true, batchSize: 1 });
assert.equal(firstIndex.applied, true);
assert.equal(firstIndex.changedCount, 2);
assert.equal(fake.calls.upserts, 2);
assert.equal(fake.calls.stateWrites, 1);
assert.equal(fake.states.get('local-bank').source_hash, firstIndex.sourceHash);
const unchangedIndex = await indexQuestionBank(fake, [sourceQuestion, { ...sourceQuestion, id: 'q-2' }], taxonomy, { apply: true });
assert.equal(unchangedIndex.changedCount, 0, 'mesmo hash/version não reprocessa conteúdo');
assert.equal(fake.calls.upserts, 2);
const removedIndex = await indexQuestionBank(fake, [sourceQuestion], taxonomy, { apply: true });
assert.equal(removedIndex.deactivatedCount, 1);
assert.equal(fake.rows.get('q-2').is_active, false);

const fakeSemantic = fakeSupabase();
let embeddingCalls = 0;
const semanticConfig = { token: 'test-token', indexModel: 'test:embed-v1' };
let dryRunEmbeddingCalls = 0;
const semanticPreview = await indexQuestionBank(null, [sourceQuestion], taxonomy, {
  embed: true, embeddingConfig: semanticConfig,
  embedTexts: async texts => { dryRunEmbeddingCalls++; return texts.map(() => [1, 0]); }
});
assert.equal(semanticPreview.embeddingsToGenerate, 1);
assert.equal(dryRunEmbeddingCalls, 0, 'prévia não envia o texto a um provedor');
const firstSemanticIndex = await indexQuestionBank(fakeSemantic, [sourceQuestion], taxonomy, {
  apply: true, embed: true, embeddingConfig: semanticConfig, embeddingBatchSize: 1,
  embedTexts: async texts => { embeddingCalls++; return texts.map(() => [1, 0.5]); }
});
assert.equal(firstSemanticIndex.embeddingsProcessed, 1);
assert.equal(fakeSemantic.embeddings.get('q-1').embedding.length, 1024, 'normaliza o vetor para a dimensão do ISC');
assert.equal(embeddingCalls, 1);
const taxonomyOnly = { ...taxonomy, version: taxonomy.version + 1 };
const taxonomyRefresh = await indexQuestionBank(fakeSemantic, [sourceQuestion], taxonomyOnly, {
  apply: true, embed: true, embeddingConfig: semanticConfig,
  embedTexts: async texts => { embeddingCalls++; return texts.map(() => [1, 0.5]); }
});
assert.equal(taxonomyRefresh.changedCount, 1, 'taxonomia atualiza evidências textuais');
assert.equal(taxonomyRefresh.embeddingsToGenerate, 0, 'mudança apenas de taxonomia não refaz embeddings');
assert.equal(embeddingCalls, 1);
const contentRefresh = await indexQuestionBank(fakeSemantic, [{ ...sourceQuestion, statement: `${sourceQuestion.statement} Outra frase.` }], taxonomyOnly, {
  apply: true, embed: true, embeddingConfig: semanticConfig,
  embedTexts: async texts => { embeddingCalls++; return texts.map(() => [0.5, 1]); }
});
assert.equal(contentRefresh.embeddingsProcessed, 1, 'mudança de conteúdo gera novo embedding');
assert.equal(embeddingCalls, 2);
const modelRefresh = await indexQuestionBank(fakeSemantic, [{ ...sourceQuestion, statement: `${sourceQuestion.statement} Outra frase.` }], taxonomyOnly, {
  apply: true, embed: true, embeddingConfig: { ...semanticConfig, indexModel: 'test:embed-v2' },
  embedTexts: async texts => { embeddingCalls++; return texts.map(() => [1, 0]); }
});
assert.equal(modelRefresh.embeddingsProcessed, 1, 'mudança do provedor/modelo gera embedding compatível');
assert.equal(fakeSemantic.embeddings.get('q-1').embedding_model, 'test:embed-v2');
assert.equal(embeddingCalls, 3);
const noProvider = fakeSupabase();
await assert.rejects(indexQuestionBank(noProvider, [sourceQuestion], taxonomy, {
  apply: true, embed: true, embeddingConfig: { token: '', indexModel: 'missing' }
}), /--embed requer um provedor/);
assert.equal(noProvider.calls.upserts, 0, 'valida o provedor antes de alterar o índice textual');

const realBank = JSON.parse(await readFile(new URL('../../data/questions-bank.json', import.meta.url), 'utf8'));
const realPlan = buildQuestionIndexPlan(realBank, taxonomy);
assert.equal(realPlan.stats.indexedCount, realBank.length, 'o banco local real é indexável de forma determinística');
assert.ok(realPlan.sourceHash.length === 64);

console.log(`OK — índice de questões: taxonomia, evidências, hash, indexação incremental, recuperação persistida e ${realPlan.stats.indexedCount} questões preparadas.`);
