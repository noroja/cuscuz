/* Copia os assets estáticos para public/ antes do deploy na Vercel.
   A Vercel ignora express.static() e serve apenas o diretório public/** pelo CDN.
   Rode com: node scripts/build-public.js  (ou "npm run build"). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const arquivos = [
  'index.html', 'aula.html', 'pdf-viewer.html', 'home.html', 'liquid-glass.html', 'app-cuscuzmed.html',
  'planner-v2.js', 'aula-dia.js',
  'manifest.webmanifest', 'icon-512.png', 'apple-touch-icon.png',
  '3457_False_a.png', '3457_True_a.png'
];
const pastas = ['css', 'js', 'assets'];

let copiados = 0;
for (const f of arquivos) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(out, f));
  copiados++;
}
for (const d of pastas) {
  const src = path.join(root, d);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(out, d), { recursive: true });
  copiados++;
}

const vendor = path.join(out, 'js', 'vendor');
fs.mkdirSync(vendor, { recursive: true });
for (const [source, target] of [
  ['markdown-it/dist/browser/markdown-it.umd.min.js', 'markdown-it.min.js'],
  ['dompurify/dist/purify.min.js', 'purify.min.js']
]) fs.copyFileSync(path.join(root, 'node_modules', source), path.join(vendor, target));
console.log(`[build-public] ${copiados} itens copiados para public/`);
