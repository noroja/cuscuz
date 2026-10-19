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

  // Teclado: Ctrl/Cmd+F abre a busca do leitor; Esc fecha uma camada por vez (busca, índice, leitor)
  document.addEventListener('keydown', (ev) => {
    if (!shell.classList.contains('open')) return;
    if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 'f') {
      ev.preventDefault();
      medreaderBuscaAbrir();
      return;
    }
    if (ev.key !== 'Escape') return;
    if (document.fullscreenElement) return; // o navegador sai da tela cheia primeiro
    const busca = document.getElementById('medreader-busca');
    const painel = document.getElementById('medreader-painel');
    if (busca && !busca.hidden) medreaderBuscaFechar();
    else if (painel && !painel.hidden) medreaderIndiceFechar();
    else medreaderFechar();
  });

  // Progresso de leitura acompanha a rolagem do texto
  container.addEventListener('scroll', medreaderAoRolar, { passive: true });

  // Rótulo do botão de tela cheia
  document.addEventListener('fullscreenchange', () => {
    const t = document.getElementById('medreader-fs-txt');
    if (t) t.textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
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

/** Ícones da barra (SVG simples, herdam a cor do botão). */
const MEDREADER_ICONES = {
  indice: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  busca: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  tela: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>',
};

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
        '<button type="button" class="medreader-btn" data-mr="indice" id="medreader-btn-indice" title="Índice da apostila" aria-label="Índice da apostila" aria-expanded="false">' + MEDREADER_ICONES.indice + '<span class="medreader-btn-txt">Índice</span></button>' +
        '<button type="button" class="medreader-btn" data-mr="busca" title="Busca de texto (Ctrl+F)" aria-label="Busca de texto">' + MEDREADER_ICONES.busca + '<span class="medreader-btn-txt">Buscar</span></button>' +
        '<button type="button" class="medreader-btn" data-mr="fonte-menos" title="Diminuir fonte" aria-label="Diminuir fonte">A\u2212</button>' +
        '<button type="button" class="medreader-btn" data-mr="fonte-mais" title="Aumentar fonte" aria-label="Aumentar fonte">A+</button>' +
        '<button type="button" class="medreader-btn" data-mr="tema" title="Alternar tema" aria-label="Alternar tema">Tema</button>' +
        '<button type="button" class="medreader-btn" data-mr="tela-cheia" id="medreader-btn-tela" title="Tela cheia" aria-label="Tela cheia">' + MEDREADER_ICONES.tela + '<span class="medreader-btn-txt" id="medreader-fs-txt">Tela cheia</span></button>' +
        '<button type="button" class="medreader-btn primary" data-mr="fechar" title="Fechar (Esc)" aria-label="Fechar leitor">\u2715 Fechar</button>' +
      '</div>' +
    '</div>' +
    '<div class="medreader-busca" id="medreader-busca" hidden>' +
      '<input type="search" id="medreader-busca-input" placeholder="Buscar no texto…" aria-label="Buscar no texto" autocomplete="off">' +
      '<span class="medreader-busca-cont" id="medreader-busca-cont" aria-live="polite"></span>' +
      '<button type="button" class="medreader-btn" data-mr="busca-ant" title="Anterior (Shift+Enter)" aria-label="Resultado anterior">↑</button>' +
      '<button type="button" class="medreader-btn" data-mr="busca-prox" title="Próximo (Enter)" aria-label="Próximo resultado">↓</button>' +
      '<button type="button" class="medreader-btn" data-mr="busca-fechar" title="Fechar busca (Esc)" aria-label="Fechar busca">\u2715</button>' +
    '</div>' +
    '<div class="medreader-corpo">' +
      '<div id="medreader-container" class="medreader-body" tabindex="-1"></div>' +
      '<div class="medreader-rodape" id="medreader-rodape">' +
        '<span>Porcentagem lida <b id="medreader-pct">0%</b></span>' +
        '<span>Término estimado <b id="medreader-eta">—</b></span>' +
      '</div>' +
      '<aside class="medreader-painel" id="medreader-painel" aria-label="Índice da apostila" hidden>' +
        '<div class="medreader-painel-cab"><strong>Índice da apostila</strong>' +
          '<button type="button" class="medreader-btn" data-mr="indice-fechar" title="Fechar índice" aria-label="Fechar índice">\u2715</button></div>' +
        '<nav id="medreader-indice"></nav>' +
      '</aside>' +
    '</div>';
  shell.addEventListener('click', (ev) => {
    const btn = ev.target.closest && ev.target.closest('[data-mr]');
    if (!btn) return;
    const acao = btn.getAttribute('data-mr');
    if (acao === 'fechar') medreaderFechar();
    else if (acao === 'tema') medreaderAlternarTema();
    else if (acao === 'fonte-mais') medreaderAjustarFonte(1);
    else if (acao === 'fonte-menos') medreaderAjustarFonte(-1);
    else if (acao === 'indice') medreaderIndiceAlternar();
    else if (acao === 'indice-fechar') medreaderIndiceFechar();
    else if (acao === 'busca') medreaderBuscaAlternar();
    else if (acao === 'busca-ant') medreaderBuscaIr(-1);
    else if (acao === 'busca-prox') medreaderBuscaIr(1);
    else if (acao === 'busca-fechar') medreaderBuscaFechar();
    else if (acao === 'tela-cheia') medreaderTelaCheia();
  });

  // Campo de busca: busca ao digitar (com pequena espera); Enter / Shift+Enter navegam
  const entrada = shell.querySelector('#medreader-busca-input');
  entrada.addEventListener('input', () => {
    clearTimeout(medreaderBuscaEstado.timer);
    medreaderBuscaEstado.timer = setTimeout(() => { medreaderBuscaEstado.timer = 0; medreaderBuscar(entrada.value); }, 150);
  });
  entrada.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    if (medreaderBuscaEstado.timer) { // digitou e apertou Enter antes da espera acabar
      clearTimeout(medreaderBuscaEstado.timer);
      medreaderBuscaEstado.timer = 0;
      medreaderBuscar(entrada.value);
      return;
    }
    medreaderBuscaIr(ev.shiftKey ? -1 : 1);
  });

  // Tela cheia nem sempre existe (ex.: iPhone): some o botão
  if (!(document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
    shell.querySelector('#medreader-btn-tela').hidden = true;
  }

  document.body.appendChild(shell);
  return shell;
}

/* ══════════════ Barra superior: índice, busca, tela cheia e progresso ══════════════ */

const $mr = (id) => document.getElementById(id);
const MEDREADER_PALAVRAS_POR_MIN = 200; // velocidade de leitura usada no "término estimado"

/** Índice da apostila: lista os títulos (h1–h4) e rola até o escolhido. */
function medreaderMontarIndice() {
  const nav = $mr('medreader-indice');
  const container = window.medreader.container;
  if (!nav || !container) return;
  nav.innerHTML = '';
  const titulos = [...container.querySelectorAll('.medreader-content h1, .medreader-content h2, .medreader-content h3, .medreader-content h4')]
    .filter((h) => (h.textContent || '').trim());
  if (!titulos.length) {
    nav.innerHTML = '<p class="medreader-painel-vazio">Esta apostila não tem títulos para montar o índice.</p>';
    return;
  }
  const base = Math.min(...titulos.map((h) => Number(h.tagName[1])));
  const frag = document.createDocumentFragment();
  titulos.forEach((h) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'medreader-indice-item';
    item.style.paddingLeft = (14 + (Number(h.tagName[1]) - base) * 16) + 'px';
    item.textContent = h.textContent.trim().replace(/\s+/g, ' ');
    item.addEventListener('click', () => {
      h.scrollIntoView({ block: 'start' });
      if (window.matchMedia('(max-width: 700px)').matches) medreaderIndiceFechar(); // no celular o painel cobre o texto
    });
    frag.appendChild(item);
  });
  nav.appendChild(frag);
}

function medreaderIndiceAlternar() {
  const painel = $mr('medreader-painel');
  if (!painel) return;
  if (painel.hidden) {
    medreaderMontarIndice();
    painel.hidden = false;
    const b = $mr('medreader-btn-indice'); if (b) b.setAttribute('aria-expanded', 'true');
  } else {
    medreaderIndiceFechar();
  }
}

function medreaderIndiceFechar() {
  const painel = $mr('medreader-painel');
  if (painel) painel.hidden = true;
  const b = $mr('medreader-btn-indice'); if (b) b.setAttribute('aria-expanded', 'false');
}

/** Busca de texto: ignora maiúsculas e acentos, marca os resultados e navega entre eles. */
const medreaderBuscaEstado = { hits: [], atual: -1, timer: 0 };
const MEDREADER_BUSCA_MAX = 500;

// Texto sem acento e em minúsculas, mantendo um mapa 1:1 para a posição original
function medreaderNormalizar(str) {
  let out = '';
  const mapa = [];
  for (let i = 0; i < str.length; i++) {
    const n = str[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (let k = 0; k < n.length; k++) { out += n[k]; mapa.push(i); }
  }
  return { out, mapa };
}

function medreaderTextosDoConteudo(raiz) {
  const walker = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nos = [];
  while (walker.nextNode()) nos.push(walker.currentNode);
  return nos;
}

function medreaderBuscaLimpar() {
  const container = window.medreader.container;
  if (container) {
    container.querySelectorAll('mark.medreader-busca-hit').forEach((m) => {
      const pai = m.parentNode;
      while (m.firstChild) pai.insertBefore(m.firstChild, m);
      pai.removeChild(m);
      pai.normalize();
    });
  }
  medreaderBuscaEstado.hits = [];
  medreaderBuscaEstado.atual = -1;
}

function medreaderBuscar(consulta) {
  medreaderBuscaLimpar();
  const cont = $mr('medreader-busca-cont');
  const container = window.medreader.container;
  if (!cont || !container) return;
  cont.classList.remove('sem');
  const q = medreaderNormalizar(String(consulta || '').trim()).out;
  if (q.length < 2) { cont.textContent = ''; return; }
  const raiz = container.querySelector('.medreader-content');
  if (!raiz) { cont.textContent = ''; return; }

  let total = 0;
  for (const no of medreaderTextosDoConteudo(raiz)) {
    if (total >= MEDREADER_BUSCA_MAX) break;
    const { out, mapa } = medreaderNormalizar(no.nodeValue);
    const partes = [];
    for (let i = out.indexOf(q); i !== -1 && total + partes.length < MEDREADER_BUSCA_MAX; i = out.indexOf(q, i + q.length)) {
      partes.push([mapa[i], mapa[i + q.length - 1] + 1]);
    }
    // marca de trás para frente para não invalidar as posições das ocorrências anteriores
    for (let p = partes.length - 1; p >= 0; p--) {
      const r = document.createRange();
      r.setStart(no, partes[p][0]);
      r.setEnd(no, partes[p][1]);
      const m = document.createElement('mark');
      m.className = 'medreader-busca-hit';
      r.surroundContents(m);
    }
    total += partes.length;
  }

  medreaderBuscaEstado.hits = [...container.querySelectorAll('mark.medreader-busca-hit')];
  if (!medreaderBuscaEstado.hits.length) {
    cont.textContent = '0/0';
    cont.classList.add('sem');
    return;
  }
  medreaderBuscaEstado.atual = -1;
  medreaderBuscaIr(1);
}

function medreaderBuscaIr(delta) {
  const e = medreaderBuscaEstado;
  const cont = $mr('medreader-busca-cont');
  if (!e.hits.length) return;
  if (e.atual >= 0 && e.hits[e.atual]) e.hits[e.atual].classList.remove('atual');
  e.atual = (e.atual + delta + e.hits.length) % e.hits.length;
  const el = e.hits[e.atual];
  el.classList.add('atual');
  el.scrollIntoView({ block: 'center' });
  if (cont) cont.textContent = (e.atual + 1) + '/' + e.hits.length + (e.hits.length >= MEDREADER_BUSCA_MAX ? '+' : '');
}

function medreaderBuscaAbrir() {
  const barra = $mr('medreader-busca');
  const entrada = $mr('medreader-busca-input');
  if (!barra || !entrada) return;
  barra.hidden = false;
  entrada.focus();
  entrada.select();
}

function medreaderBuscaAlternar() {
  const barra = $mr('medreader-busca');
  if (barra && !barra.hidden) medreaderBuscaFechar(); else medreaderBuscaAbrir();
}

function medreaderBuscaFechar() {
  clearTimeout(medreaderBuscaEstado.timer);
  medreaderBuscaEstado.timer = 0;
  medreaderBuscaLimpar();
  const barra = $mr('medreader-busca');
  const entrada = $mr('medreader-busca-input');
  const cont = $mr('medreader-busca-cont');
  if (barra) barra.hidden = true;
  if (entrada) entrada.value = '';
  if (cont) { cont.textContent = ''; cont.classList.remove('sem'); }
  const container = window.medreader.container;
  if (container && $mr('medreader-shell') && $mr('medreader-shell').classList.contains('open')) {
    try { container.focus({ preventScroll: true }); } catch (_) { /* ok */ }
  }
}

/** Tela cheia do leitor (Fullscreen API). */
function medreaderTelaCheia() {
  const shell = window.medreader.shell;
  if (!shell) return;
  if (document.fullscreenElement) {
    const p = document.exitFullscreen && document.exitFullscreen();
    if (p && p.catch) p.catch(() => {});
    return;
  }
  const req = shell.requestFullscreen || shell.webkitRequestFullscreen;
  if (req) {
    const p = req.call(shell);
    if (p && p.catch) p.catch(() => medreaderToast('Não foi possível entrar em tela cheia.', 'error'));
  }
}

/** Progresso de leitura: porcentagem pela rolagem e minutos restantes pelo total de palavras. */
let medreaderRafScroll = 0;
let medreaderTimerPos = 0;

function medreaderContarPalavras(raiz) {
  let n = 0;
  for (const no of medreaderTextosDoConteudo(raiz)) {
    const t = (no.nodeValue || '').trim();
    if (t) n += t.split(/\s+/).length;
  }
  return n;
}

function medreaderFormatarMinutos(min) {
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + ' h' + (m ? ' ' + m + ' min' : '');
}

function medreaderFracaoLida() {
  const c = window.medreader.container;
  if (!c) return 0;
  const max = c.scrollHeight - c.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, c.scrollTop / max)) : 1;
}

function medreaderAtualizarProgresso() {
  const pctEl = $mr('medreader-pct');
  const etaEl = $mr('medreader-eta');
  if (!pctEl || !etaEl) return 0;
  if (!window.medreader.pronto) { pctEl.textContent = '0%'; etaEl.textContent = '—'; return 0; }
  const frac = medreaderFracaoLida();
  pctEl.textContent = Math.round(frac * 100) + '%';
  etaEl.textContent = frac >= 0.995
    ? 'concluída'
    : medreaderFormatarMinutos(Math.ceil((window.medreader.palavras || 0) * (1 - frac) / MEDREADER_PALAVRAS_POR_MIN));
  return frac;
}

function medreaderSalvarPosicao(id, frac) {
  try { localStorage.setItem('cuscuz-medreader:pos:' + id, String(Math.round(frac * 1000) / 1000)); } catch (_) { /* sem storage */ }
}

function medreaderLerPosicao(id) {
  try {
    const v = parseFloat(localStorage.getItem('cuscuz-medreader:pos:' + id));
    return isFinite(v) ? v : 0;
  } catch (_) { return 0; }
}

function medreaderAoRolar() {
  if (medreaderRafScroll) return;
  medreaderRafScroll = requestAnimationFrame(() => {
    medreaderRafScroll = 0;
    const frac = medreaderAtualizarProgresso();
    const id = window.medreader.atualId;
    if (window.medreader.pronto && id) {
      clearTimeout(medreaderTimerPos);
      medreaderTimerPos = setTimeout(() => medreaderSalvarPosicao(id, frac), 400);
    }
  });
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

  window.medreader.pronto = false;
  window.medreader.atualId = fileId;
  window.medreader.palavras = 0;
  medreaderBuscaFechar();
  medreaderIndiceFechar();

  shell.classList.add('open');
  document.body.style.overflow = 'hidden';
  container.innerHTML = '<div class="medreader-estado">Carregando apostila…</div>';
  container.scrollTop = 0;
  medreaderAtualizarProgresso();

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
    const raiz = container.querySelector('.medreader-content');
    window.medreader.palavras = raiz ? medreaderContarPalavras(raiz) : 0;
    window.medreader.pronto = true;

    // Retoma de onde parou (só se não estava no começo nem já terminada)
    const salvo = medreaderLerPosicao(fileId);
    const max = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = (salvo > 0.02 && salvo < 0.98) ? salvo * max : 0;
    medreaderAtualizarProgresso();
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
  // Grava onde parou antes de esconder o leitor (escondido, a altura da área vira 0)
  if (window.medreader.pronto && window.medreader.atualId) {
    clearTimeout(medreaderTimerPos);
    medreaderSalvarPosicao(window.medreader.atualId, medreaderFracaoLida());
  }
  window.medreader.pronto = false;
  medreaderBuscaFechar();
  medreaderIndiceFechar();
  if (document.fullscreenElement) {
    const p = document.exitFullscreen && document.exitFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
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
