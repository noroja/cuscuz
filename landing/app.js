(() => {
  const data = window.CUSCUZ_DATA || {};
  const items = Array.isArray(data.searchItems) ? data.searchItems : [];
  const input = document.getElementById('acervo-search');
  const results = document.getElementById('acervo-results');
  const line = document.querySelector('.search-line');
  const measure = document.querySelector('.measure');
  const caret = document.querySelector('.caret');

  const norm = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  const esc = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  const updateCaret = () => {
    if (!input || !measure || !line) return;
    measure.textContent = input.value || '';
    const textWidth = measure.getBoundingClientRect().width;
    const max = Math.max(0, input.clientWidth - 2);
    line.style.setProperty('--caret-x', `${Math.min(textWidth, max)}px`);
    if (caret) caret.hidden = document.activeElement !== input && input.value === '';
  };

  const render = () => {
    if (!input || !results) return;
    const query = norm(input.value);
    if (!query) {
      results.innerHTML = '<p class="result-more">Digite um tema para ver o acervo responder.</p>';
      return;
    }
    const matches = items.filter((item) => norm(`${item.title} ${item.course}`).includes(query));
    if (!matches.length) {
      results.innerHTML = '<p class="result-more">Nenhum resultado para este tema. Tente outro assunto.</p>';
      return;
    }
    const rows = matches.slice(0, 3).map((item) => `
      <a class="result" href="https://cuscuz-nu.vercel.app/" target="_blank" rel="noopener">
        <span class="result-type">${esc(item.type)}</span>
        <span class="result-title">${esc(item.title)}</span>
        <span class="result-course">${esc(item.course)}</span>
      </a>`).join('');
    const more = matches.length > 3
      ? `<p class="result-more">e mais ${matches.length - 3} resultados no acervo</p>`
      : '';
    results.innerHTML = rows + more;
  };

  if (input) {
    input.addEventListener('input', () => {
      render();
      updateCaret();
    });
    input.addEventListener('focus', updateCaret);
    input.addEventListener('blur', updateCaret);
    render();
    updateCaret();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateCaret);
    window.addEventListener('resize', updateCaret);
  }

  document.querySelectorAll('.example').forEach((button) => {
    button.addEventListener('click', () => {
      if (!input) return;
      input.value = button.dataset.query || '';
      render();
      updateCaret();
      input.focus({ preventScroll: true });
    });
  });

  const stages = [...document.querySelectorAll('.stage')];
  const syncStages = () => {
    stages.forEach((stage) => {
      const open = stage.classList.contains('is-open');
      const tab = stage.querySelector('.stage-tab');
      const body = stage.querySelector('.stage-body');
      if (tab) tab.setAttribute('aria-expanded', String(open));
      if (body) body.setAttribute('aria-hidden', String(!open));
    });
  };
  stages.forEach((stage) => {
    const tab = stage.querySelector('.stage-tab');
    if (!tab) return;
    tab.addEventListener('click', () => {
      stages.forEach((other) => other.classList.remove('is-open'));
      stage.classList.add('is-open');
      syncStages();
    });
  });
  syncStages();

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const videos = [...document.querySelectorAll('video')];
  const syncVideo = () => {
    videos.forEach((video) => {
      if (!reduceMotion.matches) return;
      video.removeAttribute('autoplay');
      video.pause();
    });
  };
  syncVideo();
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', syncVideo);

  const revealSelectors = [
    '.hero-bottom',
    '.search-label', '.search-line', '.results', '.examples',
    '.tile', '.proof-tile',
    '.how-intro h2', '.how-intro p', '.stage',
    '.faq-intro', '.faq-list details',
    '.cta h2', '.cta-bottom',
    '.footer-photo', '.footer-menu'
  ];
  const nodes = [...document.querySelectorAll(revealSelectors.join(','))];
  nodes.forEach((node, index) => {
    node.setAttribute('data-reveal', '');
    node.style.setProperty('--delay', `${(index % 5) * 70}ms`);
  });

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.01 });
    nodes.forEach((node) => observer.observe(node));
  } else {
    nodes.forEach((node) => node.classList.add('is-in'));
  }

  window.setTimeout(() => {
    nodes.forEach((node) => node.classList.add('is-in'));
  }, 5000);
})();
