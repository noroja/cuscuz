import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildIscCatalogResource, buildIscConsolidatedIndex, buildIscUserResource, compareIscResources, hashIsc, normalizeIscText, segmentIscText } from '../../src/isc-core.js';
import { embedIscTexts } from '../../src/isc-embeddings.js';
import { buildIscCatalogPlan, indexIscCatalog, loadIscTaxonomy, mergeIscCatalogs } from '../../src/isc-indexer.js';

const taxonomy = await loadIscTaxonomy();
assert.equal(normalizeIscText('Doença do Refluxo Gastroesofágico'), 'doenca do refluxo gastroesofagico');
assert.equal(hashIsc({ a: 1 }), hashIsc({ a: 1 }));
assert.notEqual(hashIsc({ a: 1 }), hashIsc({ a: 2 }));

const catalog = {
  generatedAt: '2026-10-24T00:00:00.000Z',
  videos: [
    { id: 'video-heart-failure', course: 'CURSINHOS', t: 'Insuficiência Cardíaca', path: 'CURSINHOS / Estratégia MED 2026 / Cardiologia / Insuficiência Cardíaca / Aula.mp4' },
    { id: 'video-drge', course: 'CURSINHOS', t: 'Aula de DRGE e Esofagites', path: 'CURSINHOS / Gastroenterologia / DRGE / aula.mp4' }
  ],
  materials: [
    { id: 'pdf-icfer', course: 'APOSTILAS', t: 'ICFER: revisão', path: 'APOSTILAS / Cardiologia / Insuficiência Cardíaca com fração de ejeção reduzida / resumo.pdf' }
  ]
};
const plan = buildIscCatalogPlan(catalog, taxonomy);
assert.equal(plan.resources.length, 3);
const mergedCatalog = mergeIscCatalogs(
  { videos: [{ id: 'same-video', t: 'Título anterior', course: 'CURSINHOS' }], materials: [{ id: 'local-pdf', t: 'Resumo.pdf' }] },
  { items: [
    { id: 'same-video', t: 'Título atualizado', course: 'Estratégia MED 2026', kind: 'video', mimeType: 'video/mp4' },
    { id: 'new-pdf', t: 'Novo.pdf', course: 'Estratégia MED 2026', kind: 'material', mimeType: 'application/pdf' }
  ] }
);
assert.equal(mergedCatalog.videos.length, 1, 'merge deduplica por tipo e ID');
assert.equal(mergedCatalog.videos[0].t, 'Título atualizado', 'dados novos substituem metadata antiga do mesmo ID');
assert.equal(mergedCatalog.materials.length, 2, 'merge preserva base e acrescenta novos materiais');
const heart = plan.resources.find(entry => entry.resource.resourceId === 'video-heart-failure');
assert.ok(heart.resource.taxonomyTopicIds.includes('isc.subject.cardiologia.insuficiencia-cardiaca'));
assert.ok(heart.resource.taxonomyTopicIds.includes('isc.discipline.cardiologia'));
assert.equal(heart.topics[0].sourceKind, 'catalog_title');
assert.equal(heart.topics[0].coverageLevel, null, 'título e caminho não comprovam cobertura do conteúdo');
assert.equal(heart.topics[0].depthLevel, null, 'metadados não estimam profundidade didática');
assert.equal(heart.segments[0].sourcePage, null);
assert.equal(heart.segments[0].timestampStart, null);
assert.ok(heart.segments[0].topicIds.length > 0, 'o embedding de catálogo está ligado a um tópico canônico');
const changedTaxonomy = structuredClone(taxonomy);
changedTaxonomy.nodes.find(node => node.id === 'isc.subject.cardiologia.insuficiencia-cardiaca').synonyms.push('síndrome congestiva cardíaca');
assert.notEqual(
  heart.resource.sourceHash,
  buildIscCatalogResource(catalog.videos[0], 'video', changedTaxonomy).resource.sourceHash,
  'mudanças nos sinônimos da taxonomia invalidam seletivamente o hash do material'
);
const icfer = plan.resources.find(entry => entry.resource.resourceId === 'pdf-icfer');
assert.ok(icfer.resource.taxonomyTopicIds.includes('isc.subtopic.cardiologia.icfer'));
assert.ok(icfer.resource.taxonomyTopicIds.includes('isc.subject.cardiologia.insuficiencia-cardiaca'));
const drge = plan.resources.find(entry => entry.resource.resourceId === 'video-drge');
assert.ok(drge.resource.taxonomyTopicIds.includes('isc.subject.gastroenterologia.drge'));
assert.ok(drge.resource.taxonomyTopicIds.includes('isc.subject.gastroenterologia.esofagites'));

const sourceText = 'Fisiologia cardíaca. '.repeat(150);
const chunks = segmentIscText(sourceText, { maxChars: 700, overlap: 100 });
assert.ok(chunks.length > 2);
assert.equal(chunks[0].sourceStart, 0);
assert.ok(chunks.every((chunk, index) => chunk.text === sourceText.slice(chunk.sourceStart, chunk.sourceEnd)));
assert.ok(chunks.slice(1).every((chunk, index) => chunk.sourceStart < chunks[index].sourceEnd), 'janelas mantêm sobreposição controlada sem lacunas');
assert.equal(chunks.at(-1).sourceEnd, sourceText.length);

const indexedUser = buildIscUserResource({
  text: 'Insuficiência cardíaca. '.repeat(180), sourceKind: 'transcript', title: 'Aula de cardiologia',
  course: 'Residência', resourceId: 'a123456', username: 'Aluno', taxonomy
});
assert.equal(indexedUser.resource.resourceKey, 'user:aluno:a123456');
assert.ok(indexedUser.segments.length > 1);
assert.ok(indexedUser.segments.every(segment => segment.sourceStart >= 0 && segment.sourceEnd <= 'Insuficiência cardíaca. '.repeat(180).length));
assert.ok(indexedUser.topics.some(topic => topic.topicId === 'isc.subject.cardiologia.insuficiencia-cardiaca'));
assert.ok(indexedUser.segments.every(segment => segment.sourceRef.includes(`chars:${segment.sourceStart}-${segment.sourceEnd}`)));

const pdfText = 'Doença do refluxo gastroesofágico. '.repeat(40);
const indexedPdf = buildIscUserResource({
  text: pdfText, sourceKind: 'pdf_text', title: 'Apostila de gastroenterologia', course: 'Residência',
  resourceId: 'pdf123456', username: 'Aluno', taxonomy, sourcePages: [{ page: 7, start: 0, end: pdfText.length }]
});
assert.equal(indexedPdf.segments[0].sourcePage, 7, 'segmentos de PDF mantêm a página de origem');
assert.match(indexedPdf.segments[0].sourceRef, /page:7:chars:0-/);
assert.ok(indexedPdf.topics.some(topic => topic.sourcePage === 7), 'tópicos do PDF preservam evidência de página');

const slideText = '## Slide 5\nInsuficiência cardíaca. '.repeat(80);
const indexedSlides = buildIscUserResource({
  text: slideText, sourceKind: 'slides', title: 'Aula de cardiologia.pptx', course: 'Faculdade',
  resourceId: 'slides12345', username: 'Aluno', taxonomy, sourcePages: [{ page: 5, start: 0, end: slideText.length }]
});
assert.equal(indexedSlides.resource.sourceKind, 'slides');
assert.equal(indexedSlides.segments[0].sourcePage, 5, 'slides preservam o número do slide na evidência');
assert.match(indexedSlides.segments[0].sourceRef, /slides:page:5/);
const consolidated = buildIscConsolidatedIndex([
  { ...indexedSlides.resource, topics: indexedSlides.topics, segments: indexedSlides.segments },
  { ...indexedUser.resource, topics: indexedUser.topics, segments: indexedUser.segments }
], taxonomy.nodes);
const mergedHeartTopic = consolidated.topics.find(topic => topic.topicId === 'isc.subject.cardiologia.insuficiencia-cardiaca');
assert.equal(mergedHeartTopic.origin, 'both', 'o ICC preserva a presença independente nos slides e na fala');
assert.ok(mergedHeartTopic.evidence.some(item => item.page === 5), 'evidência do ICC mantém o slide de origem');
assert.equal(consolidated.counts.slides, 1);
assert.equal(consolidated.counts.oral, 1);

const equivalent = compareIscResources(
  { topics: [{ topicId: 'isc.subject.cardiologia.insuficiencia-cardiaca', confidence: 0.9, sourceKind: 'catalog_path' }], segments: [{ embedding: [1, 0] }] },
  { topics: [{ topicId: 'isc.subject.cardiologia.insuficiencia-cardiaca', confidence: 0.85, sourceKind: 'catalog_title' }], segments: [{ embedding: [1, 0] }] },
  { taxonomy: taxonomy.nodes }
);
assert.equal(equivalent.relation, 'equivalent');
assert.equal(equivalent.classificationStatus, 'preliminary');
assert.equal(equivalent.metrics.thematicSimilarity.score, 1);
assert.equal(equivalent.metrics.curriculumCoverage.resources[0].status, 'metadata_match_only');
assert.equal(equivalent.metrics.curriculumCoverage.resources[0].score, null, 'metadados não são usados para estimar cobertura de conteúdo');
assert.equal(equivalent.metrics.complementaryGain.leftToRight.score, null, 'sem conteúdo, nem redundância nem ganho recebe quantificação');

const complementary = compareIscResources(
  { topics: [{ topicId: 'isc.subject.cardiologia.insuficiencia-cardiaca', confidence: 0.8, sourceKind: 'catalog_path' }], segments: [{ embedding: [1, 0] }] },
  { topics: [{ topicId: 'isc.subject.gastroenterologia.drge', confidence: 0.7, sourceKind: 'catalog_title' }], segments: [{ embedding: [0, 1] }] },
  { taxonomy: taxonomy.nodes }
);
assert.equal(complementary.relation, 'complementary');
assert.equal(complementary.classificationStatus, 'preliminary');
assert.equal(complementary.metrics.complementaryGain.leftToRight.score, null, 'diferenças de metadados não viram ganho complementar quantificado');
assert.equal(complementary.metrics.complementaryGain.leftToRight.status, 'metadata_match_only');

const contentComplementary = compareIscResources(
  { topics: [{ topicId: 'isc.subject.cardiologia.insuficiencia-cardiaca', confidence: 0.9, sourceKind: 'transcript' }], segments: [{ embedding: [1, 0], embeddingModel: 'test-model' }] },
  { topics: [{ topicId: 'isc.subject.gastroenterologia.drge', confidence: 0.9, sourceKind: 'pdf_text' }], segments: [{ embedding: [0, 1], embeddingModel: 'test-model' }] },
  { taxonomy: taxonomy.nodes }
);
assert.ok(contentComplementary.metrics.complementaryGain.leftToRight.score > 0, 'ganho é quantificado somente quando há evidência de conteúdo');
assert.equal(contentComplementary.classificationStatus, 'assessed');

const mixedEvidence = compareIscResources(
  { topics: [{ topicId: 'isc.subject.cardiologia.insuficiencia-cardiaca', confidence: 0.9, sourceKind: 'transcript' }], segments: [{ sourceKind: 'transcript', embedding: [1, 0], embeddingModel: 'test-model' }] },
  { topics: [{ topicId: 'isc.subject.cardiologia.insuficiencia-cardiaca', confidence: 0.8, sourceKind: 'catalog_path' }], segments: [{ sourceKind: 'catalog_metadata', embedding: [1, 0], embeddingModel: 'test-model' }] },
  { taxonomy: taxonomy.nodes, expectedTopicIds: ['isc.subject.cardiologia.insuficiencia-cardiaca'] }
);
assert.equal(mixedEvidence.classificationStatus, 'preliminary', 'conteúdo em apenas uma das fontes não confirma a videoaula');
assert.equal(mixedEvidence.metrics.thematicSimilarity.score, null, 'similaridade exige embeddings de conteúdo comparáveis nos dois materiais');
assert.ok(mixedEvidence.metrics.curriculumCoverage.resources[0].score !== null, 'a fonte com transcrição ainda pode relatar seus próprios tópicos reconhecidos');
assert.equal(mixedEvidence.metrics.curriculumCoverage.resources[1].score, null, 'metadados da candidata não viram cobertura de vídeo');

const differentEmbeddingModels = compareIscResources(
  { topics: [], segments: [{ embedding: [1, 0], embeddingModel: 'model-a' }] },
  { topics: [], segments: [{ embedding: [1, 0], embeddingModel: 'model-b' }] }
);
assert.equal(differentEmbeddingModels.metrics.thematicSimilarity.score, null, 'vetores de modelos diferentes não são comparados');

const missingContent = compareIscResources({ topics: [], segments: [] }, { topics: [], segments: [] });
assert.equal(missingContent.metrics.thematicSimilarity.score, null);
assert.equal(missingContent.metrics.curriculumCoverage.status, 'insufficient_evidence');
assert.equal(missingContent.metrics.complementaryGain.leftToRight, null);
const unknownObjective = compareIscResources(
  { topics: [{ topicId: 'isc.subject.cardiologia.insuficiencia-cardiaca', confidence: 0.8, sourceKind: 'catalog_metadata' }], segments: [] },
  { topics: [], segments: [] },
  { taxonomy: taxonomy.nodes, expectedTopicIds: ['isc.objective.cardiologia.ic.fisiopatologia'] }
);
assert.equal(unknownObjective.metrics.curriculumCoverage.status, 'insufficient_evidence', 'ausência de análise de objetivo não vira nota zero');

let capturedBody;
const embedded = await embedIscTexts(['texto de teste'], {
  purpose: 'query', config: { provider: 'huggingface', model: 'model-test', token: 'fake' },
  fetchImpl: async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify([[1, 0]]), { status: 200 });
  }
});
assert.equal(embedded[0].length, 1024, 'vetores de provedores de 768 ou 1024 dimensões compartilham o tipo pgvector do ISC');
assert.equal(embedded[0][0], 1);
assert.match(capturedBody.inputs[0], /task: search result \| query:/);

const migrations = await readFile(new URL('../../supabase/migrations/20261024053135_isc_curriculum_index.sql', import.meta.url), 'utf8');
const filterMigration = await readFile(new URL('../../supabase/migrations/20261024053636_isc_search_filters.sql', import.meta.url), 'utf8');
const userContentMigration = await readFile(new URL('../../supabase/migrations/20261024134824_isc_user_content_keyword_search.sql', import.meta.url), 'utf8');
const slidesMigration = await readFile(new URL('../../supabase/migrations/20261025180328_isc_slides_source_kind.sql', import.meta.url), 'utf8');
for (const table of ['isc_taxonomy_nodes', 'isc_resources', 'isc_resource_topics', 'isc_segments']) {
  assert.match(migrations, new RegExp(`create table if not exists public\\.${table}`));
  assert.match(migrations, new RegExp(`alter table public\\.${table} enable row level security`));
}
assert.match(migrations, /revoke all on table public\.isc_taxonomy_nodes[\s\S]+from public, anon, authenticated/);
assert.match(migrations, /create or replace function public\.search_isc_resources/);
assert.match(filterMigration, /p_course_filter text default null/);
assert.match(filterMigration, /position\(lower\(btrim\(p_course_filter\)\)/, 'filtro por curso limita o conjunto consultado antes do ranking final');
assert.match(userContentMigration, /create or replace function public\.replace_isc_user_resource/);
assert.match(userContentMigration, /create or replace function public\.search_isc_user_resources/);
assert.match(slidesMigration, /source_kind in \('catalog_metadata', 'transcript', 'pdf_text', 'slides'\)/);
assert.match(userContentMigration, /revoke all on function public\.replace_isc_user_resource[\s\S]+from public, anon, authenticated/);

const rpcCalls = [];
const fakeSupabase = {
  from(table) {
    const query = {
      select() { return this; }, eq() { return this; }, order() { return this; },
      async range() { return { data: [], error: null }; },
      async upsert(rows) { rpcCalls.push({ table, rows }); return { error: null }; },
      update() { return this; }, async in() { return { error: null }; }
    };
    return query;
  },
  async rpc(name, args) { rpcCalls.push({ name, args }); return { data: 1, error: null }; }
};
const preview = await indexIscCatalog(fakeSupabase, catalog, { taxonomy, apply: false });
assert.equal(preview.totalCatalogResources, 3);
assert.equal(preview.applied, false);
assert.ok(preview.segmentsToEmbed > 0);
assert.equal(rpcCalls.length, 0, 'prévia não grava dados');

const applied = await indexIscCatalog(fakeSupabase, catalog, {
  taxonomy, apply: true, maxResources: 2, embeddingConfig: { provider: 'mock', model: 'mock-embedding', indexModel: 'mock:1', token: 'fake' },
  embedTexts: async texts => texts.map(() => [1, ...new Array(1023).fill(0)])
});
assert.equal(applied.applied, true);
assert.equal(applied.processed, 2);
assert.equal(applied.deferred, 1);
assert.ok(rpcCalls.some(call => call.name === 'replace_isc_catalog_batch'));
const indexedSegments = rpcCalls.find(call => call.name === 'replace_isc_catalog_batch').args.p_segments;
assert.ok(indexedSegments.length > 0);
assert.equal(indexedSegments[0].embedding.length, 1024);

let metadataOnlyCalls = 0;
const metadataOnlyRpc = [];
const metadataOnlySupabase = {
  ...fakeSupabase,
  async rpc(name, args) { metadataOnlyRpc.push({ name, args }); return { data: 1, error: null }; }
};
const metadataOnlyResult = await indexIscCatalog(metadataOnlySupabase, catalog, {
  taxonomy, apply: true, metadataOnly: true,
  embeddingConfig: { provider: 'none', model: 'none', indexModel: 'none:1', token: '' },
  embedTexts: async () => { metadataOnlyCalls++; throw new Error('metadata-only must not embed content'); }
});
assert.equal(metadataOnlyResult.applied, true);
assert.equal(metadataOnlyCalls, 0);
const metadataOnlyArgs = metadataOnlyRpc.find(call => call.name === 'replace_isc_catalog_batch').args;
assert.equal(metadataOnlyArgs.p_segments.length, 0, 'importação metadata-only não cria conteúdo nem embeddings');
assert.equal(metadataOnlyArgs.p_resources[0].metadata.embeddingStatus, 'pending', 'marca recursos para futura indexação semântica');

console.log('OK — taxonomia controlada, hashes, evidências, ausência de falsa cobertura, comparação, vetores segmentados e persistência incremental ISC.');
