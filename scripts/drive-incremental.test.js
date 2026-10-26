import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_DRIVE_FLASHCARDS_ROOTS = 'root-cards-id|Cartões';
const { packageFromChange } = await import('../src/drive-flashcards.js');

test('push change maps a package directly under its configured Drive root', async () => {
  const file = await packageFromChange({ file: { id: 'file-id', name: 'Cardio.apkg', size: '1000', modifiedTime: '2026-10-20T10:00:00Z', parents: ['root-cards-id'] } });
  assert.equal(file.id, 'file-id');
  assert.equal(file.path, 'Cartões/Cardio.apkg');
});

test('push change ignores deleted files and non-package files', async () => {
  assert.equal(await packageFromChange({ removed: true, fileId: 'old-file' }), null);
  assert.equal(await packageFromChange({ file: { id: 'pdf-id', name: 'Cards.pdf', parents: ['root-cards-id'] } }), null);
});
