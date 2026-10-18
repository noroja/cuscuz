/**
 * MedReader — Integration Helper
 * Ajuda a integrar o MedReader em sua plataforma existente
 */

class MedReaderIntegration {
  constructor(reader, downloader, modal) {
    this.reader = reader;
    this.downloader = downloader;
    this.modal = modal;
  }

  async init(options = {}) {
    if (options.showWelcome !== false && this.modal) {
      this.modal.show();
    }

    if (options.entityId) {
      await this.loadEntity(options.entityId, options.matricula);
    }
  }

  async loadEntity(entityId, matricula) {
    try {
      const result = await this.downloader.downloadMiolo(entityId);

      if (result.success) {
        this.reader.loadContent(result.content);
        return { success: true, content: result.content };
      } else {
        console.error('MedReader: Falha ao carregar apostila', result.error);
        return { success: false, error: result.error };
      }
    } catch (err) {
      console.error('MedReader: Erro ao carregar entidade', err);
      return { success: false, error: err.message };
    }
  }

  applyUserConfig(config) {
    if (config.theme) this.reader.setTheme(config.theme);
    if (config.fontSize) this.reader.setFontSize(config.fontSize);
    if (config.fontFamily) this.reader.setFontFamily(config.fontFamily);
  }

  saveUserConfig(config) {
    try {
      localStorage.setItem('medreader_config', JSON.stringify(config));
    } catch (e) {
      console.warn('MedReader: Não foi possível salvar configurações', e);
    }
  }

  loadUserConfig() {
    try {
      const stored = localStorage.getItem('medreader_config');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.warn('MedReader: Não foi possível carregar configurações', e);
    }
    return null;
  }
}

if (typeof window !== 'undefined') {
  window.MedReaderIntegration = MedReaderIntegration;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MedReaderIntegration;
}
