const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const UPLOAD_ROOT = 'https://generativelanguage.googleapis.com/upload/v1beta';
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

function apiKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '').trim();
}

function providerError(response, payload, action) {
  const error = new Error(String(payload?.error?.message || `Gemini não concluiu ${action} (HTTP ${response.status}).`).slice(0, 500));
  error.status = response.status;
  error.code = response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'upstream' : 'provider';
  return error;
}

async function geminiRequest(url, options, action) {
  const key = apiKey();
  if (!key) {
    const error = new Error('GEMINI_API_KEY não está configurada no servidor.');
    error.status = 503;
    error.code = 'no_key';
    throw error;
  }
  const response = await fetch(url, {
    ...options,
    headers: { ...(options?.headers || {}), 'x-goog-api-key': key }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw providerError(response, payload, action);
  return payload;
}

export function geminiVideoIndexAvailable() {
  return !!apiKey();
}

export async function uploadGeminiVideoFile({ stream, sizeBytes, mimeType = 'video/mp4', displayName = 'Videoaula Cuscuz-MED' }) {
  if (!geminiVideoIndexAvailable()) {
    const error = new Error('A indexação de videoaulas exige GEMINI_API_KEY no servidor.');
    error.status = 503;
    error.code = 'no_key';
    throw error;
  }
  const size = Number(sizeBytes);
  if (!stream || !Number.isSafeInteger(size) || size <= 0) {
    const error = new Error('Não foi possível validar o arquivo de vídeo antes do envio.');
    error.status = 422;
    error.code = 'invalid_media';
    throw error;
  }
  if (size > MAX_VIDEO_BYTES) {
    const error = new Error('O Gemini Files API aceita até 2 GB por vídeo no fluxo atual.');
    error.status = 413;
    error.code = 'media_too_large';
    throw error;
  }

  const key = apiKey();
  const startResponse = await fetch(`${UPLOAD_ROOT}/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: String(displayName).slice(0, 120) } }),
    signal: AbortSignal.timeout(20000)
  });
  if (!startResponse.ok) {
    const payload = await startResponse.json().catch(() => ({}));
    throw providerError(startResponse, payload, 'iniciar o upload do vídeo');
  }
  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    const error = new Error('O Gemini não devolveu a URL de upload do vídeo.');
    error.status = 502;
    error.code = 'upstream';
    throw error;
  }

  const uploaded = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Type': mimeType
    },
    body: stream,
    duplex: 'half',
    signal: AbortSignal.timeout(270000)
  });
  const payload = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok) throw providerError(uploaded, payload, 'enviar o vídeo');
  const file = payload.file || payload;
  if (!file.name || !file.uri) {
    const error = new Error('O Gemini recebeu o arquivo, mas não devolveu uma referência utilizável.');
    error.status = 502;
    error.code = 'upstream';
    throw error;
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType, state: file.state || 'PROCESSING' };
}

export async function getGeminiVideoFile(name) {
  return geminiRequest(`${API_ROOT}/${String(name || '').replace(/^\//, '')}`, { method: 'GET', signal: AbortSignal.timeout(15000) }, 'consultar o arquivo');
}

export async function startGeminiVideoIndex({ fileUri, mimeType, title, course, sourcePath, durationSeconds }) {
  const model = String(process.env.GEMINI_VIDEO_INDEX_MODEL || 'gemini-3.8-flash').trim();
  const prompt = [
    'Analise esta videoaula médica somente para criar um índice curricular rastreável que será usado para selecionar questões.',
    'Use o áudio e os slides realmente presentes no arquivo. Não infira conteúdo pelo nome do arquivo, curso ou caminho.',
    'Liste os tópicos e subtópicos distintos efetivamente explicados; não transforme repetições em importância curricular.',
    'Para cada tópico, retorne um trecho curto que sirva de evidência, timestamp em segundos quando localizável, cobertura (partial ou complete), profundidade de 1 a 5 e confiança estimada entre 0 e 1. A confiança é uma estimativa não calibrada.',
    'Não invente falas, timestamps, diretrizes, diagnósticos ou condutas. Se a evidência ou o timestamp não forem claros, use null e reduza a confiança.',
    'Não gere transcrição integral. Gere todos os tópicos curriculares encontrados, sem duplicatas; inclua mecanismos, classificações, diagnósticos e condutas apenas quando estiverem na aula.',
    `Metadados de referência (não são evidência): título=${JSON.stringify(title || '')}; curso=${JSON.stringify(course || '')}; caminho=${JSON.stringify(sourcePath || '')}; duração=${Number.isFinite(Number(durationSeconds)) ? `${Number(durationSeconds)} segundos` : 'desconhecida'}.`,
    'Responda somente JSON válido neste formato: {"topics":[{"name":"","synonyms":[],"evidence":"","timestampStart":null,"timestampEnd":null,"coverageLevel":"partial","depthLevel":1,"confidence":0.5}],"limitations":[]}.',
    'Use no máximo 120 tópicos e no máximo 240 caracteres no campo evidence.'
  ].join('\n');
  return geminiRequest(`${API_ROOT}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      background: true,
      store: true,
      input: [
        { type: 'video', uri: fileUri, mime_type: mimeType, processing: 'agentic' },
        { type: 'text', text: prompt }
      ]
    }),
    signal: AbortSignal.timeout(30000)
  }, 'iniciar a análise curricular da videoaula');
}

export async function getGeminiVideoIndexInteraction(id) {
  return geminiRequest(`${API_ROOT}/interactions/${encodeURIComponent(String(id || ''))}`, { method: 'GET', signal: AbortSignal.timeout(20000) }, 'consultar a análise da videoaula');
}

export async function deleteGeminiVideoFile(name) {
  if (!name) return;
  await geminiRequest(`${API_ROOT}/${String(name).replace(/^\//, '')}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) }, 'remover o vídeo temporário');
}

export async function deleteGeminiVideoIndexInteraction(id) {
  if (!id) return;
  await geminiRequest(`${API_ROOT}/interactions/${encodeURIComponent(String(id))}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) }, 'remover o resultado temporário');
}

export function extractGeminiVideoIndexText(interaction) {
  const direct = String(interaction?.output_text || '').trim();
  if (direct) return direct;
  return (interaction?.steps || []).flatMap(step => step?.content || [])
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text).join('\n').trim();
}

export function parseGeminiVideoIndexText(value) {
  let text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { throw new Error('A IA terminou, mas devolveu um índice em formato inválido.'); }
  if (!Array.isArray(parsed?.topics)) throw new Error('A IA não devolveu a lista de tópicos da videoaula.');
  const topics = parsed.topics.slice(0, 120).map(topic => {
    const name = String(topic?.name || '').trim().slice(0, 180);
    const evidence = String(topic?.evidence || '').trim().slice(0, 240);
    const confidence = Number(topic?.confidence);
    const start = topic?.timestampStart == null ? null : Number(topic.timestampStart);
    const end = topic?.timestampEnd == null ? null : Number(topic.timestampEnd);
    if (!name || !evidence || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    if ((start !== null && (!Number.isFinite(start) || start < 0)) || (end !== null && (!Number.isFinite(end) || end < 0)) || (start !== null && end !== null && end < start)) return null;
    return {
      name,
      synonyms: Array.isArray(topic.synonyms) ? [...new Set(topic.synonyms.map(value => String(value || '').trim().slice(0, 120)).filter(Boolean))].slice(0, 12) : [],
      evidence,
      timestampStart: start,
      timestampEnd: end,
      coverageLevel: ['partial', 'complete'].includes(topic.coverageLevel) ? topic.coverageLevel : null,
      depthLevel: Number.isInteger(Number(topic.depthLevel)) && Number(topic.depthLevel) >= 1 && Number(topic.depthLevel) <= 5 ? Number(topic.depthLevel) : null,
      confidence
    };
  }).filter(Boolean);
  return { topics, limitations: Array.isArray(parsed.limitations) ? parsed.limitations.map(item => String(item || '').trim()).filter(Boolean).slice(0, 20) : [] };
}
