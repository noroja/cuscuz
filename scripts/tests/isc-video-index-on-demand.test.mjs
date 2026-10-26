import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerIscRoutes } from '../../src/isc-routes.js';

const state = { resources: [], topics: [], segments: [], jobs: [] };
const taxonomy = [{ id: 'isc.cardio.fibrilacao-atrial', kind: 'subject', parent_id: null, canonical_name: 'Fibrilação atrial', synonyms: ['FA'], origin: 'curated', is_canonical: true, confidence: 1 }];
const tableRows = table => table === 'isc_resources' ? state.resources : table === 'isc_resource_topics' ? state.topics : table === 'isc_segments' ? state.segments : table === 'isc_video_index_jobs' ? state.jobs : [];
const supabase = {
  from(table) {
    const filters = [];
    let operation = 'select';
    let payload = null;
    const matches = row => filters.every(([key, value]) => typeof value === 'function' ? value(row) : row[key] === value);
    const result = () => {
      const rows = tableRows(table).filter(matches);
      if (operation === 'update') { rows.forEach(row => Object.assign(row, payload)); return { data: rows, error: null }; }
      if (operation === 'insert') { tableRows(table).push(payload); return { data: payload, error: null }; }
      return { data: rows, error: null };
    };
    return {
      select() { if (operation === 'select') operation = 'select'; return this; },
      order() { return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      lt(key, value) { filters.push([key, row => String(row[key] || '') < String(value)]); return this; },
      async maybeSingle() {
        if (operation === 'update') return { data: result().data[0] || null, error: null };
        return { data: tableRows(table).find(matches) || null, error: null };
      },
      async range() { return { data: taxonomy, error: null }; },
      async in(key, values) { return { data: tableRows(table).filter(row => values.includes(row[key])), error: null }; },
      insert(row) {
        operation = 'insert'; payload = row;
        if (tableRows(table).some(item => item.resource_key === row.resource_key && item.source_hash === row.source_hash)) {
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } });
        }
        return Promise.resolve(result());
      },
      update(patch) { operation = 'update'; payload = patch; return this; },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
    };
  },
  async rpc(name, args) {
    if (name === 'ensure_isc_video_metadata_index') {
      const row = args.p_resource;
      if (!state.resources.some(item => item.resource_key === row.resource_key)) {
        state.resources.push({ ...row, source_path: row.source_path, is_active: true });
        state.topics.push(...args.p_topics);
      }
      return { data: true, error: null };
    }
    if (name === 'replace_isc_video_content_index') {
      const row = state.resources.find(item => item.resource_key === args.p_resource.resource_key);
      Object.assign(row, args.p_resource, { index_status: args.p_topics.length ? 'content_indexed' : 'insufficient_evidence' });
      state.topics = args.p_topics;
      state.segments = [];
      return { data: 'content_indexed', error: null };
    }
    throw new Error(`RPC não esperado: ${name}`);
  }
};

const handlers = new Map();
let fileReads = 0;
let releaseFileReads;
let fileReadBarrier = null;
let analysisStarts = 0;
registerIscRoutes({
  get(path, handler) { handlers.set(`GET ${path}`, handler); },
  post(path, handler) { handlers.set(`POST ${path}`, handler); },
  delete() {}
}, {
  supabase, supabaseServiceRole: true, enabled: true,
  getCatalog: () => ({ generatedAt: '2026-10-25T00:00:00Z', videos: [{ id: 'video123', t: 'Fibrilação atrial', course: 'Extensivo', path: 'Cardiologia / Fibrilação atrial.mp4' }] }),
  getVideoMediaInfo: async id => { assert.equal(id, 'video123'); return { sizeBytes: 4, mimeType: 'video/mp4', durationSeconds: 300, sourceHash: 'drive-md5-v1' }; },
  openVideoMedia: async id => { assert.equal(id, 'video123'); return { ok: true, body: new ReadableStream() }; },
  videoIndexProvider: {
    geminiVideoIndexAvailable: () => true,
    uploadGeminiVideoFile: async () => ({ name: 'files/v1', uri: 'https://gemini.test/files/v1', mimeType: 'video/mp4', state: 'PROCESSING' }),
    getGeminiVideoFile: async () => {
      fileReads++;
      if (fileReadBarrier) await fileReadBarrier;
      return { state: 'ACTIVE', uri: 'https://gemini.test/files/v1', mimeType: 'video/mp4' };
    },
    startGeminiVideoIndex: async () => { analysisStarts++; return { id: 'interaction-v1' }; },
    getGeminiVideoIndexInteraction: async () => ({ status: 'completed', output_text: '{"topics":[]}' }),
    extractGeminiVideoIndexText: () => '{"topics":[]}',
    parseGeminiVideoIndexText: () => ({ topics: [{ name: 'Fibrilação atrial', synonyms: ['FA'], evidence: 'A aula diferencia controle de frequência e ritmo.', timestampStart: 40, timestampEnd: 70, coverageLevel: 'partial', depthLevel: 3, confidence: 0.82 }], limitations: [] }),
    deleteGeminiVideoFile: async () => {}
  }
});
const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  set(key, value) { this.headers ||= {}; this.headers[key] = value; return this; },
  json(body) { this.body = body; return this; }
});

const requestIndex = handlers.get('POST /api/isc/video-index/request');
const unauthenticated = response();
await requestIndex({ body: { id: 'video123' } }, unauthenticated);
assert.equal(unauthenticated.statusCode, 401, 'exige sessão antes de buscar a mídia');

const start = response();
await requestIndex({ user: { username: 'ana' }, body: { id: 'video123' } }, start);
assert.equal(start.statusCode, 202);
assert.equal(start.body.state, 'media_processing');
assert.equal(state.jobs.length, 1, 'registra apenas o vídeo explicitamente solicitado');

const duplicate = response();
await requestIndex({ user: { username: 'ana' }, body: { id: 'video123' } }, duplicate);
assert.equal(duplicate.body.reused, true, 'cliques repetidos reutilizam o mesmo processamento');
assert.equal(state.jobs.length, 1);

const poll = handlers.get('GET /api/isc/video-index/jobs/:jobId');
fileReadBarrier = new Promise(resolve => { releaseFileReads = resolve; });
const firstPoll = response();
const firstPollPromise = poll({ user: { username: 'ana' }, params: { jobId: start.body.jobId } }, firstPoll);
while (fileReads < 1) await new Promise(resolve => setTimeout(resolve, 0));
const secondPoll = response();
const secondPollPromise = poll({ user: { username: 'ana' }, params: { jobId: start.body.jobId } }, secondPoll);
while (fileReads < 2) await new Promise(resolve => setTimeout(resolve, 0));
releaseFileReads();
await Promise.all([firstPollPromise, secondPollPromise]);
assert.equal(analysisStarts, 1, 'duas consultas concorrentes iniciam uma única análise paga');
assert.ok(['analyzing', 'starting_analysis'].includes(firstPoll.body.state));
assert.ok(['analyzing', 'starting_analysis'].includes(secondPoll.body.state));

const completed = response();
await poll({ user: { username: 'ana' }, params: { jobId: start.body.jobId } }, completed);
assert.equal(completed.body.state, 'completed');
assert.equal(completed.body.videoIndex.evidenceMode, 'indexed_content');
assert.equal(completed.body.videoIndex.topics[0].name, 'Fibrilação atrial');
assert.equal(completed.body.videoIndex.topics[0].evidence[0].timestampStart, 40);
assert.equal(state.resources[0].source_hash, 'drive-md5-v1');

const cached = response();
await requestIndex({ user: { username: 'ana' }, body: { id: 'video123' } }, cached);
assert.equal(cached.body.reused, true, 'versão já indexada não reenvia vídeo à IA');
assert.equal(cached.body.videoIndex.evidenceMode, 'indexed_content');

console.log('OK — Smart Questions inicia indexação apenas sob solicitação, evita análise concorrente, reutiliza jobs e o índice da versão já processada.');

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const selectionCall = html.indexOf('ac2AtualizarBotaoPraticar(v);');
const updaterStart = html.indexOf('function ac2AtualizarBotaoPraticar(v, searchOptions = null)');
const noSearchBranch = html.indexOf('if (!searchOptions?.search)', updaterStart);
const questionSearch = html.indexOf('const matching = buscarQtdQuestoesTema', updaterStart);
assert.ok(selectionCall >= 0 && updaterStart >= 0 && noSearchBranch > updaterStart && questionSearch > noSearchBranch,
  'a seleção inicial usa o ramo sem busca antes do clique explícito');
assert.match(html, /if\s*\(!searchOptions\?\.search\)\s*\{\s*window\._questoesTemaAtual/, 'a seleção inicial não consulta o índice ou as questões automaticamente');
console.log('OK — trocar de videoaula não inicia a busca curricular ou o envio ao Gemini.');
