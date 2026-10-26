import assert from 'node:assert/strict';
import { registerIscRoutes, retrieveIscUserContext } from '../../src/isc-routes.js';

const taxonomyRows = [
  { id: 'isc.discipline.cardiologia', kind: 'discipline', parent_id: null, canonical_name: 'Cardiologia', synonyms: ['cardio'], origin: 'curated', is_canonical: true, confidence: 1 },
  { id: 'isc.discipline.neurologia', kind: 'discipline', parent_id: null, canonical_name: 'Neurologia', synonyms: ['neuro'], origin: 'curated', is_canonical: true, confidence: 1 },
  { id: 'isc.subject.cardiologia.insuficiencia-cardiaca', kind: 'subject', parent_id: 'isc.discipline.cardiologia', canonical_name: 'Insuficiência cardíaca', synonyms: ['ICC'], origin: 'curated', is_canonical: true, confidence: 1 },
  { id: 'isc.subject.neurologia.candidato', kind: 'subject', parent_id: 'isc.discipline.neurologia', canonical_name: 'Tema candidato', synonyms: [], origin: 'catalog_path', is_canonical: false, confidence: 0.3 },
  { id: 'isc.subtopic.cardiologia.icfer', kind: 'subtopic', parent_id: 'isc.subject.cardiologia.insuficiencia-cardiaca', canonical_name: 'ICFER', synonyms: [], origin: 'curated', is_canonical: true, confidence: 1 },
  { id: 'isc.objective.cardiologia.ic.fisiopatologia', kind: 'learning_objective', parent_id: 'isc.subject.cardiologia.insuficiencia-cardiaca', canonical_name: 'Fisiopatologia da insuficiência cardíaca', synonyms: [], origin: 'curated', is_canonical: true, confidence: 1 }
];
const captured = [];
const supabase = {
  from(table) {
    assert.equal(table, 'isc_taxonomy_nodes');
    return {
      select() { return this; }, order() { return this; },
      async range() { return { data: taxonomyRows, error: null }; }
    };
  },
  async rpc(name, args) {
    captured.push({ name, args });
    return { data: [{ resource_key: 'video:a1', resource_id: 'a1', resource_kind: 'video', title: 'Insuficiência cardíaca', course: 'CURSINHOS', source_path: 'Estratégia MED 2026 / Cardiologia', topic_ids: ['isc.subject.cardiologia.insuficiencia-cardiaca'], score: 0.91, evidence_excerpt: 'Insuficiência cardíaca', source_kind: 'catalog_metadata', source_page: null, timestamp_start: null, timestamp_end: null }], error: null };
  }
};
const handlers = new Map();
const app = {
  get(path, callback) { handlers.set(`GET ${path}`, callback); },
  post(path, callback) { handlers.set(`POST ${path}`, callback); },
  delete(path, callback) { handlers.set(`DELETE ${path}`, callback); }
};
let embedded = 0;
registerIscRoutes(app, {
  supabase, supabaseServiceRole: true,
  enabled: true,
  getEmbeddingConfig: () => ({ provider: 'mock', model: 'mock', indexModel: 'mock:v1', token: 'test-token' }),
  embedQuery: async (texts, options) => { embedded++; assert.equal(options.purpose, 'query'); return [new Array(1024).fill(0).map((_, index) => index === 0 ? 1 : 0)]; }
});
const res = {
  statusCode: 200, status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }, set() { return this; }
};

await handlers.get('POST /api/isc/search')({ body: { query: 'insuficiência cardíaca', discipline: 'Cardiologia', objectiveIds: ['isc.objective.cardiologia.ic.fisiopatologia'], course: 'Estratégia MED 2026' } }, res);
assert.equal(res.statusCode, 200);
assert.deepEqual(captured[0].args.p_topic_ids.sort(), ['isc.subject.cardiologia.insuficiencia-cardiaca', 'isc.subtopic.cardiologia.icfer'].sort(), 'disciplina e objetivo expandem para tópicos relacionados, sem afirmar domínio do objetivo');
assert.equal(captured[0].args.p_course_filter, 'Estratégia MED 2026');
assert.equal(res.body.filters.objectivesMatchRelatedTopics, true);
assert.equal(res.body.itens[0].evidence.timestampStart, null);
assert.equal(embedded, 1);

const cachedQuery = { ...res, statusCode: 200, body: null };
await handlers.get('POST /api/isc/search')({ body: { query: 'INSUFICIÊNCIA cardíaca' } }, cachedQuery);
assert.equal(cachedQuery.statusCode, 200);
assert.equal(embedded, 1, 'buscas repetidas compartilham o embedding por cinco minutos');

const invalid = { ...res, statusCode: 200, body: null };
await handlers.get('POST /api/isc/search')({ body: { query: 'teste médico', objectiveIds: ['isc.objective.nao-existe'] } }, invalid);
assert.equal(invalid.statusCode, 400, 'filtro curricular inválido é rejeitado sem remover o filtro silenciosamente');
assert.equal(embedded, 1, 'filtros inválidos não gastam chamadas de embeddings');

const uncoveredDiscipline = { ...res, statusCode: 200, body: null };
await handlers.get('POST /api/isc/search')({ body: { query: 'cefaleia', discipline: 'Neurologia' } }, uncoveredDiscipline);
assert.equal(uncoveredDiscipline.body.filters.status, 'insufficient_taxonomy_coverage');
assert.deepEqual(uncoveredDiscipline.body.itens, [], 'disciplina ainda não mapeada não remove o filtro e não abre busca global');
assert.equal(embedded, 1, 'disciplina sem cobertura não gasta chamadas de embeddings');

const shortQuery = { ...res, statusCode: 200, body: null };
await handlers.get('POST /api/isc/search')({ body: { query: 'ic' } }, shortQuery);
assert.equal(shortQuery.statusCode, 400);

const malformedFilter = { ...res, statusCode: 200, body: null };
await handlers.get('POST /api/isc/search')({ body: { query: 'teste médico', topicIds: ['bad id'] } }, malformedFilter);
assert.equal(malformedFilter.statusCode, 400, 'ids malformados não são removidos e não abrem busca sem filtro');

const subjectFilter = { ...res, statusCode: 200, body: null };
await handlers.get('POST /api/isc/search')({ body: { query: 'ICFER', discipline: 'Insuficiência cardíaca' } }, subjectFilter);
assert.equal(subjectFilter.statusCode, 200, 'o campo de disciplina também aceita assunto ou pasta canônica');
assert.ok(captured.filter(call => call.name === 'search_isc_resources').at(-1).args.p_topic_ids.includes('isc.subtopic.cardiologia.icfer'));

const invalidCompare = { ...res, statusCode: 200, body: null };
await handlers.get('POST /api/isc/compare')({ body: { resourceKeys: ['video:a1'] } }, invalidCompare);
assert.equal(invalidCompare.statusCode, 400);

const privateCalls = [];
const privateSupabase = {
  from(table) {
    return {
      select() { return this; }, eq() { return this; }, order() { return this; },
      async maybeSingle() { return { data: null, error: null }; },
      async limit() { return { data: [], error: null }; },
      async range() { return { data: taxonomyRows, error: null }; },
      in(key, values) {
        const rows = table === 'isc_resources' && key === 'resource_key' && values.includes('user:bob:b12345') ? [{
          resource_key: 'user:bob:b12345', resource_id: 'b12345', resource_kind: 'aula_dia', title: 'Aula privada de Bob',
          course: '', source_path: '', source_kind: 'transcript', index_status: 'content_indexed', metadata_confidence: 0.8,
          is_active: true, scope: 'user', owner_username: 'bob'
        }] : [];
        return { eq() { return this; }, then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); } };
      }
    };
  },
  async rpc(name, args) {
    privateCalls.push({ name, args });
    if (name === 'delete_isc_user_resource') return { data: true, error: null };
    return { data: 1, error: null };
  }
};
const privateHandlers = new Map();
registerIscRoutes({
  get(path, callback) { privateHandlers.set(`GET ${path}`, callback); },
  post(path, callback) { privateHandlers.set(`POST ${path}`, callback); },
  delete(path, callback) { privateHandlers.set(`DELETE ${path}`, callback); }
}, {
  supabase: privateSupabase, supabaseServiceRole: true, enabled: true,
  getEmbeddingConfig: () => ({ provider: 'mock', model: 'mock', indexModel: 'mock:v1', token: 'test-token' }),
  embedQuery: async texts => texts.map(() => [1, ...new Array(1023).fill(0)])
});
const freshResponse = () => ({
  statusCode: 200, status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }, set() { return this; }
});
const savedPrivate = freshResponse();
await privateHandlers.get('POST /api/isc/user-resources')({ user: { username: 'Alice' }, body: {
  sourceId: 'a123456', sourceKind: 'transcript', title: 'Aula privada', ownerUsername: 'bob',
  text: 'Insuficiência cardíaca. '.repeat(100)
} }, savedPrivate);
assert.equal(savedPrivate.statusCode, 200);
const saveCall = privateCalls.find(call => call.name === 'replace_isc_user_resource');
assert.equal(saveCall.args.p_resource.owner_username, 'alice', 'o dono vem da sessão autenticada, não do body');
assert.ok(saveCall.args.p_segments.length > 1);

const savedPdfText = freshResponse();
const pdfSourceText = 'Esofagite de refluxo. '.repeat(90);
await privateHandlers.get('POST /api/isc/user-resources')({ user: { username: 'Alice' }, body: {
  sourceId: 'pdf123456', sourceKind: 'pdf_text', title: 'Apostila clínica.pdf',
  text: pdfSourceText, sourcePages: [{ page: 12, start: 0, end: pdfSourceText.length }]
} }, savedPdfText);
assert.equal(savedPdfText.statusCode, 200, 'texto extraído de PDF pode ser indexado sem mudar o pipeline de embeddings');
assert.equal(privateCalls.filter(call => call.name === 'replace_isc_user_resource').at(-1).args.p_resource.source_kind, 'pdf_text');
assert.equal(privateCalls.filter(call => call.name === 'replace_isc_user_resource').at(-1).args.p_segments[0].source_page, 12);

const savedSlides = freshResponse();
await privateHandlers.get('POST /api/isc/user-resources')({ user: { username: 'Alice' }, body: {
  sourceId: 'slides12345', sourceKind: 'slides', title: 'Aula faculdade.pptx', text: 'Insuficiência cardíaca. '.repeat(90),
  sourcePages: [{ page: 5, start: 0, end: 'Insuficiência cardíaca. '.repeat(90).length }],
  sourceMeta: { slideCount: 12, slidesWithFigures: [3, 8] }
} }, savedSlides);
assert.equal(savedSlides.statusCode, 200, 'slides com páginas de origem usam o armazenamento privado existente');
const slideSave = privateCalls.filter(call => call.name === 'replace_isc_user_resource').at(-1).args;
assert.equal(slideSave.p_resource.source_kind, 'slides');
assert.equal(slideSave.p_segments[0].source_page, 5);
assert.deepEqual(slideSave.p_resource.metadata.slideImport.slidesWithFigures, [3, 8]);

const invalidPageEvidence = freshResponse();
await privateHandlers.get('POST /api/isc/user-resources')({ user: { username: 'Alice' }, body: {
  sourceId: 'pdfpage123', sourceKind: 'pdf_text', title: 'Apostila clínica.pdf', text: pdfSourceText,
  sourcePages: [{ page: 12, start: 0, end: pdfSourceText.length + 10 }]
} }, invalidPageEvidence);
assert.equal(invalidPageEvidence.statusCode, 400, 'evidência de página fora do texto é rejeitada');

const invalidPdf = freshResponse();
await privateHandlers.get('POST /api/isc/user-resources')({ user: { username: 'Alice' }, body: {
  sourceId: 'pdfbad123', sourceKind: 'pdf_text', title: 'invalido.pdf', pdfBase64: Buffer.from('not a PDF').toString('base64')
} }, invalidPdf);
assert.equal(invalidPdf.statusCode, 415, 'upload sem assinatura PDF é rejeitado antes de extrair ou gerar embeddings');

const crossUserDelete = freshResponse();
await privateHandlers.get('DELETE /api/isc/my-resources/:resourceKey')({ user: { username: 'alice' }, params: { resourceKey: 'user:bob:b12345' } }, crossUserDelete);
assert.equal(crossUserDelete.statusCode, 404);
assert.equal(privateCalls.some(call => call.name === 'delete_isc_user_resource'), false, 'não chama o RPC para chave de outro usuário');

const crossUserCompare = freshResponse();
await privateHandlers.get('POST /api/isc/compare')({ user: { username: 'alice' }, body: { resourceKeys: ['video:a1', 'user:bob:b12345'] } }, crossUserCompare);
assert.equal(crossUserCompare.statusCode, 404, 'comparação não expõe materiais privados de outra conta');

const lessonRows = {
  isc_resources: [
    { resource_key: 'user:alice:slides12345', resource_id: 'slides12345', resource_kind: 'aula_dia', title: 'Slides da Faculdade', course: 'Cardiologia', source_path: '', source_kind: 'slides', index_status: 'content_indexed', metadata_confidence: 0.8, is_active: true, scope: 'user', owner_username: 'alice' },
    { resource_key: 'user:alice:transcript123', resource_id: 'transcript123', resource_kind: 'aula_dia', title: 'Fala do Professor', course: 'Cardiologia', source_path: '', source_kind: 'transcript', index_status: 'content_indexed', metadata_confidence: 0.8, is_active: true, scope: 'user', owner_username: 'alice' },
    { resource_key: 'video:v1', resource_id: 'v1', resource_kind: 'video', title: 'Insuficiência Cardíaca — revisão', course: 'CURSINHOS', source_path: 'Extensivo 2026 / Cardiologia', source_kind: 'catalog_metadata', index_status: 'metadata_indexed', metadata_confidence: 0.8, is_active: true, scope: 'catalog', owner_username: null },
    { resource_key: 'video:v2', resource_id: 'v2', resource_kind: 'video', title: 'ICFER — tratamento', course: 'CURSINHOS', source_path: 'Extensivo 2026 / Cardiologia', source_kind: 'catalog_metadata', index_status: 'metadata_indexed', metadata_confidence: 0.8, is_active: true, scope: 'catalog', owner_username: null }
  ],
  isc_resource_topics: [
    { resource_key: 'user:alice:slides12345', topic_id: 'isc.subject.cardiologia.insuficiencia-cardiaca', source_kind: 'slides', confidence: 0.8, evidence_excerpt: 'Insuficiência cardíaca', evidence_ref: 'slides:page:5:chars:0-100', source_page: 5 },
    { resource_key: 'user:alice:transcript123', topic_id: 'isc.subject.cardiologia.insuficiencia-cardiaca', source_kind: 'transcript', confidence: 0.8, evidence_excerpt: 'O mecanismo da insuficiência cardíaca', evidence_ref: 'transcript:chars:0-100' },
    { resource_key: 'video:v1', topic_id: 'isc.subject.cardiologia.insuficiencia-cardiaca', source_kind: 'catalog_path', confidence: 0.76, evidence_excerpt: 'Insuficiência Cardíaca', evidence_ref: 'catalog.path:2' },
    { resource_key: 'video:v2', topic_id: 'isc.subtopic.cardiologia.icfer', source_kind: 'catalog_title', confidence: 0.82, evidence_excerpt: 'ICFER', evidence_ref: 'catalog.title' }
  ],
  isc_segments: [
    { resource_key: 'user:alice:slides12345', topic_ids: ['isc.subject.cardiologia.insuficiencia-cardiaca'], source_kind: 'slides', evidence_excerpt: 'Insuficiência cardíaca', evidence_ref: 'slides:page:5:chars:0-100', source_page: 5, embedding: [1, ...new Array(1023).fill(0)], embedding_model: 'mock:v1' },
    { resource_key: 'user:alice:transcript123', topic_ids: ['isc.subject.cardiologia.insuficiencia-cardiaca'], source_kind: 'transcript', evidence_excerpt: 'O mecanismo da insuficiência cardíaca', evidence_ref: 'transcript:chars:0-100', embedding: [1, ...new Array(1023).fill(0)], embedding_model: 'mock:v1' }
  ]
};
const lessonSupabase = {
  from(table) {
    let filters = [], maxRows = Infinity;
    const matches = row => filters.every(filter => filter.type === 'eq'
      ? row[filter.key] === filter.value : filter.values.includes(row[filter.key]));
    const query = {
      select() { return this; }, order() { return this; },
      eq(key, value) { filters.push({ type: 'eq', key, value }); return this; },
      in(key, values) { filters.push({ type: 'in', key, values }); return this; },
      limit(value) { maxRows = value; return this; },
      async range(start, end) { return { data: taxonomyRows.slice(start, end + 1), error: null }; },
      async maybeSingle() { return { data: (lessonRows[table] || []).filter(matches)[0] || null, error: null }; },
      then(resolve, reject) { return Promise.resolve({ data: (lessonRows[table] || []).filter(matches).slice(0, maxRows), error: null }).then(resolve, reject); }
    };
    return query;
  },
  async rpc() { return { data: [], error: null }; }
};
const lessonHandlers = new Map();
registerIscRoutes({
  get(path, callback) { lessonHandlers.set(`GET ${path}`, callback); },
  post(path, callback) { lessonHandlers.set(`POST ${path}`, callback); },
  delete(path, callback) { lessonHandlers.set(`DELETE ${path}`, callback); }
}, { supabase: lessonSupabase, supabaseServiceRole: true, enabled: true, getEmbeddingConfig: () => ({ token: '', indexModel: '' }) });
const lessonRequest = keys => ({ user: { username: 'alice' }, body: { resourceKeys: keys } });
const lessonIndexResponse = freshResponse();
await lessonHandlers.get('POST /api/isc/lesson-index')(lessonRequest(['user:alice:slides12345', 'user:alice:transcript123']), lessonIndexResponse);
assert.equal(lessonIndexResponse.statusCode, 200);
assert.equal(lessonIndexResponse.body.index.topics.find(topic => topic.topicId === 'isc.subject.cardiologia.insuficiencia-cardiaca').origin, 'both');
assert.equal(lessonIndexResponse.body.index.topics[0].evidence.some(item => item.page === 5), true, 'o ICC devolve página/slide rastreável');
assert.ok(lessonIndexResponse.body.topicOptions.some(topic => topic.topicId === 'isc.objective.cardiologia.ic.fisiopatologia'), 'a revisão oferece objetivos curriculares para correção manual da seleção');
assert.equal(lessonIndexResponse.body.topicOptions.some(topic => topic.topicId === 'isc.subject.neurologia.candidato'), false, 'sugestões inferidas do catálogo não são apresentadas como correção canônica');

const recommendationResponse = freshResponse();
await lessonHandlers.get('POST /api/isc/recommendations')({ ...lessonRequest(['user:alice:slides12345', 'user:alice:transcript123']), body: {
  resourceKeys: ['user:alice:slides12345', 'user:alice:transcript123'], topicIds: ['isc.subject.cardiologia.insuficiencia-cardiaca']
} }, recommendationResponse);
assert.equal(recommendationResponse.statusCode, 200);
assert.equal(recommendationResponse.body.items[0].resourceKey, 'video:v1');
assert.equal(recommendationResponse.body.items[0].evidenceMode, 'catalog_metadata');

const manualObjectiveRecommendation = freshResponse();
await lessonHandlers.get('POST /api/isc/recommendations')({ ...lessonRequest(['user:alice:slides12345', 'user:alice:transcript123']), body: {
  resourceKeys: ['user:alice:slides12345', 'user:alice:transcript123'], topicIds: ['isc.objective.cardiologia.ic.fisiopatologia']
} }, manualObjectiveRecommendation);
assert.equal(manualObjectiveRecommendation.statusCode, 200, 'objetivos canônicos podem ser adicionados mesmo se a extração não os reconheceu');

const unknownObjectiveRecommendation = freshResponse();
await lessonHandlers.get('POST /api/isc/recommendations')({ ...lessonRequest(['user:alice:slides12345', 'user:alice:transcript123']), body: {
  resourceKeys: ['user:alice:slides12345', 'user:alice:transcript123'], topicIds: ['isc.objective.inventado']
} }, unknownObjectiveRecommendation);
assert.equal(unknownObjectiveRecommendation.statusCode, 400, 'a seleção manual só aceita IDs existentes na taxonomia');

const lessonCompareResponse = freshResponse();
await lessonHandlers.get('POST /api/isc/lesson-compare')({ user: { username: 'alice' }, body: {
  sourceKeys: ['user:alice:slides12345', 'user:alice:transcript123'],
  videoKeys: ['video:v1', 'video:v2'], topicIds: ['isc.subject.cardiologia.insuficiencia-cardiaca']
} }, lessonCompareResponse);
assert.equal(lessonCompareResponse.statusCode, 200);
assert.equal(lessonCompareResponse.body.evidenceMode, 'catalog_metadata');
assert.equal(lessonCompareResponse.body.comparisons[0].coverage.consolidated.score, null, 'metadados do catálogo não produzem porcentagem de cobertura');
assert.equal(lessonCompareResponse.body.comparisons[0].coverage.consolidated.status, 'metadata_match_only');
assert.equal(lessonCompareResponse.body.comparisons[0].matchedTopicEvidence[0].excerpt, 'Insuficiência Cardíaca', 'a comparação devolve a evidência que justificou o vínculo curricular');

const manualObjectiveCompare = freshResponse();
await lessonHandlers.get('POST /api/isc/lesson-compare')({ user: { username: 'alice' }, body: {
  sourceKeys: ['user:alice:slides12345', 'user:alice:transcript123'],
  videoKeys: ['video:v1', 'video:v2'], topicIds: ['isc.objective.cardiologia.ic.fisiopatologia']
} }, manualObjectiveCompare);
assert.equal(manualObjectiveCompare.statusCode, 200);
assert.equal(manualObjectiveCompare.body.curriculum.topics[0].manuallySelected, true, 'objetivos incluídos pelo aluno permanecem distintos da evidência original');

const retrievalCalls = [];
const retrieved = await retrieveIscUserContext({
  supabase: { async rpc(name, args) {
    retrievalCalls.push({ name, args });
    return { data: [{ title: 'Aula', content_text: 'trecho médico', source_kind: 'transcript', evidence_ref: 'transcript:chars:0-100', source_start: 0, source_end: 100, score: 0.8 }], error: null };
  } },
  username: 'Alice', resourceKeys: ['user:alice:a123456', 'user:bob:other1', 'user:alice:pdf123456'],
  query: 'explique a fisiopatologia', enabled: true, supabaseServiceRole: true,
  getEmbeddingConfig: () => ({ provider: 'mock', model: 'mock', indexModel: 'mock:v1', token: 'test-token' }),
  embedQuery: async () => [[1, ...new Array(1023).fill(0)]]
});
assert.equal(retrievalCalls.length, 2, 'o Mentor consulta todos os materiais associados à aula, com limite de quatro');
assert.ok(retrievalCalls.every(call => call.args.p_owner_username === 'alice'));
assert.deepEqual(retrievalCalls.map(call => call.args.p_resource_key).sort(), ['user:alice:a123456', 'user:alice:pdf123456']);
assert.equal(retrieved.length, 2);

const keywordCalls = [];
const keywordHandlers = new Map();
registerIscRoutes({
  get(path, callback) { keywordHandlers.set(`GET ${path}`, callback); },
  post(path, callback) { keywordHandlers.set(`POST ${path}`, callback); },
  delete(path, callback) { keywordHandlers.set(`DELETE ${path}`, callback); }
}, {
  supabase: { ...privateSupabase, async rpc(name, args) {
    keywordCalls.push({ name, args });
    return { data: [{ resource_key: 'video:a1', resource_id: 'a1', resource_kind: 'video', title: 'Insuficiência cardíaca', course: 'CURSINHOS', topic_ids: [], score: 0.8 }], error: null };
  } },
  supabaseServiceRole: true, enabled: true, getEmbeddingConfig: () => ({ token: '', indexModel: '' })
});
const keywordResponse = freshResponse();
await keywordHandlers.get('POST /api/isc/search')({ body: { query: 'insuficiência cardíaca' } }, keywordResponse);
assert.equal(keywordResponse.statusCode, 200, 'busca lexical funciona sem chave de embeddings');
assert.equal(keywordCalls[0].name, 'search_isc_resources_keywords');
assert.equal(keywordResponse.body.searchMode, 'metadata_keyword');

const disabledHandlers = new Map();
registerIscRoutes({
  get(path, callback) { disabledHandlers.set(`GET ${path}`, callback); },
  post(path, callback) { disabledHandlers.set(`POST ${path}`, callback); },
  delete(path, callback) { disabledHandlers.set(`DELETE ${path}`, callback); }
}, {
  supabase, supabaseServiceRole: true, enabled: false,
  getEmbeddingConfig: () => ({ token: 'test-token' }), embedQuery: async () => { throw new Error('disabled ISC must not request embeddings'); }
});
const disabledResponse = { ...res, statusCode: 200, body: null };
await disabledHandlers.get('POST /api/isc/search')({ body: { query: 'insuficiência cardíaca' } }, disabledResponse);
assert.equal(disabledResponse.statusCode, 503, 'ISC desabilitado mantém o fallback legado sem consultar o índice incompleto');

console.log('OK — rotas ISC validam entradas e resolvem filtros por disciplina, objetivo e curso com evidência nula quando indisponível.');
