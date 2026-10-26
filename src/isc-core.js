import { createHash } from 'node:crypto';

export const ISC_INDEX_VERSION = 1;
export const ISC_VECTOR_DIMENSIONS = 1024;

export function normalizeIscText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function slugIsc(value) {
  return normalizeIscText(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'sem-rotulo';
}

export function hashIsc(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function removeFileNoise(value) {
  return String(value || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/^\s*[#\d\s._-]+/, '')
    .replace(/\b(aula|videoaula|resumo|completa|completo|parte|módulo|modulo)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function pathParts(value) {
  return String(value || '').split(/\s+\/\s+|\//).map(part => part.trim()).filter(Boolean);
}

function normalizedTermMatches(normalizedText, normalizedTerm) {
  if (!normalizedText || !normalizedTerm) return false;
  if (normalizedTerm.length < 4 && normalizedTerm.split(' ').length === 1) return false;
  return (` ${normalizedText} `).includes(` ${normalizedTerm} `);
}

function termMatches(text, term) {
  return normalizedTermMatches(normalizeIscText(text), normalizeIscText(term));
}

const compiledTaxonomyTerms = new WeakMap();
function getCompiledTaxonomyTerms(taxonomy) {
  const cached = compiledTaxonomyTerms.get(taxonomy);
  if (cached) return cached;
  const terms = (taxonomy.nodes || []).filter(node => node.kind !== 'learning_objective' && node.origin === 'curated')
    .map(node => ({ node, terms: [node.name, ...(node.synonyms || [])]
      .map(value => ({ value, normalized: normalizeIscText(value) }))
      .filter(term => term.normalized) }));
  compiledTaxonomyTerms.set(taxonomy, terms);
  return terms;
}

function findDisciplineNode(node, nodes) {
  let current = node;
  const byId = new Map(nodes.map(item => [item.id, item]));
  while (current && current.kind !== 'discipline') current = byId.get(current.parentId);
  return current || null;
}

function curatedMatches(texts, taxonomy) {
  const found = new Map();
  const normalizedSources = texts.map(source => ({
    ...source,
    normalized: normalizeIscText(source.text),
    normalizedClean: source.kind === 'path' ? normalizeIscText(removeFileNoise(source.text)) : ''
  }));
  for (const { node, terms } of getCompiledTaxonomyTerms(taxonomy)) {
    for (const source of normalizedSources) {
      const term = terms.find(value => normalizedTermMatches(source.normalized, value.normalized));
      if (!term) continue;
      const exactFolder = source.kind === 'path' && source.normalizedClean === term.normalized;
      const confidence = exactFolder ? 0.9 : source.kind === 'title' ? 0.82 : source.kind === 'content' ? 0.8 : 0.76;
      const previous = found.get(node.id);
      if (!previous || confidence > previous.confidence) found.set(node.id, {
        node, confidence, sourceKind: source.kind === 'title' ? 'catalog_title' : source.kind === 'content' ? source.contentKind : 'catalog_path',
        sourceRef: source.ref, excerpt: source.text.slice(0, 320)
      });
      break;
    }
  }
  return found;
}

const GENERIC_PATH = /^(?:aula|aulas|videoaula|videoaulas|resumo|resumos|apostila|apostilas|material|materiais|pdf|cursinho|cursinhos|extensivo|intensivo|modulo|módulo|curso|cursos|revisao|revisão|questoes|questões|flashcards?|parte|introducao|introdução|cronograma|atualizacoes|atualizações)(?:\s|$)/i;
const YEAR_PATH = /\b(?:19|20)\d{2}(?:\.\d+)?\b/;

function candidatePathNodes(pathSegments, discipline, taxonomy, matched) {
  const disciplineAliases = [discipline.name, ...(discipline.synonyms || [])];
  const normalizedDisciplineAliases = new Set(disciplineAliases.map(normalizeIscText));
  const normalizedPathSegments = pathSegments.map((part, index) => ({
    part, index, cleaned: removeFileNoise(part), normalized: normalizeIscText(removeFileNoise(part))
  }));
  const disciplineIndex = normalizedPathSegments.findIndex(part => normalizedDisciplineAliases.has(part.normalized));
  if (disciplineIndex < 0) return [];
  const knownForDiscipline = new Set([...matched.values()].map(entry => entry.node.id));
  const knownTerms = [...matched.values()].flatMap(entry => [entry.node.name, ...(entry.node.synonyms || [])])
    .map(normalizeIscText).filter(Boolean);
  const candidates = [];
  for (const segment of normalizedPathSegments.slice(disciplineIndex + 1, -1)) {
    const cleaned = segment.cleaned.replace(/^#\s*/, '').trim();
    const normalized = normalizeIscText(cleaned);
    if (normalized.length < 4 || GENERIC_PATH.test(cleaned) || YEAR_PATH.test(cleaned)) continue;
    const alreadyKnown = knownTerms.some(alias => alias === normalized || normalizedTermMatches(normalized, alias));
    if (alreadyKnown) continue;
    const id = `isc.candidate.${slugIsc(discipline.name)}.${slugIsc(cleaned)}`;
    if (knownForDiscipline.has(id)) continue;
    const node = {
      id, kind: 'subject', parentId: discipline.id, name: cleaned.slice(0, 180), synonyms: [],
      origin: 'catalog_path', canonical: false, confidence: 0.45
    };
    candidates.push({ node, confidence: 0.45, sourceKind: 'catalog_path', sourceRef: `catalog.path:${segment.index}`, excerpt: segment.part.slice(0, 320) });
    knownForDiscipline.add(id);
    if (candidates.length >= 2) break;
  }
  return candidates;
}

export function buildIscCatalogResource(item, kind, taxonomy, catalogGeneratedAt = '') {
  const resourceId = String(item?.id || '').trim();
  const title = String(item?.t || item?.title || item?.name || item?.d || 'Material do acervo').trim().slice(0, 240);
  const course = String(item?.course || item?.curso || 'Geral').trim().slice(0, 120);
  const sourcePath = String(item?.path || '').trim().slice(0, 1000);
  if (!resourceId || !['video', 'material'].includes(kind)) return null;
  const metadata = {
    mimeType: String(item?.mimeType || '').slice(0, 120),
    category: String(item?.category || '').slice(0, 120),
    tags: Array.isArray(item?.tags) ? item.tags.map(tag => String(tag).slice(0, 100)).slice(0, 30) : []
  };

  const pathSegments = pathParts(sourcePath);
  const matchSources = [
    { kind: 'title', ref: 'catalog.title', text: removeFileNoise(title) },
    ...pathSegments.map((text, index) => ({ kind: 'path', ref: `catalog.path:${index}`, text: removeFileNoise(text) }))
  ];
  const matched = curatedMatches(matchSources, taxonomy);
  const disciplines = [...matched.values()].filter(entry => entry.node.kind === 'discipline').map(entry => entry.node);
  const disciplinesById = new Map(disciplines.map(node => [node.id, node]));
  for (const entry of [...matched.values()]) {
    const discipline = findDisciplineNode(entry.node, taxonomy.nodes || []);
    if (discipline && !disciplinesById.has(discipline.id)) {
      disciplinesById.set(discipline.id, discipline);
      matched.set(discipline.id, { node: discipline, confidence: Math.min(entry.confidence, 0.8), sourceKind: entry.sourceKind, sourceRef: entry.sourceRef, excerpt: entry.excerpt });
    }
  }

  const inferredDiscipline = [...disciplinesById.values()][0] || null;
  const candidateNodes = inferredDiscipline ? candidatePathNodes(pathSegments, inferredDiscipline, taxonomy, matched) : [];
  for (const candidate of candidateNodes) matched.set(candidate.node.id, candidate);

  const topicEvidence = [...matched.values()].filter(entry => entry.node.kind !== 'discipline')
    .map(entry => ({
      topicId: entry.node.id,
      sourceKind: entry.sourceKind,
      sourceRef: entry.sourceRef,
      excerpt: entry.excerpt,
      confidence: entry.confidence,
      coverageLevel: null,
      depthLevel: null,
      sourceHash: ''
    }));
  const taxonomyTopicIds = [...new Set([...matched.keys()])].sort();
  const taxonomySignatures = taxonomyTopicIds.map(id => {
    const node = (taxonomy.nodes || []).find(entry => entry.id === id) || candidateNodes.find(entry => entry.node.id === id)?.node;
    return [id, node?.name || '', node?.synonyms || []];
  });
  const sourceHash = hashIsc({ title, course, sourcePath, kind, metadata, taxonomyVersion: taxonomy.version || 1, taxonomySignatures, indexVersion: ISC_INDEX_VERSION });
  for (const evidence of topicEvidence) evidence.sourceHash = sourceHash;

  const segments = topicEvidence.map((evidence, segmentIndex) => {
    const node = (taxonomy.nodes || []).find(topic => topic.id === evidence.topicId) || candidateNodes.find(topic => topic.node.id === evidence.topicId)?.node;
    const discipline = node ? findDisciplineNode(node, [...(taxonomy.nodes || []), ...candidateNodes.map(candidate => candidate.node)]) : null;
    const text = [
      `Material: ${title}`,
      course && `Curso: ${course}`,
      discipline && `Disciplina: ${discipline.name}`,
      node && `Tópico curricular: ${node.name}`,
      `Origem: ${evidence.excerpt}`
    ].filter(Boolean).join('\n');
    return {
      segmentIndex, topicIds: [evidence.topicId], sourceKind: 'catalog_metadata', sourceHash,
      sourceRef: evidence.sourceRef, excerpt: evidence.excerpt, text,
      sourceStart: null, sourceEnd: null, sourcePage: null, timestampStart: null, timestampEnd: null,
      confidence: evidence.confidence
    };
  });

  const confidence = topicEvidence.length ? Math.max(...topicEvidence.map(entry => entry.confidence)) : null;
  return {
    resource: {
      resourceKey: `${kind}:${resourceId}`, resourceId, resourceKind: kind, title, course, sourcePath,
      sourceHash, indexerVersion: ISC_INDEX_VERSION, sourceKind: 'catalog_metadata',
      indexStatus: segments.length ? 'metadata_indexed' : 'insufficient_evidence',
      metadataConfidence: confidence, taxonomyTopicIds, catalogGeneratedAt: catalogGeneratedAt || null,
      scope: 'catalog', ownerUsername: null, isActive: true, metadata
    },
    taxonomyNodes: candidateNodes.map(candidate => candidate.node),
    topics: topicEvidence,
    segments
  };
}

export function buildIscUserResource({ text, sourceKind = 'transcript', title, course = '', resourceId, username, taxonomy, sourcePages = [] }) {
  const sourceText = String(text || '');
  if (!sourceText.trim() || !['transcript', 'pdf_text', 'slides'].includes(sourceKind)) return null;
  const safeTitle = String(title || 'Aula do Dia').trim().slice(0, 240) || 'Aula do Dia';
  const safeCourse = String(course || '').trim().slice(0, 120);
  const safeUsername = String(username || '').trim().toLowerCase();
  const safeResourceId = String(resourceId || '').trim();
  if (!safeUsername || !safeResourceId || !taxonomy?.nodes) return null;
  const pages = Array.isArray(sourcePages) ? sourcePages.filter(page => page && typeof page === 'object' && Number.isInteger(page.page) && page.page > 0 &&
    Number.isInteger(page.start) && Number.isInteger(page.end) && page.start >= 0 && page.end > page.start && page.end <= sourceText.length)
    .sort((a, b) => a.start - b.start).slice(0, 500) : [];
  const pageForOffset = offset => pages.find(page => offset >= page.start && offset < page.end)?.page ?? null;
  const segments = segmentIscText(sourceText, { maxChars: 1800, overlap: 180, sourceKind });
  const sourceHash = hashIsc({ title: safeTitle, course: safeCourse, sourceKind, text: sourceText,
    sourcePages: pages.map(({ page, start, end }) => [page, start, end]), indexVersion: ISC_INDEX_VERSION });
  const topicById = new Map();
  const indexedSegments = segments.map((segment, segmentIndex) => {
    const sourcePage = pageForOffset(segment.sourceStart);
    const sourceRef = sourcePage === null
      ? `${sourceKind}:chars:${segment.sourceStart}-${segment.sourceEnd}`
      : `${sourceKind}:page:${sourcePage}:chars:${segment.sourceStart}-${segment.sourceEnd}`;
    const matches = curatedMatches([{
      kind: 'content', contentKind: sourceKind, ref: sourceRef,
      text: segment.text
    }], taxonomy);
    const topicIds = [...matches.values()].filter(match => match.node.kind !== 'discipline').map(match => match.node.id);
    for (const match of matches.values()) {
      if (match.node.kind === 'discipline') continue;
      const existing = topicById.get(match.node.id);
      if (!existing || segment.sourceStart < existing.sourceStart) topicById.set(match.node.id, {
        topicId: match.node.id, sourceKind, sourceRef: match.sourceRef, excerpt: match.excerpt,
        confidence: match.confidence, coverageLevel: null, depthLevel: null,
        sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd, sourcePage, sourceHash
      });
    }
    return {
      segmentIndex, topicIds, sourceKind, sourceHash,
      sourceRef,
      excerpt: segment.text.slice(0, 600), text: [
        `Aula/material: ${safeTitle}`, safeCourse && `Curso: ${safeCourse}`, `Conteúdo:\n${segment.text}`
      ].filter(Boolean).join('\n'),
      sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd,
      sourcePage, timestampStart: null, timestampEnd: null,
      confidence: topicIds.length ? Math.max(...[...matches.values()].map(match => match.confidence)) : null
    };
  });
  const topics = [...topicById.values()];
  const confidence = topics.length ? Math.min(...topics.map(topic => topic.confidence)) : null;
  return {
    resource: {
      resourceKey: `user:${safeUsername}:${safeResourceId}`, resourceId: safeResourceId,
      resourceKind: 'aula_dia', title: safeTitle, course: safeCourse, sourcePath: '', sourceHash,
      indexerVersion: ISC_INDEX_VERSION, sourceKind, indexStatus: 'content_indexed',
      metadataConfidence: confidence, taxonomyTopicIds: topics.map(topic => topic.topicId).sort(),
      catalogGeneratedAt: null, scope: 'user', ownerUsername: safeUsername, isActive: true,
      metadata: { sourceKind }
    },
    taxonomyNodes: [], topics, segments: indexedSegments
  };
}

function iscSourceRole(sourceKind) {
  if (sourceKind === 'transcript') return 'oral';
  if (sourceKind === 'slides' || sourceKind === 'pdf_text') return 'slides';
  return null;
}

export function buildIscConsolidatedIndex(resources = [], taxonomy = []) {
  const taxonomyById = new Map(taxonomy.map(node => [node.id, node]));
  const topicsById = new Map();
  const unclassifiedSegments = [];
  const sources = [];

  for (const resource of resources) {
    const role = iscSourceRole(resource.sourceKind || resource.source_kind);
    if (!role) continue;
    const resourceKey = resource.resourceKey || resource.resource_key;
    const title = resource.title || 'Material da Aula do Dia';
    const sourceKind = resource.sourceKind || resource.source_kind;
    const sourceTopics = resource.topics || [];
    const segments = resource.segments || [];
    sources.push({ resourceKey, title, role, sourceKind, indexStatus: resource.indexStatus || resource.index_status || 'content_indexed' });

    for (const item of sourceTopics) {
      const topicId = item.topicId || item.topic_id;
      if (!topicId) continue;
      const topic = topicsById.get(topicId) || {
        topicId,
        name: taxonomyById.get(topicId)?.name || taxonomyById.get(topicId)?.canonical_name || topicId,
        confidence: null,
        roles: new Set(),
        evidence: []
      };
      const confidence = Number(item.confidence);
      topic.confidence = Number.isFinite(confidence)
        ? (topic.confidence === null ? confidence : Math.min(topic.confidence, confidence))
        : topic.confidence;
      topic.roles.add(role);
      topic.evidence.push({
        resourceKey, title, role, sourceKind: item.sourceKind || item.source_kind || sourceKind,
        excerpt: item.evidence || item.evidence_excerpt || '',
        sourceRef: item.sourceRef || item.evidence_ref || '',
        page: item.sourcePage ?? item.source_page ?? null,
        timestampStart: item.timestampStart ?? item.timestamp_start ?? null,
        timestampEnd: item.timestampEnd ?? item.timestamp_end ?? null,
        confidence: Number.isFinite(confidence) ? confidence : null
      });
      topicsById.set(topicId, topic);
    }

    for (const segment of segments) {
      const topicIds = segment.topicIds || segment.topic_ids || [];
      if (topicIds.length) continue;
      const excerpt = segment.evidenceExcerpt || segment.evidence_excerpt || '';
      if (!excerpt) continue;
      unclassifiedSegments.push({
        resourceKey, title, role, sourceKind: segment.sourceKind || segment.source_kind || sourceKind,
        excerpt, sourceRef: segment.sourceRef || segment.evidence_ref || '',
        page: segment.sourcePage ?? segment.source_page ?? null,
        timestampStart: segment.timestampStart ?? segment.timestamp_start ?? null,
        timestampEnd: segment.timestampEnd ?? segment.timestamp_end ?? null
      });
    }
  }

  const topics = [...topicsById.values()].map(topic => {
    const roles = [...topic.roles];
    const canonical = taxonomyById.get(topic.topicId);
    const uncertain = !canonical || canonical.canonical === false || canonical.is_canonical === false || (topic.confidence !== null && topic.confidence < 0.55);
    return {
      topicId: topic.topicId,
      name: topic.name,
      origin: uncertain ? 'uncertain' : roles.length > 1 ? 'both' : roles[0] === 'slides' ? 'slides_only' : 'oral_only',
      confidence: topic.confidence,
      evidence: topic.evidence
    };
  }).sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));

  return {
    sources,
    topics,
    unclassifiedSegments: unclassifiedSegments.slice(0, 100),
    counts: {
      slides: sources.filter(source => source.role === 'slides').length,
      oral: sources.filter(source => source.role === 'oral').length,
      topics: topics.length,
      uncertain: topics.filter(topic => topic.origin === 'uncertain').length,
      unclassifiedSegments: unclassifiedSegments.length
    }
  };
}

export function segmentIscText(text, { maxChars = 1800, overlap = 180, sourceKind = 'transcript' } = {}) {
  const source = String(text || '');
  const limit = Math.max(200, Math.floor(maxChars));
  const overlapSize = Math.max(0, Math.min(Math.floor(overlap), Math.floor(limit / 3)));
  const chunks = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + limit);
    if (end < source.length) {
      const slice = source.slice(start, end);
      const boundary = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf(' '));
      if (boundary >= limit * 0.6) end = start + boundary + 1;
    }
    const excerpt = source.slice(start, end);
    if (excerpt.trim()) chunks.push({ text: excerpt, sourceKind, sourceStart: start, sourceEnd: end });
    if (end >= source.length) break;
    start = Math.max(start + 1, end - overlapSize);
  }
  return chunks;
}

function toVector(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

function cosineSimilarity(left, right) {
  const a = toVector(left), b = toVector(right);
  if (!a || !b || !a.length || a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return null;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] ** 2; normB += b[i] ** 2; }
  return normA && normB ? dot / Math.sqrt(normA * normB) : null;
}

function symmetricNearestSimilarity(leftSegments, rightSegments) {
  if (!leftSegments?.length || !rightSegments?.length) return null;
  const modelsFor = segments => new Set(segments.map(segment => segment.embeddingModel || segment.embedding_model).filter(Boolean));
  const leftModels = modelsFor(leftSegments), rightModels = modelsFor(rightSegments);
  if (leftModels.size > 1 || rightModels.size > 1 || Boolean(leftModels.size) !== Boolean(rightModels.size) ||
      (leftModels.size && [...leftModels][0] !== [...rightModels][0])) return null;
  const directed = (source, target) => {
    const best = source.map(segment => Math.max(-1, ...target.map(other => cosineSimilarity(segment.embedding, other.embedding)).filter(Number.isFinite)));
    return best.length && best.every(Number.isFinite) ? best.reduce((sum, value) => sum + value, 0) / best.length : null;
  };
  const forward = directed(leftSegments, rightSegments), backward = directed(rightSegments, leftSegments);
  return Number.isFinite(forward) && Number.isFinite(backward) ? (forward + backward) / 2 : null;
}

function topicSet(resource, taxonomyById) {
  const ids = new Set((resource?.topics || []).map(topic => String(topic.topicId || topic.topic_id || '')).filter(Boolean));
  for (const topic of [...ids]) {
    let current = taxonomyById.get(topic);
    while (current?.parentId || current?.parent_id) {
      const parentId = current.parentId || current.parent_id;
      ids.add(parentId);
      current = taxonomyById.get(parentId);
    }
  }
  return ids;
}

export function compareIscResources(left, right, { taxonomy = [], expectedTopicIds = [] } = {}) {
  const taxonomyById = new Map(taxonomy.map(node => [node.id, node]));
  const a = topicSet(left, taxonomyById), b = topicSet(right, taxonomyById);
  const union = new Set([...a, ...b]);
  const shared = [...a].filter(id => b.has(id));
  const onlyA = [...a].filter(id => !b.has(id));
  const onlyB = [...b].filter(id => !a.has(id));
  const overlap = union.size ? shared.length / union.size : null;
  const metadataSources = new Set(['catalog_metadata', 'catalog_title', 'catalog_path']);
  const contentSources = new Set(['transcript', 'pdf_text', 'slides']);
  const contentSegments = resource => (resource?.segments || []).filter(segment =>
    contentSources.has(segment.sourceKind || segment.source_kind));
  const contentTopics = resource => (resource?.topics || []).filter(topic =>
    contentSources.has(topic.sourceKind || topic.source_kind));
  const hasContentEvidence = resource => contentSegments(resource).length > 0 || contentTopics(resource).length > 0;
  const hasMetadataEvidence = resource => (resource?.topics || []).some(topic =>
    metadataSources.has(topic.sourceKind || topic.source_kind));
  const leftHasContent = hasContentEvidence(left), rightHasContent = hasContentEvidence(right);
  const bothHaveContent = leftHasContent && rightHasContent;
  const bothMetadataOnly = !leftHasContent && !rightHasContent && hasMetadataEvidence(left) && hasMetadataEvidence(right);
  const thematicScore = bothHaveContent
    ? symmetricNearestSimilarity(contentSegments(left), contentSegments(right))
    : bothMetadataOnly ? symmetricNearestSimilarity(left?.segments, right?.segments) : null;

  const expandExpected = new Set(expectedTopicIds);
  for (const expectedId of expectedTopicIds) {
    for (const node of taxonomy) {
      let current = node;
      while (current?.parentId && current.parentId !== expectedId) current = taxonomyById.get(current.parentId);
      if (current?.parentId === expectedId || node.id === expectedId) expandExpected.add(node.id);
    }
  }
  const objectiveTarget = expectedTopicIds.some(id => taxonomyById.get(id)?.kind === 'learning_objective');
  const targets = expandExpected.size ? expandExpected : union;
  const canAssessCoverage = !objectiveTarget || [left, right].some(resource => (resource?.topics || []).some(topic =>
    expectedTopicIds.includes(String(topic.topicId || topic.topic_id || '')) && (topic.sourceKind || topic.source_kind) !== 'catalog_metadata'));
  const coverageFor = (resource, set) => targets.size && canAssessCoverage && hasContentEvidence(resource)
    ? [...targets].filter(id => set.has(id)).length / targets.size : null;
  const coverageStatus = resource => hasContentEvidence(resource) ? 'indexed_topic_match'
    : hasMetadataEvidence(resource) ? 'metadata_match_only' : 'insufficient_evidence';
  const coverageA = coverageFor(left, a), coverageB = coverageFor(right, b);
  const complementAtoB = b.size ? onlyB.length / b.size : null;
  const complementBtoA = a.size ? onlyA.length / a.size : null;
  const confidences = [...contentTopics(left), ...contentTopics(right)].map(item => Number(item.confidence)).filter(Number.isFinite);
  const confidence = confidences.length ? Math.min(...confidences) : null;
  const basis = bothHaveContent ? 'content_evidence' : (hasMetadataEvidence(left) || hasMetadataEvidence(right)) ? 'catalog_metadata' : 'insufficient_evidence';
  const contentEvidence = bothHaveContent;

  let relation = 'distinct';
  if (Number.isFinite(thematicScore) && overlap !== null && thematicScore >= 0.88 && overlap >= 0.8) relation = 'equivalent';
  else if (overlap !== null && overlap >= 0.7 && Math.max(complementAtoB || 0, complementBtoA || 0) < 0.3) relation = 'redundant';
  else if (onlyA.length || onlyB.length) relation = 'complementary';

  return {
    relation,
    classificationStatus: union.size ? (contentEvidence ? 'assessed' : basis === 'catalog_metadata' ? 'preliminary' : 'insufficient_evidence') : 'insufficient_evidence',
    confidence,
    evidenceBasis: basis,
    metrics: {
      thematicSimilarity: thematicScore === null ? { score: null, status: 'insufficient_evidence' } : { score: thematicScore, status: basis === 'catalog_metadata' ? 'preliminary' : 'assessed' },
      curriculumCoverage: targets.size && canAssessCoverage ? {
        denominator: targets.size, targetTopicIds: [...targets],
        resources: [
          { score: coverageA, status: coverageStatus(left) },
          { score: coverageB, status: coverageStatus(right) }
        ]
      } : { denominator: 0, status: 'insufficient_evidence', resources: [{ score: null }, { score: null }] },
      complementaryGain: {
        leftToRight: complementAtoB === null ? null : { score: contentEvidence ? complementAtoB : null, topicIds: onlyB, status: contentEvidence ? 'assessed' : basis === 'catalog_metadata' ? 'metadata_match_only' : 'insufficient_evidence' },
        rightToLeft: complementBtoA === null ? null : { score: contentEvidence ? complementBtoA : null, topicIds: onlyA, status: contentEvidence ? 'assessed' : basis === 'catalog_metadata' ? 'metadata_match_only' : 'insufficient_evidence' }
      }
    },
    sharedTopicIds: shared,
    exclusiveTopicIds: { left: onlyA, right: onlyB },
    redundantTopicIds: shared,
    complementaryTopicIds: [...onlyA, ...onlyB]
  };
}
