import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPackage, mapNoteCard, readFlashcardMedia, readFlashcardPage, validatePackageArchive } from '../src/drive-flashcards.js';

const file = { id: 'drive-file-1', name: 'deck.apkg', path: 'flashcards/deck.apkg' };

test('converts a basic Anki template to stable, tagged, plain-text cards', () => {
  const note = { id: 42, mid: 7, tags: 'Cardiologia Arritmia', flds: '<b>Qual a conduta?</b>\x1f<script>alert(1)</script> Cardioversão' };
  const model = { name: 'Basic', flds: [{ name: 'Front' }, { name: 'Back' }], tmpls: [{ ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id="answer">{{Back}}' }] };
  const card = { id: 1, ord: 0, did: 3 };
  const converted = mapNoteCard(note, card, model, file, 'Cardiologia');

  assert.equal(converted.front, 'Qual a conduta?');
  assert.equal(converted.back, 'Qual a conduta? Cardioversão');
  assert.doesNotMatch(converted.backHtml, /<script|alert\(1\)/i);
  assert.deepEqual(converted.tags, ['Cardiologia', 'Arritmia']);
  assert.equal(converted.subject, 'Cardiologia');
  assert.match(converted.id, /^[a-f0-9]{64}$/);
  assert.equal(converted.id, mapNoteCard(note, card, model, file, 'Cardiologia').id);
});

test('converts the active cloze deletion into a prompt and includes its answer', () => {
  const note = { id: 9, mid: 10, tags: 'Fisiologia', flds: 'A pressão depende de {{c1::débito cardíaco::qual variável}} e resistência.' };
  const model = { name: 'Cloze', type: 1, flds: [{ name: 'Text' }], tmpls: [{ ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}' }] };
  const converted = mapNoteCard(note, { id: 11, ord: 0, did: 4 }, model, file, 'Cloze');

  assert.match(converted.front, /\[qual variável\]/);
  assert.match(converted.back, /Resposta: débito cardíaco/);
});

test('rejects cards with an empty side', () => {
  const note = { id: 1, mid: 1, tags: '', flds: 'Pergunta\x1f' };
  const model = { flds: [{ name: 'Front' }, { name: 'Back' }], tmpls: [{ ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' }] };
  assert.equal(mapNoteCard(note, { ord: 0 }, model, file, 'Deck'), null);
});

test('reads a page spanning two stored chunks without returning adjacent cards', async () => {
  const cards = Array.from({ length: 501 }, (_, index) => ({ id: String(index), front: `Q${index}`, back: `A${index}` }));
  const objects = {
    'library/manifest.json': { schemaVersion: 1, decks: [{ id: 'deck-1', name: 'Deck', cardCount: cards.length, chunks: ['chunk-0', 'chunk-1'] }] },
    'chunk-0': cards.slice(0, 500),
    'chunk-1': cards.slice(500)
  };
  const supabase = { storage: { from: () => ({ download: async key => ({ data: { text: async () => JSON.stringify(objects[key]) }, error: null }) }) } };
  const page = await readFlashcardPage(supabase, 'deck-1', 499, 2);

  assert.deepEqual(page.cards.map(card => card.id), ['499', '500']);
  assert.equal(page.deck.cardCount, 501);
});

test('extracts a real synthetic APKG with two templates, cloze and referenced image', async () => {
  const archive = path.join(import.meta.dirname, 'fixtures', 'synthetic-cards.apkg');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cuscuz-apkg-test-'));
  const objects = new Map();
  const tables = new Map();
  const supabase = {
    storage: { from: bucket => ({
      upload: async (key, data, options) => { objects.set(`${bucket}/${key}`, { data: Buffer.from(data), options }); return { error: null }; },
      download: async key => { const object = objects.get(`flashcards-library/${key}`); return object ? { data: { arrayBuffer: async () => object.data }, error: null } : { data: null, error: { message: 'missing' } }; }
    }) },
    from: table => ({ upsert: async rows => { tables.set(table, [...(tables.get(table) || []), ...(Array.isArray(rows) ? rows : [rows])]); return { error: null }; } })
  };
  try {
    const limits = await validatePackageArchive(archive);
    assert.equal(limits.entries, 3);
    const parsed = await extractPackage(supabase, file, archive, scratch);
    assert.equal(parsed.decks.length, 1);
    assert.equal(parsed.decks[0].cardCount, 3);
    const chunk = JSON.parse(objects.get('flashcards-library/' + parsed.decks[0].chunks[0]).data.toString('utf8'));
    assert.equal(chunk.length, 3);
    assert.equal(chunk.filter(card => card.source.cardTemplate === 0).length, 2);
    const basic = chunk.find(card => card.source.cardTemplate === 0 && card.type === 'basic');
    assert.match(basic.frontHtml, /<img[^>]+\/api\/flashcards\/library\/media\/[a-f0-9]{64}\.png/);
    assert.equal(basic.media.length, 1);
    assert.equal(chunk.find(card => card.type === 'cloze').cloze.index, 1);
    const cloze = chunk.find(card => card.type === 'cloze');
    assert.match(cloze.frontHtml, /\[faixa\]/);
    assert.match(cloze.back, /Resposta: 60–100 bpm/);
    assert.equal(tables.get('flashcard_notes').length, 2);
    assert.equal(tables.get('flashcards').length, 3);
    assert.equal(tables.get('flashcard_media_links').length, 2);
    const assetName = basic.media[0].url.split('/').at(-1);
    const media = await readFlashcardMedia(supabase, assetName);
    assert.equal(media.contentType, 'image/png');
    assert.ok(media.data.length > 20);
    assert.equal(await readFlashcardMedia(supabase, '../unsafe.png'), null);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('rejects an APKG archive that contains a path traversal entry', async () => {
  const archive = path.join(import.meta.dirname, 'fixtures', 'path-traversal.apkg');
  await assert.rejects(() => validatePackageArchive(archive), /(caminho inseguro|relative path)/);
});
