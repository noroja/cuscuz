/* ==========================================================================
   MEDREADER — Integração com o dashboard Cuscuz-MED
   - Ponte entre o MedReader (css/medreader.css, js/medreader-*.js) e o index.html
   - Filtra materiais (PDFs + Apostilas) por aula atual (AC2.atualId)
   - Inicializa MedReaderCore, FlashcardManager, FlashcardReviewModal, Highlighter, FlashcardExport
   - Comentários em português
   ========================================================================== */

import { MedReaderCore } from './medreader-core.js';
import { FlashcardManager, FlashcardReviewModal, Highlighter } from './medreader-flashcards.js';
import { FlashcardExport } from './medreader-export.js';

// Estado global da integração MedReader
window.medreader = {
  core: null,
  manager: null,
  modal: null,
  highlighter: null,
  exportador: null,
  container: null,
  overlay: null,
  inicializado: false,
};

/**
 * Inicializa o MedReader (uma única vez).
 * Cria o container, instancia as classes e monta o overlay/inline se necessário.
 */
function medreaderInit() {
  if (window.medreader.inicializado) return;

  // Container principal do leitor (usado pelo modo inline dentro da aba Apostilas)
  let container = document.getElementById('medreader-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'medreader-container';
    container.className = 'medreader-body';
    container.style.display = 'none';
    container.style.position = 'fixed';
    container.style.inset = '0';
    container.style.zIndex = '59';
    container.style.background = 'var(--bg-void, #07090e)';
    document.body.appendChild(container);
  }
  window.medreader.container = container;

  // Instancia classes do MedReader
  window.medreader.core = new MedReaderCore({
    container,
    theme: 'default',
    fontSize: 'medium',
    fontFamily: 'sans',
    storagePrefix: 'cuscuz-medreader',
  });

  window.medreader.manager = new FlashcardManager({ storagePrefix: 'cuscuz-medreader' });

  window.medreader.modal = new FlashcardReviewModal({
    storagePrefix: 'cuscuz-medreader',
    manager: window.medreader.manager,
    onReview: (id, qualidade, card) => {
      medreaderToast(`Flashcard revisado: ${qualidade} (etapa ${card.etapa})`);
    },
  });

  window.medreader.highlighter = new Highlighter({
    container,
    storagePrefix: 'cuscuz-medreader',
  });

  window.medreader.exportador = new FlashcardExport();

  window.medreader.inicializado = true;
  medreaderToast('MedReader inicializado.');
}

/**
 * Abre o MedReader em overlay fullscreen (modo tela cheia) para uma apostila.
 * Reutiliza o endpoint existente /api/apostila/html/:id.
 * @param {string} fileId
 * @param {string} fileName
 */
async function medreaderOpenOverlay(fileId, fileName) {
  medreaderInit();

  const core = window.medreader.core;
  const container = window.medreader.container;

  // Busca o HTML processado do backend (reutiliza endpoint existente)
  try {
    const res = await fetch(`/api/apostila/html/${encodeURIComponent(fileId)}`, {
      headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('cuscuz_token') || '') },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    core.loadContent(html);

    // Mostra overlay
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    document.body.style.overflow = 'hidden';

    // Atualiza título se houver elemento no DOM existente
    const titleEl = document.getElementById('apostila-reader-title');
    if (titleEl) titleEl.textContent = fileName || 'Apostila';

    medreaderToast(`Apostila "${fileName}" carregada no MedReader.`);
  } catch (err) {
    console.error('[MedReader] Falha ao abrir overlay:', err);
    medreaderToast(`Erro ao carregar apostila: ${err.message}`, 'error');
  }
}

/**
 * Fecha o overlay do MedReader.
 */
function medreaderCloseOverlay() {
  const container = window.medreader.container;
  if (container) {
    container.style.display = 'none';
  }
  document.body.style.overflow = '';
}

/**
 * Carrega os materiais (PDFs + Apostilas) de uma macroárea/disciplina no MedReader.
 * Apostilas são organizadas por macroárea (Pediatria, Cirurgia, etc.), não por aula individual.
 * @param {object} aula - { id, curso, disc, titulo, materiais?: Array }
 */
function medreaderCarregarMateriaisDaAula(aula) {
  if (!aula || !aula.id) {
    medreaderToast('Aula inválida para carregar materiais.', 'error');
    return;
  }

  const boxPdf = document.getElementById('ac2-materiais-pdf');
  const boxApo = document.getElementById('ac2-materiais-apostila');
  const badge = document.getElementById('ac2-mat-badge');

  if (!boxPdf || !boxApo || !badge) return;

  // Limpa conteúdos anteriores
  boxPdf.innerHTML = '';
  boxApo.innerHTML = '';

  // Busca materiais da aula (backend deve suportar ?aula=)
  const materiais = medreaderBuscarMateriaisDaAula(aula.id, aula.curso, aula.disc);

  // Separa PDFs de Apostilas
  const pdfs = [];
  const apostilas = [];

  (materiais || []).forEach((m) => {
    const nome = String(m.nome || '');
    const isApostila = m.isHtml === true || /^(html|htm)$/i.test(nome.split('.').pop() || '');
    const entry = {
      id: m.id,
      nome: nome.endsWith('.pdf') || nome.endsWith('.html') || nome.endsWith('.htm') ? nome : nome + '.pdf',
      sub: 'Material da aula: ' + (m.aulaNome || aula.titulo),
      url: m.url || '',
      isHtml: isApostila,
      aulaId: m.aulaId || aula.id,
    };
    if (isApostila) apostilas.push(entry);
    else pdfs.push(entry);
  });

  // Renderiza PDFs
  if (boxPdf) {
    if (pdfs.length) {
      boxPdf.innerHTML = pdfs.map((m) =>
        `<a class="material-chip" href="#" onclick="event.preventDefault(); cuscuzAbrirPdf('${escapeHtml(m.id)}');return false" title="Abrir ${escapeHtml(m.nome)}">
          <span class="pdf-icon"><i class="ph ph-file-pdf"></i></span>
          <div class="mat-info">
            <span class="mat-title">${escapeHtml(m.nome)}</span>
            <span class="mat-sub">${escapeHtml(m.sub)}</span>
          </div>
          <i class="ph ph-download-simple mat-dl" title="Baixar"></i>
        </a>`
      ).join('');
    } else {
      boxPdf.innerHTML = '<span style="font-size:13px;color:var(--text-muted);padding:20px;display:block">Nenhum PDF disponível para esta aula</span>';
    }
  }

  // Renderiza Apostilas
  if (boxApo) {
    if (apostilas.length) {
      boxApo.innerHTML = apostilas.map((m) =>
        `<div class="material-chip" style="cursor:pointer" onclick="medreaderApostilaInlineOpen('${escapeHtml(m.id)}', '${escapeHtml(m.nome)}')" title="Ler ${escapeHtml(m.nome)}">
          <span class="pdf-icon" style="background:rgba(99,102,241,.14);color:#6366f1"><i class="ph ph-book-open"></i></span>
          <div class="mat-info">
            <span class="mat-title">${escapeHtml(m.nome)}</span>
            <span class="mat-sub">Apostila - ${escapeHtml(m.aulaNome || aula.titulo)}</span>
          </div>
          <i class="ph ph-arrow-right mat-dl" style="color:var(--teal)"></i>
        </div>`
      ).join('');
    } else {
      boxApo.innerHTML = '<span style="font-size:13px;color:var(--text-muted);padding:20px;display:block">Nenhuma apostila disponível para esta aula</span>';
    }
  }

  // Atualiza contador
  const total = pdfs.length + apostilas.length;
  if (badge) {
    badge.textContent = total + (total === 1 ? ' arquivo disponível' : ' arquivos disponíveis') + ' (macroárea)';
  }
}

/**
 * Abre uma apostila no leitor inline do MedReader (dentro da aba Apostilas).
 * @param {string} fileId
 * @param {string} fileName
 */
async function medreaderApostilaInlineOpen(fileId, fileName) {
  medreaderInit();

  const core = window.medreader.core;
  const container = window.medreader.container;

  // Mostra container do MedReader (modo inline/fullscreen temporário)
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  document.body.style.overflow = 'hidden';

  try {
    const res = await fetch(`/api/apostila/html/${encodeURIComponent(fileId)}`, {
      headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('cuscuz_token') || '') },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    core.loadContent(html);

    // Atualiza título do leitor inline se existir
    const titleEl = document.getElementById('apostila-inline-title');
    if (titleEl) titleEl.textContent = fileName || 'Apostila';

    medreaderToast(`Apostila "${fileName}" aberta no MedReader.`);
  } catch (err) {
    console.error('[MedReader] Falha ao abrir apostila inline:', err);
    medreaderToast(`Erro ao carregar apostila: ${err.message}`, 'error');
  }
}

/**
 * Busca materiais de uma aula no backend.
 * Tenta /api/drive/materials?aula=... primeiro; se não suportar, filtra localmente.
 * @param {string} aulaId
 * @param {string} curso
 * @param {string} disc
 * @returns {Promise<Array>}
 */
async function medreaderBuscarMateriaisDaAula(aulaId, curso, disc) {
  try {
    const res = await fetch(
      `/api/drive/materials?course=${encodeURIComponent(curso || '')}&disc=${encodeURIComponent(disc || '')}`,
      { cache: 'no-cache' }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.materials && Array.isArray(data.materials)) {
        return data.materials;
      }
    }
  } catch (e) {
    console.warn('[MedReader] Falha ao buscar materiais no backend:', e.message);
  }

  // Fallback: retorna vazio. Apostilas são organizadas por macroárea/disciplina (curso+disc),
  // não por aula individual, então não há filtro por aulaId necessário.
  return [];
}

/**
 * Exporta flashcards da aula atual (abre escolha TXT/CSV).
 */
function medreaderExportarFlashcards() {
  const manager = window.medreader.manager;
  const exportador = window.medreader.exportador;
  if (!manager || !exportador) return;

  const cards = manager.getAll();
  if (cards.length === 0) {
    medreaderToast('Nenhum flashcard para exportar.', 'error');
    return;
  }

  const formato = prompt('Escolha o formato: 1 = TXT, 2 = CSV');
  if (formato === '1') {
    exportador.setFlashcards(cards);
    exportador.downloadText();
    medreaderToast('TXT baixado com sucesso.');
  } else if (formato === '2') {
    exportador.setFlashcards(cards);
    exportador.downloadCSV();
    medreaderToast('CSV baixado com sucesso.');
  } else {
    medreaderToast('Exportação cancelada.');
  }
}

/**
 * Cria um flashcard rápido a partir da seleção atual de texto no MedReader.
 */
function medreaderCriarFlashcardDaSelecao() {
  const core = window.medreader.core;
  const manager = window.medreader.manager;
  if (!core || !manager) return;

  const sel = window.getSelection();
  const texto = sel.toString().trim();
  if (!texto) {
    medreaderToast('Selecione um trecho do texto primeiro.', 'error');
    return;
  }

  const pergunta = prompt('Pergunta do flashcard:', texto);
  if (!pergunta) return;
  const resposta = prompt('Resposta do flashcard:');
  if (!resposta) return;

  try {
    const card = manager.create({
      pergunta,
      resposta,
      trecho: texto,
      apostilaId: 'aula-atual',
    });
    medreaderToast(`Flashcard criado (etapa ${card.etapa}).`);
  } catch (e) {
    medreaderToast(e.message, 'error');
  }
}

/**
 * Fecha o MedReader (overlay ou container).
 */
function medreaderFechar() {
  medreaderCloseOverlay();
  if (window.medreader.modal) window.medreader.modal.close();
}

/**
 * Toast simples para notificações.
 * @param {string} msg
 * @param {string} tipo
 */
function medreaderToast(msg, tipo = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + tipo;
  t.textContent = msg;
  t.style.position = 'fixed';
  t.style.bottom = '24px';
  t.style.right = '24px';
  t.style.padding = '10px 16px';
  t.style.borderRadius = '10px';
  t.style.background = 'rgba(15,23,42,0.95)';
  t.style.border = '1px solid var(--border-muted, rgba(255,255,255,0.14))';
  t.style.color = '#fff';
  t.style.fontSize = '13px';
  t.style.zIndex = '2000';
  t.style.boxShadow = 'var(--shadow-glass, 0 8px 32px rgba(0,0,0,0.37))';
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, 2500);
}

/**
 * Escapa HTML para evitar injeção.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Expor funções globalmente para uso no HTML existente (onclick)
window.medreaderOpenOverlay = medreaderOpenOverlay;
window.medreaderCloseOverlay = medreaderCloseOverlay;
window.medreaderCarregarMateriaisDaAula = medreaderCarregarMateriaisDaAula;
window.medreaderApostilaInlineOpen = medreaderApostilaInlineOpen;
window.medreaderExportarFlashcards = medreaderExportarFlashcards;
window.medreaderCriarFlashcardDaSelecao = medreaderCriarFlashcardDaSelecao;
window.medreaderFechar = medreaderFechar;
window.medreaderInit = medreaderInit;

// Inicializa automaticamente quando o DOM estiver pronto
document.addEventListener('DOMContentLoaded', () => {
  // Pequeno atraso para garantir que o index.html do Cuscuz já carregou suas variáveis
  setTimeout(medreaderInit, 500);
});
