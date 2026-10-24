const fetchOriginal = globalThis.fetch.bind(globalThis);
const MOCK_TOTAL_BYTES = 20 * 1024 * 1024;
const MOCK_LARGE_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const MOCK_DROP_FILE_ID = 'AbCdEfGhIjKlMnOp12345';
const MOCK_LARGE_FILE_ID = 'LargeFileFixture012345';
const droppedFiles = new Set();

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input.url || input);
  if (!url.startsWith('https://drive.usercontent.google.com/download')) {
    return fetchOriginal(input, init);
  }

  const headers = new Headers(init.headers || {});
  const rangeHeader = headers.get('range');
  const match = rangeHeader == null ? null : /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader);
  if (rangeHeader != null && !match) return new Response('Range required by media test fixture', { status: 400 });

  const fileId = new URL(url).searchParams.get('id');
  const total = fileId === MOCK_LARGE_FILE_ID ? MOCK_LARGE_TOTAL_BYTES : MOCK_TOTAL_BYTES;
  const start = match ? Number(match[1]) : 0;
  if (start >= total) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
  }
  const end = Math.min(match && match[2] ? Number(match[2]) : total - 1, total - 1);
  const simulateDrop = fileId === MOCK_DROP_FILE_ID && start === 0 && !droppedFiles.has(fileId);
  if (simulateDrop) droppedFiles.add(fileId);
  const responseEnd = simulateDrop ? Math.min(end, start + 1024 * 1024 - 1) : end;
  const length = end - start + 1;
  const responseHeaders = {
    'accept-ranges': 'bytes',
    'content-length': String(length),
    'content-type': 'video/mp4'
  };
  if (match) responseHeaders['content-range'] = `bytes ${start}-${end}/${total}`;

  if (String(init.method || 'GET').toUpperCase() === 'HEAD') {
    return new Response(null, { status: match ? 206 : 200, headers: responseHeaders });
  }

  let position = start;
  let producedBytes = 0;
  let complete = false;
  let statsReported = false;
  let streamController = null;
  const reportCancellation = () => {
    if (fileId !== MOCK_LARGE_FILE_ID || complete || statsReported) return;
    statsReported = true;
    const statsUrl = process.env.MEDIA_TEST_STATS_URL;
    if (statsUrl) {
      fetchOriginal(statsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId, aborted: true, producedBytes })
      }).catch(() => {});
    }
    try { streamController?.error(new Error('simulated upstream cancellation')); } catch (_) {}
  };

  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      if (init.signal) {
        if (init.signal.aborted) reportCancellation();
        else init.signal.addEventListener('abort', reportCancellation, { once: true });
      }
    },
    pull(controller) {
      if (position > responseEnd) {
        if (simulateDrop) return controller.error(new Error('simulated upstream interruption'));
        complete = true;
        return controller.close();
      }
      const chunkLength = Math.min(256 * 1024, responseEnd - position + 1);
      const chunk = new Uint8Array(chunkLength);
      chunk.fill(position % 251);
      position += chunkLength;
      producedBytes += chunkLength;
      controller.enqueue(chunk);
    },
    cancel() { complete = true; }
  });
  return new Response(body, { status: match ? 206 : 200, headers: responseHeaders });
};
