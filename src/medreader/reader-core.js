/**
 * MedReader — Leitor de Apostilas
 * Lógica principal de renderização e controle do leitor
 */

class MedReaderCore {
  constructor(options = {}) {
    this.container = options.container || '#medreader-container';
    this.theme = options.theme || 'default';
    this.fontSize = options.fontSize || 'medium';
    this.fontFamily = options.fontFamily || 'sans';
    this.content = '';
    this.isInitialized = false;
    this.annotations = [];

    this._init();
  }

  _init() {
    const container = document.querySelector(this.container);
    if (!container) {
      console.error(`MedReader: Container "${this.container}" não encontrado`);
      return;
    }

    this._applyTheme();
    this._applyFontSettings();
    this.isInitialized = true;
    console.log('MedReader: Inicializado com sucesso');
  }

  _applyTheme() {
    document.body.classList.remove(
      'medreader-theme-default',
      'medreader-theme-sepia',
      'medreader-theme-night'
    );
    document.body.classList.add(`medreader-theme-${this.theme}`);
  }

  _applyFontSettings() {
    document.body.classList.remove(
      'medreader-font-small',
      'medreader-font-medium',
      'medreader-font-large',
      'medreader-font-extra-large',
      'medreader-font-serif',
      'medreader-font-sans',
      'medreader-font-mono'
    );
    document.body.classList.add(`medreader-font-${this.fontSize}`);
    document.body.classList.add(`medreader-font-${this.fontFamily}`);
  }

  loadContent(htmlContent) {
    if (!this.isInitialized) {
      console.error('MedReader: Não inicializado');
      return;
    }

    this.content = htmlContent;
    const container = document.querySelector(this.container);
    container.innerHTML = '';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'medreader-content';
    contentWrapper.innerHTML = htmlContent;

    container.appendChild(contentWrapper);

    this._applyTheme();
    this._applyFontSettings();

    console.log('MedReader: Conteúdo carregado');
  }

  setTheme(theme) {
    this.theme = theme;
    this._applyTheme();
  }

  setFontSize(size) {
    this.fontSize = size;
    this._applyFontSettings();
  }

  setFontFamily(family) {
    this.fontFamily = family;
    this._applyFontSettings();
  }

  addAnnotation(annotation) {
    const anno = {
      id: annotation.id || Date.now().toString(),
      position: annotation.position || 0,
      text: annotation.text || '',
      type: annotation.type || 'note',
      timestamp: annotation.timestamp || new Date().toISOString()
    };
    this.annotations.push(anno);
    this._saveAnnotations();
    return anno;
  }

  removeAnnotation(id) {
    this.annotations = this.annotations.filter(a => a.id !== id);
    this._saveAnnotations();
  }

  getAnnotations() {
    return [...this.annotations];
  }

  _saveAnnotations() {
    try {
      localStorage.setItem('medreader_annotations', JSON.stringify(this.annotations));
    } catch (e) {
      console.warn('MedReader: Não foi possível salvar anotações', e);
    }
  }

  _loadAnnotations() {
    try {
      const stored = localStorage.getItem('medreader_annotations');
      if (stored) {
        this.annotations = JSON.parse(stored);
      }
    } catch (e) {
      console.warn('MedReader: Não foi possível carregar anotações', e);
    }
  }

  getState() {
    return {
      theme: this.theme,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      contentLength: this.content.length,
      annotationsCount: this.annotations.length,
      isInitialized: this.isInitialized
    };
  }

  destroy() {
    const container = document.querySelector(this.container);
    if (container) {
      container.innerHTML = '';
    }
    this.isInitialized = false;
    this.content = '';
    this.annotations = [];
    console.log('MedReader: Destruído');
  }
}

if (typeof window !== 'undefined') {
  window.MedReaderCore = MedReaderCore;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MedReaderCore;
}
