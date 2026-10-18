// Apostila Reader — busca HTML do Drive e serve sanitizado para o leitor
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { driveFetch, cleanDriveId } from './drive-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'apostila-cache.json');

let htmlCache = new Map();
try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      htmlCache.set(k, v);
    }
    console.log(`📂 Cache permanente de apostilas carregado (${htmlCache.size} itens).`);
  }
} catch (e) {
  console.warn('⚠️ Falha ao carregar cache de apostilas:', e.message);
}

function saveHtmlCacheToDisk() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const obj = {};
    for (const [k, v] of htmlCache.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.warn('⚠️ Falha ao salvar cache de apostilas no disco:', e.message);
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

function sanitizeHtml(html) {
  // Remove scripts, iframes, event handlers, estilos inline perigosos
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, 'blocked:')
    .replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi, '') // remove CSS externos (usamos os nossos)
    .replace(/<style[^>]*>[^<]*<\/style>/gi, ''); // remove style tags (opcional - podemos manter se quiser)
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

export async function getApostilaHtml(fileId) {
  const id = cleanDriveId(fileId);
  if (!id) throw new Error('ID inválido');
  
  const now = Date.now();
  const cached = htmlCache.get(id);
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
  htmlCache.set(id, { timestamp: now, data: processed });
  saveHtmlCacheToDisk();
  
  return processed;
}

export function registerApostilaReader(app) {
  // Endpoint para buscar HTML da apostila processado
  app.get('/api/apostila/html/:id', async (req, res) => {
    try {
      const html = await getApostilaHtml(req.params.id);
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

export { fetchCssMestre, sanitizeHtml, injectCssMestre };