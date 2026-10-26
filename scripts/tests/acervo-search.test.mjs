import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAcervoSearchIndex, getAcervoFilterOptions, normalizeSearchText, searchAcervo } from '../../js/acervo-search.js';

const catalog = {
  videos: [
    {
      id: 'strategy-video-1', course: 'CURSINHOS', d: '01_Insufi.mp4', t: 'Insufi',
      path: 'CURSINHOS / Estratégia MED 2026 / Clínica Médica / Cardiologia / Insuficiência Cardíaca Congestiva / 01_Insufi.mp4'
    },
    {
      id: 'medcof-video-1', course: 'CURSINHOS', d: 'ICC e IC.mp4', t: 'ICC e IC',
      path: 'CURSINHOS / MEDCOF / MedCal Life Hacks [MedCof 2026] / Cardiologia / Insuficiência Cardíaca Congestiva / ICC e IC.mp4'
    }
  ],
  materials: [
    {
      id: 'strategy-pdf-1', course: 'BIBLIOTECA', d: 'Insuficiência Cardíaca.pdf', t: 'Insuficiência Cardíaca',
      path: 'BIBLIOTECA / Resumos / Estratégia MED / Cardiologia / Insuficiência Cardíaca.pdf'
    },
    {
      id: 'strategy-pdf-1', course: 'BIBLIOTECA', d: 'Insuficiência Cardíaca.pdf', t: 'Duplicata',
      path: 'BIBLIOTECA / Resumos / Estratégia MED / Cardiologia / Insuficiência Cardíaca.pdf'
    },
    { course: 'CURSINHOS', t: 'Sem identificador', path: 'CURSINHOS / sem-id.mp4' }
  ]
};

assert.equal(normalizeSearchText('Insuficiência Cardíaca'), 'insuficiencia cardiaca');
assert.equal(buildAcervoSearchIndex(catalog).length, 3, 'deduplicates by original file ID and skips records without IDs');

const exactTopic = searchAcervo(catalog, 'insuficiência cardíaca');
assert.equal(exactTopic.total, 3, 'searches title and full folder path');
assert.equal(exactTopic.items[0].id, 'strategy-pdf-1', 'exact title is ranked before path-only matches');

const misspelled = searchAcervo(catalog, 'cardiolgia');
assert.ok(misspelled.items.some(item => item.id === 'strategy-video-1'), 'tolerates a one-character typo in a path segment');

const acronym = searchAcervo(catalog, 'ICC');
assert.ok(acronym.items.some(item => item.id === 'strategy-video-1'), 'expands a common medical abbreviation to the full topic in the path');

const iamCatalog = {
  materials: [
    { id: 'iam-topic', course: 'BIBLIOTECA', t: 'Infarto Agudo do Miocárdio', path: 'BIBLIOTECA / Cardiologia / Infarto Agudo do Miocárdio.pdf' },
    { id: 'iam-acronym', course: 'BIBLIOTECA', t: 'IAM na urgência', path: 'BIBLIOTECA / Cardiologia / IAM na urgência.pdf' },
    { id: 'iam-noise', course: 'BIBLIOTECA', t: 'Infarto pulmonar', path: 'BIBLIOTECA / Pneumologia / Infarto pulmonar.pdf' },
    { id: 'stop-word-noise', course: 'BIBLIOTECA', t: 'Material do curso', path: 'BIBLIOTECA / Material do curso.pdf' }
  ]
};
const iamResults = searchAcervo(iamCatalog, 'IAM');
assert.equal(iamResults.total, 2, 'matches the acronym and its medical expansion without single-token noise');
assert.ok(iamResults.items.some(item => item.id === 'iam-topic'));
assert.ok(iamResults.items.some(item => item.id === 'iam-acronym'));

const metadataCatalog = {
  materials: [
    {
      id: 'metadata-only', course: 'Geral', t: 'Aula complementar', d: 'Aula.pdf', path: 'Geral / Aula.pdf',
      category: 'Cardiologia', tags: ['assunto:dispepsia']
    }
  ]
};
assert.equal(searchAcervo(metadataCatalog, 'cardiologia').items[0]?.id, 'metadata-only', 'searches catalog category metadata');
assert.equal(searchAcervo(metadataCatalog, 'dispepsia').items[0]?.id, 'metadata-only', 'searches catalog tags without requiring the term in title or path');

const contextual = searchAcervo(catalog, 'insuficiencia cardiaca', {
  course: 'Estratégia MED', discipline: 'Cardiologia', format: 'pdf', type: 'material'
});
assert.equal(contextual.total, 1, 'combines course, discipline, format and type filters');
assert.equal(contextual.items[0].id, 'strategy-pdf-1');

const options = getAcervoFilterOptions(catalog, 'MedCof');
assert.ok(options.disciplines.some(option => option.label === 'Cardiologia'), 'filters discipline options by selected nested course');
assert.ok(options.formats.some(option => option.label === 'mp4'));

const source = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
assert.match(source, /data-global-search-filter="course"/);
assert.match(source, /data-global-search-filter="discipline"/);
assert.match(source, /data-global-search-filter="format"/);
assert.match(source, /await import\('\/js\/acervo-search\.js'\)/);
assert.match(source, /data-global-search-more/);
assert.match(source, /await ac2Init\(\);[\s\S]{0,150}AC2\.indice\.has\(entry\.id\)/, 'search opens the existing course player only after the catalog is ready');
assert.match(source, /\['\/api\/isc\/search', '\/api\/acervo\/busca-semantica'\]/, 'global semantic search tries the curricular index and retains the legacy fallback');
assert.match(source, /course: globalSearchFilters\.course, discipline: globalSearchFilters\.discipline/, 'global semantic search forwards course and discipline filters');
assert.match(source, /e\.metaKey[\s\S]{0,80}e\.key\.toLowerCase\(\) === 'k'/, 'supports the Cmd/Ctrl+K shortcut');

console.log('OK — caminho completo, acentos, siglas, typo, deduplicação, filtros combinados e contrato da busca global.');
