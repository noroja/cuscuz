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
  shell: null,
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

  // Leitor em tela cheia: barra fixa (título + controles) e, abaixo, a área rolável com o texto
  const shell = medreaderCriarShell();
  const container = shell.querySelector('#medreader-container');
  window.medreader.shell = shell;
  window.medreader.container = container;

  // Esc fecha o leitor
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && shell.classList.contains('open')) medreaderFechar();
  });

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

/** Ordem dos temas e tamanhos de fonte usados pelos botões da barra. */
const MEDREADER_TEMAS = ['default', 'sepia', 'night'];
const MEDREADER_FONTES = ['small', 'medium', 'large', 'extra-large'];

// Número do pedido de abertura atual (descarta respostas antigas se o usuário fechar ou abrir outra apostila)
let medreaderPedidoAtual = 0;

/**
 * Cria (uma vez) a estrutura do leitor: barra de controles + container rolável.
 * O container fica dentro do shell porque o MedReaderCore limpa o container a cada loadContent().
 */
function medreaderCriarShell() {
  let shell = document.getElementById('medreader-shell');
  if (shell) return shell;
  shell = document.createElement('div');
  shell.id = 'medreader-shell';
  shell.className = 'medreader-shell';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-label', 'Leitor de apostilas');
  shell.innerHTML =
    '<div class="medreader-toolbar" role="toolbar" aria-label="Controles do leitor">' +
      '<div class="medreader-title" id="medreader-title">Apostila</div>' +
      '<div class="medreader-controls">' +
        '<button type="button" class="medreader-btn" data-mr="fonte-menos" title="Diminuir fonte" aria-label="Diminuir fonte">A\u2212</button>' +
        '<button type="button" class="medreader-btn" data-mr="fonte-mais" title="Aumentar fonte" aria-label="Aumentar fonte">A+</button>' +
        '<button type="button" class="medreader-btn" data-mr="tema" title="Alternar tema" aria-label="Alternar tema">Tema</button>' +
        '<button type="button" class="medreader-btn primary" data-mr="fechar" title="Fechar (Esc)" aria-label="Fechar leitor">\u2715 Fechar</button>' +
      '</div>' +
    '</div>' +
    '<div id="medreader-container" class="medreader-body" tabindex="-1"></div>';
  shell.addEventListener('click', (ev) => {
    const btn = ev.target.closest && ev.target.closest('[data-mr]');
    if (!btn) return;
    const acao = btn.getAttribute('data-mr');
    if (acao === 'fechar') medreaderFechar();
    else if (acao === 'tema') medreaderAlternarTema();
    else if (acao === 'fonte-mais') medreaderAjustarFonte(1);
    else if (acao === 'fonte-menos') medreaderAjustarFonte(-1);
  });
  document.body.appendChild(shell);
  return shell;
}

function medreaderAlternarTema() {
  const core = window.medreader.core;
  if (!core) return;
  const i = MEDREADER_TEMAS.indexOf(core.theme);
  core.setTheme(MEDREADER_TEMAS[(i + 1) % MEDREADER_TEMAS.length]);
}

function medreaderAjustarFonte(delta) {
  const core = window.medreader.core;
  if (!core) return;
  const i = MEDREADER_FONTES.indexOf(core.fontSize);
  const novo = Math.min(MEDREADER_FONTES.length - 1, Math.max(0, (i < 0 ? 1 : i) + delta));
  core.setFontSize(MEDREADER_FONTES[novo]);
}

/**
 * Abre uma apostila (HTML do Drive) no leitor em tela cheia.
 * Mostra a barra com o botão Fechar já durante o carregamento e também se der erro.
 * @param {string} fileId
 * @param {string} fileName
 */
async function medreaderAbrir(fileId, fileName) {
  medreaderInit();

  const { core, container, shell } = window.medreader;
  const tituloEl = document.getElementById('medreader-title');
  if (tituloEl) tituloEl.textContent = fileName || 'Apostila';

  shell.classList.add('open');
  document.body.style.overflow = 'hidden';
  container.innerHTML = '<div class="medreader-estado">Carregando apostila\u2026</div>';
  container.scrollTop = 0;

  const pedido = ++medreaderPedidoAtual;
  try {
    const res = await fetch(`/api/apostila/html/${encodeURIComponent(fileId)}`, {
      headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('cuscuz_token') || '') },
    });
    if (res.status === 401) throw new Error('sess\u00e3o expirada, entre de novo');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (pedido !== medreaderPedidoAtual) return; // fechou ou abriu outra enquanto carregava

    core.loadContent(html);
    container.scrollTop = 0;
    try { container.focus({ preventScroll: true }); } catch (_) { /* sem foco, tudo bem */ }
  } catch (err) {
    if (pedido !== medreaderPedidoAtual) return;
    console.error('[MedReader] Falha ao abrir apostila:', err);
    container.innerHTML = '<div class="medreader-estado erro">N\u00e3o foi poss\u00edvel carregar a apostila (' +
      escapeHtml(err.message) + '). Use \u201cFechar\u201d e tente novamente.</div>';
    medreaderToast(`Erro ao carregar apostila: ${err.message}`, 'error');
  }
}

/** Compatibilidade: nomes antigos chamados pelo index.html. */
async function medreaderOpenOverlay(fileId, fileName) {
  return medreaderAbrir(fileId, fileName);
}

/**
 * Fecha o overlay do MedReader.
 */
function medreaderCloseOverlay() {
  medreaderPedidoAtual++; // cancela qualquer carregamento em andamento
  const shell = window.medreader.shell;
  if (shell) shell.classList.remove('open');
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
 * Abre uma apostila no leitor do MedReader (chamada pela aba Apostilas).
 * @param {string} fileId
 * @param {string} fileName
 */
async function medreaderApostilaInlineOpen(fileId, fileName) {
  return medreaderAbrir(fileId, fileName);
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
window.medreaderAbrir = medreaderAbrir;
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
