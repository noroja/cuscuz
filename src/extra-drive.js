/* ═══════════════════════════════════════════════════════════════════════════════
   EXTRA-DRIVE v2 — Sincronização INCREMENTAL via Google Drive Changes API
   ─────────────────────────────────────────────────────────────────────────────
   FLUXO:
     1) Full Sync (1ª vez, sem token)     → varredura recursiva (files.list)
     2) Guarda o StartPageToken           → drive.changes.getStartPageToken
     3) Ciclos seguintes (Δ 30 min)       → drive.changes.list (Delta Sync),
                                            processa SÓ as mudanças
     4) Token expirado (410/404)          → fallback automático para Full Sync

   PERSISTÊNCIA (Railway Volume /app/data/):
     /app/data/acervo-manifest.json  → catálogo completo gerado
     /app/data/sync-token.json       → StartPageToken da Changes API
   No boot lê os dois e JÁ FAZ apenas Delta Sync (pula a varredura do zero).
   Fallback de disco: data/ local (efêmero) quando o volume não estiver montado.
   ═══════════════════════════════════════════════════════════════════════════════ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { temConta, emailConta, driveFetch } from './drive-auth.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = (process.env.DRIVE_API_BASE || 'https://www.googleapis.com').replace(/\/$/, '');
const VIDEO = /\.(mp4|webm|mkv|mov|avi|m4v|wmv|flv|mpg|mpeg|3gp)$/i, DOC = /\.(pdf|docx?|pptx?|xlsx?|txt)$/i;
const limpa = n => String(n || '').replace(/(\.(mp4|webm|mkv|mov|avi|pdf|docx?|pptx?|xlsx?|txt))+$/gi, '').trim();

// ID padrão removido — deve vir da variável de ambiente GOOGLE_DRIVE_FOLDER_ID
export const ROOT_PADRAO = '';
const idDe = x => (String(x || '').match(/[-\w]{25,}/) || [''])[0];
export const MAIN_ID = () => idDe(process.env.GOOGLE_DRIVE_FOLDER_ID) || ROOT_PADRAO;
/* Se a pasta principal (GOOGLE_DRIVE_FOLDER_ID) for a antiga, vale o catálogo fixo + extras.
   Senão, o acervo inteiro é gerado ao vivo dela (Full Sync → Delta Sync). */
export const USA_BASE = () => MAIN_ID() === ROOT_PADRAO;
export const EXTRA_IDS = () => [...new Set(String(process.env.GOOGLE_DRIVE_EXTRA_FOLDERS || '').split(/[,\s]+/).map(idDe).filter(Boolean))].filter(id => id !== MAIN_ID());

export const STATUS = { running: false, at: null, erro: '', pastas: 0, videos: 0, materiais: 0, falhas: 0, modo: '' };

/* ── PERSISTÊNCIA DE ESTADO (Anti-Zero) ───────────────────────────────────────
   Volume persistente do Railway montado em /app/data → sobrevive a deploys.   */
function detectarVolume() {
  const unix = process.platform !== 'win32';
  const candidatos = unix ? ['/app/data', '/data'] : [];
  candidatos.push(path.join(__dirname, '..', 'data'));
  for (const d of candidatos) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) {}
  }
  return path.join(__dirname, '..', 'data');
}
export const VOLUME_DIR = detectarVolume();
export const CATALOG_FILE = path.join(VOLUME_DIR, 'acervo-manifest.json'); // catálogo gerado
export const TOKEN_FILE = path.join(VOLUME_DIR, 'sync-token.json');        // StartPageToken

/* Catálogo em memória (carregado do volume no boot; enriquecido na varredura).
   folders: { id: { name, parent } } → mapa da árvore p/ recriar caminhos no Delta. */
let CAT = { generatedAt: null, roots: [], videos: [], materials: [], folders: {} };
let TOKEN = null;
let MEMLEGADO = null; // catálogo antigo (modo "catálogo fixo + extras")

/* Lê volume no boot: se existem catálogo + token → PULA a varredura do zero */
export function carregarEstado() {
  try {
    const salvo = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    if (salvo && (salvo.videos || []).length + (salvo.materials || []).length > 0) {
      CAT = { generatedAt: salvo.generatedAt || null, roots: salvo.roots || [], videos: salvo.videos || [], materials: salvo.materials || [], folders: salvo.folders || {} };
      console.log(`📦 [Acervo] Catálogo restaurado do volume: ${CAT.videos.length} vídeos, ${CAT.materials.length} materiais (gerado em ${CAT.generatedAt || '?'})`);
    }
  } catch (e) { /* sem catálogo salvo → vai de Full Sync */ }
  try {
    const tk = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (tk && tk.pageToken) { TOKEN = tk.pageToken; console.log('🔑 [Acervo] StartPageToken restaurado do volume — a próxima rodada é Delta Sync.'); }
  } catch (e) { /* sem token → Full Sync */ }
  return { restaurado: !!TOKEN || !!CAT.generatedAt, modo: TOKEN ? 'delta-pronto' : (CAT.generatedAt ? 'full-pronto' : 'vazio') };
}
carregarEstado(); // roda no import: o 1º request já tem dados (se houver volume)

function salvarEstado() {
  CAT.generatedAt = CAT.generatedAt || new Date().toISOString();
  try {
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(CAT)); // compacto: nó grande
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ pageToken: TOKEN, savedAt: new Date().toISOString() }));
  } catch (e) { console.warn('⚠️ [Acervo] Falha ao persistir estado:', e.message); }
}

/* Ler manifest antigo (modo legado: catálogo fixo + pastas extras) */
export const EXTRA_FILE = path.join(__dirname, '..', 'data', 'extra-manifest.json');
function lerLegado() {
  if (MEMLEGADO) return MEMLEGADO;
  try { MEMLEGADO = JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8')); } catch (_) { return { videos: [], materials: [], roots: [] }; }
  return MEMLEGADO;
}
export function lerExtra() {
  if (USA_BASE()) return lerLegado();
  return CAT;
}
/* Snapshot do catálogo persistido (útil p/ o server servir direto do volume) */
export function getCatalogoSalvo() { return USA_BASE() ? lerLegado() : CAT; }

/* ═══ TRANSPORTE HTTP (retry/quota) ═══════════════════════════════════════════ */
async function get(url, tent = 6) {
  for (let i = 1; i <= tent; i++) {
    try {
      const r = await driveFetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 900 * i * i)); continue; }
      if (!r.ok) {
        const corpo = await r.text().catch(() => '');
        let hint = '';
        if (r.status === 400) hint = 'chave do Drive inválida (GOOGLE_DRIVE_API_KEY)';
        else if (r.status === 403) hint = /referer|ip address|blocked/i.test(corpo) ? 'a chave tem restrição de site/IP — no Google Cloud deixe "Restrições de aplicativo: Nenhuma"' : /disabled|not been used|accessNotConfigured/i.test(corpo) ? 'a Google Drive API não está ativada para essa chave' : /quota|rate/i.test(corpo) ? 'cota da chave esgotada — aumente EXTRA_SCAN_S' : (temConta() ? 'sem permissão — compartilhe a pasta (Leitor) com ' + emailConta() + ' e ative a Google Drive API no projeto' : 'sem permissão (pasta privada ou chave sem acesso à Drive API)');
        else if (r.status === 404) hint = temConta() ? 'pasta não encontrada — compartilhe a pasta (Leitor) com ' + emailConta() : 'pasta não encontrada ou privada — compartilhe como "qualquer pessoa com o link" ou use uma conta de serviço';
        const e = new Error('Drive ' + r.status + (hint ? ': ' + hint : '')); e.fatal = r.status < 500 && r.status !== 429 && !(r.status === 403 && /rate|quota|limit/i.test(corpo)); e.status = r.status; throw e;
      }
      return await r.json();
    } catch (e) { if (i === tent || e.fatal) throw e; await new Promise(s => setTimeout(s, 900 * i * i)); }
  }
}

async function filhos(id, key) {
  const todos = []; let tok = '';
  do {
    const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
    const d = await get(`${API}/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,shortcutDetails)&orderBy=folder,name_natural&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${tok ? '&pageToken=' + encodeURIComponent(tok) : ''}`);
    todos.push(...(d.files || [])); tok = d.nextPageToken || '';
  } while (tok);
  return todos;
}

/* ═══ RESOLUÇÃO DE CAMINHO (p/ registros do Delta) ═════════════════════════════
   Sobe a árvore de pais usando o mapa CAT.folders; pais desconhecidos são
   resolvidos com 1 files.get e ficam cacheados (custo único).                  */
function limpaParte(n) { return String(n || '').trim(); }
async function nomeDe(folderId) {
  const noh = CAT.folders[folderId];
  if (noh && noh.name) return noh;
  try {
    const meta = await get(`${API}/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    CAT.folders[folderId] = { name: limpaParte(meta.name), parent: null };
    return CAT.folders[folderId];
  } catch (e) { return null; }
}
async function partesDe(parentIds, nomeArquivo) {
  const chain = [];
  let cur = (parentIds && parentIds[0]) || '';
  const visitado = new Set();
  while (cur && cur !== MAIN_ID() && !visitado.has(cur) && visitado.size < 24) {
    visitado.add(cur);
    const noh = await nomeDe(cur);
    if (!noh || !noh.name) break;                 // desconhecido/sem acesso → para
    chain.unshift(noh.name);                      // nome do nível mais alto vai pra frente
    if (!noh.parent || noh.parent === '__EXTRA__') break; // topo conhecido / raiz de pasta extra
    cur = noh.parent;
  }
  const partes = chain.map(limpaParte).filter(Boolean);
  if (!partes.length) return { course: 'Geral', path: String(nomeArquivo || '') };
  return { course: partes[0], path: [...partes, String(nomeArquivo || '')].join(' / ') };
}

/* ═══ APLICAÇÃO DE CADA MUDANÇA (Delta Sync) ═══════════════════════════════════ */
function removerRegistro(id) { if (!id) return; CAT.videos = CAT.videos.filter(v => v.id !== id); CAT.materials = CAT.materials.filter(m => m.id !== id); }
function removerSubtree(folderId) {
  // coleta descendentes via ligação parent→filho do mapa da árvore e apaga registros apontando p/ eles
  const apagar = new Set([folderId]);
  let cresceu = true;
  while (cresceu) {
    cresceu = false;
    for (const [fid, noh] of Object.entries(CAT.folders)) {
      if (noh && noh.parent && apagar.has(noh.parent) && !apagar.has(fid)) { apagar.add(fid); cresceu = true; }
    }
  }
  for (const fid of apagar) delete CAT.folders[fid];
  CAT.videos = CAT.videos.filter(v => !apagar.has(v.pid));
  CAT.materials = CAT.materials.filter(m => !apagar.has(m.pid));
}
async function aplicarMudanca(ch) {
  const removido = ch.removed || !ch.file;
  if (removido) {
    removerRegistro(ch.fileId);
    if (CAT.folders[ch.fileId]) removerSubtree(ch.fileId);
    return;
  }
  const f = ch.file;
  const ehAtalho = !!(f.shortcutDetails && f.shortcutDetails.targetId);
  const alvoId = ehAtalho ? f.shortcutDetails.targetId : f.id;
  const mime = ehAtalho ? (f.shortcutDetails && f.shortcutDetails.targetMimeType) : f.mimeType;
  const nome = String(f.name || '');

  if (f.trashed) { // lixeira → remove registro (folha ou subárvore)
    removerRegistro(alvoId);
    if (CAT.folders[alvoId]) removerSubtree(alvoId);
    return;
  }
  if (mime === 'application/vnd.google-apps.folder') {
    removerRegistro(alvoId);
    if (ehAtalho) { // atalho p/ pasta: registra a pasta com o nome do atalho; sem pai, sem raiz
      CAT.folders[alvoId] = { name: limpa(nome), parent: null };
      if ((f.parents && f.parents[0]) === MAIN_ID()) CAT.roots.push({ id: alvoId, name: limpa(nome) });
      return;
    }
    CAT.folders[alvoId] = { name: limpa(nome), parent: (f.parents && f.parents[0]) || null };
    if ((f.parents && f.parents[0]) === MAIN_ID() && !CAT.roots.some(r => r.id === alvoId)) {
      CAT.roots.push({ id: alvoId, name: limpa(nome) });
    }
    return;
  }
  // Arquivo novo/modificado → ressincroniza só ele
  removerRegistro(alvoId);
  const { course, path } = await partesDe(f.parents, limpa(nome));
  const reg = { d: nome, t: limpa(nome), id: alvoId, course, path, pid: (f.parents && f.parents[0]) || null };
  if (/^video\//.test(mime || '') || VIDEO.test(nome)) CAT.videos.push(reg);
  else if (/pdf|document|presentation|spreadsheet|text/.test(mime || '') || DOC.test(nome)) CAT.materials.push(reg);
}

/* ═══ GOOGLE DRIVE CHANGES API — PONTO DE INJEÇÃO do Delta Sync ═════════════════
   Em vez de varrer tudo (files.list recursivo), o ciclo correto usa:
     • getStartPageToken() → token de referência da primeira sincronização
     • changes.list(pageToken) → SOMENTE o que mudou desde a última âncora (token)
   ═══════════════════════════════════════════════════════════════════════════════ */
async function getStartPageToken() {
  // drive.changes.getStartPageToken — âncora p/ Delta Sync
  const d = await get(`${API}/drive/v3/changes/startPageToken?supportsAllDrives=true&includeItemsFromAllDrives=true`);
  TOKEN = d.startPageToken;
  return TOKEN;
}
async function deltaSync(key) {
  if (STATUS.running) return null;
  STATUS.running = true;
  const t0 = Date.now();
  let tok = TOKEN, novoToken = null, processadas = 0;
  try {
    while (tok) {
      const campos = 'nextPageToken,newStartPageToken,changes(fileId,trashed,removed,file(id,name,mimeType,parents,shortcutDetails))';
      const d = await get(`${API}/drive/v3/changes?pageToken=${encodeURIComponent(tok)}&includeRemoved=true&restrictToMyDrive=false&spaces=drive&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=${encodeURIComponent(campos)}`);
      for (const ch of (d.changes || [])) { await aplicarMudanca(ch); processadas++; }
      if (d.newStartPageToken) { novoToken = d.newStartPageToken; break; }
      tok = d.nextPageToken || '';
    }
    if (novoToken) TOKEN = novoToken;        // avança a âncora p/ próximo delta
    STATUS.at = new Date().toISOString(); Object.assign(STATUS, { modo: 'delta', erro: '' });
    salvarEstado();
    console.log(`🔄 [Acervo] Delta Sync OK: ${processadas} mudança(s) em ${((Date.now() - t0) / 1000).toFixed(1)}s → ${CAT.videos.length} vídeos, ${CAT.materials.length} materiais`);
    return { videos: CAT.videos.length, materials: CAT.materials.length, mudancas: processadas, modo: 'delta' };
  } catch (e) {
    /* Fallback e Resiliência: token expirado/invalidado (410 Gone, 404) →
       descarta a âncora e refaz Full Sync automaticamente, gravando o novo token. */
    if (/Drive (410|404)/i.test(String(e.message)) || ['404', '410'].includes(String(e.status))) {
      console.warn('♻️ [Acervo] StartPageToken inválido — refazendo Full Sync de segurança:', e.message);
      TOKEN = null; salvarEstado();
      return await varrerFull(key);
    }
    STATUS.erro = String(e.message || e).slice(0, 260);
    console.warn('⚠️ [Acervo] Delta falhou (estado preservado, retry no próximo ciclo):', e.message);
    return null; // erro transitório: estado e token continuam válidos
  } finally { STATUS.running = false; }
}

/* ═══ FULL SYNC (varredura completa — só no 1º boot ou quando o token expira) ══ */
async function varrerFull(key) {
  const t0 = Date.now();
  STATUS.running = true; STATUS.erro = ''; STATUS.pastas = 0;
  try {
    const videos = [], materials = [], roots = [];
    const folders = {}; // id → { name, parent } — árvore reconstruída (usada pelo Delta)
    const alvos = [];
    // 1) Pastas de 1º nível do Drive principal viram cursos; arquivos na raiz → 'Geral'
    const itensRaiz = await filhos(MAIN_ID(), key);
    // Diagnóstico: mostra qual pasta a conta de serviço está enxergando
    try {
      const raiz = await get(`${API}/drive/v3/files/${encodeURIComponent(MAIN_ID())}?fields=id,name,mimeType&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      STATUS.raiz = { id: MAIN_ID(), name: raiz.name || '', mimeType: raiz.mimeType || '' };
      console.log(`📘 [Acervo] Pasta raiz configurada: "${raiz.name}" (${MAIN_ID()}) → ${itensRaiz.length} item(ns) no 1º nível`);
      if (!itensRaiz.length) console.warn(`⚠️ [Acervo] A pasta "${raiz.name}" está VAZIA para a conta ${temConta() ? emailConta() : 'da chave de API'}. Verifique: (1) se este é o ID da pasta certa no Railway, (2) se os cursos estão mesmo dentro dela, (3) se ela é um atalho para o conteúdo real.`);
    } catch (e) { STATUS.raiz = { id: MAIN_ID(), name: '', mimeType: '', erro: String(e.message || e).slice(0, 120) }; }
    for (const it of itensRaiz) {
      const alvoId = it.shortcutDetails && it.shortcutDetails.targetId || it.id;
      const mime = it.shortcutDetails && it.shortcutDetails.targetMimeType || it.mimeType;
      if (mime === 'application/vnd.google-apps.folder') {
        alvos.push({ rid: alvoId, curso: limpa(it.name.trim()) });
        folders[alvoId] = { name: limpa(it.name), parent: idDe(process.env.GOOGLE_DRIVE_FOLDER_ID) };
      } else {
        const reg = { d: it.name, t: limpa(it.name), id: alvoId, course: 'Geral', path: 'Geral / ' + it.name, pid: MAIN_ID() };
        if (/^video\//.test(mime || '') || VIDEO.test(it.name)) videos.push(reg); else if (/pdf|document|presentation|spreadsheet|text/.test(mime || '') || DOC.test(it.name)) materials.push(reg);
      }
    }
    // 2) Pastas extras (GOOGLE_DRIVE_EXTRA_FOLDERS), se houver, entram como cursos próprios
    for (const rid of EXTRA_IDS()) {
      const meta = await get(`${API}/drive/v3/files/${rid}?fields=id,name&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      alvos.push({ rid, curso: limpa(meta.name) || 'Extra' });
      folders[rid] = { name: limpa(meta.name) || 'Extra', parent: '__EXTRA__' };
    }
    // 3) Crawl em largura (10 pastas em paralelo), reconstruindo a árvore em `folders`
    const falhas = [];
    for (const { rid, curso } of alvos) {
      roots.push({ id: rid, name: curso });
      const fila = [{ id: rid, partes: [curso], pid: null }]; let tentativas = 0;
      while (fila.length) {
        const lote = fila.splice(0, 10);
        const res = await Promise.all(lote.map(async f => ({ f, itens: await filhos(f.id, key).catch(e => { STATUS.erro = String(e.message).slice(0, 100); falhas.push(f); return []; }) })));
        for (const { f, itens } of res) for (const it of itens) {
          const alvoId = it.shortcutDetails && it.shortcutDetails.targetId || it.id;
          const mime = it.shortcutDetails && it.shortcutDetails.targetMimeType || it.mimeType;
          if (mime === 'application/vnd.google-apps.folder') {
            folders[alvoId] = { name: limpaParte(it.name), parent: f.id };
            fila.push({ id: alvoId, partes: [...f.partes, it.name.trim()], pid: f.id }); STATUS.pastas++;
            continue;
          }
          const reg = { d: it.name, t: limpa(it.name), id: alvoId, course: curso, path: [...f.partes, it.name].join(' / '), pid: f.id };
          if (/^video\//.test(mime || '') || VIDEO.test(it.name)) videos.push(reg);
          else if (/pdf|document|presentation|spreadsheet|text/.test(mime || '') || DOC.test(it.name)) materials.push(reg);
        }
        Object.assign(STATUS, { videos: videos.length, materiais: materials.length });
        // pastas que falharam (limite do Google etc.) voltam pro fim da fila, até 4×
        if (!fila.length && falhas.length && tentativas++ < 4) { await new Promise(s => setTimeout(s, 2500)); fila.push(...falhas.splice(0)); }
      }
    }
    // 4) Commit do catálogo + primeiro token de âncora da Changes API
    const pronto = { generatedAt: new Date().toISOString(), roots, videos, materials, folders };

    CAT = pronto;
    try { await getStartPageToken(); salvarEstado(); } // ⬅ CHANGES API injetada aqui (âncora p/ deltas)
    catch (e) { console.warn('⚠️ [Acervo] Sem token de changes (fará Full sempre):', e.message); salvarEstado(); }
    STATUS.at = new Date().toISOString(); Object.assign(STATUS, { modo: 'full', erro: '' });
    console.log(`✅ [Acervo] Full Sync: ${videos.length} vídeos, ${materials.length} materiais, ${roots.length} cursos em ${((Date.now() - t0) / 1000).toFixed(0)}s. Delta Sync ativo.`);
    return { videos: videos.length, materials: materials.length, mudancas: 0, modo: 'full' };
  } catch (e) {
    STATUS.erro = String(e.message || e).slice(0, 260);
    return null;
  } finally { STATUS.running = false; }
}

/* ═══ MODO LEGADO (catálogo fixo + pastas extras, quando a pasta é a antiga) ═══ */
async function varrerLegado(key) {
  if (STATUS.running) return null;
  STATUS.running = true; STATUS.erro = ''; STATUS.pastas = 0;
  const videos = [], materials = [], roots = [];
  const tinha = !!(lerLegado().videos.length || lerLegado().materials.length);
  const falhas = []; const antes = lerLegado();
  try {
    const alvos = [];
    for (const rid of EXTRA_IDS()) { const meta = await get(`${API}/drive/v3/files/${rid}?fields=id,name&supportsAllDrives=true&includeItemsFromAllDrives=true`); alvos.push({ rid, curso: limpa(meta.name) || 'Extra' }); }
    for (const { rid, curso } of alvos) {
      roots.push({ id: rid, name: curso });
      const fila = [{ id: rid, partes: [curso], pid: null }]; let tentativas = 0;
      while (fila.length) {
        const lote = fila.splice(0, 10);
        const res = await Promise.all(lote.map(async f => ({ f, itens: await filhos(f.id, key).catch(e => { STATUS.erro = String(e.message).slice(0, 100); falhas.push(f); return []; }) })));
        for (const { f, itens } of res) for (const it of itens) {
          const alvoId = it.shortcutDetails && it.shortcutDetails.targetId || it.id;
          const mime = it.shortcutDetails && it.shortcutDetails.targetMimeType || it.mimeType;
          if (mime === 'application/vnd.google-apps.folder') { fila.push({ id: alvoId, partes: [...f.partes, it.name.trim()], pid: f.id }); STATUS.pastas++; continue; }
          const reg = { d: it.name, t: limpa(it.name), id: alvoId, course: curso, path: [...f.partes, it.name].join(' / '), pid: f.id };
          if (/^video\//.test(mime || '') || VIDEO.test(it.name)) videos.push(reg);
          else if (/pdf|document|presentation|spreadsheet|text/.test(mime || '') || DOC.test(it.name)) materials.push(reg);
        }
        Object.assign(STATUS, { videos: videos.length, materiais: materials.length });
        if (!tinha) MEMLEGADO = { generatedAt: 'parcial-' + Date.now(), roots, videos, materials }; // 1ª varredura: mostra progresso
        if (!fila.length && falhas.length && tentativas++ < 4) { await new Promise(s => setTimeout(s, 2500)); fila.push(...falhas.splice(0)); }
      }
    }
    STATUS.falhas = falhas.length;
    const pronto = { generatedAt: new Date().toISOString(), roots, videos, materials };
    if (tinha && falhas.length && (videos.length + materials.length) < 0.95 * ((antes.videos || []).length + (antes.materials || []).length)) {
      STATUS.erro = falhas.length + ' pasta(s) não puderam ser lidas; mantive a lista anterior';
      return { videos: antes.videos.length, materials: antes.materials.length };
    }
    fs.writeFileSync(EXTRA_FILE, JSON.stringify(pronto)); MEMLEGADO = pronto;
    Object.assign(STATUS, { at: new Date().toISOString(), videos: videos.length, materiais: materials.length });
    return { videos: videos.length, materials: materials.length };
  } catch (e) { STATUS.erro = String(e.message || e).slice(0, 260); return null; }
  finally { STATUS.running = false; }
}

/* ═══ ORQUESTRAÇÃO (mesma assinatura usada pelo server.js) ══════════════════════
   1º boot sem volume/token  → Full Sync (e grava catálogo + token)
   boot COM volume/token     → pula varredura; roda Δ Delta Sync direto
   token expirado            → fallback automático p/ Full Sync daqui a pouco   */
export async function varrerExtras(key = process.env.GOOGLE_DRIVE_API_KEY || '') {
  if (!USA_BASE()) {
    if (!key && !temConta()) { STATUS.erro = 'falta GOOGLE_SERVICE_ACCOUNT_JSON (pasta privada) ou GOOGLE_DRIVE_API_KEY (pasta com link público)'; return null; }
    if (!TOKEN && !CAT.generatedAt) return await varrerFull(key);
    return await deltaSync(key);
  }
  if (!key && !temConta()) { STATUS.erro = 'falta GOOGLE_SERVICE_ACCOUNT_JSON (pasta privada) ou GOOGLE_DRIVE_API_KEY (pasta com link público)'; return null; }
  return await varrerLegado(key);
}

/* ═══ Junta o catálogo principal com o das pastas extras (ids repetidos valem o principal) ═══ */
export function juntar(base0) {
  const base = USA_BASE() ? base0 : { ...base0, videos: [], materials: [], courses: [] };
  const ex = lerExtra();
  if (!ex.videos.length && !ex.materials.length) return base;
  const vi = new Set((base.videos || []).map(v => v.id)), mi = new Set((base.materials || []).map(m => m.id));
  return { ...base, videos: [...(base.videos || []), ...ex.videos.filter(v => !vi.has(v.id))], materials: [...(base.materials || []), ...ex.materials.filter(m => !mi.has(m.id))], courses: [...(base.courses || []), ...(ex.roots || []).filter(r => !(base.courses || []).some(c => c.id === r.id))] };
}
