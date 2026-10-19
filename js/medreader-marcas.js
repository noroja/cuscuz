/* ==========================================================================
   MEDREADER — Marcações (menu de seleção + histórico)
   - Menu flutuante ao selecionar texto: sublinhar (4 cores), bookmark, anotar,
     buscar a seleção e depositar dúvida.
   - As marcações ficam ancoradas por posição no texto (offsets sobre os nós de texto)
     e também guardam o trecho, para se reencontrar se o texto mudar um pouco.
   - Salva no navegador (localStorage) e sincroniza com o servidor (Supabase) quando disponível.
   ========================================================================== */

const CORES = [
  { id: 'amarelo', rotulo: 'Amarelo' },
  { id: 'verde', rotulo: 'Verde' },
  { id: 'azul', rotulo: 'Azul' },
  { id: 'rosa', rotulo: 'Rosa' },
];
const TIPOS = {
  sublinhar: { icone: 'A', nome: 'Sublinhado' },
  bookmark: { icone: '🔖', nome: 'Bookmark' },
  nota: { icone: '✎', nome: 'Anotação' },
  duvida: { icone: '?', nome: 'Dúvida' },
};
const PREFIXO_LS = 'cuscuz-medreader:marcas:';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class MedReaderMarcas {
  /**
   * @param {object} o
   * @param {HTMLElement} o.shell     elemento que recebe o menu (position: fixed)
   * @param {HTMLElement} o.container área rolável com o conteúdo
   * @param {Function} [o.antesDeAplicar] chamado antes de mexer no DOM (ex.: limpar busca)
   * @param {Function} [o.aoBuscar]   (texto) => void
   * @param {Function} [o.aoFlashcard](marca) => void
   * @param {Function} [o.aviso]      (msg, tipo) => void
   * @param {Function} [o.token]      () => string do Bearer
   */
  constructor(o) {
    this.shell = o.shell;
    this.container = o.container;
    this.antesDeAplicar = o.antesDeAplicar || (() => {});
    this.aoBuscar = o.aoBuscar || (() => {});
    this.aoFlashcard = o.aoFlashcard || (() => {});
    this.aviso = o.aviso || (() => {});
    this.token = o.token || (() => '');
    this.id = null;
    this.marcas = [];
    this.atualizado = 0;
    this.cor = 'amarelo';
    this.alvo = null; // { tipo:'selecao', inicio, fim, trecho } | { tipo:'marca', id }
    this._timerSel = 0;
    this._timerSave = 0;
    this._sujo = false;
    this._montarMenu();
    this._ligarEventos();
  }

  /* ───────── texto e posições ───────── */

  get raiz() { return this.container.querySelector('.medreader-content'); }

  _nos() {
    const raiz = this.raiz;
    if (!raiz) return [];
    const w = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('style,script,noscript')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const lista = [];
    let n;
    while ((n = w.nextNode())) lista.push(n);
    return lista;
  }

  _textoTotal() { return this._nos().map((n) => n.data).join(''); }

  /** Converte um ponto do DOM (nó, deslocamento) no deslocamento dentro do texto total. */
  _deslocamento(no, desl) {
    const ponto = document.createRange();
    ponto.setStart(no, desl);
    ponto.collapse(true);
    let acc = 0;
    for (const t of this._nos()) {
      if (t === no) return acc + desl;
      if (ponto.comparePoint(t, t.length) === -1) { acc += t.length; continue; }
      if (ponto.comparePoint(t, 0) === 1) break;
    }
    return acc;
  }

  _selecaoAtual() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const raiz = this.raiz;
    if (!raiz || !raiz.contains(r.startContainer) || !raiz.contains(r.endContainer)) return null;
    const inicio = this._deslocamento(r.startContainer, r.startOffset);
    const fim = this._deslocamento(r.endContainer, r.endOffset);
    if (fim <= inicio) return null;
    const trecho = this._textoTotal().slice(inicio, fim);
    if (!trecho.trim()) return null;
    return { inicio, fim, trecho, rect: r.getBoundingClientRect() };
  }

  /* ───────── desenhar as marcações no DOM ───────── */

  _desfazer() {
    const raiz = this.raiz;
    if (!raiz) return;
    raiz.querySelectorAll('mark.mr-marca').forEach((m) => {
      const pai = m.parentNode;
      while (m.firstChild) pai.insertBefore(m.firstChild, m);
      pai.removeChild(m);
    });
    raiz.normalize();
  }

  /** Procura onde o trecho está agora: posição guardada, senão a ocorrência mais próxima. */
  _localizar(m, texto) {
    if (texto.slice(m.inicio, m.fim) === m.trecho) return [m.inicio, m.fim];
    let melhor = -1;
    let i = texto.indexOf(m.trecho);
    while (i !== -1) {
      if (melhor === -1 || Math.abs(i - m.inicio) < Math.abs(melhor - m.inicio)) melhor = i;
      i = texto.indexOf(m.trecho, i + 1);
    }
    return melhor === -1 ? null : [melhor, melhor + m.trecho.length];
  }

  /** Redesenha todas as marcações. */
  aplicar() {
    this.antesDeAplicar();
    this._desfazer();
    if (!this.raiz) return;
    const texto = this._textoTotal();
    for (const m of this.marcas) {
      const pos = this._localizar(m, texto);
      m._orfa = !pos;
      if (!pos) continue;
      this._envolver(m, pos[0], pos[1]);
    }
    this._atualizarLista();
  }

  _envolver(m, ini, fim) {
    const partes = [];
    let acc = 0;
    for (const t of this._nos()) {
      const a = acc; const b = acc + t.length;
      acc = b;
      if (b <= ini) continue;
      if (a >= fim) break;
      partes.push({ t, de: Math.max(ini, a) - a, ate: Math.min(fim, b) - a });
    }
    partes.forEach((p, i) => {
      if (p.ate <= p.de) return;
      const el = document.createElement('mark');
      el.className = `mr-marca mr-t-${m.tipo} mr-c-${m.cor}` + (i === 0 ? ' mr-primeira' : '');
      el.dataset.marcaId = m.id;
      if (m.nota) el.title = m.nota;
      const r = document.createRange();
      r.setStart(p.t, p.de);
      r.setEnd(p.t, p.ate);
      r.surroundContents(el);
    });
  }

  /* ───────── criar / alterar / remover ───────── */

  adicionar({ tipo, cor, inicio, fim, trecho, nota }) {
    const agora = Date.now();
    const m = {
      id: 'm' + agora.toString(36) + Math.random().toString(36).slice(2, 7),
      tipo, cor: cor || this.cor, inicio, fim, trecho, nota: nota || '',
      criado: agora, atualizado: agora,
    };
    this.marcas.push(m);
    this._persistir();
    this.aplicar();
    return m;
  }

  remover(id) {
    this.marcas = this.marcas.filter((m) => m.id !== id);
    this._persistir();
    this.aplicar();
  }

  alterar(id, campos) {
    const m = this.marcas.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, campos, { atualizado: Date.now() });
    this._persistir();
    this.aplicar();
  }

  irPara(id) {
    const el = this.container.querySelector(`mark.mr-marca[data-marca-id="${id}"]`);
    if (!el) { this.aviso('Não encontrei este trecho no texto.', 'error'); return false; }
    el.scrollIntoView({ block: 'center' });
    this.container.querySelectorAll(`mark.mr-marca[data-marca-id="${id}"]`).forEach((e) => {
      e.classList.add('mr-pulso');
      setTimeout(() => e.classList.remove('mr-pulso'), 1600);
    });
    return true;
  }

  /* ───────── persistência ───────── */

  _chave() { return PREFIXO_LS + this.id; }

  _lerLocal() {
    try {
      const d = JSON.parse(localStorage.getItem(this._chave()) || 'null');
      if (d && Array.isArray(d.marcas)) return d;
    } catch (_) { /* sem armazenamento, segue */ }
    return { atualizado: 0, marcas: [] };
  }

  _persistir() {
    this.atualizado = Date.now();
    this._sujo = true;
    try {
      localStorage.setItem(this._chave(), JSON.stringify({ atualizado: this.atualizado, marcas: this.marcas.map(this._limpa) }));
    } catch (_) { /* cota cheia: fica só na memória */ }
    clearTimeout(this._timerSave);
    this._timerSave = setTimeout(() => this._enviar(), 800);
  }

  _limpa(m) { const { _orfa, ...resto } = m; return resto; }

  async _enviar() {
    clearTimeout(this._timerSave);
    this._timerSave = 0;
    if (!this.id || !this._sujo) return;
    const id = this.id;
    const corpo = { atualizado: this.atualizado, marcas: this.marcas.map(this._limpa) };
    try {
      const res = await fetch(`/api/medreader/marcas/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token() },
        body: JSON.stringify(corpo),
        keepalive: true,
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.success && id === this.id) this._sujo = false;
    } catch (_) { /* offline: tenta de novo na próxima alteração */ }
  }

  /** Abre as marcações de uma apostila (chamar depois que o conteúdo foi carregado). */
  async abrir(id) {
    this.id = id;
    const local = this._lerLocal();
    this.marcas = local.marcas;
    this.atualizado = local.atualizado;
    this._sujo = false;
    this.aplicar();
    try {
      const res = await fetch(`/api/medreader/marcas/${encodeURIComponent(id)}`, {
        headers: { Authorization: 'Bearer ' + this.token() },
      });
      if (!res.ok) return;
      const j = await res.json();
      if (!j || !j.success || id !== this.id) return;
      const remoto = j.dados;
      if (remoto && Array.isArray(remoto.marcas) && Number(remoto.atualizado) > this.atualizado) {
        this.marcas = remoto.marcas;
        this.atualizado = Number(remoto.atualizado);
        try { localStorage.setItem(this._chave(), JSON.stringify({ atualizado: this.atualizado, marcas: this.marcas })); } catch (_) { /* ok */ }
        this.aplicar();
      } else if (this.marcas.length && this.atualizado > Number(remoto && remoto.atualizado || 0)) {
        this._sujo = true;
        this._enviar();
      }
    } catch (_) { /* sem servidor: só local */ }
  }

  fechar() {
    this._esconderMenu();
    if (this._sujo) this._enviar();
    clearTimeout(this._timerSel);
    this.id = null;
    this.marcas = [];
    this._atualizarLista();
  }

  /* ───────── menu flutuante ───────── */

  _montarMenu() {
    const menu = document.createElement('div');
    menu.id = 'medreader-menu';
    menu.className = 'medreader-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'toolbar');
    menu.setAttribute('aria-label', 'Marcar trecho');
    // não deixa o clique no menu desfazer a seleção do texto
    const segurar = (e) => { if (!e.target.closest('textarea,input')) e.preventDefault(); };
    menu.addEventListener('mousedown', segurar);
    menu.addEventListener('pointerdown', segurar);
    menu.addEventListener('click', (e) => this._cliqueMenu(e));
    this.shell.appendChild(menu);
    this.menu = menu;
  }

  _menuSelecao() {
    const cores = CORES.map((c) =>
      `<button type="button" class="mr-sw mr-c-${c.id}" data-a="cor" data-v="${c.id}" title="Sublinhar (${c.rotulo})" aria-label="Sublinhar em ${c.rotulo}"></button>`).join('');
    return cores +
      '<span class="mr-sep"></span>' +
      '<button type="button" class="mr-b" data-a="bookmark" title="Bookmark">🔖</button>' +
      '<button type="button" class="mr-b" data-a="nota" title="Anotar em texto">✎</button>' +
      '<button type="button" class="mr-b" data-a="buscar" title="Buscar a seleção">🔍</button>' +
      '<button type="button" class="mr-b" data-a="duvida" title="Depositar dúvida">?</button>';
  }

  _menuMarca(m) {
    const cores = CORES.map((c) =>
      `<button type="button" class="mr-sw mr-c-${c.id}${m.cor === c.id ? ' ativo' : ''}" data-a="trocar-cor" data-v="${c.id}" title="${c.rotulo}" aria-label="${c.rotulo}"></button>`).join('');
    return cores +
      '<span class="mr-sep"></span>' +
      '<button type="button" class="mr-b" data-a="editar" title="Editar anotação">✎</button>' +
      '<button type="button" class="mr-b" data-a="flash" title="Criar flashcard">🃏</button>' +
      '<button type="button" class="mr-b perigo" data-a="remover" title="Remover marcação">🗑</button>';
  }

  _menuEditor(rotulo) {
    return `<div class="mr-editor"><label>${esc(rotulo)}</label>` +
      '<textarea rows="3" maxlength="2000" aria-label="' + esc(rotulo) + '"></textarea>' +
      '<div class="mr-editor-acoes"><button type="button" class="mr-b" data-a="cancelar">Cancelar</button>' +
      '<button type="button" class="mr-b primario" data-a="salvar">Salvar</button></div></div>';
  }

  _mostrarMenu(html, rect) {
    this.menu.innerHTML = html;
    this.menu.hidden = false;
    this.menu.style.visibility = 'hidden';
    const mw = this.menu.offsetWidth; const mh = this.menu.offsetHeight;
    const topoMin = 56; // abaixo da barra superior
    let top = rect.top - mh - 8;
    if (top < topoMin) top = Math.min(rect.bottom + 8, window.innerHeight - mh - 8);
    let left = rect.left + rect.width / 2 - mw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    this.menu.style.top = Math.max(topoMin, top) + 'px';
    this.menu.style.left = left + 'px';
    this.menu.style.visibility = '';
  }

  _esconderMenu() {
    if (!this.menu) return;
    this.menu.hidden = true;
    this.menu.innerHTML = '';
    this.alvo = null;
  }

  _editando() { return !this.menu.hidden && !!this.menu.querySelector('textarea'); }

  _aoMudarSelecao() {
    clearTimeout(this._timerSel);
    this._timerSel = setTimeout(() => {
      if (!this.id || this._editando()) return;
      const s = this._selecaoAtual();
      if (!s) {
        if (this.alvo && this.alvo.tipo === 'selecao') this._esconderMenu();
        return;
      }
      this.alvo = { tipo: 'selecao', inicio: s.inicio, fim: s.fim, trecho: s.trecho };
      this._mostrarMenu(this._menuSelecao(), s.rect);
    }, 220);
  }

  _ligarEventos() {
    document.addEventListener('selectionchange', () => { if (this.shell.classList.contains('open')) this._aoMudarSelecao(); });
    this.container.addEventListener('scroll', () => { if (!this._editando()) this._esconderMenu(); }, { passive: true });
    // clique numa marcação existente abre as opções dela
    this.container.addEventListener('click', (e) => {
      const el = e.target.closest && e.target.closest('mark.mr-marca');
      const sel = window.getSelection();
      if (!el || (sel && !sel.isCollapsed)) return;
      const m = this.marcas.find((x) => x.id === el.dataset.marcaId);
      if (!m) return;
      this.alvo = { tipo: 'marca', id: m.id };
      this._mostrarMenu(this._menuMarca(m), el.getBoundingClientRect());
    });
    document.addEventListener('mousedown', (e) => {
      if (this.menu.hidden || this._editando()) return;
      if (!this.menu.contains(e.target) && !e.target.closest('mark.mr-marca')) this._esconderMenu();
    });
  }

  _abrirEditor(rotulo, valor, aoSalvar) {
    const rect = this.menu.getBoundingClientRect();
    this._mostrarMenu(this._menuEditor(rotulo), rect);
    const ta = this.menu.querySelector('textarea');
    ta.value = valor || '';
    this._aoSalvar = aoSalvar;
    setTimeout(() => ta.focus(), 0);
  }

  _cliqueMenu(e) {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    const alvo = this.alvo;
    if (a === 'cancelar') { this._esconderMenu(); return; }
    if (a === 'salvar') {
      const ta = this.menu.querySelector('textarea');
      const fn = this._aoSalvar;
      const texto = ta ? ta.value.trim() : '';
      this._esconderMenu();
      if (fn) fn(texto);
      return;
    }
    if (!alvo) return;

    if (alvo.tipo === 'selecao') {
      const base = { inicio: alvo.inicio, fim: alvo.fim, trecho: alvo.trecho };
      const limpar = () => { const s = window.getSelection(); if (s) s.removeAllRanges(); this._esconderMenu(); };
      if (a === 'cor') { this.cor = b.dataset.v; limpar(); this.adicionar({ ...base, tipo: 'sublinhar', cor: this.cor }); }
      else if (a === 'bookmark') { limpar(); this.adicionar({ ...base, tipo: 'bookmark', cor: this.cor }); this.aviso('Bookmark salvo.'); }
      else if (a === 'buscar') { const t = alvo.trecho; limpar(); this.aoBuscar(t); }
      else if (a === 'nota' || a === 'duvida') {
        const tipo = a;
        this._abrirEditor(tipo === 'nota' ? 'Anotação' : 'Qual é a sua dúvida?', '', (texto) => {
          const s = window.getSelection(); if (s) s.removeAllRanges();
          if (!texto) return;
          this.adicionar({ ...base, tipo, cor: this.cor, nota: texto });
          this.aviso(tipo === 'nota' ? 'Anotação salva.' : 'Dúvida guardada no histórico.');
        });
      }
      return;
    }

    const m = this.marcas.find((x) => x.id === alvo.id);
    if (!m) return;
    if (a === 'trocar-cor') { this._esconderMenu(); this.cor = b.dataset.v; this.alterar(m.id, { cor: b.dataset.v }); }
    else if (a === 'remover') { this._esconderMenu(); this.remover(m.id); }
    else if (a === 'flash') { this._esconderMenu(); this.aoFlashcard(m); }
    else if (a === 'editar') {
      const rotulo = m.tipo === 'duvida' ? 'Qual é a sua dúvida?' : 'Anotação';
      this._abrirEditor(rotulo, m.nota, (texto) => {
        this.alterar(m.id, { nota: texto, tipo: m.tipo === 'sublinhar' && texto ? 'nota' : m.tipo });
      });
    }
  }

  /* ───────── histórico ───────── */

  /** Liga o painel de histórico (um elemento qualquer que receberá a lista). */
  ligarPainel(el) {
    this.painel = el;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-h]');
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.h === 'ir') { if (this.irPara(id) && window.matchMedia('(max-width: 700px)').matches) this.aoIrNoCelular && this.aoIrNoCelular(); }
      else if (b.dataset.h === 'remover') this.remover(id);
      else if (b.dataset.h === 'flash') { const m = this.marcas.find((x) => x.id === id); if (m) this.aoFlashcard(m); }
    });
    this._atualizarLista();
  }

  _atualizarLista() {
    const el = this.painel;
    if (!el) return;
    if (this.onContagem) this.onContagem(this.marcas.length);
    if (!this.marcas.length) {
      el.innerHTML = '<p class="medreader-painel-vazio">Nenhuma marcação ainda. Selecione um trecho do texto para sublinhar, anotar ou guardar uma dúvida.</p>';
      return;
    }
    const ordenadas = [...this.marcas].sort((a, b) => (a.inicio - b.inicio) || (a.criado - b.criado));
    el.innerHTML = ordenadas.map((m) => {
      const t = TIPOS[m.tipo] || TIPOS.sublinhar;
      const trecho = m.trecho.length > 140 ? m.trecho.slice(0, 140).trim() + '…' : m.trecho;
      return `<div class="mr-item${m._orfa ? ' orfa' : ''}">` +
        `<div class="mr-item-cab"><span class="mr-chip mr-c-${esc(m.cor)}">${esc(t.icone)}</span><b>${esc(t.nome)}</b>` +
        (m._orfa ? '<em>trecho não encontrado</em>' : '') + '</div>' +
        `<button type="button" class="mr-item-trecho" data-h="ir" data-id="${esc(m.id)}">${esc(trecho)}</button>` +
        (m.nota ? `<p class="mr-item-nota">${esc(m.nota)}</p>` : '') +
        '<div class="mr-item-acoes">' +
        `<button type="button" class="medreader-btn" data-h="flash" data-id="${esc(m.id)}" title="Criar flashcard">Flashcard</button>` +
        `<button type="button" class="medreader-btn" data-h="remover" data-id="${esc(m.id)}" title="Remover">Remover</button>` +
        '</div></div>';
    }).join('');
  }
}
