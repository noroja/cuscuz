/**
 * MedReader — Download Service
 * Baixa conteúdo de apostilas de um servidor remoto
 */

class MedReaderDownloadService {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || '';
    this.timeout = options.timeout || 30000;
    this.retryAttempts = options.retryAttempts || 3;
  }

  async downloadMiolo(entityId, options = {}) {
    const url = `${this.baseUrl}/json/Materiais/ApostilaOriginal/IdEntidade/${entityId}`;
    return this._fetchContent(url, options);
  }

  async openApostila(entityId, matricula, options = {}) {
    const produto = options.produto || '';
    const ano = options.ano || '';
    const url = `${this.baseUrl}/V2/Materiais/Apostila/Abertura/IdEntidade/${entityId}/Matricula/${matricula}/?produto=${produto}&ano=${ano}`;
    return this._fetchContent(url, options);
  }

  async getApostila(entityId, matricula) {
    const url = `${this.baseUrl}/json/Materiais/Apostila/IdEntidade/${entityId}/Matricula/${matricula}/versao/0`;
    return this._fetchContent(url);
  }

  async getErratas(apostilaId) {
    const url = `${this.baseUrl}/json/Materiais/Apostila/Addons/IdApostila/${apostilaId}/`;
    return this._fetchContent(url);
  }

  async _fetchContent(url, options = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'text/html, application/json',
            'Accept-Charset': 'utf-8',
            ...options.headers
          },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        let content;

        if (contentType.includes('application/json')) {
          content = await response.json();
        } else {
          content = await response.text();
          if (typeof content === 'string') {
            content = content.replace(/\s\s+/g, ' ');
          }
        }

        return {
          success: true,
          content: content,
          url: url,
          status: response.status
        };

      } catch (err) {
        lastError = err;
        console.warn(`MedReader Download: Tentativa ${attempt} falhou`, err.message);

        if (attempt < this.retryAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    return {
      success: false,
      content: null,
      error: lastError.message || 'Erro desconhecido',
      url: url
    };
  }

  async checkAvailability(url) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch (e) {
      return false;
    }
  }
}

if (typeof window !== 'undefined') {
  window.MedReaderDownloadService = MedReaderDownloadService;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MedReaderDownloadService;
}
