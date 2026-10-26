(function () {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const id = params.get('id') || '';
  const name = params.get('name') || 'PDF · Cuscuz-MED';
  const title = document.getElementById('pdf-title');
  const status = document.getElementById('pdf-status');
  const frame = document.getElementById('pdf-frame');
  let objectUrl = '';

  document.title = name + ' · Cuscuz-MED';
  title.textContent = name;
  frame.title = 'Visualizador de PDF: ' + name;

  function showError(message) {
    frame.hidden = true;
    status.hidden = false;
    status.textContent = message;
  }

  function findPinnedPdf(fileId) {
    if (!window.indexedDB) return Promise.resolve(null);
    return new Promise(resolve => {
      let request;
      try { request = window.indexedDB.open('cuscuz_med_storage'); }
      catch (_) { resolve(null); return; }
      request.onsuccess = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains('pinned_pdfs')) { db.close(); resolve(null); return; }
        try {
          const get = db.transaction('pinned_pdfs', 'readonly').objectStore('pinned_pdfs').get(fileId);
          get.onsuccess = function () {
            const blob = get.result && get.result.blob;
            db.close();
            resolve(blob instanceof Blob ? blob : null);
          };
          get.onerror = function () { db.close(); resolve(null); };
        } catch (_) {
          db.close();
          resolve(null);
        }
      };
      request.onerror = function () { resolve(null); };
    });
  }

  async function loadPdf() {
    if (!/^[A-Za-z0-9_-]{10,120}$/.test(id)) {
      showError('Este link de PDF é inválido. Feche esta guia e tente novamente pela plataforma.');
      return;
    }

    const pinned = await findPinnedPdf(id);
    if (pinned) {
      objectUrl = window.URL.createObjectURL(pinned);
      frame.src = objectUrl;
      frame.hidden = false;
      status.hidden = true;
      return;
    }

    let token = '';
    try { token = window.localStorage.getItem('cuscuz_token') || ''; } catch (_) {}
    const headers = { 'Content-Type': 'application/json' };
    if (token && token !== 'cookie-session') headers.Authorization = 'Bearer ' + token;
    const response = await window.fetch('/api/media/ticket', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ id: id, kind: 'p' })
    });
    if (response.status === 401) {
      showError('Sua sessão expirou. Volte à plataforma, entre novamente e abra o PDF.');
      return;
    }
    if (!response.ok) {
      showError('Este PDF não está disponível para sua conta.');
      return;
    }
    const data = await response.json();
    if (!data || !/^\/m\/[A-Za-z0-9_-]{10,}$/.test(data.url || '')) {
      showError('Não foi possível autorizar a visualização deste PDF.');
      return;
    }

    frame.src = data.url;
    frame.hidden = false;
    status.hidden = true;
  }

  window.addEventListener('pagehide', function () {
    if (objectUrl) window.URL.revokeObjectURL(objectUrl);
  });
  loadPdf().catch(function () {
    showError('Não foi possível carregar este PDF. Feche esta guia e tente novamente pela plataforma.');
  });
})();
