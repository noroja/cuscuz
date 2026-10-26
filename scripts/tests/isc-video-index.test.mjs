import assert from 'node:assert/strict';
import { registerIscRoutes } from '../../src/isc-routes.js';

const taxonomy = [{
  id: 'isc.subject.uti.ventilacao', kind: 'subject', parent_id: null,
  canonical_name: 'Ventilação mecânica', synonyms: ['VM'], origin: 'curated', is_canonical: true, confidence: 1
}];
const resources = [{
  resource_key: 'video:a123', resource_id: 'a123', resource_kind: 'video', title: 'Ventilação mecânica',
  course: 'Extensivo', source_path: 'UTI / Ventilação', source_kind: 'catalog_metadata', index_status: 'metadata_indexed',
  metadata_confidence: 0.7, is_active: true, scope: 'catalog', owner_username: null
}];
const topicRows = [{
  resource_key: 'video:a123', topic_id: 'isc.subject.uti.ventilacao', source_kind: 'catalog_metadata',
  confidence: null, coverage_level: null, depth_level: null, evidence_excerpt: 'Ventilação mecânica', evidence_ref: 'catalog:title',
  source_start: null, source_end: null, source_page: null, timestamp_start: null, timestamp_end: null
}];
let segmentRows = [];
const fixtureRows = table => table === 'isc_resources' ? resources : table === 'isc_resource_topics' ? topicRows : table === 'isc_segments' ? segmentRows : [];
const supabase = {
  from(table) {
    const filters = [];
    return {
      select() { return this; },
      eq(column, value) { filters.push(row => row[column] === value); return this; },
      order() { return this; },
      async range() { return { data: taxonomy, error: null }; },
      async maybeSingle() {
        const row = fixtureRows(table).find(item => filters.every(test => test(item))) || null;
        return { data: row, error: null };
      },
      in(column, values) {
        const rows = fixtureRows(table).filter(row => values.includes(row[column]));
        return Promise.resolve({ data: rows, error: null });
      }
    };
  },
  async rpc(name, args) {
    assert.equal(name, 'ensure_isc_video_metadata_index');
    const row = args.p_resource;
    if (resources.some(item => item.resource_key === row.resource_key)) return { data: false, error: null };
    resources.push({
      resource_key: row.resource_key, resource_id: row.resource_id, resource_kind: row.resource_kind,
      title: row.title, course: row.course, source_path: row.source_path, source_kind: row.source_kind,
      index_status: row.index_status, metadata_confidence: row.metadata_confidence,
      is_active: true, scope: 'catalog', owner_username: null
    });
    topicRows.push(...args.p_topics);
    return { data: true, error: null };
  }
};
const handlers = new Map();
const catalog = { generatedAt: '2026-10-25T00:00:00.000Z', videos: [
  { id: 'b456', t: 'Ventilação mecânica', course: 'Extensivo', path: 'UTI / Ventilação' }
] };
registerIscRoutes({
  get(path, callback) { handlers.set(`GET ${path}`, callback); },
  post(path, callback) { handlers.set(`POST ${path}`, callback); },
  delete(path, callback) { handlers.set(`DELETE ${path}`, callback); }
}, { supabase, supabaseServiceRole: true, enabled: true, getCatalog: () => catalog });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set(name, value) { this.headers ||= {}; this.headers[name] = value; return this; } });
const handler = handlers.get('GET /api/isc/video-index');

const guest = response();
await handler({ query: { id: 'a123' } }, guest);
assert.equal(guest.statusCode, 401, 'video-index exige sessão');

const invalid = response();
await handler({ user: { username: 'ana' }, query: { id: '../private' } }, invalid);
assert.equal(invalid.statusCode, 400, 'IDs de vídeo inválidos são recusados');

const metadataOnly = response();
await handler({ user: { username: 'ana' }, query: { id: 'a123' } }, metadataOnly);
assert.equal(metadataOnly.statusCode, 200);
assert.equal(metadataOnly.body.evidenceMode, 'catalog_metadata');
assert.equal(metadataOnly.body.topics[0].confidence, null, 'ausência de confiança permanece nula');
assert.equal(metadataOnly.body.topics[0].evidence[0].timestampStart, null, 'ausência de timestamp não vira zero');

topicRows[0] = { ...topicRows[0], source_kind: 'transcript', evidence_excerpt: 'O suporte inspiratório é ajustado pelo modo de pressão.', evidence_ref: 'transcript:chars:10-80', timestamp_start: 42, timestamp_end: 75 };
segmentRows = [{
  resource_key: 'video:a123', topic_ids: ['isc.subject.uti.ventilacao'], source_kind: 'transcript', confidence: 0.8,
  evidence_excerpt: 'O suporte inspiratório é ajustado pelo modo de pressão.', evidence_ref: 'segment:2', source_page: null,
  timestamp_start: 42, timestamp_end: 75, embedding: null, embedding_model: null
}];
const indexed = response();
await handler({ user: { username: 'ana' }, query: { id: 'a123' } }, indexed);
assert.equal(indexed.body.evidenceMode, 'indexed_content');
assert.equal(indexed.body.topics[0].confidence, 0.8);
assert.equal(indexed.body.topics[0].evidence[0].timestampStart, 42);
assert.equal(indexed.headers['Cache-Control'], 'private, no-store');

const generated = response();
await handler({ user: { username: 'ana' }, query: { id: 'b456' } }, generated);
assert.equal(generated.statusCode, 200, 'gera o índice quando o vídeo atual ainda não está persistido');
assert.equal(generated.body.generatedOnDemand, true);
assert.equal(generated.body.persisted, true);
assert.equal(generated.body.evidenceMode, 'catalog_metadata');
assert.equal(generated.body.topics[0].name, 'Ventilação mecânica');
assert.equal(generated.body.topics[0].sourceKind, 'catalog_metadata');
assert.equal(generated.body.topics[0].evidence[0].sourceKind, 'catalog_title');

const fallbackHandlers = new Map();
registerIscRoutes({
  get(path, callback) { fallbackHandlers.set(`GET ${path}`, callback); },
  post() {}, delete() {}
}, { enabled: false, getCatalog: () => ({ videos: [
  { id: 'c789', t: 'Conduta da Fibrilação e Flutter Atrial', course: 'Extensivo 2026', path: 'Estratégia MED 2026 / Extensivo 2026 / Cardiologia / Arritmias cardíacas / Conduta da Fibrilação e Flutter Atrial.mp4' }
] }) });
const fallback = response();
await fallbackHandlers.get('GET /api/isc/video-index')({ user: { username: 'ana' }, query: { id: 'c789' } }, fallback);
assert.equal(fallback.statusCode, 200, 'gera índice de metadados mesmo sem ISC/Supabase habilitado');
assert.equal(fallback.body.persisted, false);
assert.ok(fallback.body.topics.some(topic => topic.name === 'Arritmias cardíacas'), 'o tópico curricular do vídeo selecionado é extraído de seus metadados');

console.log('OK — índice do vídeo atual é gerado sob demanda, persiste apenas se ausente e mantém explícita a diferença entre metadados e fala indexada.');
