import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const viewerSource = read('js/pdf-viewer.js');
const id1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz_123';
const id2 = '2BcDeFgHiJkLmNoPqRsTuVwXyZa_456';
const ticket1 = '/m/authorizedTicket_1234567890';
const ticket2 = '/m/authorizedTicket_0987654321';

const opened = [];
const originalLocation = { origin: 'https://cuscuz.test', href: 'https://cuscuz.test/index.html#lesson-state' };
const linksWindow = {
  location: originalLocation,
  open(...args) { opened.push(args); return null; }
};
vm.runInNewContext(read('js/pdf-links.js'), { window: linksWindow, URL, URLSearchParams });

const driveUrl = 'https://drive.google.com/file/d/' + id1 + '/view?usp=sharing';
const viewerHref = linksWindow.cuscuzPdfViewerHref(driveUrl, 'Resumo.pdf');
const params = new URLSearchParams(viewerHref.split('#')[1]);
assert.equal(viewerHref.startsWith('/pdf-viewer.html#'), true);
assert.equal(params.get('id'), id1);
assert.equal(params.get('name'), 'Resumo.pdf');

const accessTokenUrl = 'https://www.googleapis.com/drive/v3/files/' + id1 + '?access_token=private-token';
assert.equal(linksWindow.cuscuzPdfViewerHref(accessTokenUrl, 'Apostila.pdf').includes('private-token'), false);
assert.equal(linksWindow.cuscuzPdfViewerHref('/api/drive/pdf/' + id2, 'Resumo 2.pdf').includes(id2), true);
assert.equal(linksWindow.cuscuzPdfViewerHref('javascript:alert(1)'), '');

assert.equal(linksWindow.cuscuzAbrirPdf(id1, 'Resumo.pdf'), true);
assert.equal(linksWindow.cuscuzAbrirPdf(id2, 'Resumo 2.pdf'), true);
assert.equal(opened.length, 2, 'cada clique cria uma guia independente');
assert.equal(opened[0][1], '_blank');
assert.equal(opened[0][2], 'noopener,noreferrer');
assert.notEqual(opened[0][0], opened[1][0]);
assert.equal(originalLocation.href, 'https://cuscuz.test/index.html#lesson-state', 'a guia original não é redirecionada');

async function waitFor(predicate) {
  for (let i = 0; i < 20; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
    if (predicate()) return;
  }
  assert.fail('A visualização do PDF não concluiu no tempo esperado.');
}

async function loadViewer({ id, response, blob, sessionToken = 'session-token' }) {
  const elements = {
    'pdf-title': { textContent: '' },
    'pdf-status': { hidden: false, textContent: 'Verificando seu acesso ao PDF…' },
    'pdf-frame': { hidden: true, src: '', title: '' }
  };
  const document = {
    title: '',
    getElementById(name) { return elements[name]; }
  };
  let ticketRequest = null;
  const window = {
    location: { hash: '#id=' + encodeURIComponent(id) + '&name=Teste.pdf', href: 'https://cuscuz.test/pdf-viewer.html#id=' + id },
    localStorage: { getItem: () => sessionToken },
    addEventListener() {},
    URL: {
      createObjectURL(value) { assert.equal(value, blob); return 'blob:offline-pdf'; },
      revokeObjectURL() {}
    }
  };
  if (blob) {
    window.indexedDB = {
      open(name) {
        assert.equal(name, 'cuscuz_med_storage');
        const request = {};
        queueMicrotask(() => {
          request.result = {
            objectStoreNames: { contains: store => store === 'pinned_pdfs' },
            transaction(store, mode) {
              assert.equal(store, 'pinned_pdfs');
              assert.equal(mode, 'readonly');
              return { objectStore: () => ({
                get(fileId) {
                  assert.equal(fileId, id);
                  const get = {};
                  queueMicrotask(() => { get.result = { blob }; get.onsuccess(); });
                  return get;
                }
              }) };
            },
            close() {}
          };
          request.onsuccess();
        });
        return request;
      }
    };
  }
  window.fetch = async (url, options) => {
    ticketRequest = { url, options };
    if (blob) throw new Error('PDF fixado deveria abrir sem rede.');
    return response;
  };

  vm.runInNewContext(viewerSource, { window, document, URLSearchParams, Blob, Promise, queueMicrotask, console });
  await waitFor(() => elements['pdf-frame'].src || elements['pdf-status'].textContent !== 'Verificando seu acesso ao PDF…');
  return { elements, ticketRequest, window, document };
}

const successResponse = url => ({
  status: 200,
  ok: true,
  async json() { return { url }; }
});
const first = await loadViewer({ id: id1, response: successResponse(ticket1) });
const second = await loadViewer({ id: id2, response: successResponse(ticket2) });
assert.equal(first.ticketRequest.url, '/api/media/ticket');
assert.equal(first.ticketRequest.options.headers.Authorization, 'Bearer session-token');
assert.equal(first.ticketRequest.options.credentials, 'same-origin');
assert.deepEqual(JSON.parse(first.ticketRequest.options.body), { id: id1, kind: 'p' });
assert.equal(first.elements['pdf-frame'].src, ticket1);
assert.equal(second.elements['pdf-frame'].src, ticket2);
assert.notEqual(first.elements['pdf-frame'].src, second.elements['pdf-frame'].src);
assert.equal(first.elements['pdf-status'].hidden, true);

const denied = await loadViewer({ id: id1, response: { status: 401, ok: false } });
assert.match(denied.elements['pdf-status'].textContent, /sessão expirou/);
assert.equal(denied.elements['pdf-frame'].hidden, true);

const cookieSession = await loadViewer({ id: id1, response: successResponse(ticket1), sessionToken: 'cookie-session' });
assert.equal(cookieSession.ticketRequest.options.headers.Authorization, undefined);
assert.equal(cookieSession.ticketRequest.options.credentials, 'same-origin');

const pinnedBlob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
const offline = await loadViewer({ id: id1, blob: pinnedBlob });
assert.equal(offline.elements['pdf-frame'].src, 'blob:offline-pdf');
assert.equal(offline.ticketRequest, null);

const viewerHtml = read('pdf-viewer.html');
const indexHtml = read('index.html');
const lessonHtml = read('aula.html');
const medreader = read('js/medreader-integracao.js');
const appServer = read('server.js');
const auth = read('src/auth-multiuser.js');
const build = read('scripts/build-public.js');

assert.match(viewerHtml, /<iframe[^>]+referrerpolicy="no-referrer"/);
assert.match(indexHtml, /window\.cuscuzPdfViewerHref\(item\.id, item\.title\).*target="_blank" rel="noopener noreferrer"/);
assert.match(indexHtml, /window\.cuscuzAbrirPdf\(item\.id,/);
const legacySearchHandler = indexHtml.slice(indexHtml.indexOf('async function abrirResultadoBuscaGlobal'), indexHtml.indexOf('async function renderResultadoBuscaGlobal'));
assert.match(legacySearchHandler, /if \(\/pdf\/i\.test\(String\(item\.format \|\| ''\)\)\) \{[\s\S]*?window\.cuscuzAbrirPdf\(item\.id, item\.title \|\| 'PDF'\);[\s\S]*?return;[\s\S]*?await acervoSearchCatalog\(\)/);
assert.match(lessonHtml, /window\.cuscuzPdfViewerHref\(m\.id, m\.nome\).*target="_blank" rel="noopener noreferrer"/);
assert.doesNotMatch(lessonHtml, /id="pdf-frame"|\/api\/drive\/pdf\//);
assert.match(medreader, /cuscuzPdfViewerHref\(m\.id,m\.nome\).*target="_blank" rel="noopener noreferrer"/);
assert.match(appServer, /app\.use\('\/api', authMiddleware\)/);
assert.match(appServer, /app\.post\('\/api\/media\/ticket'/);
assert.match(auth, /export function authMiddleware\(req, res, next\)[\s\S]*?validateSession\(token\)/);
assert.match(appServer, /Content-Disposition', 'inline'/);
assert.match(appServer, /Readable\.fromWeb\(up\.resp\.body\)/);
assert.match(build, /'pdf-viewer\.html'/);

console.log('PDF new-tab and authenticated-viewer checks passed.');
