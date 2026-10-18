/* ==========================================================================
   CUSCUZ-MED — Aplicação Automática das Correções de Design
   3 Skills: redesign-existing-projects + design-taste-frontend + high-end-visual-design
   
   Carregar APÓS o redesenho-correcoes.css e antes de fechar </body>:
   <script defer src="/js/aplicar-redesign.js"></script>
   
   Este script:
   1. Envolve cards existentes em Double-Bezel (shell + core)
   2. Adiciona classes .reveal nas seções para animação de entrada
   3. Aplica ARIA em componentes que faltam
   4. Não modifica nenhuma funcionalidade existente
   ========================================================================== */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════════
     1. DOUBLE-BEZEL — envolver cards existentes em shell + core
     ═══════════════════════════════════════════════════════════════════════════ */

  const cardSelectors = [
    '.module-card',
    '.content-item',
    '.ac2-card',
    '.ac2-mat-card',
    '.quiz-deck-card',
    '.sim-prova-card',
    '.week-card',
    '.prep-card',
    '.stat',
    '.resume-card',
    '.imp-box',
    '.sim-config-card'
  ];

  function applyDoubleBezel() {
    cardSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(card => {
        // Evita processar duas vezes
        if (card.classList.contains('card-shell-processed')) return;

        // Se o card já tem .card-core direto, pula
        if (card.parentElement && card.parentElement.classList.contains('card-shell')) return;

        const shell = document.createElement('div');
        shell.className = 'card-shell';

        // Move o card para dentro do shell
        card.parentNode.insertBefore(shell, card);
        shell.appendChild(card);

        // Adiciona wrapper .card-core dentro do card (envolve conteúdo existente)
        // Como o card já tem conteúdo direto, envolvemos o innerHTML
        const originalInner = card.innerHTML;
        card.innerHTML = '';
        const core = document.createElement('div');
        core.className = 'card-core';
        core.innerHTML = originalInner;
        card.appendChild(core);

        card.classList.add('card-shell-processed');
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     2. REVEAL — adicionar classe .reveal nas seções para animação de entrada
     ═══════════════════════════════════════════════════════════════════════════ */

  const revealSelectors = [
    '.view-section',
    '.week-card',
    '.module-card',
    '.quiz-deck-card',
    '.sim-prova-card',
    '.prep-card',
    '.content-item',
    '.stat',
    '.resume-card',
    '.imp-box',
    '.sim-config-card',
    '.ac2-card',
    '.ac2-mat-card'
  ];

  function applyReveal() {
    revealSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (!el.classList.contains('reveal')) {
          el.classList.add('reveal');
        }
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     3. ARIA — adicionar atributos faltantes em componentes-chave
     ═══════════════════════════════════════════════════════════════════════════ */

  function applyAria() {
    // Botões de ícone sem aria-label
    document.querySelectorAll('.btn-icon').forEach(btn => {
      if (!btn.getAttribute('aria-label') && !btn.getAttribute('title')) {
        const icon = btn.querySelector('i');
        const iconClass = icon ? icon.className : '';
        let label = 'Botão';
        if (iconClass.includes('ph-list')) label = 'Abrir menu';
        if (iconClass.includes('ph-speaker')) label = 'Controlar áudio';
        if (iconClass.includes('ph-chalkboard')) label = 'Modo apresentação';
        if (iconClass.includes('ph-circle')) label = 'Gravar';
        if (iconClass.includes('ph-chart-donut')) label = 'Painel de métricas';
        if (iconClass.includes('ph-sign-out')) label = 'Sair';
        if (iconClass.includes('ph-pause') || iconClass.includes('ph-play')) label = 'Controlar reprodução';
        btn.setAttribute('aria-label', label);
      }
    });

    // Check buttons — aria-pressed
    document.querySelectorAll('.check-btn').forEach(btn => {
      if (!btn.getAttribute('aria-pressed')) {
        btn.setAttribute('aria-pressed', btn.classList.contains('checked') ? 'true' : 'false');
        btn.setAttribute('aria-label', 'Marcar como concluído');
      }
    });

    // Nav items ativos — aria-current
    document.querySelectorAll('.nav-item.active').forEach(item => {
      item.setAttribute('aria-current', 'page');
    });

    // Quiz options — role="radio" + aria-pressed
    document.querySelectorAll('.quiz-option, .quiz-opt-card').forEach(opt => {
      if (!opt.getAttribute('role')) {
        opt.setAttribute('role', 'radio');
      }
      if (!opt.getAttribute('aria-pressed')) {
        opt.setAttribute('aria-pressed', opt.classList.contains('selected') ? 'true' : 'false');
      }
    });

    // Toasts — role="alert"
    document.querySelectorAll('.toast').forEach(toast => {
      if (!toast.getAttribute('role')) {
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'polite');
      }
    });

    // Modais — role="dialog"
    document.querySelectorAll('.modal-overlay, .apostila-reader-overlay, .reward-overlay').forEach(modal => {
      if (!modal.getAttribute('role')) {
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     4. EXECUÇÃO
     ═══════════════════════════════════════════════════════════════════════════ */

  function init() {
    applyDoubleBezel();
    applyReveal();
    applyAria();
    console.log('[Cuscuz-MED Redesign] Double-Bezel, Reveal e ARIA aplicados.');
  }

  // Executa quando o DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-aplica após navegação SPA (quando views são mostradas/escondidas)
  const originalGo = window.go;
  if (typeof originalGo === 'function') {
    window.go = function (id) {
      originalGo.call(this, id);
      setTimeout(() => {
        applyDoubleBezel();
        applyReveal();
        applyAria();
      }, 50);
    };
  }

})();
