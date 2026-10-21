// Creates a small, synthetic Anki export for deterministic end-to-end tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';

const root = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(root, 'collection.anki2');
const output = path.join(root, 'synthetic-cards.apkg');
const models = {
  100: { id: 100, name: 'Basic two templates', type: 0, flds: [{ name: 'Front' }, { name: 'Back' }], tmpls: [
    { name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' },
    { name: 'Card 2', ord: 1, qfmt: '{{Back}}', afmt: '{{Front}}' }
  ] },
  101: { id: 101, name: 'Cloze', type: 1, flds: [{ name: 'Text' }], tmpls: [
    { name: 'Cloze 1', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}' }
  ] }
};
const decks = { 200: { id: 200, name: 'Cardiologia::Fixture' } };
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
  CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
  CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
`);
db.prepare('INSERT INTO col VALUES (1,0,0,0,11,0,0,0,?,?,?,?,?)').run('{}', JSON.stringify(models), JSON.stringify(decks), '{}', '{}');
db.prepare('INSERT INTO notes VALUES (1,\'basic-guid\',100,0,0,\'Cardiologia Ritmo\',?,?,0,0,\'\')').run('Qual o ritmo? <img src="0">\x1f<b>Sinusal</b>', 'Qual o ritmo? <img src="0">');
db.prepare('INSERT INTO notes VALUES (2,\'cloze-guid\',101,0,0,\'Cardiologia\',?,?,0,0,\'\')').run('A frequência normal é {{c1::60–100 bpm::faixa}}.', 'A frequência normal é {{c1::60–100 bpm::faixa}}.');
const addCard = db.prepare("INSERT INTO cards VALUES (?, ?, 200, ?, 0,0,0,0,0,0,2500,0,0,0,0,0,0,'')");
for (const row of [[11, 1, 0], [12, 1, 1], [13, 2, 0]]) addCard.run(...row);
db.close();

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
function writeZip(target, inputs) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const [filename, data] of inputs) {
    const name = Buffer.from(filename);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    localParts.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(inputs.length, 8); end.writeUInt16LE(inputs.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(target, Buffer.concat([...localParts, centralDirectory, end]));
}
writeZip(output, [
  ['collection.anki2', fs.readFileSync(dbPath)],
  ['media', Buffer.from(JSON.stringify({ 0: 'heart.png' }))],
  ['0', png]
]);
writeZip(path.join(root, 'path-traversal.apkg'), [['../escape.txt', Buffer.from('unsafe')]]);
fs.unlinkSync(dbPath);
console.log(output);
