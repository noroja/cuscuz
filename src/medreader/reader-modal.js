/**
 * MedReader — Welcome Modal
 * Modal de boas-vindas e informações sobre o leitor
 */

class MedReaderModal {
  constructor(options = {}) {
    this.title = options.title || 'Bem vindo ao MedReader';
    this.subtitle = options.subtitle || 'A nova maneira de ler as suas apostilas.';
    this.message = options.message || 'Antes de começarmos, vamos ver algumas informações importantes para seu estudo.';
    this.features = options.features || [];
    this.onClose = options.onClose || (() => {});
    this.autoShow = options.autoShow !== false;

    this.modalElement = null;
    this.isShown = false;
  }

  show() {
    if (this.isShown) return;
    this._createModal();
    this.isShown = true;
  }

  hide() {
    if (!this.isShown) return;
    this._destroyModal();
    this.isShown = false;
    if (typeof this.onClose === 'function') {
      this.onClose();
    }
  }

  _createModal() {
    const existing = document.querySelector('.medreader-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'medreader-modal';
    modal.innerHTML = `
      <div class="medreader-modal-content">
        <h2>${this._escapeHtml(this.title)}</h2>
        <p><strong>${this._escapeHtml(this.subtitle)}</strong></p>
        <p>${this._escapeHtml(this.message)}</p>
        ${this.features.map(f => `
          <p style="margin: 0.5rem 0; display: flex; align-items: center;">
            <span style="margin-right: 0.5rem;">✓</span>
            ${this._escapeHtml(f)}
          </p>
        `).join('')}
        <button class="btn-close" id="medreader-modal-close">Entendi</button>
      </div>
    `;

    document.body.appendChild(modal);

    const btnClose = modal.querySelector('#medreader-modal-close');
    btnClose.addEventListener('click', () => this.hide());

    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.hide();
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        this.hide();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  _destroyModal() {
    const modal = document.querySelector('.medreader-modal');
    if (modal) {
      modal.remove();
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

if (typeof window !== 'undefined') {
  window.MedReaderModal = MedReaderModal;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MedReaderModal;
}
