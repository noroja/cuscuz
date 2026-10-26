import assert from 'node:assert/strict';
import {
  parseGeminiVideoIndexText, uploadGeminiVideoFile, startGeminiVideoIndex
} from '../../src/gemini-video-index.js';
import { canonicalVideoTopicRows } from '../../src/isc-routes.js';

const parsed = parseGeminiVideoIndexText('```json\n{"topics":[{"name":"Fibrilação atrial","synonyms":["FA"],"evidence":"A aula compara controle de frequência e ritmo.","timestampStart":50,"timestampEnd":84,"coverageLevel":"partial","depthLevel":3,"confidence":0.82},{"name":"Sem confiança","evidence":"Trecho incerto","confidence":1.4}],"limitations":[]}\n```');
assert.equal(parsed.topics.length, 1, 'descarta itens sem confiança válida');
assert.equal(parsed.topics[0].timestampStart, 50);
assert.equal(parsed.topics[0].confidence, 0.82);

const topicRows = canonicalVideoTopicRows([
  { ...parsed.topics[0], name: 'Fibrilação atrial', timestampStart: 50, timestampEnd: 84 },
  { ...parsed.topics[0], name: 'Arritmia não catalogada', timestampStart: 500, timestampEnd: 510 }
], [{ id: 'isc.cardio.fibrilacao-atrial', kind: 'subject', name: 'Fibrilação atrial', synonyms: ['FA'] }], 'video:file123', 'source-hash-1', 300);
assert.equal(topicRows.topics.length, 1, 'só persiste tópicos associados à taxonomia');
assert.equal(topicRows.topics[0].source_kind, 'video_analysis');
assert.equal(topicRows.topics[0].timestamp_start, 50);
assert.equal(topicRows.topics[0].confidence, 0.82, 'preserva a estimativa original do modelo');
assert.equal(topicRows.unmapped.length, 1, 'mantém tópicos não mapeados para revisão');
assert.equal(topicRows.unmapped[0].timestampStart, 500, 'não inventa nem corrige timestamps não validados');

const originalFetch = globalThis.fetch;
const originalKey = process.env.GEMINI_API_KEY;
const originalModel = process.env.GEMINI_VIDEO_INDEX_MODEL;
process.env.GEMINI_API_KEY = 'test-key-not-a-real-secret';
process.env.GEMINI_VIDEO_INDEX_MODEL = 'gemini-test-model';
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (String(url).endsWith('/upload/v1beta/files')) {
    return { ok: true, status: 200, headers: { get: name => name.toLowerCase() === 'x-goog-upload-url' ? 'https://upload.test/video' : null } };
  }
  if (String(url) === 'https://upload.test/video') {
    assert.equal(options.duplex, 'half', 'o arquivo é encaminhado como stream');
    assert.equal(options.headers['Content-Length'], '4');
    return { ok: true, status: 200, json: async () => ({ file: { name: 'files/video1', uri: 'https://files.test/video1', mimeType: 'video/mp4', state: 'PROCESSING' } }) };
  }
  if (String(url).endsWith('/v1beta/interactions')) {
    const body = JSON.parse(options.body);
    assert.equal(body.background, true, 'a análise longa roda em segundo plano no Gemini');
    assert.equal(body.input[0].processing, 'agentic');
    assert.equal(body.model, 'gemini-test-model');
    return { ok: true, status: 200, json: async () => ({ id: 'interaction1', status: 'in_progress' }) };
  }
  throw new Error('Chamado HTTP inesperado no teste.');
};

try {
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([0, 1, 2, 3])); controller.close(); }
  });
  const file = await uploadGeminiVideoFile({ stream, sizeBytes: 4, mimeType: 'video/mp4', displayName: 'Aula de teste' });
  assert.equal(file.name, 'files/video1');
  assert.equal((await startGeminiVideoIndex({ fileUri: file.uri, mimeType: file.mimeType, title: 'Aula de teste' })).id, 'interaction1');
  assert.equal(calls.length, 3, 'um upload e uma interação para a videoaula solicitada');
  await assert.rejects(() => uploadGeminiVideoFile({ stream: new ReadableStream(), sizeBytes: 2 * 1024 * 1024 * 1024 + 1 }), /2 GB/);
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.GEMINI_VIDEO_INDEX_MODEL; else process.env.GEMINI_VIDEO_INDEX_MODEL = originalModel;
}

console.log('OK — indexação de uma videoaula: validação do índice multimodal, mapeamento canônico e upload em stream.');
