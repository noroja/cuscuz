(function () {
  function viewerHref(source, name) {
    const raw = String(source || '').trim();
    if (!raw) return '';

    const match = raw.match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?[^#]*?id=)|drive\.usercontent\.google\.com\/[^?#]*[?&]id=|googleapis\.com\/drive\/v3\/files\/|\/api\/drive\/pdf\/)([A-Za-z0-9_-]{10,120})/i);
    const id = /^[A-Za-z0-9_-]{10,120}$/.test(raw) ? raw : match && match[1];
    if (id) {
      const params = new URLSearchParams();
      params.set('id', id);
      if (name) params.set('name', String(name));
      return '/pdf-viewer.html#' + params.toString();
    }

    try {
      const url = new URL(raw, window.location.origin);
      return ['https:', 'http:', 'blob:'].includes(url.protocol) ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  window.cuscuzPdfViewerHref = viewerHref;
  window.cuscuzAbrirPdf = function (source, name) {
    const href = viewerHref(source, name);
    if (!href) return false;
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  };
})();
