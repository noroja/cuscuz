const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp']);
const COURSE_ALIASES = [
  ['Estratégia MED', /estrat[eé]gia\s*med|estrategiamed/i],
  ['MedCof', /med\s*cof|medcof/i],
  ['Medcurso', /med\s*curso|medcurso/i],
  ['MedGrupo', /med\s*grupo|medgrupo/i],
  ['Sanar', /sanar/i]
];
const SEARCH_SYNONYMS = {
  avc: 'acidente vascular cerebral',
  has: 'hipertensão arterial sistêmica',
  iam: 'infarto agudo do miocárdio',
  icc: 'insuficiência cardíaca congestiva'
};
const SYNONYM_STOP_WORDS = new Set(['a', 'as', 'ao', 'aos', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos']);
const SEARCH_COLLATOR = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const indexCache = new WeakMap();

export function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function pathParts(value) {
  return String(value || '').split(/\s*\/\s*/).map(part => part.trim()).filter(Boolean);
}

function fileExtension(item, path) {
  const candidates = [path, item.d, item.t, item.name];
  for (const value of candidates) {
    const match = String(value || '').match(/\.([a-z0-9]{1,8})(?:\?.*)?$/i);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function courseLabels(course, path) {
  const labels = new Set();
  if (course) labels.add(String(course).trim());
  const fullPath = `${course || ''} ${path || ''}`;
  for (const [label, pattern] of COURSE_ALIASES) {
    if (pattern.test(fullPath)) labels.add(label);
  }
  return [...labels].filter(Boolean);
}

function meaningfulDiscipline(item, parts) {
  const name = String(item.d || '').trim();
  const basename = parts.at(-1) || '';
  const stem = value => normalizeSearchText(String(value || '').replace(/\.[a-z0-9]{1,8}$/i, ''));
  if (name && !/\.[a-z0-9]{1,8}$/i.test(name) && stem(name) !== stem(basename)) return name;
  return parts.length > 2 ? parts.at(-2) : '';
}

function makeEntry(item, kind) {
  if (!item || !item.id) return null;
  const path = String(item.path || '');
  const parts = pathParts(path);
  const title = String(item.t || item.title || item.name || parts.at(-1) || 'Material').trim();
  const course = String(item.course || parts[0] || 'Geral').trim() || 'Geral';
  const ext = fileExtension(item, path);
  const type = kind === 'video' || VIDEO_EXTENSIONS.has(ext) ? 'video' : 'material';
  const folders = parts.slice(0, -1);
  const providers = courseLabels(course, path);
  const metadata = [item.category, item.semanticCategory, item.subject, item.topic, item.tags, item.semanticTags]
    .flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value);
  const discipline = meaningfulDiscipline(item, parts);
  const searchable = [title, item.d, item.course, path, ...providers, ...metadata].filter(Boolean).join(' ');
  const normalizedTitle = normalizeSearchText(title);
  const normalizedSearch = normalizeSearchText(searchable);

  return {
    id: String(item.id),
    title,
    type,
    format: ext,
    course,
    courseLabels: providers,
    normalizedCourseLabels: providers.map(normalizeSearchText),
    discipline,
    disciplineLabels: [...new Set([discipline, ...folders.slice(1)].filter(Boolean))],
    normalizedDisciplineLabels: [...new Set([discipline, ...folders.slice(1)].filter(Boolean))].map(normalizeSearchText),
    location: folders.join(' › ') || course,
    path,
    normalizedTitle,
    normalizedSearch,
    titleTokens: [...new Set(normalizedTitle.split(' ').filter(Boolean))],
    tokens: [...new Set(normalizedSearch.split(' ').filter(Boolean))]
  };
}

export function buildAcervoSearchIndex(catalog = {}) {
  if (!catalog || typeof catalog !== 'object') return [];
  const cached = indexCache.get(catalog);
  if (cached) return cached;

  const byId = new Map();
  for (const item of catalog.videos || []) {
    const entry = makeEntry(item, 'video');
    if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  for (const item of catalog.materials || catalog.apostilas || []) {
    const entry = makeEntry(item, 'material');
    if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  const index = [...byId.values()];
  indexCache.set(catalog, index);
  return index;
}

function editDistanceAtMostOne(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length > right.length) i++;
    else if (right.length > left.length) j++;
    else { i++; j++; }
  }
  return edits + (i < left.length || j < right.length ? 1 : 0) <= 1;
}

function tokenMatches(queryToken, entryTokens, normalizedText) {
  if (queryToken.length <= 3) return entryTokens.includes(queryToken);
  if (normalizedText.includes(queryToken)) return true;
  return queryToken.length >= 5 && entryTokens.some(token => editDistanceAtMostOne(queryToken, token));
}

function queryVariants(query) {
  const tokens = normalizeSearchText(query).split(' ').filter(Boolean);
  const expanded = tokens.flatMap(token => SEARCH_SYNONYMS[token]
    ? normalizeSearchText(SEARCH_SYNONYMS[token]).split(' ')
    : [token]).filter(token => !SYNONYM_STOP_WORDS.has(token));
  return [tokens, expanded].filter((variant, index, all) => variant.length && all.findIndex(other => other.join(' ') === variant.join(' ')) === index);
}

function scoreEntry(entry, query, variants, phrase) {
  let best = 0;
  for (const tokens of variants) {
    const matchesInTitle = tokens.filter(token => tokenMatches(token, entry.titleTokens, entry.normalizedTitle)).length;
    const matchesAnywhere = tokens.filter(token => tokenMatches(token, entry.tokens, entry.normalizedSearch)).length;
    const minimumPartialMatches = Math.ceil(tokens.length / 2);
    const score = phrase && entry.normalizedTitle === phrase ? 1000
      : phrase && entry.normalizedTitle.startsWith(phrase) ? 850
      : matchesInTitle === tokens.length ? 700 + tokens.length
      : matchesAnywhere === tokens.length ? 400 + matchesInTitle * 20 + tokens.length
      : matchesAnywhere >= minimumPartialMatches ? 100 * matchesAnywhere / tokens.length + matchesInTitle * 10
      : 0;
    best = Math.max(best, score);
  }
  return best;
}

function matchesFilter(entry, filters) {
  const course = filters.course;
  if (course && !entry.normalizedCourseLabels.includes(course)) return false;

  const discipline = filters.discipline;
  if (discipline && !entry.normalizedDisciplineLabels.some(value => value === discipline || value.includes(discipline))) return false;

  const format = filters.format;
  if (format && normalizeSearchText(entry.format) !== format) return false;
  if (filters.type && entry.type !== filters.type) return false;
  return true;
}

export function searchAcervo(catalog, query, filters = {}, limit = 40) {
  const normalizedQuery = normalizeSearchText(query);
  const activeFilter = !!(filters.course || filters.discipline || filters.format || filters.type);
  if (normalizedQuery.length < 2 && !activeFilter) return { total: 0, items: [] };
  const normalized = {
    course: normalizeSearchText(filters.course),
    discipline: normalizeSearchText(filters.discipline),
    format: normalizeSearchText(filters.format),
    type: filters.type || ''
  };
  const variants = normalizedQuery.length >= 2 ? queryVariants(query) : [];

  const matched = [];
  for (const entry of buildAcervoSearchIndex(catalog)) {
    if (!matchesFilter(entry, normalized)) continue;
    const score = normalizedQuery.length >= 2 ? scoreEntry(entry, query, variants, normalizedQuery) : 1;
    if (score > 0) matched.push({ ...entry, score });
  }
  matched.sort((a, b) => b.score - a.score || SEARCH_COLLATOR.compare(a.title, b.title));
  return { total: matched.length, items: matched.slice(0, Math.max(1, limit)) };
}

export function getAcervoEntriesByIds(catalog, ids, filters = {}, limit = 40) {
  const wanted = new Map((ids || []).map((value, index) => [String(value?.id || value), index]));
  const normalized = {
    course: normalizeSearchText(filters.course),
    discipline: normalizeSearchText(filters.discipline),
    format: normalizeSearchText(filters.format),
    type: filters.type || ''
  };
  return buildAcervoSearchIndex(catalog)
    .filter(entry => wanted.has(entry.id) && matchesFilter(entry, normalized))
    .sort((a, b) => wanted.get(a.id) - wanted.get(b.id))
    .slice(0, Math.max(1, limit));
}

export function getAcervoFilterOptions(catalog, selectedCourse = '') {
  const entries = buildAcervoSearchIndex(catalog);
  const courses = new Map();
  const disciplines = new Map();
  const formats = new Map();
  const types = new Map();
  const courseFilter = normalizeSearchText(selectedCourse);

  for (const entry of entries) {
    for (const label of entry.courseLabels) courses.set(label, (courses.get(label) || 0) + 1);
    if (courseFilter && !entry.normalizedCourseLabels.includes(courseFilter)) continue;
    for (const label of entry.disciplineLabels) disciplines.set(label, (disciplines.get(label) || 0) + 1);
    if (entry.format) formats.set(entry.format, (formats.get(entry.format) || 0) + 1);
    types.set(entry.type, (types.get(entry.type) || 0) + 1);
  }

  const sortOptions = map => [...map].map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' }));
  return {
    courses: sortOptions(courses),
    disciplines: sortOptions(disciplines).slice(0, 250),
    formats: sortOptions(formats),
    types: sortOptions(types)
  };
}

if (typeof window !== 'undefined') {
  window.CuscuzAcervoSearch = { normalizeSearchText, buildAcervoSearchIndex, searchAcervo, getAcervoEntriesByIds, getAcervoFilterOptions };
}
