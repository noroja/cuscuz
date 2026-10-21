/* Vercel Web Interface Guidelines: native links, URL state and focus continuity. */
(function () {
  'use strict';
  const positions = new Map();
  const valid = id => /^view-[a-z-]+$/.test(id) && document.getElementById(id)?.classList.contains('view-section');
  window.cuscuzBeforeNavigate = function () {
    const app = document.getElementById('app-main');
    const main = document.getElementById('main-content');
    if (app?.dataset.view && main) positions.set(app.dataset.view, main.scrollTop);
  };
  window.cuscuzRouteDidChange = function (id, options) {
    options = options || {};
    if (!options.restore) {
      const hash = '#' + id;
      if (location.hash !== hash) history[options.replace ? 'replaceState' : 'pushState']({ studyView: id }, '', hash);
    }
    const main = document.getElementById('main-content');
    if (options.restore && main) main.scrollTop = positions.get(id) || 0;
  };
  window.navigateStudy = function (event, id) {
    if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0)) return true;
    if (!valid(id)) return true;
    event?.preventDefault();
    window.go(id);
    document.getElementById('main-content')?.focus({ preventScroll: true });
    return false;
  };
  function restore() {
    const id = location.hash.slice(1);
    const app = document.getElementById('app-main');
    if (valid(id) && app?.dataset.view && app.dataset.view !== id) window.go(id, { restore: true });
  }
  window.addEventListener('popstate', restore);
  window.addEventListener('hashchange', restore);
})();
