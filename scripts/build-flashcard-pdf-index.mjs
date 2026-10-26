import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'acervo-manifest.json'), 'utf8'));
const files = [...new Map((manifest.materials || [])
  .filter(item => /\.pdf$/i.test(item.path || '') && /(?:^|[\\/\s_-])flashcards?(?:[\\/(\s_-]|$)/i.test(`${item.path || ''}/${item.t || ''}`))
  .filter(item => /^[A-Za-z0-9_-]{10,}$/.test(String(item.id || '')))
  .map(item => [item.id, { id: item.id, name: `${item.t || path.basename(item.path, '.pdf')}.pdf`.replace(/\.pdf\.pdf$/i, '.pdf'), path: item.path, course: item.course || '', subject: item.d || '' }]))
  .values()];
const output = { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceInventory: 'acervo-manifest.json', files };
fs.writeFileSync(path.join(root, 'data', 'flashcard-pdf-index.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`Índice de PDFs de flashcards: ${files.length} arquivos.`);
