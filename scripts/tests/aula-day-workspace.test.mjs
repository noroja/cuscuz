import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [aula, html, css] = await Promise.all([
  readFile(new URL('../../aula-dia.js', import.meta.url), 'utf8'),
  readFile(new URL('../../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../../css/cuscuz-brand.css', import.meta.url), 'utf8')
]);

for (const label of ['Materiais', 'Índice curricular', 'Comparar aulas', 'Estudar']) assert.ok(aula.includes(`label: '${label}'`), `workspace expõe a etapa ${label}`);
for (const method of ['filtrarHistorico', 'selecionarSlidesSetup', 'processarSlidesPendentes']) assert.ok(aula.includes(`${method},`), `aula-dia expõe ${method}`);
assert.ok(aula.includes('role="tabpanel" tabindex="0"'), 'painel de conteúdo pode receber foco');
assert.ok(aula.includes('@media(max-width:900px)') && aula.includes('@media(max-width:600px)'), 'workspace adapta layout para viewport menor');
assert.ok(aula.includes('aria-live="polite"'), 'estados assíncronos são anunciados');

for (const field of ['ac2-q-count', 'ac2-q-mode', 'ac2-q-difficulty', 'ac2-q-unanswered', 'ac2-q-complementary']) assert.ok(html.includes(`id="${field}"`), `Smart Questions oferece o filtro ${field}`);
assert.ok(html.includes('ac2-q-coverage') && html.includes('ac2-q-topics'), 'a interface mostra cobertura e distribuição por objetivo');
assert.ok(html.includes('aria-label="Quantidade de questões"') && html.includes('aria-label="Dificuldade das questões"'), 'filtros possuem nomes acessíveis');
assert.match(css, /\.ac2-mat-content \.btn-praticar-questoes-tema\{[^}]*background:var\(--teal\)!important;[^}]*color:var\(--text-inverse\)!important/s, 'CTA usa contraste explícito da marca');

console.log('OK — Aula do Dia: estrutura de workspace, controles, estados, responsividade, acessibilidade e CTA de questões.');
