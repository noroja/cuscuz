const fetchOriginal = globalThis.fetch.bind(globalThis);
const MOCK_TOTAL_BYTES = 20 * 1024 * 1024;
const MOCK_DROP_FILE_ID = 'AbCdEfGhIjKlMnOp12345';
const droppedFiles = new Set();

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input.url || input);
  if (!url.startsWith('https://drive.usercontent.google.com/download')) {
    return fetchOriginal(input, init);
  }

  const headers = new Headers(init.headers || {});
  const match = /^bytes=(\d+)-(\d*)$/.exec(headers.get('range') || '');
  if (!match) return new Response('Range required by media test fixture', { status: 400 });

  const start = Number(match[1]);
  if (start >= MOCK_TOTAL_BYTES) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${MOCK_TOTAL_BYTES}` } });
  }
  const fileId = new URL(url).searchParams.get('id');
  const simulateDrop = fileId === MOCK_DROP_FILE_ID && start === 0 && !droppedFiles.has(fileId);
  if (simulateDrop) droppedFiles.add(fileId);
  const end = Math.min(match[2] ? Number(match[2]) : MOCK_TOTAL_BYTES - 1, MOCK_TOTAL_BYTES - 1);
  const responseEnd = simulateDrop ? Math.min(end, start + 1024 * 1024 - 1) : end;
  const length = end - start + 1;
  const responseHeaders = {
    'accept-ranges': 'bytes',
    'content-length': String(length),
    'content-range': `bytes ${start}-${end}/${MOCK_TOTAL_BYTES}`,
    'content-type': 'video/mp4'
  };

  if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
    return new Response(null, { status: 206, headers: responseHeaders });
  }

  let position = start;
  const body = new ReadableStream({
    pull(controller) {
      if (position > responseEnd) {
        return simulateDrop ? controller.error(new Error('simulated upstream interruption')) : controller.close();
      }
      const chunkLength = Math.min(256 * 1024, responseEnd - position + 1);
      const chunk = new Uint8Array(chunkLength);
      chunk.fill(position % 251);
      position += chunkLength;
      controller.enqueue(chunk);
    }
  });
  return new Response(body, { status: 206, headers: responseHeaders });
};
