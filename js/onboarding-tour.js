/* ═════════════════════════════════════════════════════════════════════════════
   ONBOARDING TOUR — Modo Apresentação de Boas-Vindas (Cuscuz-MED)
   ─────────────────────────────────────────────────────────────────────────────
   Vanilla JS, sem dependências. API global: window.CuscuzTour
     .start({ force: true })   → inicia (força mesmo quando já visto)
     .stop()                   → cancela e fecha
     .reset()                  → apaga localStorage (hasSeenTour)
     .onAppReady()             → hook chamado pelo index.html após login/startApp
   ═════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Configuração ─────────────────────────────────────────────────────────── */
  var LSK = 'hasSeenTour';               // chave de first-access (especificação)
  var AUTO_DELAY_MS = 2000;              // 2s após carregar
  var RETRY_INTERVAL_MS = 1200;          // esperas até o app estiver pronto
  var RETRY_MAX = 30;

  /* ── ROTEIRO DO TOUR (state machine) ────────────────────────────────────────
     target: ID/classe do elemento existente (fallback: passo centralizado)
     placement: lado preferido da caixa (right|left|bottom|top|center)          */
  var STEP_DEFAULTS = [
    {
      title: 'Bem-vindo ao Cuscuz-MED',
      text: 'Aqui é a sua área de domínio. Use este tour rápido para conhecer os 5 passos principais da plataforma. Leva menos de 1 minuto.',
      placement: 'center'
    },
    {
      target: '.sidebar',
      title: 'Menu de Navegação',
      text: 'Acesse o seu cronograma gerado por IA, as aulas teóricas, simulados e desempenho por aqui.',
      placement: 'right'
    },
    {
      target: '#ac2-player',
      title: 'Player Principal',
      text: 'Assista às aulas em vídeo com controles próprios (velocidade, buffer inteligente) e materiais sincronizados na mesma tela.',
      placement: 'bottom',
      go: 'view-acervo'
    },
    {
      target: '#ac2-praticar-wrap',
      title: 'Fixação',
      text: 'Treino ativo: logo abaixo da aula, pratique questões sobre o tema assistido — é o que fixa de verdade.',
      placement: 'bottom',
      go: 'view-acervo'
    },
    {
      title: 'Sua rotina de estudos',
      text: 'Volte ao Meu plano para continuar seu próximo estudo. No calendário, acompanhe suas provas e os blocos da semana.',
      target: '.sidebar [data-view="view-planneria"]',
      placement: 'left'
    }
  ];

  /* ── Estado interno ───────────────────────────────────────────────────────── */
  var idx = -1;              // passo atual
  var steps = [];            // roteiro resolvido (defaults + custom)
  var root, mask, spot, dlg; // nós do DOM
  var isOpen = false;
  var rafPending = false;

  /* ── Utilidades ───────────────────────────────────────────────────────────── */
  function $(sel, r) { return (r || document).querySelector(sel); }
  function seen() { try { return localStorage.getItem(LSK) === '1'; } catch (e) { return false; } }
  function markSeen() { try { localStorage.setItem(LSK, '1'); } catch (e) {} }
  function logged() { try { return localStorage.getItem('medplan_logged') === '1'; } catch (e) { return false; } }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var css = getComputedStyle(el);
    return css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0';
  }

  /* --- Construção do DOM uma única vez (root isolado) ------------------------ */
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'ct-root';
    root.setAttribute('role', 'presentation');
    root.style.display = 'none';
    root.innerHTML =
      '<div class="ct-mask"></div>' +
      '<div class="ct-spot ct-spot-hidden"></div>' +
      '<div class="ct-dialog" role="dialog" aria-modal="true" aria-live="polite">' +
      '  <span class="ct-kicker">Tutor IA</span>' +
      '  <h3 class="ct-title"></h3>' +
      '  <p class="ct-text"></p>' +
      '  <div class="ct-progress">' +
      '    <div class="ct-dots"></div>' +
      '    <span class="ct-step-counter"></span>' +
      '  </div>' +
      '  <div class="ct-buttons">' +
      '    <button class="ct-btn ct-btn-ghost ct-btn-skip">Pular Tutorial</button>' +
      '    <span class="ct-btn-spacer"></span>' +
      '    <button class="ct-btn ct-btn-ghost ct-btn-prev" style="display:none">Voltar</button>' +
      '    <button class="ct-btn ct-btn-primary ct-btn-next">Próximo</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(root);
    mask = $('.ct-mask', root);
    spot = $('.ct-spot', root);
    dlg = $('.ct-dialog', root);
    $('.ct-btn-skip', dlg).addEventListener('click', function () { stop(); });
    $('.ct-btn-prev', dlg).addEventListener('click', function () { goStep(idx - 1); });
    $('.ct-btn-next', dlg).addEventListener('click', function () {
      if (idx >= steps.length - 1) stop(); else goStep(idx + 1);
    });
    window.addEventListener('resize', onRelayout, true);
    window.addEventListener('scroll', onRelayout, true);
  }

  function onRelayout() {
    if (!isOpen || rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; if (isOpen) renderStep(); });
  }

  /* --- Resolve o alvo de um passo --------------------------------------------- */
  function resolveTarget(st) {
    if (!st.target) return null;                       // passo sem alvo
    if (st.go && typeof window.go === 'function') {    // navegar antes (view SPA)
      try { window.go(st.go); } catch (e) {}
    }
    // Alvo pode ser seletor único ou lista de candidatos
    var candidates = typeof st.target === 'string' ? [st.target] : st.target;
    for (var i = 0; i < candidates.length; i++) {
      var el = $(candidates[i]);
      if (visible(el)) return el;
    }
    return null; // não existe/oculto → dialog centralizado
  }

  // Reaproveita chamado pelo render (resolved em onEnter para aguardar navegação)
  function measureTarget(st) {
    var el = resolveTarget(st);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return {
      top: r.top - 8, left: r.left - 8,
      width: r.width + 16, height: r.height + 16,
      radius: 14
    };
  }

  /* --- Render do passo corrente ------------------------------------------------ */
  function renderStep() {
    var st = steps[idx];
    var box = measureTarget(st);
    var vw = window.innerWidth, vh = window.innerHeight;

    // 1) Spotlight
    if (box) {
      spot.className = 'ct-spot';
      spot.style.top = box.top + 'px';
      spot.style.left = box.left + 'px';
      spot.style.width = box.width + 'px';
      spot.style.height = box.height + 'px';
      spot.style.borderRadius = box.radius + 'px';
    } else {
      spot.className = 'ct-spot ct-spot-hidden';
    }

    // 2) Conteúdo do dialog
    $('.ct-title', dlg).textContent = st.title || '';
    $('.ct-text', dlg).textContent = st.text || '';
    $('.ct-step-counter', dlg).textContent = 'Passo ' + (idx + 1) + ' de ' + steps.length;
    $('.ct-btn-prev', dlg).style.display = idx > 0 ? '' : 'none';
    $('.ct-btn-next', dlg).textContent = idx >= steps.length - 1 ? 'Começar agora' : 'Próximo';

    // dots clicáveis
    var dots = $('.ct-dots', dlg);
    dots.innerHTML = '';
    steps.forEach(function (_, i) {
      var d = document.createElement('button');
      d.className = 'ct-dot' + (i === idx ? ' ct-dot-active' : '');
      d.title = 'Passo ' + (i + 1);
      d.addEventListener('click', function () { goStep(i); });
      dots.appendChild(d);
    });

    // 3) Posição do dialog
    var place = box ? (st.placement || 'auto') : 'center';
    if (vw < 760) place = 'center';
    positionDialog(place, box, vw, vh);
  }

  function positionDialog(place, box, vw, vh) {
    dlg.classList.toggle('ct-dialog-centered', place === 'center');
    if (place === 'center') return;              // CSS centraliza

    var dw = dlg.offsetWidth || 340;
    var dh = dlg.offsetHeight || 220;
    var PAD = 16;
    var anchor, left, top;

    if (place === 'auto') {
      var below = box ? (vh - (box.top + box.height)) : 0;
      var hasBelow = box && below >= dh + PAD;
      var rightSp = box ? (vw - (box.left + box.width)) : 0;
      place = hasBelow ? 'bottom' : (rightSp >= dw + PAD ? 'right' : (box.left >= dw + PAD ? 'left' : 'bottom'));
    }
    switch (place) {
      case 'bottom': left = box.left + box.width / 2 - dw / 2; top = box.top + box.height + 14; break;
      case 'top':    left = box.left + box.width / 2 - dw / 2; top = box.top - dh - 14; break;
      case 'right':  left = box.left + box.width + 14; top = box.top + Math.min(box.height, dh) / 2 - dh / 2; break;
      default: /* left */ left = box.left - dw - 14; top = box.top + Math.min(box.height, dh) / 2 - dh / 2;
    }
    left = Math.max(PAD, Math.min(left, vw - dw - PAD));
    top = Math.max(PAD, Math.min(top, vh - dh - PAD));
    dlg.style.left = left + 'px';
    dlg.style.top = top + 'px';
  }

  /* --- State machine ------------------------------------------------------------ */
  function goStep(nextIdx) {
    if (nextIdx < 0 || nextIdx >= steps.length) return;
    idx = nextIdx;
    var st = steps[idx];
    // onEnter assíncrono (navegação de view SPA movimenta o DOM) → 1 frame depois
    if (st.go) {
      setTimeout(renderStep, 420);   // espera a transição da view
      renderStep();                  // primeira medida (fallback centro)
    } else {
      renderStep();
    }
  }

  function start(opts) {
    opts = opts || {};
    if (!opts.force && seen()) return;   // já viu o tour
    build();
    steps = STEP_DEFAULTS;
    isOpen = true;
    idx = -1;
    root.style.display = '';
    document.body.classList.add('ct-active');
    dlg.style.left = ''; dlg.style.top = '';
    goStep(0);
    // A11y: foco no primeiro botão para navegação por teclado
    setTimeout(function () { $('.ct-btn-next', dlg) && $('.ct-btn-next', dlg).focus(); }, 50);
  }

  function stop() {
    if (!isOpen) return;
    isOpen = false;
    idx = -1;
    if (root) root.style.display = 'none';
    document.body.classList.remove('ct-active');
    markSeen();
    try { document.dispatchEvent(new CustomEvent('cuscuz-tour:ended')); } catch (e) {}
  }

  function reset() { try { localStorage.removeItem(LSK); } catch (e) {} }

  /* ── Acionamento automático (First-Time User) ──────────────────────────────── */
  function onAppReady() {
    // movimenta assim que a plataforma estiver pronta (login/startApp)
    if (!logged()) return;
    setTimeout(function () {
      var n = 0;
      (function tick() {
        if (isOpen) return;
        var sidebar =$('.sidebar');
        var login = $('#login-screen');
        var pronto = visible(sidebar) && (!login || getComputedStyle(login).display === 'none');
        if (pronto && !seen()) return start();
        if (!seen() && ++n < RETRY_MAX) setTimeout(tick, RETRY_INTERVAL_MS);
      })();
    }, AUTO_DELAY_MS);
  }

  /* ── Menu: injeta o item "Tutorial da Plataforma" na sidebar ───────────────── */
  function injectMenuItem() {
    try {
      var scrollEl = $('.sidebar-scroll');
      if (!scrollEl || $('.nav-item[data-tour-trigger]')) return;
      var last = scrollEl.querySelector('.nav-item:last-of-type');
      var item = document.createElement('div');
      item.className = 'nav-item';
      item.setAttribute('data-tour-trigger', '');
      item.setAttribute('data-tooltip', 'Tutorial da Plataforma');
      item.innerHTML = '<i class="ph ph-map-trifold"></i>' +
        '<span class="nav-text">Tutorial da Plataforma</span>' +
        '<div class="nav-tooltip">Tutorial da Plataforma</div>';
      item.addEventListener('click', function () { start({ force: true }); });
      if (last && last.parentNode) last.parentNode.insertBefore(item, last.nextSibling);
      else scrollEl.appendChild(item);
    } catch (e) { /* nunca derruba o app por causa do tour */ }
  }

  /* ── Teclado: Esc pula · → próximo · ← volta ── */
  document.addEventListener('keydown', function (e) {
    if (!isOpen) return;
    if (e.key === 'Escape') stop();
    else if (e.key === 'ArrowRight') goStep(idx + 1);
    else if (e.key === 'ArrowLeft') goStep(idx - 1);
  });

  /* ── Boot ──────────────────────────────────────────────────────────────────── */
  function boot() {
    injectMenuItem();
    if (seen()) return;               // jáassistiu → não agenda nada
    var timer = setInterval(function () {
      if (seen()) return clearInterval(timer);
      if (logged() && visible($('.sidebar'))) {
        clearInterval(timer);
        onAppReady();
      }
    }, RETRY_INTERVAL_MS);
    // também retorna após load puro (caso o usuário entre sem login → hook login)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ── API pública ───────────────────────────────────────────────────────────── */
  window.CuscuzTour = { start: start, stop: stop, reset: reset, onAppReady: onAppReady };
})();
