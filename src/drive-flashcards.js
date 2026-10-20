import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Apkg } from 'anki-apkg-parser';
import { authHeaders, cleanDriveId, driveFetchWithRetry, temConta } from './drive-auth.js';

const BUCKET = 'flashcards-library';
const MANIFEST_PATH = 'library/manifest.json';
const PAGE_SIZE = 500;
const positiveInt = (value, fallback) => { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; };
const MAX_PACKAGE_BYTES = positiveInt(process.env.FLASHCARD_MAX_PACKAGE_BYTES, 6 * 1024 ** 3);
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

export function mapNoteCard(note, card, model, packageFile, deckName) {
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
  const cloze = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/gs;
  if (Number(model?.type) === 1 || /cloze/i.test(String(model?.name || ''))) {
    const answers = [];
    for (const value of values) {
      for (const match of value.matchAll(cloze)) if (Number(match[1]) === Number(card.ord) + 1) answers.push(match[2]);
    }
    if (!front || front === qfmt) front = values.join(' ');
    front = front.replace(cloze, (m, n, answer, hint) => Number(n) === Number(card.ord) + 1 ? (hint ? `[${hint}]` : '[…]') : answer);
    if (answers.length) back = `${cleanText(back)}\n\nResposta: ${cleanText(answers.join('; '))}`;
  }
  front = cleanText(front);
  back = cleanText(back);
  if (!front || !back) return null;
  const tags = String(note.tags || '').trim().split(/\s+/).filter(Boolean);
  const sourceKey = `${packageFile.id}:${note.id}:${card.ord}`;
  return {
    id: hash(sourceKey), front, back,
    subject: tags[0] || deckName,
    topic: tags[1] || '', tags,
    source: { driveFileId: packageFile.id, packageName: packageFile.name, drivePath: packageFile.path, noteId: String(note.id), cardTemplate: Number(card.ord) }
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
      const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)');
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

export async function packageFromChange(change) {
  const file = change?.file;
  if (!file?.id || !/\.(apkg|colpkg)$/i.test(file.name || '') || file.trashed) return null;
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
        const converted = mapNoteCard(note, card, models?.[row.modelId], file, deckName);
        if (!converted) { rejected++; continue; }
        const key = String(row.deckId || 'default');
        if (!grouped.has(key)) grouped.set(key, { id: hash(`${file.id}:${key}`).slice(0, 24), name: deckName, cards: [], chunks: [], cardCount: 0 });
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

async function flushDeckChunk(supabase, deck) {
  if (!deck.cards.length) return;
  const index = deck.chunks.length;
  const objectPath = `library/decks/${deck.id}/${index}.json`;
  const payload = Buffer.from(JSON.stringify(deck.cards));
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
      if (!supabase || !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) throw new Error('A ingestão exige SUPABASE_URL e uma chave Supabase (SUPABASE_SERVICE_ROLE_KEY ou SUPABASE_ANON_KEY).');
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
        : await listPackageFiles(ROOTS)).sort((a, b) => Number(a.size || 0) - Number(b.size || 0));
      const present = new Set(found.map(file => file.id));
      const pending = incremental ? found : found.filter(file => force || next.files[file.id]?.modifiedTime !== file.modifiedTime);
      if (incremental && !found.length && ![...changedIds].some(id => next.files[id])) {
        status = { ...status, running: false, lastSuccess: new Date().toISOString(), lastError: null };
        return { success: true, unchanged: true, decks: next.decks.length, cards: next.decks.reduce((n, deck) => n + deck.cardCount, 0), filesFound: 0, filesPending: 0, filesFailed: 0 };
      }
      for (const file of pending) {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cuscuz-anki-'));
        const archive = path.join(scratch, 'source' + path.extname(file.name).toLowerCase());
        try {
          await downloadPackage(file, archive);
          const parsed = await extractPackage(supabase, file, archive, scratch);
          const oldDecks = next.decks.filter(deck => deck.sourceFileId === file.id);
          const newDecks = parsed.decks.map(deck => ({ ...deck, sourceFileId: file.id, sourceName: file.name, sourcePath: file.path, modifiedTime: file.modifiedTime }));
          const activeChunks = new Set(newDecks.flatMap(deck => deck.chunks));
          const obsoleteChunks = oldDecks.flatMap(deck => deck.chunks || []).filter(chunk => !activeChunks.has(chunk));
          if (obsoleteChunks.length) await supabase.storage.from(BUCKET).remove(obsoleteChunks);
          next.decks = next.decks.filter(deck => deck.sourceFileId !== file.id).concat(newDecks);
          next.files[file.id] = { modifiedTime: file.modifiedTime, status: 'done', cards: newDecks.reduce((n, d) => n + d.cardCount, 0), rejected: parsed.rejected, processedAt: new Date().toISOString() };
          status.processed += 1;
          status.cards += next.files[file.id].cards;
        } catch (error) {
          next.files[file.id] = { modifiedTime: file.modifiedTime, status: 'error', error: String(error.message || error).slice(0, 500), processedAt: new Date().toISOString() };
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

export function startFlashcardSyncScheduler(supabase) {
  if (!ROOTS.length || process.env.GOOGLE_DRIVE_FLASHCARDS_SYNC === 'false') return false;
  const run = () => syncDriveFlashcards(supabase).catch(error => console.error('[Flashcards] Sincronização automática falhou:', error.message));
  const timer = setTimeout(run, 15_000);
  timer.unref?.();
  // A carga inicial ocorre uma vez; atualizações posteriores chegam pelo webhook
  // do Drive. O catálogo completo só é rechecado pela reconciliação de segurança.
  return true;
}
