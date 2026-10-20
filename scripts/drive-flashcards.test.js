import test from 'node:test';
import assert from 'node:assert/strict';
import { mapNoteCard, readFlashcardPage } from '../src/drive-flashcards.js';

const file = { id: 'drive-file-1', name: 'deck.apkg', path: 'flashcards/deck.apkg' };

test('converts a basic Anki template to stable, tagged, plain-text cards', () => {
  const note = { id: 42, mid: 7, tags: 'Cardiologia Arritmia', flds: '<b>Qual a conduta?</b>\x1f<script>alert(1)</script> Cardioversão' };
  const model = { name: 'Basic', flds: [{ name: 'Front' }, { name: 'Back' }], tmpls: [{ ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id="answer">{{Back}}' }] };
  const card = { id: 1, ord: 0, did: 3 };
  const converted = mapNoteCard(note, card, model, file, 'Cardiologia');

  assert.equal(converted.front, 'Qual a conduta?');
  assert.equal(converted.back, 'Qual a conduta? Cardioversão');
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
