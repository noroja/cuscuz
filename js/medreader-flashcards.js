/* ==========================================================================
   MEDREADER — Flashcards (FlashcardManager, FlashcardReviewModal, Highlighter)
   Dashboard pessoal Cuscuz-MED
   - Criação, listagem, edição, exclusão de flashcards
   - Revisão espaçada (SM-2 simplificado)
   - Modal de revisão com avaliação Difícil/Médio/Fácil
   - Vinculação a destaques no texto (Highlighter)
   - Persistência em localStorage (com fallback)
   - Comentários em português
   ========================================================================== */

const LocalStorageFallback = (() => {
  const store = {};
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  };
})();

function safeLocalStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem) {
      const testKey = '__medreader_fc_ls_test__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return localStorage;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[FlashcardManager] localStorage indisponível, usando fallback em memória:', e.message);
  }
  return LocalStorageFallback;
}

const LS = safeLocalStorage();

/**
 * Calcula a próxima revisão usando SM-2 simplificado.
 * qualidade: 'facil' | 'medio' | 'dificil'
 * @param {object} card - { etapa, intervalo, facilidade, proxima_revisao }
 * @param {string} qualidade
 * @returns {object} { etapa, intervalo, facilidade, proxima_revisao }
 */
function calcularProximaRevisao(card = {}, qualidade) {
  const etapa = Number(card.etapa) || 0;
  let intervalo = Number(card.intervalo) || 1;
  let facilidade = Number(card.facilidade) || 2.5;

  // Qualidade numérica (SM-2): fácil=3, médio=2, difícil=1
  let q;
  switch (qualidade) {
    case 'facil': q = 3; break;
    case 'medio': q = 2; break;
    case 'dificil': q = 1; break;
    default: q = 2; break;
  }

  if (q < 3) {
    // Errou ou lembrou com dificuldade: reinicia etapa e intervalo
    etapa = 1;
    intervalo = 1;
  } else {
    // Acertou: avança etapa
    etapa += 1;
    if (etapa === 1) intervalo = 1;
    else if (etapa === 2) intervalo = 6;
    else intervalo = Math.round(intervalo * facilidade);
  }

  // Ajusta facilidade (EF): EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  facilidade = facilidade + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (facilidade < 1.3) facilidade = 1.3;

  const proxima_revisao = new Date();
  proxima_revisao.setDate(proxima_revisao.getDate() + intervalo);

  return {
    etapa,
    intervalo,
    facilidade: Math.round(facilidade * 100) / 100,
    proxima_revisao: proxima_revisao.toISOString(),
  };
}

/**
 * FlashcardManager — gerencia criação, listagem e revisão de flashcards.
 */
class FlashcardManager {
  constructor(opts = {}) {
    this.storagePrefix = opts.storagePrefix || 'medreader';
    this.flashcards = [];
    this._loadFlashcards();
  }

  _storageKey(sufixo) {
    return `${this.storagePrefix}:flashcards`;
  }

  _loadFlashcards() {
    try {
      const raw = LS.getItem(this._storageKey(''));
      if (raw) {
        const arr = JSON.parse(raw);
        this.flashcards = Array.isArray(arr) ? arr : [];
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[FlashcardManager] Falha ao carregar flashcards:', e.message);
      this.flashcards = [];
    }
  }

  _saveFlashcards() {
    try {
      LS.setItem(this._storageKey(''), JSON.stringify(this.flashcards));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[FlashcardManager] Falha ao salvar flashcards:', e.message);
    }
  }

  _novoId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Cria um flashcard.
   * @param {object} dados
   * @param {string} dados.pergunta
   * @param {string} dados.resposta
   * @param {string} [dados.trecho]
   * @param {string} [dados.posicao]
   * @param {string} [dados.apostilaId]
   * @returns {object} flashcard criado
   */
  create(dados = {}) {
    if (!dados.pergunta || String(dados.pergunta).trim() === '') {
      throw new Error('[FlashcardManager] Pergunta é obrigatória.');
    }
    if (!dados.resposta || String(dados.resposta).trim() === '') {
      throw new Error('[FlashcardManager] Resposta é obrigatória.');
    }

    const card = {
      id: this._novoId(),
      pergunta: String(dados.pergunta).trim(),
      resposta: String(dados.resposta).trim(),
      trecho: dados.trecho ? String(dados.trecho).trim() : '',
      posicao: dados.posicao || null,
      apostilaId: dados.apostilaId || null,
      etapa: 0,
      intervalo: 1,
      facilidade: 2.5,
      proxima_revisao: new Date().toISOString(),
      criadoEm: Date.now(),
      revisadoEm: null,
    };

    this.flashcards.push(card);
    this._saveFlashcards();
    return card;
  }

  /**
   * Atualiza um flashcard existente.
   * @param {string} id
   * @param {object} atualizacoes
   * @returns {object|null}
   */
  update(id, atualizacoes = {}) {
    const idx = this.flashcards.findIndex((c) => c.id === id);
    if (idx === -1) return null;

    const campos = ['pergunta', 'resposta', 'trecho', 'posicao', 'apostilaId'];
    campos.forEach((campo) => {
      if (atualizacoes[campo] !== undefined) {
        this.flashcards[idx][campo] = atualizacoes[campo];
      }
    });

    this._saveFlashcards();
    return this.flashcards[idx];
  }

  /**
   * Remove um flashcard.
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    const idx = this.flashcards.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    this.flashcards.splice(idx, 1);
    this._saveFlashcards();
    return true;
  }

  /**
   * Retorna todos os flashcards.
   * @returns {Array}
   */
  getAll() {
    return [...this.flashcards];
  }

  /**
   * Retorna flashcards de uma apostila específica.
   * @param {string} apostilaId
   * @returns {Array}
   */
  getByApostila(apostilaId) {
    if (!apostilaId) return this.getAll();
    return this.flashcards.filter((c) => c.apostilaId === apostilaId);
  }

  /**
   * Retorna flashcards vencidos para revisão (próxima_revisao <= agora), ordenados
   * pelos mais atrasados primeiro.
   * @returns {Array}
   */
  getDueFlashcards() {
    const agora = new Date();
    return this.flashcards
      .filter((c) => new Date(c.proxima_revisao) <= agora)
      .sort((a, b) => new Date(a.proxima_revisao) - new Date(b.proxima_revisao));
  }

  /**
   * Estatísticas gerais.
   * @returns {object} { total, vencidos, porEtapa }
   */
  stats() {
    const total = this.flashcards.length;
    const vencidos = this.getDueFlashcards().length;
    const porEtapa = {};
    this.flashcards.forEach((c) => {
      porEtapa[c.etapa] = (porEtapa[c.etapa] || 0) + 1;
    });
    return { total, vencidos, porEtapa };
  }

  /**
   * Revisa um flashcard com avaliação do usuário e agenda próxima revisão (SM-2).
   * @param {string} id
   * @param {'facil'|'medio'|'dificil'} qualidade
   * @returns {object|null} flashcard atualizado
   */
  review(id, qualidade) {
    const idx = this.flashcards.findIndex((c) => c.id === id);
    if (idx === -1) return null;

    const nova = calcularProximaRevisao(this.flashcards[idx], qualidade);
    this.flashcards[idx] = {
      ...this.flashcards[idx],
      ...nova,
      revisadoEm: Date.now(),
    };

    this._saveFlashcards();
    return this.flashcards[idx];
  }
}

/**
 * FlashcardReviewModal — injeta e controla o modal de revisão.
 */
class FlashcardReviewModal {
  constructor(opts = {}) {
    this.storagePrefix = opts.storagePrefix || 'medreader';
    this.onReview = opts.onReview || null; // callback(id, qualidade, card)
    this.manager = opts.manager || null;
    this.modalEl = null;
    this._injetarEstilos();
  }

  _injetarEstilos() {
    // Estilos essenciais do modal (sobrescrevem/complementam o CSS se necessário)
    const style = document.createElement('style');
    style.id = 'medreader-review-modal-styles';
    style.textContent = `
      .medreader-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(3, 5, 8, 0.6);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        z-index: 1000;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .medreader-modal-overlay.open { display: flex; }
      .medreader-modal {
        background: var(--bg-surface, #161d2c);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid var(--border-muted, rgba(255,255,255,0.14));
        border-radius: 18px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.55);
        width: 100%;
        max-width: 520px;
        max-height: 85vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        animation: medreaderModalIn 0.25s ease;
      }
      @keyframes medreaderModalIn {
        from { opacity: 0; transform: translateY(16px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .medreader-modal-header {
        padding: 18px 22px;
        border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .medreader-modal-title { font-size: 15px; font-weight: 800; color: var(--text-primary, #f1f5f9); }
      .medreader-modal-close {
        width: 32px; height: 32px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        color: var(--text-muted, #64748b); background: var(--bg-hover, rgba(255,255,255,0.08));
        border: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
        cursor: pointer; transition: transform 0.15s, opacity 0.15s;
      }
      .medreader-modal-close:hover { color: #fb7185; }
      .medreader-modal-body {
        padding: 24px 22px; flex: 1; overflow-y: auto;
        display: flex; flex-direction: column; gap: 18px;
      }
      .medreader-modal-question {
        font-size: 17px; line-height: 1.6;
        color: var(--text-primary, #f1f5f9);
        min-height: 120px; display: flex; align-items: center;
      }
      .medreader-modal-answer {
        display: none;
        font-size: 15px; line-height: 1.6;
        color: var(--text-secondary, #94a3b8);
        background: var(--bg-elevated, rgba(30,40,60,0.75));
        border: 1px solid var(--border-muted, rgba(255,255,255,0.14));
        border-radius: 12px; padding: 16px; margin-top: 8px;
      }
      .medreader-modal-answer.visible { display: block; }
      .medreader-modal-answer b { color: #00d4b8; }
      .medreader-modal-actions {
        display: flex; gap: 10px;
        padding: 16px 22px;
        border-top: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
      }
      .medreader-modal-btn {
        flex: 1; padding: 12px; border-radius: 12px;
        border: 1px solid var(--border-muted, rgba(255,255,255,0.14));
        background: var(--bg-elevated, rgba(30,40,60,0.75));
        color: var(--text-primary, #f1f5f9);
        font-weight: 700; font-size: 13px;
        cursor: pointer; transition: transform 0.15s, opacity 0.15s;
      }
      .medreader-modal-btn.dificil:hover { border-color: #fb7185; color: #fb7185; }
      .medreader-modal-btn.medio:hover { border-color: #fbbf24; color: #fbbf24; }
      .medreader-modal-btn.facil:hover { border-color: #00d4b8; color: #00d4b8; }
      .medreader-modal-footer {
        padding: 12px 22px;
        border-top: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
        display: flex; justify-content: space-between;
        font-size: 11px; color: var(--text-muted, #64748b);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  _criarModal() {
    const overlay = document.createElement('div');
    overlay.className = 'medreader-modal-overlay';
    overlay.innerHTML = `
      <div class="medreader-modal">
        <div class="medreader-modal-header">
          <div class="medreader-modal-title">Revisar Flashcard</div>
          <button type="button" class="medreader-modal-close" aria-label="Fechar revisão de flashcard" onclick="this.closest('.medreader-modal-overlay').classList.remove('open')"><i class="ph ph-x" aria-hidden="true"></i></button>
        </div>
        <div class="medreader-modal-body">
          <div class="medreader-modal-question" id="medreader-modal-pergunta">Carregando...</div>
          <div class="medreader-modal-answer" id="medreader-modal-resposta"></div>
        </div>
        <div class="medreader-modal-actions">
          <button class="medreader-modal-btn dificil" onclick="window.__medreaderReviewQualidade('dificil')">Difícil</button>
          <button class="medreader-modal-btn medio" onclick="window.__medreaderReviewQualidade('medio')">Médio</button>
          <button class="medreader-modal-btn facil" onclick="window.__medreaderReviewQualidade('facil')">Fácil</button>
        </div>
        <div class="medreader-modal-footer">
          <span id="medreader-modal-etapa">Etapa: —</span>
          <span id="medreader-modal-proxima">Próxima: —</span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Fecha ao clicar no backdrop
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('open');
    });

    return overlay;
  }

  /**
   * Abre o modal com um flashcard.
   * @param {object} card
   */
  open(card) {
    if (!card) return;

    if (!this.modalEl) {
      this.modalEl = this._criarModal();
    }

    // Expõe callback global para os botões do modal
    window.__medreaderReviewQualidade = (qualidade) => {
      this.review(qualidade);
    };

    const perguntaEl = this.modalEl.querySelector('#medreader-modal-pergunta');
    const respostaEl = this.modalEl.querySelector('#medreader-modal-resposta');
    const etapaEl = this.modalEl.querySelector('#medreader-modal-etapa');
    const proximaEl = this.modalEl.querySelector('#medreader-modal-proxima');

    perguntaEl.textContent = card.pergunta;
    respostaEl.textContent = card.resposta;
    respostaEl.classList.remove('visible');
    etapaEl.textContent = `Etapa: ${card.etapa}`;
    const proxima = card.proxima_revisao ? new Date(card.proxima_revisao).toLocaleDateString('pt-BR') : '—';
    proximaEl.textContent = `Próxima revisão: ${proxima}`;

    // Guarda referência ao card atual para revisão
    this._cardAtual = card;

    this.modalEl.classList.add('open');
  }

  close() {
    if (this.modalEl) {
      this.modalEl.classList.remove('open');
      this._cardAtual = null;
    }
  }

  /**
   * Processa a avaliação do usuário e agenda próxima revisão.
   * @param {'facil'|'medio'|'dificil'} qualidade
   */
  review(qualidade) {
    if (!this._cardAtual) return;
    const cardAtual = this._cardAtual;

    if (this.manager) {
      this.manager.review(cardAtual.id, qualidade);
    }

    if (typeof this.onReview === 'function') {
      this.onReview(cardAtual.id, qualidade, cardAtual);
    }

    this.close();
  }
}

/**
 * Highlighter — marca trechos de texto e vincula a flashcards/anotações.
 */
class Highlighter {
  constructor(opts = {}) {
    this.container = typeof opts.container === 'string' ? document.querySelector(opts.container) : opts.container || null;
    this.storagePrefix = opts.storagePrefix || 'medreader';
    this.highlights = []; // { id, texto, annotationId, flashcardId, range }
    this._loadHighlights();
  }

  _storageKey(sufixo) {
    return `${this.storagePrefix}:destaques`;
  }

  _loadHighlights() {
    try {
      const raw = LS.getItem(this._storageKey(''));
      if (raw) {
        const arr = JSON.parse(raw);
        this.highlights = Array.isArray(arr) ? arr : [];
      }
    } catch (e) {
      this.highlights = [];
    }
  }

  _saveHighlights() {
    try {
      LS.setItem(this._storageKey(''), JSON.stringify(this.highlights));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Highlighter] Falha ao salvar destaques:', e.message);
    }
  }

  _novoId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Marca um intervalo de texto e opcionalmente vincula a um flashcard/anotação.
   * @param {object} range - { startContainer, startOffset, endContainer, endOffset } (DOM Range serializado)
   * @param {object} [vinculo] - { annotationId, flashcardId, texto }
   * @returns {object|null}
   */
  destacar(range, vinculo = {}) {
    if (!this.container) return null;
    try {
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      const textoSelecionado = r.toString().trim();
      if (!textoSelecionado) return null;

      const span = document.createElement('span');
      span.className = 'medreader-highlight';
      span.textContent = textoSelecionado;
      span.title = 'Destaque vinculado';

      const id = this._novoId();
      span.setAttribute('data-highlight-id', id);
      const highlight = {
        id,
        texto: textoSelecionado,
        annotationId: vinculo.annotationId || null,
        flashcardId: vinculo.flashcardId || null,
        criadoEm: Date.now(),
      };

      r.surroundContents(span);
      this.highlights.push(highlight);
      this._saveHighlights();
      return highlight;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Highlighter] Falha ao destacar:', e.message);
      return null;
    }
  }

  /**
   * Remove um destaque por ID.
   * @param {string} id
   * @returns {boolean}
   */
  remover(id) {
    const idx = this.highlights.findIndex((h) => h.id === id);
    if (idx === -1) return false;
    this.highlights.splice(idx, 1);
    this._saveHighlights();

    // Remove elemento visual correspondente
    if (this.container) {
      const el = this.container.querySelector(`.medreader-highlight[data-highlight-id="${id}"]`);
      if (el) {
        const texto = el.textContent;
        el.replaceWith(document.createTextNode(texto));
      }
    }
    return true;
  }

  getAll() {
    return [...this.highlights];
  }
}

export { FlashcardManager, FlashcardReviewModal, Highlighter, calcularProximaRevisao };
