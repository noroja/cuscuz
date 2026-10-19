// Apostila Reader — busca HTML do Drive e serve sanitizado para o leitor
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { driveFetch, cleanDriveId } from './drive-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'apostila-cache.json');

// Cache em disco: um arquivo por apostila, lido sob demanda (apostilas com imagens embutidas
// passam de dezenas de MB; um JSON único estourava a memória). Na memória fica só um punhado.
const CACHE_ARQ_DIR = path.join(CACHE_DIR, 'apostilas');
const MEM_MAX = 2;
const htmlCache = new Map(); // id -> { timestamp, data }

try { // cache antigo em arquivo único: não é mais usado
  if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
} catch (e) {
  console.warn('⚠️ Não consegui apagar o cache antigo de apostilas:', e.message);
}

function arquivoDoCache(id) {
  return /^[A-Za-z0-9_-]{5,120}$/.test(id) ? path.join(CACHE_ARQ_DIR, id + '.html') : null;
}

function lerCache(id) {
  const mem = htmlCache.get(id);
  if (mem) return mem;
  const arq = arquivoDoCache(id);
  try {
    if (arq && fs.existsSync(arq)) {
      const st = fs.statSync(arq);
      const entrada = { timestamp: st.mtimeMs, data: fs.readFileSync(arq, 'utf8') };
      guardarNaMemoria(id, entrada);
      return entrada;
    }
  } catch (e) {
    console.warn('⚠️ Falha ao ler cache de apostila:', e.message);
  }
  return null;
}

function guardarNaMemoria(id, entrada) {
  htmlCache.delete(id);
  htmlCache.set(id, entrada);
  while (htmlCache.size > MEM_MAX) htmlCache.delete(htmlCache.keys().next().value);
}

function gravarCache(id, entrada) {
  guardarNaMemoria(id, entrada);
  const arq = arquivoDoCache(id);
  if (!arq) return;
  try {
    fs.mkdirSync(CACHE_ARQ_DIR, { recursive: true });
    const tmp = arq + '.tmp';
    fs.writeFileSync(tmp, entrada.data, 'utf8');
    fs.renameSync(tmp, arq); // troca atômica: nunca fica arquivo pela metade
  } catch (e) {
    console.warn('⚠️ Falha ao salvar cache de apostila no disco:', e.message);
  }
}

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 dias (permanente na prática)

// URLs dos CSSs mestres do MedReader (S3)
const CSS_MESTRE_URLS = [
  'https://apostilas-readerpro.s3-sa-east-1.amazonaws.com/css-mestre/apostilas.min.css',
  'https://apostilas-readerpro.s3-sa-east-1.amazonaws.com/css-mestre/ultimo_recurso.css'
];

let cssMestreCache = null;
let cssMestreTimestamp = 0;
const CSS_CACHE_TTL = 60 * 60 * 1000; // 1 hora

async function fetchCssMestre() {
  const now = Date.now();
  if (cssMestreCache && (now - cssMestreTimestamp < CSS_CACHE_TTL)) {
    return cssMestreCache;
  }
  
  try {
    const cssParts = await Promise.all(
      CSS_MESTRE_URLS.map(url => 
        fetch(url, { signal: AbortSignal.timeout(10000) })
          .then(r => r.ok ? r.text() : '')
          .catch(() => '')
      )
    );
    cssMestreCache = cssParts.join('\n\n/* === CSS MESTRE APOSTILAS === */\n\n');
    cssMestreTimestamp = now;
    console.log('✅ CSSs mestres do MedReader carregados do S3');
    return cssMestreCache;
  } catch (err) {
    console.warn('⚠️ Falha ao buscar CSSs mestres do S3:', err.message);
    return '';
  }
}

/** Tira as imagens base64 do texto (podem somar dezenas de MB), roda fn no esqueleto e devolve as imagens. */
function comImagensDeFora(html, fn) {
  const guardadas = [];
  const esqueleto = html.replace(/data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=\s]{200,}/gi, (m) => {
    guardadas.push(m);
    return 'data:image/png;base64,MRIMG' + (guardadas.length - 1) + 'X';
  });
  const out = fn(esqueleto);
  if (!guardadas.length) return out;
  return out.replace(/data:image\/png;base64,MRIMG(\d+)X/g, (m, n) => guardadas[Number(n)] || '');
}

function sanitizeHtml(html) {
  return comImagensDeFora(html, sanitizarEsqueleto);
}

function sanitizarEsqueleto(html) {
  // Remove tudo que executa código ou puxa recursos externos; as folhas de estilo da própria
  // apostila saem também (o leitor usa o CSS-mestre).
  const $ = cheerio.load(html);
  $('script, noscript, iframe, frame, frameset, object, embed, applet, base, form, link, style, meta[http-equiv]').remove();
  const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'srcset', 'poster', 'data']);
  $('*').each((_, el) => {
    for (const nome of Object.keys(el.attribs || {})) {
      const n = nome.toLowerCase();
      const v = String(el.attribs[nome] || '');
      if (n.startsWith('on')) { $(el).removeAttr(nome); continue; }
      if (URL_ATTRS.has(n)) {
        const limpo = v.replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, '').toLowerCase();
        if (/^(javascript|vbscript):/.test(limpo) || (/^data:/.test(limpo) && !/^data:image\/(png|jpe?g|gif|webp|avif|bmp);/.test(limpo))) {
          $(el).removeAttr(nome);
        }
      }
      if (n === 'style' && /expression\s*\(|javascript:|url\s*\(\s*['"]?\s*(javascript|data:text)/i.test(v)) $(el).removeAttr(nome);
    }
  });
  return $.html();
}

/**
 * Prefixa os seletores de uma folha de estilo para ela valer só dentro do leitor
 * (html/body/:root viram o próprio prefixo). @import some; @font-face/@keyframes ficam como estão.
 */
function scopeCss(css, prefix) {
  const src = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  let out = '';
  const bloco = (ini) => { // devolve o índice do '}' que fecha o '{' em ini
    let prof = 0;
    for (let k = ini; k < src.length; k++) {
      const c = src[k];
      if (c === '"' || c === "'") { const q = c; k++; while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
      if (c === '{') prof++;
      else if (c === '}') { prof--; if (prof === 0) return k; }
    }
    return src.length - 1;
  };
  const dividir = (sel) => { // separa por vírgula fora de (), [] e aspas
    const partes = []; let prof = 0; let q = ''; let ini = 0;
    for (let k = 0; k < sel.length; k++) {
      const c = sel[k];
      if (q) { if (c === '\\') k++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '(' || c === '[') prof++;
      else if (c === ')' || c === ']') prof--;
      else if (c === ',' && prof === 0) { partes.push(sel.slice(ini, k)); ini = k + 1; }
    }
    partes.push(sel.slice(ini));
    return partes;
  };
  const escopar = (sel) => dividir(sel).map((x) => {
    let t = x.trim();
    if (!t) return '';
    for (;;) {
      const m = t.match(/^(html|body|:root)(?![\w-])\s*/i);
      if (!m) break;
      t = t.slice(m[0].length);
    }
    if (!t) return prefix;
    if (/^[>+~]/.test(t)) return prefix + ' ' + t;
    if (t === '*') return prefix + ', ' + prefix + ' *';
    return prefix + ' ' + t;
  }).filter(Boolean).join(', ');
  const rec = (texto) => scopeCss(texto, prefix);
  while (i < src.length) {
    const ab = src.indexOf('{', i);
    const pv = src.indexOf(';', i);
    if (ab === -1 && pv === -1) break;
    if (pv !== -1 && (ab === -1 || pv < ab) && src.slice(i, pv).trim().startsWith('@')) { // @import, @charset...
      i = pv + 1; continue;
    }
    if (ab === -1) break;
    const cab = src.slice(i, ab).trim();
    const fim = bloco(ab);
    const corpo = src.slice(ab + 1, fim);
    if (cab.startsWith('@')) {
      if (/^@(media|supports|document|layer|container)\b/i.test(cab)) out += cab + '{' + rec(corpo) + '}\n';
      else out += cab + '{' + corpo + '}\n';
    } else {
      const sel = escopar(cab);
      if (sel) out += sel + '{' + corpo + '}\n';
    }
    i = fim + 1;
  }
  return out;
}

function injectCssMestre(html, cssMestre) {
  // Injeta o CSS mestre no head do HTML
  const cssTag = `<style id="medreader-css-mestre">${cssMestre}</style>`;
  
  if (html.includes('</head>')) {
    return html.replace('</head>', cssTag + '\n</head>');
  } else if (html.includes('<head>')) {
    return html.replace('<head>', '<head>\n' + cssTag);
  } else {
    // Sem head, pré-fixa
    return cssTag + '\n' + html;
  }
}

function addReaderEnhancements(html) {
  // Adiciona classes e estrutura para o leitor funcionar bem
  return html
    .replace(/<body([^>]*)>/i, '<body$1 class="medreader-body">')
    .replace(/<html([^>]*)>/i, '<html$1 class="medreader-html">');
}

const escopoCache = new Map();

export async function getApostilaHtml(fileId, { escopo = false } = {}) {
  if (escopo) {
    const base = await getApostilaHtml(fileId);
    const chave = cleanDriveId(fileId) + ':' + base.length;
    if (escopoCache.has(chave)) return escopoCache.get(chave);
    const ini = base.indexOf('<style id="medreader-css-mestre">');
    const fimCss = ini === -1 ? -1 : base.indexOf('</style>', ini);
    const css = ini === -1 || fimCss === -1 ? '' : base.slice(ini + '<style id="medreader-css-mestre">'.length, fimCss);
    const resto = ini === -1 || fimCss === -1 ? base : base.slice(0, ini) + base.slice(fimCss + 8);
    const mCorpo = resto.match(/<body[^>]*>/i);
    const iCorpo = mCorpo ? mCorpo.index + mCorpo[0].length : 0;
    const fCorpo = resto.lastIndexOf('</body>');
    const corpo = resto.slice(iCorpo, fCorpo > iCorpo ? fCorpo : undefined);
    const pronto = '<style id="medreader-css-mestre">' + scopeCss(css, '.medreader-content') + '</style>\n' + corpo;
    escopoCache.clear(); // guarda só a última (podem ser grandes)
    escopoCache.set(chave, pronto);
    return pronto;
  }
  const id = cleanDriveId(fileId);
  if (!id) throw new Error('ID inválido');
  
  const now = Date.now();
  const cached = lerCache(id);
  if (cached && (now - cached.timestamp < CACHE_TTL)) {
    return cached.data;
  }
  
  // Tenta baixar o arquivo do Drive
  const candidates = [
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}&confirm=t`
  ];
  
  let html = '';
  let lastErr = null;
  
  for (const url of candidates) {
    try {
      const resp = await driveFetch(url, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const ctype = String(resp.headers.get('content-type') || '').toLowerCase();
        // Arquivo binário (PDF etc.) não é apostila HTML: não lê como texto nem coloca em cache
        if (/application\/(pdf|octet-stream|zip)|^(image|video|audio)\//.test(ctype) && !/html/.test(ctype)) {
          lastErr = new Error('O arquivo não é uma apostila HTML (' + ctype + ')');
          continue;
        }
        const text = await resp.text();
        if (/^\s*%PDF-/.test(text)) {
          lastErr = new Error('O arquivo é um PDF, não uma apostila HTML');
          continue;
        }
        if (text && text.length > 50) {
          html = text;
          break;
        }
      }
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  
  if (!html) {
    throw new Error('Não foi possível obter o HTML da apostila do Drive: ' + (lastErr?.message || 'desconhecido'));
  }
  
  // Processa o HTML
  const cssMestre = await fetchCssMestre();
  let processed = sanitizeHtml(html);
  processed = injectCssMestre(processed, cssMestre);
  processed = addReaderEnhancements(processed);
  
  // Cache
  gravarCache(id, { timestamp: now, data: processed });
  
  return processed;
}

export function registerApostilaReader(app) {
  // Endpoint para buscar HTML da apostila processado
  app.get('/api/apostila/html/:id', async (req, res) => {
    try {
      const html = await getApostilaHtml(req.params.id, { escopo: req.query.escopo === '1' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=1800'); // 30 min
      res.send(html);
    } catch (err) {
      console.error('[Apostila Reader]', err.message);
      res.status(502).json({ 
        success: false, 
        msg: 'Erro ao carregar apostila: ' + err.message 
      });
    }
  });
  
  // Endpoint para buscar apenas o CSS mestre (para uso standalone)
  app.get('/api/apostila/css-mestre', async (_req, res) => {
    try {
      const css = await fetchCssMestre();
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(css);
    } catch (err) {
      res.status(500).send('/* Erro ao carregar CSS mestre */');
    }
  });
  
  // Endpoint para listar apostilas (arquivos HTML) em uma pasta
  app.get('/api/apostila/list', async (req, res) => {
    const folderId = cleanDriveId(req.query.folderId) || process.env.GOOGLE_DRIVE_FOLDER_ID || '';
    
    try {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and (mimeType='text/html' or name contains '.html' or name contains '.htm')`);
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)&orderBy=name_natural&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`;
      
      const resp = await driveFetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error('Drive API ' + resp.status);
      
      const data = await resp.json();
      const apostilas = (data.files || []).map(f => ({
        id: f.id,
        name: f.name.replace(/\.(html?|htm)$/i, ''),
        rawName: f.name,
        size: parseInt(f.size || '0', 10),
        modifiedTime: f.modifiedTime,
        webViewLink: f.webViewLink
      }));
      
      res.json({ success: true, apostilas, total: apostilas.length });
    } catch (err) {
      console.error('[Apostila List]', err.message);
      res.status(500).json({ success: false, msg: err.message });
    }
  });
}

export { fetchCssMestre, sanitizeHtml, injectCssMestre, scopeCss };