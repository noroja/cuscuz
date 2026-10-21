import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Apkg } from 'anki-apkg-parser';
import yauzl from 'yauzl';
import * as cheerio from 'cheerio';
import { authHeaders, cleanDriveId, driveFetchWithRetry, temConta } from './drive-auth.js';

const BUCKET = 'flashcards-library';
const MANIFEST_PATH = 'library/manifest.json';
const PAGE_SIZE = 500;
const positiveInt = (value, fallback) => { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; };
const MAX_PACKAGE_BYTES = positiveInt(process.env.FLASHCARD_MAX_PACKAGE_BYTES, 100 * 1024 ** 2);
const MAX_UNPACKED_BYTES = positiveInt(process.env.FLASHCARD_MAX_UNPACKED_BYTES, 512 * 1024 ** 2);
const MAX_ARCHIVE_ENTRIES = positiveInt(process.env.FLASHCARD_MAX_ARCHIVE_ENTRIES, 50_000);
const MAX_MEDIA_FILE_BYTES = positiveInt(process.env.FLASHCARD_MAX_MEDIA_FILE_BYTES, 25 * 1024 ** 2);
const MAX_MEDIA_TOTAL_BYTES = positiveInt(process.env.FLASHCARD_MAX_MEDIA_TOTAL_BYTES, 250 * 1024 ** 2);
const ROOTS = (() => {
  const configured = String(process.env.GOOGLE_DRIVE_FLASHCARDS_ROOTS || '').split(';').map(value => value.trim()).filter(Boolean);
  const roots = configured.map(value => {
    const [id, ...pathParts] = value.split('|');
    return { id: cleanDriveId(id), path: pathParts.join('|').trim() };
  }).filter(root => root.id);
  if (roots.length) return roots;
  const legacyRoot = cleanDriveId(process.env.GOOGLE_DRIVE_FLASHCARDS_ROOT_ID || '');
  return legacyRoot ? [{ id: legacyRoot, path: '' }] : [];
})();
let syncPromise = null;
let status = { running: false, lastRun: null, lastSuccess: null, lastError: null, processed: 0, cards: 0 };

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const fileVersionKey = file => [file?.modifiedTime || '', file?.size || '', file?.md5Checksum || ''].join(':');
const mimeFromName = name => ({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4'
}[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream');

export async function validatePackageArchive(archivePath, {
  maxExpandedBytes = MAX_UNPACKED_BYTES,
  maxEntries = MAX_ARCHIVE_ENTRIES,
  maxEntryRatio = 2000
} = {}) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: true }, (openError, zip) => {
      if (openError) return reject(openError);
      let entries = 0, expandedBytes = 0, settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch (_) {}
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entries, expandedBytes });
      });
      zip.on('entry', entry => {
        entries++;
        const rawName = String(entry.fileName || '').replace(/\\/g, '/');
        const normalized = path.posix.normalize(rawName);
        const parts = normalized.split('/');
        if (!rawName || rawName.startsWith('/') || /^[a-z]:/i.test(rawName) || parts.includes('..') || normalized === '..') {
          return fail(new Error(`Pacote Anki contém caminho inseguro: ${rawName.slice(0, 120)}`));
        }
        if (entries > maxEntries) return fail(new Error(`Pacote Anki excede o limite de ${maxEntries} itens.`));
        const expanded = Number(entry.uncompressedSize || 0);
        const compressed = Number(entry.compressedSize || 0);
        expandedBytes += expanded;
        if (expandedBytes > maxExpandedBytes) return fail(new Error(`Pacote Anki excede o limite expandido de ${maxExpandedBytes} bytes.`));
        if (expanded > 1024 * 1024 && expanded / Math.max(compressed, 1) > maxEntryRatio) {
          return fail(new Error(`Pacote Anki contém item com taxa de expansão suspeita: ${rawName.slice(0, 120)}`));
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

const HTML_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'br', 'p', 'div', 'span', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'code', 'pre', 'sup', 'sub', 'hr', 'img']);
function sanitizeAnkiHtml(value, mediaByName = {}) {
  const $ = cheerio.load(`<div id="anki-root">${String(value || '')}</div>`, { decodeEntities: false });
  $('#anki-root script, #anki-root style, #anki-root iframe, #anki-root object, #anki-root embed, #anki-root form, #anki-root svg, #anki-root audio, #anki-root video').remove();
  $('#anki-root *').each((_, element) => {
    const node = $(element);
    const tag = String(element.tagName || '').toLowerCase();
    if (!HTML_TAGS.has(tag)) { node.replaceWith(node.contents()); return; }
    const attrs = { ...(element.attribs || {}) };
    for (const name of Object.keys(attrs)) node.removeAttr(name);
    if (tag === 'img') {
      const name = String(attrs.src || '').replace(/^\.\//, '');
      const asset = mediaByName[name];
      if (!asset || !asset.url) { node.replaceWith(`[imagem indisponível: ${String(attrs.alt || name).slice(0, 100)}]`); return; }
      node.attr('src', asset.url);
      node.attr('alt', String(attrs.alt || asset.name || 'Imagem do cartão').slice(0, 180));
      node.attr('loading', 'lazy');
      node.attr('decoding', 'async');
      return;
    }
    if (attrs.class && /^[\w\s-]{1,100}$/.test(attrs.class)) node.attr('class', attrs.class);
    if (tag === 'td' || tag === 'th') {
      for (const key of ['colspan', 'rowspan']) if (/^\d{1,2}$/.test(attrs[key] || '')) node.attr(key, attrs[key]);
    }
  });
  return $('#anki-root').html() || '';
}
const cleanText = html => String(html || '')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, ' $1 ')
  .replace(/<img\b[^>]*>/gi, ' [imagem do cartão] ')
  .replace(/\[sound:([^\]]+)\]/gi, ' [áudio: $1] ')
  .replace(/<br\s*\/?\s*>|<\/(?:div|p|li|tr|h[1-6])\s*>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').trim();

function renderTemplate(template, fields, frontSide, clozeIndex) {
  let out = String(template || '');
  out = out.replace(/{{([#^])([^{}]+)}}([\s\S]*?){{\/\2}}/g, (_, kind, name, body) => {
    const value = fields[name.trim()] || '';
    return (kind === '#' ? !!cleanText(value) : !cleanText(value)) ? body : '';
  });
  out = out.replace(/{{FrontSide}}/gi, frontSide || '');
  out = out.replace(/{{(?:cloze:)?([^{}:]+)}}/g, (all, name) => {
    const value = fields[name.trim()] || '';
    if (/^cloze:/i.test(all)) {
      return value.replace(/\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/gs, (m, n, answer, hint) => {
        if (Number(n) !== Number(clozeIndex) + 1) return answer;
        return `<span class="anki-cloze">${hint ? `[${hint}]` : '[…]'}</span>`;
      });
    }
    return value;
  });
  return out;
}

function modelFields(model) {
  return Array.isArray(model?.flds) ? model.flds.map(f => f.name).filter(Boolean) : [];
}

export function mapNoteCard(note, card, model, packageFile, deckName, mediaByName = {}) {
  const names = modelFields(model);
  const values = String(note.flds || '').split('\x1f');
  const fields = Object.fromEntries(names.map((name, i) => [name, values[i] || '']));
  if (!names.length) values.forEach((v, i) => { fields[`Field${i + 1}`] = v; });
  const templates = model?.tmpls || [];
  const template = templates.find(t => Number(t.ord) === Number(card.ord)) || templates[0];
  const qfmt = template?.qfmt || '';
  const afmt = template?.afmt || '';
  let front = qfmt ? renderTemplate(qfmt, fields, '', card.ord) : (values[0] || '');
  let back = afmt ? renderTemplate(afmt, fields, front, card.ord) : (values[1] || values[0] || '');
  let type = 'basic';
  let clozeData = null;
  const clozePattern = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/gs;
  if (Number(model?.type) === 1 || /cloze/i.test(String(model?.name || ''))) {
    type = 'cloze';
    const answers = [];
    const originals = [];
    for (const value of values) {
      for (const match of value.matchAll(clozePattern)) {
        originals.push(match[0]);
        if (Number(match[1]) === Number(card.ord) + 1) answers.push(match[2]);
      }
    }
    if (!front || front === qfmt) front = values.join(' ');
    front = front.replace(clozePattern, (m, n, answer, hint) => Number(n) === Number(card.ord) + 1 ? (hint ? `[${hint}]` : '[…]') : answer);
    if (answers.length) back = `${cleanText(back)}\n\nResposta: ${cleanText(answers.join('; '))}`;
    clozeData = { index: Number(card.ord) + 1, answers, original: originals };
  }
  const frontHtml = sanitizeAnkiHtml(front, mediaByName);
  const backHtml = sanitizeAnkiHtml(back, mediaByName);
  front = cleanText(front);
  back = cleanText(back);
  if (!front || !back) return null;
  const tags = String(note.tags || '').trim().split(/\s+/).filter(Boolean);
  const sourceKey = `${packageFile.id}:${note.id}:${card.ord}`;
  const mediaNames = new Set();
  for (const field of values) {
    for (const match of field.matchAll(/(?:<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']|\[sound:([^\]]+)\])/gi)) {
      const name = String(match[1] || match[2] || '').replace(/^\.\//, '');
      if (mediaByName[name]) mediaNames.add(name);
    }
  }
  return {
    schemaVersion: 1, id: hash(sourceKey), type, front, back, frontHtml, backHtml, cloze: clozeData,
    subject: tags[0] || deckName,
    topic: tags[1] || '', tags,
    media: [...mediaNames].map(name => mediaByName[name]),
    source: {
      driveFileId: packageFile.id, packageName: packageFile.name, drivePath: packageFile.path,
      noteId: String(note.id), noteStableId: hash(`${packageFile.id}:${note.id}`), cardId: String(card.id || ''),
      modelId: String(note.mid || ''), modelName: String(model?.name || ''), originalTags: tags,
      fields: names.map((name, index) => ({ name, value: values[index] || '' })), cardTemplate: Number(card.ord)
    }
  };
}

async function storageJson(supabase, bucket, objectPath) {
  const { data, error } = await supabase.storage.from(bucket).download(objectPath);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()); } catch (_) { return null; }
}

async function ensureBucket(supabase) {
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`Supabase Storage indisponível: ${error.message}`);
  if ((data || []).some(b => b.name === BUCKET)) return;
  const { error: createError } = await supabase.storage.createBucket(BUCKET, { public: false, fileSizeLimit: '6GB' });
  if (createError && !/already exists/i.test(createError.message || '')) throw new Error(`Não foi possível criar o bucket ${BUCKET}: ${createError.message}`);
}

async function listPackageFiles(roots) {
  const folders = roots.map(root => ({ id: root.id, path: root.path || '' }));
  const visited = new Set();
  const packages = [];
  while (folders.length) {
    const folder = folders.shift();
    if (visited.has(folder.id)) continue;
    visited.add(folder.id);
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${folder.id}' in parents and trashed = false`);
      const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,webViewLink)');
      const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${page}`;
      const response = await driveFetchWithRetry(url, { headers: await authHeaders(), signal: AbortSignal.timeout(45000) });
      const body = await response.json();
      for (const file of body.files || []) {
        const rel = folder.path ? `${folder.path}/${file.name}` : file.name;
        if (file.mimeType === 'application/vnd.google-apps.folder') folders.push({ id: file.id, path: rel });
        else if (/\.(apkg|colpkg)$/i.test(file.name)) packages.push({ ...file, path: rel });
      }
      pageToken = body.nextPageToken || '';
    } while (pageToken);
  }
  return packages;
}

function readPackageCatalog() {
  const configuredPath = String(process.env.GOOGLE_DRIVE_FLASHCARDS_CATALOG_PATH || '').trim();
  const catalogPath = configuredPath ? path.resolve(configuredPath) : new URL('../data/flashcard-drive-index.json', import.meta.url);
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.packages)) return [];
    return catalog.packages.filter(item => /^[A-Za-z0-9_-]{10,}$/.test(String(item.id || '')) && /\.apkg$/i.test(String(item.name || '')));
  } catch (error) {
    if (configuredPath) console.warn('[Flashcards] Catálogo de arquivos não pôde ser lido:', error.message);
    return [];
  }
}

async function listCatalogPackageFiles() {
  const indexed = readPackageCatalog();
  return (await Promise.all(indexed.map(async item => {
    try {
      const response = await driveFetchWithRetry(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}?fields=id,name,mimeType,size,modifiedTime,md5Checksum,parents,webViewLink,trashed&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: await authHeaders(), signal: AbortSignal.timeout(30000) });
      const file = await response.json();
      if (file.trashed || !/\.apkg$/i.test(file.name || '')) return null;
      return { ...item, ...file, path: item.path || file.name };
    } catch (error) {
      console.warn(`[Flashcards] Não foi possível atualizar o arquivo do catálogo ${item.id}:`, error.message);
      return null;
    }
  }))).filter(Boolean);
}

export async function packageFromChange(change) {
  let file = change?.file;
  if (!file?.id || !/\.(apkg|colpkg)$/i.test(file.name || '') || file.trashed) return null;
  if (!file.modifiedTime || file.size == null || !file.parents) {
    try {
      const response = await driveFetchWithRetry(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?fields=id,name,mimeType,size,modifiedTime,md5Checksum,parents,webViewLink,trashed&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: await authHeaders(), signal: AbortSignal.timeout(30000) });
      file = { ...file, ...(await response.json()) };
    } catch (error) {
      console.warn(`[Flashcards] Metadados do arquivo alterado ${file.id} indisponíveis:`, error.message);
      return null;
    }
  }
  const rootsById = new Map(ROOTS.map(root => [root.id, root]));
  const parents = [...(file.parents || [])];
  const names = [file.name];
  const visited = new Set();
  while (parents.length && visited.size < 32) {
    const parentId = parents.shift();
    if (!parentId || visited.has(parentId)) continue;
    if (rootsById.has(parentId)) {
      const root = rootsById.get(parentId);
      return { ...file, path: [root.path, ...names].filter(Boolean).join('/') };
    }
    visited.add(parentId);
    const response = await driveFetchWithRetry(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parentId)}?fields=id,name,parents,mimeType&supportsAllDrives=true&includeItemsFromAllDrives=true`, { signal: AbortSignal.timeout(30000) });
    const parent = await response.json();
    if (parent.name) names.unshift(parent.name);
    parents.push(...(parent.parents || []));
  }
  return null;
}

async function downloadPackage(file, destination) {
  const size = Number(file.size || 0);
  if (size > MAX_PACKAGE_BYTES) throw new Error(`Pacote ${file.name} excede o limite de ${MAX_PACKAGE_BYTES} bytes.`);
  const response = await driveFetchWithRetry(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`, { signal: AbortSignal.timeout(30 * 60_000) });
  let received = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length;
    if (received > MAX_PACKAGE_BYTES) return callback(new Error(`Pacote ${file.name} excedeu o limite de download.`));
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(destination));
}

export async function extractPackage(supabase, file, archivePath, scratch) {
  await validatePackageArchive(archivePath);
  const unpacked = path.join(scratch, 'unpacked');
  const apkg = await Apkg.create(archivePath, unpacked);
  const db = await apkg.getDb();
  try {
    const [models, collection, countRow] = await Promise.all([
      db.getModels(), db.getCollection().catch(() => null), db.get('SELECT COUNT(*) AS count FROM cards')
    ]);
    let decks = collection?.decks || {};
    if (!Object.keys(decks).length) {
      try { decks = Object.fromEntries((await db.all('SELECT id, name FROM decks')).map(deck => [deck.id, deck])); } catch (_) {}
    }
    const grouped = new Map();
    const mediaByName = {};
    let mediaBytes = 0;
    const mediaManifest = await apkg.getMedia().catch(() => ({}));
    const mediaReferences = new Set();
    for (const note of await db.all('SELECT flds FROM notes')) {
      for (const match of String(note.flds || '').matchAll(/(?:<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']|\[sound:([^\]]+)\])/gi)) {
        mediaReferences.add(String(match[1] || match[2] || '').replace(/^\.\//, ''));
      }
    }
    const allowedMediaExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
    for (const [archiveName, originalNameRaw] of Object.entries(mediaManifest)) {
      const originalName = String(originalNameRaw || '').replace(/\\/g, '/');
      const archiveEntry = String(archiveName || '').replace(/\\/g, '/');
      const normalizedEntry = path.posix.normalize(archiveEntry);
      if ((!mediaReferences.has(originalName) && !mediaReferences.has(archiveEntry)) || !originalName || originalName.includes('/') || originalName.includes('..')) continue;
      if (!normalizedEntry || normalizedEntry === '..' || normalizedEntry.startsWith('/') || normalizedEntry.split('/').includes('..')) continue;
      const extension = path.extname(originalName).toLowerCase();
      if (!allowedMediaExt.has(extension)) continue;
      const resolvedMediaPath = path.resolve(unpacked, ...normalizedEntry.split('/'));
      if (!resolvedMediaPath.startsWith(path.resolve(unpacked) + path.sep)) continue;
      let stat;
      try { stat = await fs.promises.stat(resolvedMediaPath); } catch (_) { continue; }
      if (!stat.isFile() || stat.size > MAX_MEDIA_FILE_BYTES || mediaBytes + stat.size > MAX_MEDIA_TOTAL_BYTES) continue;
      const data = await fs.promises.readFile(resolvedMediaPath);
      const digest = crypto.createHash('sha256').update(data).digest('hex');
      const assetName = `${digest}${extension}`;
      const objectPath = `library/media/${assetName}`;
      const { error } = await supabase.storage.from(BUCKET).upload(objectPath, data, { contentType: mimeFromName(originalName), upsert: true });
      if (error) throw new Error(`Falha salvando mídia ${originalName}: ${error.message}`);
      const { error: mediaError } = await supabase.from('flashcard_media').upsert({
        id: digest, filename: originalName, mime_type: mimeFromName(originalName), storage_path: objectPath, size_bytes: data.length
      }, { onConflict: 'id' });
      if (mediaError) throw new Error(`Falha registrando mídia ${originalName}: ${mediaError.message}`);
      const mediaRef = { id: digest, name: originalName, mimeType: mimeFromName(originalName), size: data.length, url: `/api/flashcards/library/media/${assetName}` };
      mediaByName[originalName] = mediaRef;
      mediaByName[archiveEntry] = mediaRef;
      mediaBytes += data.length;
    }
    let rejected = 0;
    const total = Number(countRow?.count || 0);
    for (let offset = 0; offset < total; offset += 500) {
      const rows = await db.all(`SELECT c.id AS cardId, c.nid AS noteId, c.did AS deckId, c.ord AS cardOrd,
        n.mid AS modelId, n.tags AS noteTags, n.flds AS noteFields
        FROM cards c JOIN notes n ON n.id = c.nid ORDER BY c.did, c.id LIMIT 500 OFFSET ?`, offset);
      for (const row of rows) {
        const card = { id: row.cardId, ord: row.cardOrd, did: row.deckId };
        const note = { id: row.noteId, mid: row.modelId, tags: row.noteTags, flds: row.noteFields };
        const deckName = decks?.[row.deckId]?.name || file.name.replace(/\.(apkg|colpkg)$/i, '');
        const converted = mapNoteCard(note, card, models?.[row.modelId], file, deckName, mediaByName);
        if (!converted) { rejected++; continue; }
        const key = String(row.deckId || 'default');
        if (!grouped.has(key)) grouped.set(key, { id: hash(`${file.id}:${key}`).slice(0, 24), name: deckName, sourceFileId: file.id, sourcePath: file.path, cards: [], chunks: [], cardCount: 0 });
        const deck = grouped.get(key);
        deck.cards.push(converted);
        deck.cardCount++;
        if (deck.cards.length === PAGE_SIZE) await flushDeckChunk(supabase, deck);
      }
    }
    for (const deck of grouped.values()) await flushDeckChunk(supabase, deck);
    return { decks: [...grouped.values()].map(({ cards, ...deck }) => deck), rejected };
  } finally { await db.close(); }
}

async function persistFlashcardChunk(supabase, deck) {
  const notesById = new Map();
  for (const card of deck.cards) {
    const source = card.source || {};
    if (source.noteStableId && !notesById.has(source.noteStableId)) notesById.set(source.noteStableId, {
      id: source.noteStableId, source_file_id: source.driveFileId, source_note_id: source.noteId,
      model_id: source.modelId || null, model_name: source.modelName || null,
      original_tags: source.originalTags || [], fields: source.fields || []
    });
  }
  const noteRows = [...notesById.values()];
  if (noteRows.length) {
    const { error } = await supabase.from('flashcard_notes').upsert(noteRows, { onConflict: 'id' });
    if (error) throw new Error(`Falha salvando notas do deck ${deck.name}: ${error.message}`);
  }
  const rows = deck.cards.map(card => ({
    id: card.id, deck_id: deck.id, note_id: card.source.noteStableId,
    source_file_id: card.source.driveFileId, source_card_id: card.source.cardId || card.id,
    card_type: card.type || 'basic', front: card.front, back: card.back,
    front_html: card.frontHtml || '', back_html: card.backHtml || '', subject: card.subject || null,
    topic: card.topic || null, tags: card.tags || [], cloze: card.cloze || null,
    content_hash: hash(`${card.type || 'basic'}\n${card.front}\n${card.back}`), is_active: true
  }));
  if (rows.length) {
    const { error } = await supabase.from('flashcard_library_cards').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`Falha salvando cartões do deck ${deck.name}: ${error.message}`);
  }
  const links = deck.cards.flatMap(card => (card.media || []).map((media, position) => ({ card_id: card.id, media_id: media.id, position })));
  if (links.length) {
    const { error } = await supabase.from('flashcard_media_links').upsert(links, { onConflict: 'card_id,media_id' });
    if (error) throw new Error(`Falha vinculando mídia no deck ${deck.name}: ${error.message}`);
  }
}

async function flushDeckChunk(supabase, deck) {
  if (!deck.cards.length) return;
  const { error: deckError } = await supabase.from('flashcard_decks').upsert({
    id: deck.id, source_file_id: deck.sourceFileId, name: deck.name, drive_path: deck.sourcePath || null,
    card_count: deck.cardCount, is_active: true
  }, { onConflict: 'id' });
  if (deckError) throw new Error(`Falha salvando metadados do deck ${deck.name}: ${deckError.message}`);
  await persistFlashcardChunk(supabase, deck);
  const index = deck.chunks.length;
  const objectPath = `library/decks/${deck.id}/${index}.json`;
  const payloadCards = deck.cards.map(card => {
    const copy = { ...card, source: { ...card.source } };
    delete copy.source.fields;
    return copy;
  });
  const payload = Buffer.from(JSON.stringify(payloadCards));
  const { error } = await supabase.storage.from(BUCKET).upload(objectPath, payload, { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`Falha salvando deck ${deck.name}: ${error.message}`);
  deck.chunks.push(objectPath);
  deck.cards = [];
}

export function getFlashcardSyncStatus() { return { ...status, configured: ROOTS.length > 0, enabled: process.env.GOOGLE_DRIVE_FLASHCARDS_SYNC !== 'false', rootCount: ROOTS.length }; }

export async function syncDriveFlashcards(supabase, { force = false, changes } = {}) {
  if (process.env.GOOGLE_DRIVE_FLASHCARDS_SYNC === 'false') return { success: false, disabled: true };
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    status = { ...status, running: true, lastRun: new Date().toISOString(), lastError: null };
    try {
      if (!ROOTS.length) throw new Error('Configure GOOGLE_DRIVE_FLASHCARDS_ROOTS com as pastas do Drive que contêm os decks.');
      if (!supabase || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('A ingestão exige SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no servidor; a chave anon não pode gravar na biblioteca privada.');
      if (!temConta() && !process.env.GOOGLE_DRIVE_API_KEY) throw new Error('Configure GOOGLE_SERVICE_ACCOUNT_JSON para Drive privado ou GOOGLE_DRIVE_API_KEY para pasta acessível pela API key.');
      await ensureBucket(supabase);
      const stored = await storageJson(supabase, BUCKET, MANIFEST_PATH) || { schemaVersion: 1, decks: [], files: {} };
      const next = { ...stored, schemaVersion: 1, generatedAt: new Date().toISOString(), decks: [...(stored.decks || [])], files: { ...(stored.files || {}) } };
      const incremental = Array.isArray(changes);
      const changedIds = incremental ? new Set(changes.filter(change => {
        const id = String(change.fileId || change.file?.id || '');
        return id && (next.files[id] || /\.(apkg|colpkg)$/i.test(change.file?.name || ''));
      }).map(change => String(change.fileId || change.file?.id))) : null;
      const found = (incremental
        ? (await Promise.all(changes.map(packageFromChange))).filter(Boolean)
        : await (async () => {
          const [listed, indexed] = await Promise.all([listPackageFiles(ROOTS), listCatalogPackageFiles()]);
          const byId = new Map(listed.map(file => [file.id, file]));
          for (const file of indexed) if (!byId.has(file.id)) byId.set(file.id, file);
          return [...byId.values()];
        })()).sort((a, b) => Number(a.size || 0) - Number(b.size || 0));
      const present = new Set(found.map(file => file.id));
      const pending = incremental ? found : found.filter(file => force || (next.files[file.id]?.versionKey || next.files[file.id]?.modifiedTime || '') !== fileVersionKey(file));
      if (incremental && !found.length && ![...changedIds].some(id => next.files[id])) {
        status = { ...status, running: false, lastSuccess: new Date().toISOString(), lastError: null };
        return { success: true, unchanged: true, decks: next.decks.length, cards: next.decks.reduce((n, deck) => n + deck.cardCount, 0), filesFound: 0, filesPending: 0, filesFailed: 0 };
      }
      for (const file of pending) {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cuscuz-anki-'));
        const archive = path.join(scratch, 'source' + path.extname(file.name).toLowerCase());
        const jobId = crypto.randomUUID();
        let sourceSaved = false, jobSaved = false;
        try {
          const sourceRow = {
            drive_file_id: file.id, filename: file.name, drive_path: file.path || null, mime_type: file.mimeType || null,
            file_size_bytes: Number(file.size || 0), modified_time: file.modifiedTime || null,
            md5_checksum: file.md5Checksum || null, version_key: fileVersionKey(file), import_status: 'downloading', last_error: null, updated_at: new Date().toISOString()
          };
          const { error: sourceError } = await supabase.from('flashcard_sources').upsert(sourceRow, { onConflict: 'drive_file_id' });
          if (sourceError) throw new Error(`Falha registrando a origem do Drive: ${sourceError.message}`);
          sourceSaved = true;
          const { error: jobError } = await supabase.from('flashcard_import_jobs').insert({ id: jobId, drive_file_id: file.id, status: 'downloading' });
          if (jobError) throw new Error(`Falha criando o job de importação: ${jobError.message}`);
          jobSaved = true;
          await downloadPackage(file, archive);
          await supabase.from('flashcard_import_jobs').update({ status: 'extracting' }).eq('id', jobId);
          await supabase.from('flashcard_sources').update({ import_status: 'extracting', updated_at: new Date().toISOString() }).eq('drive_file_id', file.id);
          const parsed = await extractPackage(supabase, file, archive, scratch);
          await supabase.from('flashcard_import_jobs').update({ status: 'validating' }).eq('id', jobId);
          const oldDecks = next.decks.filter(deck => deck.sourceFileId === file.id);
          const newDecks = parsed.decks.map(deck => ({ ...deck, sourceFileId: file.id, sourceName: file.name, sourcePath: file.path, modifiedTime: file.modifiedTime }));
          for (const deck of newDecks) {
            const { error: deckError } = await supabase.from('flashcard_decks').upsert({
              id: deck.id, source_file_id: file.id, name: deck.name, drive_path: file.path || null, card_count: deck.cardCount, is_active: true
            }, { onConflict: 'id' });
            if (deckError) throw new Error(`Falha validando o deck ${deck.name}: ${deckError.message}`);
          }
          const activeChunks = new Set(newDecks.flatMap(deck => deck.chunks));
          const obsoleteChunks = oldDecks.flatMap(deck => deck.chunks || []).filter(chunk => !activeChunks.has(chunk));
          if (obsoleteChunks.length) await supabase.storage.from(BUCKET).remove(obsoleteChunks);
          next.decks = next.decks.filter(deck => deck.sourceFileId !== file.id).concat(newDecks);
          next.files[file.id] = { modifiedTime: file.modifiedTime, size: Number(file.size || 0), md5Checksum: file.md5Checksum || null, versionKey: fileVersionKey(file), status: 'done', cards: newDecks.reduce((n, d) => n + d.cardCount, 0), rejected: parsed.rejected, processedAt: new Date().toISOString() };
          const { error: completedSourceError } = await supabase.from('flashcard_sources').update({ import_status: 'completed', last_error: null, imported_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('drive_file_id', file.id);
          if (completedSourceError) throw new Error(`Falha marcando a origem como concluída: ${completedSourceError.message}`);
          const { error: completedJobError } = await supabase.from('flashcard_import_jobs').update({ status: parsed.rejected ? 'needs_review' : 'completed', cards_imported: next.files[file.id].cards, cards_rejected: parsed.rejected, finished_at: new Date().toISOString() }).eq('id', jobId);
          if (completedJobError) throw new Error(`Falha encerrando o job: ${completedJobError.message}`);
          status.processed += 1;
          status.cards += next.files[file.id].cards;
        } catch (error) {
          next.files[file.id] = { modifiedTime: file.modifiedTime, size: Number(file.size || 0), md5Checksum: file.md5Checksum || null, versionKey: fileVersionKey(file), status: 'error', error: String(error.message || error).slice(0, 500), processedAt: new Date().toISOString() };
          if (sourceSaved) await supabase.from('flashcard_sources').update({ import_status: 'failed', last_error: String(error.message || error).slice(0, 500), updated_at: new Date().toISOString() }).eq('drive_file_id', file.id).catch(() => {});
          if (jobSaved) await supabase.from('flashcard_import_jobs').update({ status: 'failed', error: String(error.message || error).slice(0, 500), finished_at: new Date().toISOString() }).eq('id', jobId).catch(() => {});
          console.error(`[Flashcards] Falha ao processar ${file.name}:`, error.message);
        } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
      }
      // Em modo push, só reconciliamos IDs presentes no lote de mudanças; no sync inicial
      // a lista completa continua sendo a fonte para remover itens que sumiram do Drive.
      const removedIds = incremental
        ? [...changedIds].filter(id => !present.has(id))
        : Object.keys(next.files).filter(id => !present.has(id));
      for (const id of removedIds) {
        const oldDecks = next.decks.filter(deck => deck.sourceFileId === id);
        const obsoleteChunks = oldDecks.flatMap(deck => deck.chunks || []);
        if (obsoleteChunks.length) await supabase.storage.from(BUCKET).remove(obsoleteChunks);
        next.decks = next.decks.filter(deck => deck.sourceFileId !== id);
        delete next.files[id];
      }
      const { error } = await supabase.storage.from(BUCKET).upload(MANIFEST_PATH, Buffer.from(JSON.stringify(next)), { contentType: 'application/json', upsert: true });
      if (error) throw new Error(`Falha publicando o índice de flashcards: ${error.message}`);
      const failed = Object.values(next.files).filter(file => file.status === 'error').length;
      status = { ...status, running: false, lastSuccess: new Date().toISOString(), lastError: failed ? `${failed} arquivo(s) aguardam correção ou repetição forçada.` : null, decks: next.decks.length, cards: next.decks.reduce((n, d) => n + d.cardCount, 0) };
      return { success: true, decks: status.decks, cards: status.cards, filesFound: found.length, filesPending: 0, filesFailed: failed };
    } catch (error) {
      status = { ...status, running: false, lastError: String(error.message || error) };
      throw error;
    } finally { syncPromise = null; }
  })();
  return syncPromise;
}

export async function readFlashcardManifest(supabase) {
  return await storageJson(supabase, BUCKET, MANIFEST_PATH) || { schemaVersion: 1, generatedAt: null, decks: [], files: {} };
}

export async function readFlashcardPage(supabase, deckId, offset = 0, limit = 100) {
  const manifest = await readFlashcardManifest(supabase);
  const deck = manifest.decks.find(item => item.id === deckId);
  if (!deck) return null;
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  if (safeOffset >= deck.cardCount) return { deck: { id: deck.id, name: deck.name, cardCount: deck.cardCount }, offset: safeOffset, limit: safeLimit, cards: [] };
  const first = Math.floor(safeOffset / PAGE_SIZE), last = Math.floor(Math.max(safeOffset, safeOffset + safeLimit - 1) / PAGE_SIZE);
  const cards = [];
  for (let chunk = first; chunk <= last; chunk++) {
    const payload = await storageJson(supabase, BUCKET, deck.chunks[chunk]);
    if (Array.isArray(payload)) cards.push(...payload);
  }
  const start = safeOffset % PAGE_SIZE;
  return { deck: { id: deck.id, name: deck.name, cardCount: deck.cardCount }, offset: safeOffset, limit: safeLimit, cards: cards.slice(start, start + safeLimit) };
}

export async function readFlashcardMedia(supabase, assetName) {
  const safeName = String(assetName || '').toLowerCase();
  if (!/^[a-f0-9]{64}\.(png|jpe?g|gif|webp|bmp)$/.test(safeName)) return null;
  const { data, error } = await supabase.storage.from(BUCKET).download(`library/media/${safeName}`);
  if (error || !data) return null;
  return { data: Buffer.from(await data.arrayBuffer()), contentType: mimeFromName(safeName) };
}

export function startFlashcardSyncScheduler(supabase) {
  if (!ROOTS.length || process.env.GOOGLE_DRIVE_FLASHCARDS_SYNC === 'false') return false;
  const run = () => syncDriveFlashcards(supabase).catch(error => console.error('[Flashcards] Sincronização automática falhou:', error.message));
  const timer = setTimeout(run, 15_000);
  timer.unref?.();
  // A carga inicial ocorre uma vez; atualizações posteriores chegam pelo webhook
  // do Drive. O catálogo completo só é rechecado pela reconciliação de segurança.
  return true;
}
