import { buildIscCatalogResource, buildIscConsolidatedIndex, buildIscUserResource, compareIscResources, hashIsc, ISC_INDEX_VERSION, normalizeIscText } from './isc-core.js';
import { embedIscTexts, semanticEmbeddingConfig } from './isc-embeddings.js';
import { pdfParaTexto } from './ai-provider.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as defaultVideoIndexProvider from './gemini-video-index.js';

const LOCAL_TAXONOMY_URL = new URL('../data/isc-taxonomy.json', import.meta.url);

const isAdmin = req => ['admin', 'super_admin'].includes(req.user?.role);
const safeId = value => typeof value === 'string' && /^[a-z0-9._:-]{3,180}$/i.test(value);
const cache = { taxonomy: null, loadedAt: 0 };
let localTaxonomyPromise = null;
const queryEmbeddingCache = new Map();
const QUERY_EMBEDDING_TTL_MS = 5 * 60 * 1000;
const QUERY_EMBEDDING_MAX_ITEMS = 256;

async function getQueryEmbedding(query, config, embedQuery) {
  const key = hashIsc([config.indexModel, normalizeIscText(query)]);
  const existing = queryEmbeddingCache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    queryEmbeddingCache.delete(key);
    queryEmbeddingCache.set(key, existing);
    return existing.promise || existing.vector;
  }
  queryEmbeddingCache.delete(key);
  const promise = Promise.resolve().then(async () => {
    try {
      const [vector] = await embedQuery([query], { purpose: 'query', config });
      queryEmbeddingCache.set(key, { vector, expiresAt: Date.now() + QUERY_EMBEDDING_TTL_MS });
      return vector;
    } catch (error) {
      queryEmbeddingCache.delete(key);
      throw error;
    }
  });
  queryEmbeddingCache.set(key, { promise, expiresAt: Number.POSITIVE_INFINITY });
  while (queryEmbeddingCache.size > QUERY_EMBEDDING_MAX_ITEMS) queryEmbeddingCache.delete(queryEmbeddingCache.keys().next().value);
  return promise;
}

async function getTaxonomy(supabase, force = false) {
  if (!force && cache.taxonomy && Date.now() - cache.loadedAt < 5 * 60 * 1000) return cache.taxonomy;
  const rows = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from('isc_taxonomy_nodes')
      .select('id,kind,parent_id,canonical_name,synonyms,origin,is_canonical,confidence')
      .order('canonical_name').range(start, start + 999);
    if (error) throw new Error(`Taxonomia ISC indisponível: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  cache.taxonomy = rows.map(row => ({
    id: row.id, kind: row.kind, parentId: row.parent_id, name: row.canonical_name,
    synonyms: row.synonyms || [], origin: row.origin, canonical: row.is_canonical, confidence: row.confidence
  }));
  cache.loadedAt = Date.now();
  return cache.taxonomy;
}

async function getLocalTaxonomy() {
  if (!localTaxonomyPromise) {
    localTaxonomyPromise = readFile(LOCAL_TAXONOMY_URL, 'utf8').then(text => {
      const taxonomy = JSON.parse(text);
      if (!Number.isInteger(taxonomy.version) || !Array.isArray(taxonomy.nodes)) throw new Error('Taxonomia ISC local inválida.');
      return {
        version: taxonomy.version,
        nodes: taxonomy.nodes.map(node => ({
          id: node.id, kind: node.kind, parentId: node.parentId || null, name: node.name,
          synonyms: node.synonyms || [], origin: node.origin || 'curated',
          canonical: node.canonical !== false, confidence: node.confidence ?? 1
        }))
      };
    }).catch(error => { localTaxonomyPromise = null; throw error; });
  }
  return localTaxonomyPromise;
}

function findCatalogVideo(catalog, resourceId) {
  return (catalog?.videos || []).find(item => String(item?.id || '') === resourceId) ||
    (catalog?.items || []).find(item => String(item?.id || '') === resourceId &&
      (item.kind === 'video' || /^video\//i.test(item.mimeType || '')));
}

function catalogVideoIndex(indexed, taxonomyNodes, { persisted = false } = {}) {
  const resource = indexed.resource;
  const byId = new Map(taxonomyNodes.map(node => [node.id, node]));
  const topics = indexed.topics.map(topic => {
    const node = byId.get(topic.topicId);
    return {
      topicId: topic.topicId,
      name: node?.name || topic.topicId,
      synonyms: node?.synonyms || [],
      sourceKind: topic.sourceKind,
      confidence: topic.confidence,
      evidence: [{ sourceKind: topic.sourceKind, confidence: topic.confidence, excerpt: topic.excerpt,
        sourceRef: topic.sourceRef, page: null, timestampStart: null, timestampEnd: null }]
    };
  });
  return {
    success: true, resourceKey: resource.resourceKey, title: resource.title, course: resource.course,
    indexStatus: resource.indexStatus, evidenceMode: 'catalog_metadata', topics,
    segmentCount: 0, generatedOnDemand: true, persisted,
    limitations: [
      'O índice foi gerado a partir do título, curso e caminho do acervo; ainda não há transcrição do áudio desta videoaula.',
      ...(persisted ? [] : ['Este índice foi calculado para esta consulta e ainda não foi persistido neste ambiente.'])
    ]
  };
}

function catalogIndexRows(indexed, taxonomyVersion) {
  const resource = indexed.resource;
  return {
    p_resource: {
      resource_key: resource.resourceKey, resource_id: resource.resourceId, resource_kind: resource.resourceKind,
      title: resource.title, course: resource.course, source_path: resource.sourcePath, source_hash: resource.sourceHash,
      indexer_version: resource.indexerVersion, source_kind: resource.sourceKind, index_status: resource.indexStatus,
      metadata_confidence: resource.metadataConfidence, taxonomy_topic_ids: resource.taxonomyTopicIds,
      catalog_generated_at: resource.catalogGeneratedAt, scope: 'catalog', owner_username: null, is_active: true,
      metadata: { ...resource.metadata, taxonomyVersion, indexGeneration: 'on_demand', embeddingStatus: 'pending' }
    },
    p_taxonomy_nodes: indexed.taxonomyNodes.map(node => ({
      id: node.id, kind: node.kind, parent_id: node.parentId || null, canonical_name: node.name,
      normalized_name: normalizeIscText(node.name), synonyms: node.synonyms || [], origin: node.origin || 'catalog_path',
      is_canonical: node.canonical === true, confidence: node.confidence ?? 0.45,
      metadata: { taxonomyVersion }
    })),
    p_topics: indexed.topics.map(topic => ({
      resource_key: resource.resourceKey, topic_id: topic.topicId, source_hash: topic.sourceHash,
      source_kind: topic.sourceKind, evidence_ref: topic.sourceRef, evidence_excerpt: topic.excerpt,
      confidence: topic.confidence, coverage_level: null, depth_level: null,
      source_start: null, source_end: null, source_page: null, timestamp_start: null, timestamp_end: null
    }))
  };
}

function persistedVideoIndex(bundle, taxonomy) {
  const taxonomyById = new Map(taxonomy.map(node => [node.id, node]));
  const topicIds = new Set(bundle.topics.map(topic => topic.topicId));
  for (const segment of bundle.segments) for (const topicId of segment.topicIds || []) topicIds.add(topicId);
  const topics = [...topicIds].map(topicId => {
    const node = taxonomyById.get(topicId);
    const relations = bundle.topics.filter(topic => topic.topicId === topicId);
    const segments = bundle.segments.filter(segment => (segment.topicIds || []).includes(topicId));
    const evidence = [
      ...relations.map(topic => ({ sourceKind: topic.sourceKind, confidence: topic.confidence,
        excerpt: topic.evidence || '', sourceRef: topic.sourceRef || '', page: topic.sourcePage,
        timestampStart: topic.timestampStart, timestampEnd: topic.timestampEnd })),
      ...segments.map(segment => ({ sourceKind: segment.sourceKind, confidence: segment.confidence,
        excerpt: segment.evidenceExcerpt || '', sourceRef: segment.sourceRef || '', page: segment.sourcePage,
        timestampStart: segment.timestampStart, timestampEnd: segment.timestampEnd }))
    ].filter(item => item.excerpt || Number.isFinite(item.timestampStart) || Number.isFinite(item.page)).slice(0, 6);
    const sourceKinds = [...new Set([...relations.map(topic => topic.sourceKind), ...segments.map(segment => segment.sourceKind)].filter(Boolean))];
    const confidenceValues = [...relations, ...segments].map(item => item.confidence).filter(Number.isFinite);
    return {
      topicId, name: node?.name || relations.find(topic => topic.evidence)?.evidence || topicId, synonyms: node?.synonyms || [],
      sourceKind: sourceKinds.some(kind => !METADATA_SOURCE_KINDS.has(kind)) ? 'indexed_content' : 'catalog_metadata',
      confidence: confidenceValues.length ? Math.min(...confidenceValues) : null,
      evidence
    };
  }).sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
  const hasContent = bundle.sourceKind === 'video_analysis' || topics.some(topic => topic.sourceKind === 'indexed_content');
  return {
    success: true, resourceKey: bundle.resourceKey, title: bundle.title, course: bundle.course,
    indexStatus: bundle.indexStatus, evidenceMode: hasContent ? 'indexed_content' : 'catalog_metadata',
    sourceHash: bundle.sourceHash, topics, segmentCount: bundle.segments.length, persisted: true,
    unmappedTopics: Array.isArray(bundle.metadata?.unmappedTopics) ? bundle.metadata.unmappedTopics : [],
    confidenceBasis: bundle.metadata?.confidenceBasis || null,
    limitations: hasContent
      ? (bundle.indexStatus === 'insufficient_evidence' ? ['A análise do vídeo não encontrou tópicos curriculares com evidência suficiente para a taxonomia atual.'] : [])
      : ['O catálogo ainda não contém transcrição ou segmentos de conteúdo desta videoaula; os tópicos são pistas de título/pasta.']
  };
}

export function canonicalVideoTopicRows(items, taxonomy, resourceKey, sourceHash, durationSeconds) {
  const nodes = (taxonomy || []).filter(node => node.kind !== 'discipline');
  const mapped = new Map();
  const unmapped = [];
  const normalize = value => normalizeIscText(value);
  for (const item of items || []) {
    const queryTerms = [item.name, ...(item.synonyms || [])].map(normalize).filter(Boolean);
    const evidenceText = normalize(item.evidence);
    let match = null;
    let matchLength = 0;
    for (const node of nodes) {
      for (const alias of [node.name, ...(node.synonyms || [])].map(normalize).filter(value => value.length >= 4)) {
        const exact = queryTerms.includes(alias);
        const supportedByEvidence = (` ${evidenceText} `).includes(` ${alias} `);
        if ((exact || supportedByEvidence) && alias.length > matchLength) { match = node; matchLength = alias.length; }
      }
    }
    if (!match) {
      unmapped.push({ name: item.name, evidence: item.evidence, timestampStart: item.timestampStart, timestampEnd: item.timestampEnd });
      continue;
    }
    let timestampStart = item.timestampStart;
    let timestampEnd = item.timestampEnd;
    if (Number.isFinite(durationSeconds) && ((timestampStart !== null && timestampStart > durationSeconds) || (timestampEnd !== null && timestampEnd > durationSeconds))) {
      timestampStart = null;
      timestampEnd = null;
    }
    const topic = {
      resource_key: resourceKey, topic_id: match.id, source_hash: sourceHash, source_kind: 'video_analysis',
      evidence_ref: timestampStart === null ? `video:topic:${match.id}` : `video:seconds:${timestampStart}-${timestampEnd ?? timestampStart}`,
      evidence_excerpt: item.evidence, confidence: item.confidence, coverage_level: item.coverageLevel,
      depth_level: item.depthLevel, source_start: null, source_end: null, source_page: null,
      timestamp_start: timestampStart, timestamp_end: timestampEnd
    };
    const existing = mapped.get(match.id);
    if (!existing || topic.confidence > existing.confidence) mapped.set(match.id, topic);
  }
  return { topics: [...mapped.values()], unmapped };
}

function catalogEntries(catalog) {
  const map = new Map();
  for (const [kind, key] of [['video', 'videos'], ['material', 'materials']]) {
    for (const item of catalog?.[key] || []) {
      if (item?.id) map.set(`${kind}:${item.id}`, item);
    }
  }
  return map;
}

function resolveCurriculumFilters(taxonomy, { topicIds = [], objectiveIds = [], discipline = '' } = {}) {
  const byId = new Map(taxonomy.map(node => [node.id, node]));
  const selected = new Set();
  const allIds = [...topicIds, ...objectiveIds];
  for (const id of allIds) {
    const node = byId.get(id);
    if (!node) throw new Error(`Filtro curricular desconhecido: ${id}`);
    if (node.kind === 'learning_objective') selected.add(node.parentId);
    else selected.add(node.id);
  }
  if (discipline) {
    const normalized = normalizeIscText(discipline);
    const node = byId.get(discipline) || taxonomy.find(item =>
      [item.name, ...(item.synonyms || [])].some(term => normalizeIscText(term) === normalized));
    if (!node) throw new Error('Disciplina ou pasta não encontrada na taxonomia curricular.');
    selected.add(node.kind === 'learning_objective' ? node.parentId : node.id);
  }
  const matches = new Set();
  for (const node of taxonomy) {
    if (!['subject', 'subtopic'].includes(node.kind) || node.canonical === false) continue;
    let current = node;
    while (current) {
      if (selected.has(current.id)) { matches.add(node.id); break; }
      current = byId.get(current.parentId);
    }
  }
  return {
    topicIds: [...matches],
    objectiveIds: objectiveIds.slice(),
    discipline: discipline || null,
    objectivesMatchRelatedTopics: objectiveIds.length > 0
  };
}

function selectableCurriculumTopics(taxonomy) {
  const byId = new Map(taxonomy.map(node => [node.id, node]));
  return taxonomy.filter(node => node.canonical === true && ['subject', 'subtopic', 'learning_objective'].includes(node.kind))
    .slice(0, 2000).map(node => ({
      topicId: node.id, name: node.name, kind: node.kind,
      parentName: byId.get(node.parentId)?.name || ''
    }));
}

function toSearchItem(row, catalog) {
  const source = catalog.get(row.resource_key) || {};
  return {
    id: row.resource_id,
    tipo: row.resource_kind,
    titulo: String(source.t || source.title || source.name || source.d || row.title || 'Material do acervo'),
    curso: String(source.course || row.course || ''),
    path: String(source.path || row.source_path || ''),
    score: Number(row.score),
    indexStatus: row.index_status || 'metadata_indexed',
    topicIds: row.topic_ids || [],
    evidence: {
      excerpt: row.evidence_excerpt || '',
      sourceKind: row.source_kind || 'catalog_metadata',
      page: row.source_page ?? null,
      timestampStart: row.timestamp_start ?? null,
      timestampEnd: row.timestamp_end ?? null
    },
    matchMode: row.search_mode || 'semantic'
  };
}

const METADATA_SOURCE_KINDS = new Set(['catalog_metadata', 'catalog_title', 'catalog_path']);

function attachIscEvidence(resources, topicRows = [], segmentRows = []) {
  const bundles = resources.map(row => ({
    resourceKey: row.resource_key, resourceId: row.resource_id, resourceKind: row.resource_kind,
    title: row.title, course: row.course, sourcePath: row.source_path, sourceKind: row.source_kind,
    sourceHash: row.source_hash, metadata: row.metadata || {},
    indexStatus: row.index_status, metadataConfidence: row.metadata_confidence,
    scope: row.scope, ownerUsername: row.owner_username,
    topics: [], segments: []
  }));
  const byKey = new Map(bundles.map(resource => [resource.resourceKey, resource]));
  for (const row of topicRows) {
    const resource = byKey.get(row.resource_key);
    if (!resource) continue;
    resource.topics.push({
      topicId: row.topic_id, sourceKind: row.source_kind, confidence: row.confidence,
      coverageLevel: row.coverage_level, depthLevel: row.depth_level,
      evidence: row.evidence_excerpt, sourceRef: row.evidence_ref,
      sourceStart: row.source_start, sourceEnd: row.source_end,
      sourcePage: row.source_page, timestampStart: row.timestamp_start, timestampEnd: row.timestamp_end
    });
  }
  for (const row of segmentRows) {
    const resource = byKey.get(row.resource_key);
    if (!resource) continue;
    resource.segments.push({
      topicIds: row.topic_ids || [], sourceKind: row.source_kind, confidence: row.confidence,
      evidenceExcerpt: row.evidence_excerpt, sourceRef: row.evidence_ref,
      sourcePage: row.source_page, timestampStart: row.timestamp_start, timestampEnd: row.timestamp_end,
      embedding: row.embedding, embeddingModel: row.embedding_model
    });
  }
  return bundles;
}

async function fetchIscEvidence(supabase, resourceKeys) {
  const [{ data: topicRows, error: topicError }, { data: segmentRows, error: segmentError }] = await Promise.all([
    supabase.from('isc_resource_topics')
      .select('resource_key,topic_id,source_kind,confidence,coverage_level,depth_level,evidence_excerpt,evidence_ref,source_start,source_end,source_page,timestamp_start,timestamp_end')
      .in('resource_key', resourceKeys),
    supabase.from('isc_segments')
      .select('resource_key,topic_ids,source_kind,confidence,evidence_excerpt,evidence_ref,source_page,timestamp_start,timestamp_end,embedding,embedding_model')
      .in('resource_key', resourceKeys)
  ]);
  if (topicError || segmentError) throw new Error(topicError?.message || segmentError?.message);
  return { topicRows: topicRows || [], segmentRows: segmentRows || [] };
}

export async function retrieveIscUserContext({ supabase, username, resourceKey, resourceKeys = [], query, enabled = false,
  supabaseServiceRole = false, getEmbeddingConfig = semanticEmbeddingConfig, embedQuery = embedIscTexts } = {}) {
  const owner = String(username || '').trim().toLowerCase();
  const requestedKeys = Array.isArray(resourceKeys) && resourceKeys.length ? resourceKeys : [resourceKey];
  const ownedResourceKeys = [...new Set(requestedKeys.filter(key => typeof key === 'string' && key.startsWith(`user:${owner}:`)))].slice(0, 4);
  if (!enabled || !supabase || !supabaseServiceRole || !owner || !ownedResourceKeys.length || !query) return [];
  const config = getEmbeddingConfig();
  if (!config.token) return [];
  const vector = await getQueryEmbedding(String(query).slice(0, 1600), config, embedQuery);
  const results = await Promise.all(ownedResourceKeys.map(key => supabase.rpc('search_isc_user_resources', {
    p_query_embedding: vector, p_embedding_model: config.indexModel, p_owner_username: owner,
    p_resource_key: key, p_result_limit: 4
  })));
  const rows = [];
  for (const { data, error } of results) {
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
  }
  return rows.sort((left, right) => Number(right.score) - Number(left.score)).slice(0, 4).map((row, index) => ({
    id: `ISC${index + 1}`,
    title: String(row.title || ''),
    text: String(row.content_text || row.evidence_ref || '').slice(0, 2400),
    sourceKind: row.source_kind,
    sourceRef: row.evidence_ref,
    sourceStart: row.source_start,
    sourceEnd: row.source_end,
    sourcePage: row.source_page,
    timestampStart: row.timestamp_start,
    timestampEnd: row.timestamp_end,
    score: Number(row.score)
  }));
}

export function registerIscRoutes(app, { supabase, supabaseServiceRole = false, getCatalog = () => null,
  getEmbeddingConfig = semanticEmbeddingConfig, embedQuery = embedIscTexts, enabled = false,
  getVideoMediaInfo = null, openVideoMedia = null, videoIndexProvider = defaultVideoIndexProvider } = {}) {
  const ready = res => {
    if (!enabled || !supabase || !supabaseServiceRole) {
      res.status(503).json({ success: false, msg: 'O índice curricular ainda não está conectado ao banco privado.' });
      return false;
    }
    return true;
  };

  async function loadOwnedUserBundles(username, resourceKeys) {
    const { data: resources, error: resourceError } = await supabase.from('isc_resources')
      .select('resource_key,resource_id,resource_kind,title,course,source_path,source_kind,index_status,metadata_confidence,is_active,scope,owner_username')
      .in('resource_key', resourceKeys).eq('scope', 'user').eq('owner_username', username).eq('is_active', true);
    if (resourceError) throw new Error(resourceError.message);
    if ((resources || []).length !== resourceKeys.length) return null;
    const { topicRows, segmentRows } = await fetchIscEvidence(supabase, resourceKeys);
    return attachIscEvidence(resources || [], topicRows, segmentRows);
  }

  async function loadVideoIndex(resourceKey) {
    const { data: resource, error } = await supabase.from('isc_resources')
      .select('resource_key,resource_id,resource_kind,title,course,source_path,source_hash,source_kind,index_status,metadata_confidence,is_active,scope,owner_username,metadata')
      .eq('resource_key', resourceKey).eq('scope', 'catalog').eq('resource_kind', 'video').eq('is_active', true).maybeSingle();
    if (error) throw new Error(error.message);
    if (!resource) return null;
    const [{ topicRows, segmentRows }, taxonomy] = await Promise.all([
      fetchIscEvidence(supabase, [resourceKey]), getTaxonomy(supabase)
    ]);
    return persistedVideoIndex(attachIscEvidence([resource], topicRows, segmentRows)[0], taxonomy);
  }

  async function ensureVideoMetadataResource(video, catalog) {
    const resourceKey = `video:${String(video.id)}`;
    const { data: existing, error } = await supabase.from('isc_resources').select('resource_key')
      .eq('resource_key', resourceKey).eq('scope', 'catalog').eq('resource_kind', 'video').eq('is_active', true).maybeSingle();
    if (error) throw new Error(error.message);
    if (existing) return;
    const taxonomy = { version: ISC_INDEX_VERSION, nodes: await getTaxonomy(supabase) };
    const indexed = buildIscCatalogResource(video, 'video', taxonomy, catalog?.generatedAt || '');
    if (!indexed) throw new Error('Não foi possível preparar os metadados da videoaula.');
    const { error: persistError } = await supabase.rpc('ensure_isc_video_metadata_index', catalogIndexRows(indexed, taxonomy.version));
    if (persistError) throw new Error(persistError.message);
  }

  app.get('/api/isc/status', (_req, res) => {
    let embeddingAvailable = false;
    try { embeddingAvailable = !!getEmbeddingConfig().token; } catch (_) {}
    return res.json({ success: true, enabled: !!(enabled && supabase && supabaseServiceRole), embeddingAvailable });
  });

  app.get('/api/isc/my-resources', async (req, res) => {
    if (!ready(res)) return;
    const username = String(req.user?.username || '').toLowerCase();
    if (!username) return res.status(401).json({ success: false, msg: 'Não autenticado.' });
    try {
      const { data, error } = await supabase.from('isc_resources')
        .select('resource_key,title,course,source_kind,index_status,metadata_confidence,updated_at,taxonomy_topic_ids')
        .eq('scope', 'user').eq('owner_username', username).eq('is_active', true)
        .order('updated_at', { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      return res.set('Cache-Control', 'private, no-store').json({ success: true, items: (data || []).map(row => ({
        resourceKey: row.resource_key, title: row.title, course: row.course, sourceKind: row.source_kind,
        indexStatus: row.index_status, confidence: row.metadata_confidence, updatedAt: row.updated_at,
        topicIds: row.taxonomy_topic_ids || []
      })) });
    } catch (error) {
      console.error('[ISC] Falha ao listar materiais pessoais:', error.message);
      return res.status(503).json({ success: false, msg: 'Não foi possível carregar seus materiais indexados.' });
    }
  });

  app.get('/api/isc/video-index', async (req, res) => {
    if (!req.user?.username) return res.status(401).json({ success: false, msg: 'Não autenticado.' });
    const resourceId = String(req.query?.id || '').trim().slice(0, 180);
    if (!safeId(resourceId)) return res.status(400).json({ success: false, msg: 'Identificador de videoaula inválido.' });
    const resourceKey = `video:${resourceId}`;
    try {
      const canPersist = !!(enabled && supabase && supabaseServiceRole);
      if (canPersist) {
        const { data: resource, error: resourceError } = await supabase.from('isc_resources')
          .select('resource_key,resource_id,resource_kind,title,course,source_path,source_hash,source_kind,index_status,metadata_confidence,is_active,scope,owner_username,metadata')
          .eq('resource_key', resourceKey).eq('scope', 'catalog').eq('resource_kind', 'video').eq('is_active', true).maybeSingle();
        if (resourceError) throw new Error(resourceError.message);
        if (resource) {
          const [{ topicRows, segmentRows }, taxonomy] = await Promise.all([
            fetchIscEvidence(supabase, [resourceKey]), getTaxonomy(supabase)
          ]);
          const bundle = attachIscEvidence([resource], topicRows, segmentRows)[0];
          return res.set('Cache-Control', 'private, no-store').json(persistedVideoIndex(bundle, taxonomy));
        }
      }

      const catalog = getCatalog?.();
      const video = findCatalogVideo(catalog, resourceId);
      if (!video) return res.status(404).json({ success: false, msg: 'Esta videoaula não foi encontrada no acervo atual.' });
      const taxonomy = canPersist ? { version: ISC_INDEX_VERSION, nodes: await getTaxonomy(supabase) } : await getLocalTaxonomy();
      const indexed = buildIscCatalogResource(video, 'video', taxonomy, catalog?.generatedAt || '');
      if (!indexed) return res.status(404).json({ success: false, msg: 'Não foi possível gerar o índice desta videoaula.' });

      let persisted = false;
      if (canPersist && typeof supabase.rpc === 'function') {
        try {
          const rows = catalogIndexRows(indexed, taxonomy.version);
          const { error } = await supabase.rpc('ensure_isc_video_metadata_index', rows);
          if (error) throw new Error(error.message);
          persisted = true;
        } catch (error) {
          console.warn('[ISC] Índice de vídeo gerado, mas não persistido:', error.message);
        }
      }
      if (persisted) {
        const { data: resource, error: resourceError } = await supabase.from('isc_resources')
          .select('resource_key,resource_id,resource_kind,title,course,source_path,source_hash,source_kind,index_status,metadata_confidence,is_active,scope,owner_username,metadata')
          .eq('resource_key', resourceKey).eq('scope', 'catalog').eq('resource_kind', 'video').eq('is_active', true).maybeSingle();
        if (!resourceError && resource) {
          const [{ topicRows, segmentRows }] = await Promise.all([fetchIscEvidence(supabase, [resourceKey])]);
          const bundle = attachIscEvidence([resource], topicRows, segmentRows)[0];
          const response = persistedVideoIndex(bundle, [...taxonomy.nodes, ...indexed.taxonomyNodes]);
          response.generatedOnDemand = true;
          return res.set('Cache-Control', 'private, no-store').json(response);
        }
      }
      return res.set('Cache-Control', 'private, no-store').json(catalogVideoIndex(indexed, [...taxonomy.nodes, ...indexed.taxonomyNodes], { persisted }));
    } catch (error) {
      console.error('[ISC] Falha ao carregar índice da videoaula:', error.message);
      return res.status(503).json({ success: false, msg: 'Não foi possível carregar o índice curricular da videoaula.' });
    }
  });

  app.post('/api/isc/video-index/request', async (req, res) => {
    if (!ready(res)) return;
    const username = String(req.user?.username || '').trim().toLowerCase();
    if (!username) return res.status(401).json({ success: false, msg: 'Não autenticado.' });
    const resourceId = String(req.body?.id || '').trim().slice(0, 180);
    if (!safeId(resourceId)) return res.status(400).json({ success: false, msg: 'Identificador de videoaula inválido.' });
    if (typeof getVideoMediaInfo !== 'function' || typeof openVideoMedia !== 'function' || !videoIndexProvider.geminiVideoIndexAvailable?.()) {
      return res.status(503).json({ success: false, msg: 'A indexação sob demanda exige Gemini e acesso de mídia configurados no servidor.' });
    }
    const resourceKey = `video:${resourceId}`;
    const catalog = getCatalog?.();
    const video = findCatalogVideo(catalog, resourceId);
    if (!video) return res.status(404).json({ success: false, msg: 'Esta videoaula não foi encontrada no acervo atual.' });

    let jobId = '';
    try {
      const mediaInfo = await getVideoMediaInfo(resourceId);
      const sizeBytes = Number(mediaInfo?.sizeBytes);
      const durationSeconds = Number(mediaInfo?.durationSeconds);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return res.status(422).json({ success: false, msg: 'O Drive não informou um tamanho válido para esta videoaula.' });
      const sourceHash = String(mediaInfo.sourceHash || hashIsc([resourceId, mediaInfo.version, mediaInfo.modifiedTime, sizeBytes]));
      const existingIndex = await loadVideoIndex(resourceKey);
      if (existingIndex?.sourceHash === sourceHash && ['content_indexed', 'insufficient_evidence'].includes(existingIndex.indexStatus)) {
        return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'completed', videoIndex: existingIndex, reused: true });
      }

      await ensureVideoMetadataResource(video, catalog);
      const { data: previousJob, error: previousError } = await supabase.from('isc_video_index_jobs')
        .select('job_id,resource_key,source_hash,requested_by,status,gemini_file_name,gemini_file_uri,gemini_mime_type,duration_seconds,interaction_id,result_json,updated_at')
        .eq('resource_key', resourceKey).eq('source_hash', sourceHash).maybeSingle();
      if (previousError) throw new Error(previousError.message);
      if (previousJob && ['media_processing', 'starting_analysis', 'analyzing'].includes(previousJob.status)) {
        if (previousJob.requested_by !== username) return res.status(409).json({ success: false, msg: 'Esta videoaula já está sendo indexada por outro usuário. Tente buscar novamente quando o processamento terminar.' });
        return res.status(202).set('Cache-Control', 'private, no-store').json({ success: true, state: previousJob.status, jobId: previousJob.job_id, reused: true });
      }
      if (previousJob?.status === 'uploading' && Date.now() - new Date(previousJob.updated_at || 0).getTime() < 10 * 60 * 1000) {
        if (previousJob.requested_by !== username) return res.status(409).json({ success: false, msg: 'Esta videoaula já está sendo enviada para indexação. Tente novamente em alguns minutos.' });
        return res.status(202).set('Cache-Control', 'private, no-store').json({ success: true, state: 'uploading', jobId: previousJob.job_id, reused: true });
      }

      jobId = previousJob?.job_id || randomUUID();
      const jobRow = {
        job_id: jobId, resource_key: resourceKey, source_hash: sourceHash, requested_by: username,
        status: 'uploading', gemini_file_name: null, gemini_file_uri: null, gemini_mime_type: null,
        duration_seconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
        interaction_id: null, result_json: null, error_code: null, error_message: null, updated_at: new Date().toISOString()
      };
      if (previousJob) {
        const { error } = await supabase.from('isc_video_index_jobs').update(jobRow).eq('job_id', jobId);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from('isc_video_index_jobs').insert(jobRow);
        if (error) {
          if (error.code !== '23505') throw new Error(error.message);
          const { data: raced, error: racedError } = await supabase.from('isc_video_index_jobs')
            .select('job_id,status,requested_by').eq('resource_key', resourceKey).eq('source_hash', sourceHash).maybeSingle();
          if (racedError) throw new Error(racedError.message);
          if (!raced) throw new Error('Não foi possível reservar a indexação desta videoaula.');
          return res.status(202).set('Cache-Control', 'private, no-store').json({ success: true, state: raced.status, jobId: raced.job_id, reused: true });
        }
      }

      const media = await openVideoMedia(resourceId);
      if (!media?.ok || !media.body) throw Object.assign(new Error('Não foi possível abrir a mídia original no Google Drive.'), { status: 502, code: 'drive_media' });
      const file = await videoIndexProvider.uploadGeminiVideoFile({
        stream: media.body, sizeBytes, mimeType: String(mediaInfo.mimeType || 'video/mp4'),
        displayName: String(video.t || video.title || 'Videoaula Cuscuz-MED').slice(0, 120)
      });
      const { error: uploadError } = await supabase.from('isc_video_index_jobs').update({
        status: 'media_processing', gemini_file_name: file.name, gemini_file_uri: file.uri,
        gemini_mime_type: file.mimeType || mediaInfo.mimeType || 'video/mp4', error_code: null,
        error_message: null, updated_at: new Date().toISOString()
      }).eq('job_id', jobId);
      if (uploadError) throw new Error(uploadError.message);
      return res.status(202).set('Cache-Control', 'private, no-store').json({ success: true, state: 'media_processing', jobId });
    } catch (error) {
      if (jobId) await supabase.from('isc_video_index_jobs').update({
        status: 'failed', error_code: String(error.code || 'index_failed').slice(0, 80),
        error_message: String(error.message || error).slice(0, 400), updated_at: new Date().toISOString()
      }).eq('job_id', jobId).catch(() => {});
      console.error('[ISC] Falha ao iniciar índice de conteúdo da videoaula:', error.message);
      const status = Number(error.status);
      return res.status(status >= 400 && status < 500 ? status : 503).json({ success: false, msg: String(error.message || 'Não foi possível iniciar a indexação desta videoaula.').slice(0, 400), state: 'failed' });
    }
  });

  app.get('/api/isc/video-index/jobs/:jobId', async (req, res) => {
    if (!ready(res)) return;
    const username = String(req.user?.username || '').trim().toLowerCase();
    if (!username) return res.status(401).json({ success: false, msg: 'Não autenticado.' });
    const jobId = String(req.params?.jobId || '').trim();
    if (!safeId(jobId)) return res.status(400).json({ success: false, msg: 'Identificador de processamento inválido.' });
    try {
      const { data: job, error } = await supabase.from('isc_video_index_jobs')
        .select('job_id,resource_key,source_hash,requested_by,status,gemini_file_name,gemini_file_uri,gemini_mime_type,duration_seconds,interaction_id,result_json,error_code,error_message,updated_at')
        .eq('job_id', jobId).eq('requested_by', username).maybeSingle();
      if (error) throw new Error(error.message);
      if (!job) return res.status(404).json({ success: false, msg: 'Este processamento não está disponível para esta conta.' });
      if (job.status === 'completed') {
        const videoIndex = await loadVideoIndex(job.resource_key);
        return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'completed', videoIndex });
      }
      if (job.status === 'failed') return res.json({ success: false, state: 'failed', msg: job.error_message || 'A indexação desta videoaula falhou.', retryable: true });
      if (job.status === 'uploading') return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'uploading', jobId });

      if (job.status === 'starting_analysis') {
        const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        const updatedAt = Date.parse(job.updated_at || '');
        if (Number.isFinite(updatedAt) && updatedAt < Date.parse(staleBefore)) {
          const { data: reclaimed, error: reclaimError } = await supabase.from('isc_video_index_jobs').update({
            status: 'media_processing', updated_at: new Date().toISOString()
          }).eq('job_id', jobId).eq('status', 'starting_analysis').lt('updated_at', staleBefore).select('job_id').maybeSingle();
          if (reclaimError) throw new Error(reclaimError.message);
          if (reclaimed) return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'media_processing', jobId });
        }
        return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'starting_analysis', jobId });
      }

      if (job.status === 'media_processing') {
        const file = await videoIndexProvider.getGeminiVideoFile(job.gemini_file_name);
        const fileState = String(file.state || '').toUpperCase();
        if (fileState === 'FAILED') {
          await supabase.from('isc_video_index_jobs').update({ status: 'failed', error_code: 'media_processing_failed', error_message: 'O Gemini não conseguiu preparar o arquivo de vídeo.', updated_at: new Date().toISOString() }).eq('job_id', jobId);
          await videoIndexProvider.deleteGeminiVideoFile(job.gemini_file_name).catch(() => {});
          return res.json({ success: false, state: 'failed', msg: 'O Gemini não conseguiu preparar o arquivo de vídeo.', retryable: true });
        }
        if (fileState !== 'ACTIVE') return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'media_processing', jobId });
        const { data: claimed, error: claimError } = await supabase.from('isc_video_index_jobs').update({
          status: 'starting_analysis', updated_at: new Date().toISOString()
        }).eq('job_id', jobId).eq('status', 'media_processing').select('job_id').maybeSingle();
        if (claimError) throw new Error(claimError.message);
        if (!claimed) return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'starting_analysis', jobId });
        const { data: resource, error: resourceError } = await supabase.from('isc_resources')
          .select('title,course,source_path').eq('resource_key', job.resource_key).maybeSingle();
        if (resourceError) throw new Error(resourceError.message);
        const catalogVideo = findCatalogVideo(getCatalog?.(), job.resource_key.slice('video:'.length));
        try {
          const interaction = await videoIndexProvider.startGeminiVideoIndex({
            fileUri: job.gemini_file_uri || file.uri, mimeType: job.gemini_mime_type || file.mimeType,
            title: resource?.title || catalogVideo?.t, course: resource?.course || catalogVideo?.course,
            sourcePath: resource?.source_path || catalogVideo?.path, durationSeconds: job.duration_seconds
          });
          const interactionId = String(interaction?.id || '').trim();
          if (!interactionId) throw new Error('O Gemini não devolveu um identificador para a análise da videoaula.');
          const { data: updated, error: updateError } = await supabase.from('isc_video_index_jobs').update({
            status: 'analyzing', interaction_id: interactionId, updated_at: new Date().toISOString()
          }).eq('job_id', jobId).eq('status', 'starting_analysis').select('job_id').maybeSingle();
          if (updateError) throw new Error(updateError.message);
          if (!updated) return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'starting_analysis', jobId });
        } catch (error) {
          await supabase.from('isc_video_index_jobs').update({
            status: 'failed', error_code: String(error.code || 'analysis_start_failed').slice(0, 80),
            error_message: String(error.message || error).slice(0, 400), updated_at: new Date().toISOString()
          }).eq('job_id', jobId).eq('status', 'starting_analysis');
          await videoIndexProvider.deleteGeminiVideoFile(job.gemini_file_name).catch(() => {});
          throw error;
        }
        return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'analyzing', jobId });
      }

      let parsed = job.result_json;
      if (!parsed) {
        const interaction = await videoIndexProvider.getGeminiVideoIndexInteraction(job.interaction_id);
        const interactionState = String(interaction.status || '').toLowerCase();
        if (interactionState === 'failed' || interactionState === 'cancelled' || interactionState === 'incomplete') {
          const message = 'A análise da videoaula não foi concluída. Você pode tentar novamente.';
          await supabase.from('isc_video_index_jobs').update({ status: 'failed', error_code: `gemini_${interactionState}`, error_message: message, updated_at: new Date().toISOString() }).eq('job_id', jobId);
          await videoIndexProvider.deleteGeminiVideoFile(job.gemini_file_name).catch(() => {});
          return res.json({ success: false, state: 'failed', msg: message, retryable: true });
        }
        if (interactionState !== 'completed') return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'analyzing', jobId });
        try {
          parsed = videoIndexProvider.parseGeminiVideoIndexText(videoIndexProvider.extractGeminiVideoIndexText(interaction));
        } catch (parseError) {
          await supabase.from('isc_video_index_jobs').update({ status: 'failed', error_code: 'invalid_model_output', error_message: 'A IA não devolveu um índice estruturado válido. Você pode tentar novamente.', updated_at: new Date().toISOString() }).eq('job_id', jobId);
          await videoIndexProvider.deleteGeminiVideoFile(job.gemini_file_name).catch(() => {});
          return res.json({ success: false, state: 'failed', msg: parseError.message || 'A IA devolveu um índice inválido.', retryable: true });
        }
        const { error: resultError } = await supabase.from('isc_video_index_jobs').update({ result_json: parsed, updated_at: new Date().toISOString() }).eq('job_id', jobId);
        if (resultError) throw new Error(resultError.message);
      }

      const taxonomy = await getTaxonomy(supabase);
      const durationSeconds = job.duration_seconds == null ? Number.NaN : Number(job.duration_seconds);
      const { topics, unmapped } = canonicalVideoTopicRows(parsed.topics, taxonomy, job.resource_key, job.source_hash, durationSeconds);
      const { data: resource, error: resourceError } = await supabase.from('isc_resources')
        .select('resource_key,resource_id,resource_kind,title,course,source_path,metadata').eq('resource_key', job.resource_key).maybeSingle();
      if (resourceError) throw new Error(resourceError.message);
      if (!resource) throw new Error('A videoaula não está mais disponível no catálogo.');
      const confidences = topics.map(topic => topic.confidence).filter(Number.isFinite);
      const metadata = {
        ...(resource.metadata || {}), videoIndexModel: String(process.env.GEMINI_VIDEO_INDEX_MODEL || 'gemini-3.8-flash'),
        videoIndexGeneratedAt: new Date().toISOString(), confidenceBasis: 'estimativa do modelo, não calibrada',
        videoSourceVersion: job.source_hash, unmappedTopics: unmapped.slice(0, 40),
        providerLimitations: parsed.limitations || []
      };
      const { error: persistError } = await supabase.rpc('replace_isc_video_content_index', {
        p_resource: {
          resource_key: resource.resource_key, resource_id: resource.resource_id, resource_kind: 'video',
          source_hash: job.source_hash, indexer_version: ISC_INDEX_VERSION, source_kind: 'video_analysis',
          scope: 'catalog', metadata_confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
          taxonomy_topic_ids: topics.map(topic => topic.topic_id), metadata
        },
        p_topics: topics
      });
      if (persistError) throw new Error(persistError.message);
      const { error: completedError } = await supabase.from('isc_video_index_jobs').update({ status: 'completed', error_code: null, error_message: null, updated_at: new Date().toISOString() }).eq('job_id', jobId);
      if (completedError) throw new Error(completedError.message);
      await videoIndexProvider.deleteGeminiVideoFile(job.gemini_file_name).catch(() => {});
      const videoIndex = await loadVideoIndex(job.resource_key);
      return res.set('Cache-Control', 'private, no-store').json({ success: true, state: 'completed', videoIndex });
    } catch (error) {
      console.error('[ISC] Falha ao atualizar índice da videoaula:', error.message);
      return res.status(Number(error.status) >= 400 ? Number(error.status) : 503).json({ success: false, msg: String(error.message || 'Não foi possível verificar a indexação desta videoaula.').slice(0, 400) });
    }
  });

  app.post('/api/isc/lesson-index', async (req, res) => {
    if (!ready(res)) return;
    const username = String(req.user?.username || '').trim().toLowerCase();
    if (!username) return res.status(401).json({ success: false, msg: 'Não autenticado.' });
    const resourceKeys = Array.isArray(req.body?.resourceKeys) ? [...new Set(req.body.resourceKeys)] : [];
    if (!resourceKeys.length || resourceKeys.length > 12 || resourceKeys.some(key => !safeId(key) || !key.startsWith(`user:${username}:`))) {
      return res.status(400).json({ success: false, msg: 'Selecione materiais válidos desta Aula do Dia.' });
    }
    try {
      const [sources, taxonomy] = await Promise.all([loadOwnedUserBundles(username, resourceKeys), getTaxonomy(supabase)]);
      if (!sources) return res.status(404).json({ success: false, msg: 'Um ou mais materiais não estão disponíveis para esta conta.' });
      const index = buildIscConsolidatedIndex(sources, taxonomy);
      return res.set('Cache-Control', 'private, no-store').json({
        success: true, indexVersion: ISC_INDEX_VERSION, index,
        topicOptions: selectableCurriculumTopics(taxonomy),
        limitations: ['A classificação automática usa correspondência com a taxonomia; revise os tópicos antes de usá-los como objetivos.',
          'Trechos sem tópico canônico aparecem para revisão e não são descartados.']
      });
    } catch (error) {
      console.error('[ISC] Falha ao consolidar índice da aula:', error.message);
      return res.status(503).json({ success: false, msg: 'Não foi possível montar o índice curricular consolidado.' });
    }
  });

  app.post('/api/isc/recommendations', async (req, res) => {
    if (!ready(res)) return;
    const username = String(req.user?.username || '').trim().toLowerCase();
    if (!username) return res.status(401).json({ success: false, msg: 'Não autenticado.' });
    const resourceKeys = Array.isArray(req.body?.resourceKeys) ? [...new Set(req.body.resourceKeys)] : [];
    const topicIds = Array.isArray(req.body?.topicIds) ? [...new Set(req.body.topicIds)] : [];
    if (!resourceKeys.length || resourceKeys.length > 12 || resourceKeys.some(key => !safeId(key) || !key.startsWith(`user:${username}:`)) ||
        !topicIds.length || topicIds.length > 100 || topicIds.some(id => !safeId(id))) {
      return res.status(400).json({ success: false, msg: 'Fontes ou tópicos do índice curricular inválidos.' });
    }
    try {
      const [sources, taxonomy] = await Promise.all([loadOwnedUserBundles(username, resourceKeys), getTaxonomy(supabase)]);
      if (!sources) return res.status(404).json({ success: false, msg: 'Uma ou mais fontes não estão disponíveis para esta conta.' });
      const allowedTopicIds = new Set(selectableCurriculumTopics(taxonomy).map(topic => topic.topicId));
      if (topicIds.some(id => !allowedTopicIds.has(id))) return res.status(400).json({ success: false, msg: 'Inclua somente tópicos curriculares canônicos.' });

      let semanticRows = [];
      const embeddingConfig = getEmbeddingConfig();
      if (embeddingConfig.token) {
        const taxonomyById = new Map(taxonomy.map(node => [node.id, node]));
        const query = topicIds.map(id => taxonomyById.get(id)?.name || '').filter(Boolean).join(' ').slice(0, 240);
        if (query.length >= 3) {
          const vector = await getQueryEmbedding(query, embeddingConfig, embedQuery);
          const { data, error } = await supabase.rpc('search_isc_resources', {
            p_query_embedding: vector, p_embedding_model: embeddingConfig.indexModel,
            p_topic_ids: topicIds, p_result_limit: 40, p_course_filter: null
          });
          if (error) throw new Error(error.message);
          semanticRows = data || [];
        }
      }

      const { data: matchedRows, error: matchError } = await supabase.from('isc_resource_topics')
        .select('resource_key,topic_id,source_kind,confidence,evidence_excerpt,evidence_ref,source_page,timestamp_start,timestamp_end,depth_level')
        .in('topic_id', topicIds).limit(5000);
      if (matchError) throw new Error(matchError.message);
      const grouped = new Map();
      for (const row of matchedRows || []) {
        const entry = grouped.get(row.resource_key) || [];
        entry.push(row); grouped.set(row.resource_key, entry);
      }
      const catalogMatches = [...grouped.entries()]
        .sort((a, b) => new Set(b[1].map(row => row.topic_id)).size - new Set(a[1].map(row => row.topic_id)).size)
        .map(([key]) => key);
      const candidateKeys = [...new Set([...semanticRows.map(row => row.resource_key), ...catalogMatches])].slice(0, 250);
      if (!candidateKeys.length) return res.json({ success: true, indexVersion: ISC_INDEX_VERSION, evidenceMode: 'catalog_metadata', items: [] });
      const { data: videoRows, error: videoError } = await supabase.from('isc_resources')
        .select('resource_key,resource_id,resource_kind,title,course,source_path,source_kind,index_status,metadata_confidence,is_active,scope,owner_username')
        .in('resource_key', candidateKeys).eq('scope', 'catalog').eq('resource_kind', 'video').eq('is_active', true);
      if (videoError) throw new Error(videoError.message);
      const videoKeys = (videoRows || []).map(row => row.resource_key);
      const videoTopicRows = (matchedRows || []).filter(row => videoKeys.includes(row.resource_key));
      for (const row of semanticRows) {
        if (!videoKeys.includes(row.resource_key)) continue;
        for (const topicId of row.topic_ids || []) {
          if (videoTopicRows.some(topic => topic.resource_key === row.resource_key && topic.topic_id === topicId)) continue;
          videoTopicRows.push({
            resource_key: row.resource_key, topic_id: topicId, source_kind: row.source_kind || 'catalog_metadata',
            confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
            evidence_excerpt: row.evidence_excerpt || '', evidence_ref: row.evidence_ref || '',
            source_page: row.source_page ?? null, timestamp_start: row.timestamp_start ?? null,
            timestamp_end: row.timestamp_end ?? null, depth_level: null
          });
        }
      }
      const bundles = attachIscEvidence(videoRows || [], videoTopicRows, []);
      const taxonomyById = new Map(taxonomy.map(node => [node.id, node]));
      const targetSet = new Set(topicIds);
      const semanticByKey = new Map(semanticRows.map(row => [row.resource_key, row]));
      const items = bundles.map(video => {
        const relevantTopics = video.topics.filter(topic => targetSet.has(topic.topicId));
        const contentTopics = relevantTopics.filter(topic => !METADATA_SOURCE_KINDS.has(topic.sourceKind));
        const semantic = semanticByKey.get(video.resourceKey);
        const evidenceMode = contentTopics.length || (semantic && !METADATA_SOURCE_KINDS.has(semantic.source_kind))
          ? 'indexed_content' : 'catalog_metadata';
        return {
          resourceKey: video.resourceKey, resourceId: video.resourceId, title: video.title, course: video.course,
          sourcePath: video.sourcePath, indexStatus: video.indexStatus,
          evidenceMode,
          semanticSimilarity: semantic ? Number(semantic.score) : null,
          semanticEvidenceKind: semantic?.source_kind || null,
          matchedTopicCount: new Set(relevantTopics.map(topic => topic.topicId)).size,
          targetTopicCount: topicIds.length,
          matchedTopics: relevantTopics.map(topic => ({
            topicId: topic.topicId, name: taxonomyById.get(topic.topicId)?.name || topic.topicId,
            sourceKind: topic.sourceKind, confidence: topic.confidence, excerpt: topic.evidence,
            sourceRef: topic.sourceRef, page: topic.sourcePage, timestampStart: topic.timestampStart,
            timestampEnd: topic.timestampEnd, depthLevel: topic.depthLevel
          })),
          notLinkedTopicIds: topicIds.filter(id => !relevantTopics.some(topic => topic.topicId === id)),
          confidence: relevantTopics.length ? Math.min(...relevantTopics.map(topic => topic.confidence).filter(Number.isFinite)) : null
        };
      }).sort((a, b) => (b.evidenceMode === 'indexed_content' ? 1 : 0) - (a.evidenceMode === 'indexed_content' ? 1 : 0) ||
        (Number.isFinite(b.semanticSimilarity) ? b.semanticSimilarity : -2) - (Number.isFinite(a.semanticSimilarity) ? a.semanticSimilarity : -2) ||
        b.matchedTopicCount - a.matchedTopicCount || (b.confidence || 0) - (a.confidence || 0) || a.title.localeCompare(b.title, 'pt-BR'));
      return res.set('Cache-Control', 'private, no-store').json({
        success: true, indexVersion: ISC_INDEX_VERSION,
        searchMode: semanticRows.length ? 'hybrid' : 'curriculum_metadata',
        evidenceMode: items.some(item => item.evidenceMode === 'indexed_content') ? 'mixed' : 'catalog_metadata',
        items: items.slice(0, 40)
      });
    } catch (error) {
      console.error('[ISC] Falha ao recomendar aulas:', error.message);
      return res.status(503).json({ success: false, msg: 'Não foi possível localizar aulas relacionadas agora.' });
    }
  });

  app.post('/api/isc/lesson-compare', async (req, res) => {
    if (!ready(res)) return;
    const username = String(req.user?.username || '').trim().toLowerCase();
    if (!username) return res.status(401).json({ success: false, msg: 'Não autenticado.' });
    const sourceKeys = Array.isArray(req.body?.sourceKeys) ? [...new Set(req.body.sourceKeys)] : [];
    const videoKeys = Array.isArray(req.body?.videoKeys) ? [...new Set(req.body.videoKeys)] : [];
    const topicIds = Array.isArray(req.body?.topicIds) ? [...new Set(req.body.topicIds)] : [];
    if (!sourceKeys.length || sourceKeys.length > 12 || sourceKeys.some(key => !safeId(key) || !key.startsWith(`user:${username}:`)) ||
        videoKeys.length < 2 || videoKeys.length > 4 || videoKeys.some(key => !safeId(key) || !key.startsWith('video:')) ||
        topicIds.length > 100 || topicIds.some(id => !safeId(id))) {
      return res.status(400).json({ success: false, msg: 'Selecione fontes próprias, tópicos válidos e de duas a quatro videoaulas.' });
    }
    try {
      const [{ data: videoRows, error: videoError }, sourceBundles, taxonomy] = await Promise.all([
        supabase.from('isc_resources')
          .select('resource_key,resource_id,resource_kind,title,course,source_path,source_kind,index_status,metadata_confidence,is_active,scope,owner_username')
          .in('resource_key', videoKeys).eq('scope', 'catalog').eq('resource_kind', 'video').eq('is_active', true),
        loadOwnedUserBundles(username, sourceKeys),
        getTaxonomy(supabase)
      ]);
      if (videoError) throw new Error(videoError.message);
      if (!sourceBundles || (videoRows || []).length !== videoKeys.length) {
        return res.status(404).json({ success: false, msg: 'Uma ou mais fontes/aulas não estão disponíveis.' });
      }
      const allKeys = videoKeys;
      const { topicRows, segmentRows } = await fetchIscEvidence(supabase, allKeys);
      const videos = attachIscEvidence(videoRows || [], topicRows, segmentRows);
      const curriculum = buildIscConsolidatedIndex(sourceBundles, taxonomy);
      const knownTopicIds = new Set(curriculum.topics.map(topic => topic.topicId));
      const allowedTopicIds = new Set(selectableCurriculumTopics(taxonomy).map(topic => topic.topicId));
      const selectedTopicIds = topicIds.length ? topicIds : curriculum.topics.map(topic => topic.topicId);
      if (selectedTopicIds.some(id => !allowedTopicIds.has(id))) {
        return res.status(400).json({ success: false, msg: 'A comparação inclui tópicos não canônicos.' });
      }
      const taxonomyById = new Map(taxonomy.map(node => [node.id, node]));
      for (const topicId of selectedTopicIds) {
        if (knownTopicIds.has(topicId)) continue;
        const node = taxonomyById.get(topicId);
        curriculum.topics.push({ topicId, name: node?.name || topicId, origin: 'uncertain', confidence: null, evidence: [], manuallySelected: true });
      }
      const curriculumTopics = sourceBundles.flatMap(source => source.topics)
        .filter(topic => selectedTopicIds.includes(topic.topicId));
      const curriculumSegments = sourceBundles.flatMap(source => source.segments);
      const curriculumResource = { topics: curriculumTopics, segments: curriculumSegments };
      const topicNames = new Map(taxonomy.map(node => [node.id, node.name]));
      const byKey = new Map(videos.map(video => [video.resourceKey, video]));
      const comparisons = videos.map(video => {
        const result = compareIscResources(curriculumResource, video, { taxonomy, expectedTopicIds: selectedTopicIds });
        const videoTopicIds = new Set(video.topics.map(topic => topic.topicId));
        const contentTopicIds = new Set(video.topics.filter(topic => !METADATA_SOURCE_KINDS.has(topic.sourceKind)).map(topic => topic.topicId));
        const hasContentIndex = contentTopicIds.size > 0;
        const observedTopicIds = hasContentIndex ? contentTopicIds : videoTopicIds;
        const metricsByOrigin = origin => {
          const targetIds = curriculum.topics.filter(topic => selectedTopicIds.includes(topic.topicId) &&
            (topic.origin === 'both' || topic.origin === `${origin}_only`)).map(topic => topic.topicId);
          const matchedIds = targetIds.filter(id => observedTopicIds.has(id));
          const contentIds = targetIds.filter(id => contentTopicIds.has(id));
          return {
            targetCount: targetIds.length,
            matchedTopicIds: matchedIds,
            score: hasContentIndex && targetIds.length ? contentIds.length / targetIds.length : null,
            status: !targetIds.length ? 'no_targets' : hasContentIndex ? 'indexed_topic_match' : 'metadata_match_only'
          };
        };
        const recommendedSegments = video.segments.filter(segment =>
          Number.isFinite(segment.timestampStart) && (segment.topicIds || []).some(id => selectedTopicIds.includes(id)))
          .map(segment => ({
            topicIds: segment.topicIds.filter(id => selectedTopicIds.includes(id)),
            excerpt: segment.evidenceExcerpt, timestampStart: segment.timestampStart,
            timestampEnd: segment.timestampEnd, sourceRef: segment.sourceRef
          })).sort((a, b) => a.timestampStart - b.timestampStart).slice(0, 20);
        return {
          resourceKey: video.resourceKey, title: video.title, course: video.course, sourcePath: video.sourcePath,
          indexStatus: video.indexStatus,
          evidenceMode: contentTopicIds.size ? 'indexed_content' : 'catalog_metadata',
          topicNames: {
            shared: result.sharedTopicIds.map(id => topicNames.get(id) || id),
            notLinkedInCatalogIndex: selectedTopicIds.filter(id => !videoTopicIds.has(id)).map(id => topicNames.get(id) || id)
          },
          matchedTopicEvidence: video.topics.filter(topic => selectedTopicIds.includes(topic.topicId)).map(topic => ({
            topicId: topic.topicId, name: topicNames.get(topic.topicId) || topic.topicId,
            sourceKind: topic.sourceKind, confidence: topic.confidence, excerpt: topic.evidence,
            sourceRef: topic.sourceRef, page: topic.sourcePage,
            timestampStart: topic.timestampStart, timestampEnd: topic.timestampEnd
          })),
          coverage: {
            slides: metricsByOrigin('slides'),
            oral: metricsByOrigin('oral'),
            consolidated: {
              targetCount: selectedTopicIds.length,
              matchedTopicIds: selectedTopicIds.filter(id => observedTopicIds.has(id)),
              score: hasContentIndex && selectedTopicIds.length
                ? selectedTopicIds.filter(id => contentTopicIds.has(id)).length / selectedTopicIds.length : null,
              status: !selectedTopicIds.length ? 'no_targets' : hasContentIndex ? 'indexed_topic_match' : 'metadata_match_only'
            }
          },
          thematicSimilarity: result.metrics.thematicSimilarity,
          complementaryGain: result.metrics.complementaryGain,
          depth: video.topics.some(topic => Number.isInteger(topic.depthLevel))
            ? video.topics.map(topic => topic.depthLevel).filter(Number.isInteger) : null,
          recommendedSegments
        };
      });
      const pairs = [];
      for (let i = 0; i < videos.length; i++) for (let j = i + 1; j < videos.length; j++) {
        const result = compareIscResources(videos[i], videos[j], { taxonomy, expectedTopicIds: selectedTopicIds });
        pairs.push({
          left: videos[i].resourceKey, right: videos[j].resourceKey,
          relation: result.relation, classificationStatus: result.classificationStatus,
          thematicSimilarity: result.metrics.thematicSimilarity,
          sharedTopicNames: result.sharedTopicIds.map(id => topicNames.get(id) || id),
          exclusiveLeft: result.exclusiveTopicIds.left.map(id => topicNames.get(id) || id),
          exclusiveRight: result.exclusiveTopicIds.right.map(id => topicNames.get(id) || id)
        });
      }
      const roadmap = comparisons.map((item, index) => ({
        order: index + 1, resourceKey: item.resourceKey, title: item.title,
        focus: item.evidenceMode === 'indexed_content'
          ? `Revisar ${item.coverage.consolidated.matchedTopicIds.length} tópico(s) reconhecido(s) no conteúdo indexado.`
          : 'Candidato por título/pasta; confirme a aula antes de estudar, pois o conteúdo e os timestamps ainda não estão indexados.'
      }));
      return res.set('Cache-Control', 'private, no-store').json({
        success: true, indexVersion: ISC_INDEX_VERSION,
        evidenceMode: comparisons.some(item => item.evidenceMode === 'indexed_content') ? 'mixed' : 'catalog_metadata',
        curriculum: { topics: curriculum.topics.filter(topic => selectedTopicIds.includes(topic.topicId)), counts: curriculum.counts },
        comparisons, pairs, roadmap
      });
    } catch (error) {
      console.error('[ISC] Falha ao comparar aulas com a Aula do Dia:', error.message);
      return res.status(503).json({ success: false, msg: 'Não foi possível comparar as aulas selecionadas.' });
    }
  });

  app.post('/api/isc/user-resources', async (req, res) => {
    if (!ready(res)) return;
    const username = String(req.user?.username || '').trim().toLowerCase();
    if (!username) return res.status(401).json({ success: false, msg: 'Não autenticado.' });
    let text = typeof req.body?.text === 'string' ? req.body.text : '';
    const sourceId = String(req.body?.sourceId || '').trim();
    if (!/^[a-z0-9_-]{3,80}$/i.test(sourceId)) return res.status(400).json({ success: false, msg: 'Identificador da aula inválido.' });
    const sourceKind = String(req.body?.sourceKind || 'transcript');
    if (!['transcript', 'pdf_text', 'slides'].includes(sourceKind)) return res.status(400).json({ success: false, msg: 'Tipo de fonte inválido.' });
    const encodedPdf = typeof req.body?.pdfBase64 === 'string' ? req.body.pdfBase64.replace(/\s+/g, '') : '';
    if (encodedPdf) {
      if (!['pdf_text', 'slides'].includes(sourceKind) || text.trim()) return res.status(400).json({ success: false, msg: 'Envie o PDF ou o texto extraído, não ambos.' });
      if (encodedPdf.length > 24_000_000) return res.status(413).json({ success: false, msg: 'O PDF excede o limite de 18 MB.' });
      const bytes = Buffer.from(encodedPdf, 'base64');
      if (!bytes.length || bytes.length > 18 * 1024 * 1024) return res.status(413).json({ success: false, msg: 'O PDF excede o limite de 18 MB.' });
      if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return res.status(415).json({ success: false, msg: 'O arquivo enviado não parece ser um PDF válido.' });
      try {
        text = await pdfParaTexto(bytes.toString('base64'), { maxChars: 200_000 });
        if (text.includes('[…texto truncado…]')) return res.status(413).json({ success: false, msg: 'O PDF tem mais de 200 mil caracteres extraíveis. Divida-o em partes antes de indexar.' });
      } catch (error) {
        return res.status(error.status || 422).json({ success: false, msg: error.message || 'Não foi possível extrair texto do PDF.' });
      }
    }
    let sourcePages = [];
    if (req.body?.sourcePages !== undefined) {
      const rawPages = req.body.sourcePages;
      if (!['pdf_text', 'slides'].includes(sourceKind) || !Array.isArray(rawPages) || rawPages.length > 500) {
        return res.status(400).json({ success: false, msg: 'As referências de páginas ou slides são inválidas.' });
      }
      let previousEnd = 0;
      for (const page of rawPages) {
        if (!page || !Number.isInteger(page.page) || page.page < 1 || page.page > 100_000 ||
            !Number.isInteger(page.start) || !Number.isInteger(page.end) || page.start < previousEnd ||
            page.start < 0 || page.end <= page.start || page.end > text.length) {
          return res.status(400).json({ success: false, msg: 'As referências de páginas ou slides não correspondem ao texto enviado.' });
        }
        previousEnd = page.end;
      }
      sourcePages = rawPages;
    }
    if (text.trim().length < 50) return res.status(400).json({ success: false, msg: 'A fonte precisa ter pelo menos 50 caracteres.' });
    if (text.length > 500_000) return res.status(413).json({ success: false, msg: 'O limite de indexação é 500 mil caracteres por material.' });
    const embeddingConfig = getEmbeddingConfig();
    if (!embeddingConfig.token) return res.status(503).json({ success: false, msg: 'Provedor de embeddings não está configurado no servidor.' });
    const title = String(req.body?.title || 'Aula do Dia').trim().slice(0, 240);
    const course = String(req.body?.course || '').trim().slice(0, 120);
    const resourceKey = `user:${username}:${sourceId}`;
    try {
      const sourceHash = hashIsc({ title, course, sourceKind, text,
        sourcePages: sourcePages.map(({ page, start, end }) => [page, start, end]), indexVersion: ISC_INDEX_VERSION });
      const { data: existing, error: existingError } = await supabase.from('isc_resources')
        .select('source_hash,metadata').eq('resource_key', resourceKey).eq('scope', 'user')
        .eq('owner_username', username).maybeSingle();
      if (existingError) throw new Error(existingError.message);
      if (existing?.source_hash === sourceHash && existing?.metadata?.embeddingStatus === 'indexed') {
        return res.json({ success: true, resourceKey, unchanged: true, segments: 0, topics: 0 });
      }
      const taxonomyNodes = await getTaxonomy(supabase);
      const built = buildIscUserResource({ text, sourceKind, title, course, resourceId: sourceId, username,
        taxonomy: { version: 1, nodes: taxonomyNodes }, sourcePages });
      const limiter = { nextRequestAt: 0 };
      const vectors = [];
      for (let start = 0; start < built.segments.length; start += 48) {
        const batch = built.segments.slice(start, start + 48);
        vectors.push(...await embedQuery(batch.map(segment => segment.text), { purpose: 'document', config: embeddingConfig, limiter }));
      }
      if (vectors.length !== built.segments.length) throw new Error('Quantidade de vetores retornada não corresponde aos segmentos.');
      const resource = {
        resource_key: built.resource.resourceKey, resource_id: built.resource.resourceId, resource_kind: 'aula_dia',
        title: built.resource.title, course: built.resource.course, source_path: '', source_hash: built.resource.sourceHash,
        indexer_version: built.resource.indexerVersion, source_kind: built.resource.sourceKind,
        index_status: built.resource.indexStatus, metadata_confidence: built.resource.metadataConfidence,
        taxonomy_topic_ids: built.resource.taxonomyTopicIds, catalog_generated_at: null, scope: 'user',
        owner_username: username, is_active: true, metadata: {
          ...built.resource.metadata,
          ...(sourceKind === 'slides' ? { slideImport: {
            slideCount: Number.isInteger(req.body?.sourceMeta?.slideCount) ? Math.max(0, Math.min(500, req.body.sourceMeta.slideCount)) : null,
            pageCount: Number.isInteger(req.body?.sourceMeta?.pageCount) ? Math.max(0, Math.min(500, req.body.sourceMeta.pageCount)) : null,
            slidesWithFigures: Array.isArray(req.body?.sourceMeta?.slidesWithFigures)
              ? req.body.sourceMeta.slidesWithFigures.filter(page => Number.isInteger(page) && page > 0 && page <= 500).slice(0, 500)
              : []
          } } : {}),
          embeddingStatus: 'indexed'
        }
      };
      const topics = built.topics.map(topic => ({
        resource_key: resourceKey, topic_id: topic.topicId, source_hash: sourceHash, source_kind: sourceKind,
        evidence_ref: topic.sourceRef, evidence_excerpt: topic.excerpt, confidence: topic.confidence,
        coverage_level: null, depth_level: null, source_start: topic.sourceStart, source_end: topic.sourceEnd,
        source_page: topic.sourcePage, timestamp_start: null, timestamp_end: null
      }));
      const segments = built.segments.map((segment, index) => ({
        segment_id: hashIsc(`${resourceKey}:${sourceHash}:${segment.segmentIndex}`), resource_key: resourceKey,
        source_hash: sourceHash, segment_index: segment.segmentIndex, source_kind: sourceKind,
        topic_ids: segment.topicIds, evidence_ref: segment.sourceRef, evidence_excerpt: segment.excerpt,
        content_text: segment.text, source_start: segment.sourceStart, source_end: segment.sourceEnd,
        source_page: segment.sourcePage, timestamp_start: null, timestamp_end: null, confidence: segment.confidence,
        embedding_model: embeddingConfig.indexModel, embedding: vectors[index]
      }));
      const { error } = await supabase.rpc('replace_isc_user_resource', { p_resource: resource, p_topics: topics, p_segments: segments });
      if (error) throw new Error(error.message);
      return res.json({ success: true, resourceKey, unchanged: false, segments: segments.length, topics: topics.length });
    } catch (error) {
      console.error('[ISC] Falha ao indexar material pessoal:', error.message);
      return res.status(502).json({ success: false, msg: 'Não foi possível indexar o material. A versão anterior foi preservada.' });
    }
  });

  app.delete('/api/isc/my-resources/:resourceKey', async (req, res) => {
    if (!ready(res)) return;
    const username = String(req.user?.username || '').trim().toLowerCase();
    const resourceKey = String(req.params?.resourceKey || '');
    if (!username) return res.status(401).json({ success: false, msg: 'Não autenticado.' });
    if (!safeId(resourceKey) || !resourceKey.startsWith(`user:${username}:`)) return res.status(404).json({ success: false, msg: 'Material não encontrado.' });
    try {
      const { data, error } = await supabase.rpc('delete_isc_user_resource', { p_resource_key: resourceKey, p_owner_username: username });
      if (error) throw new Error(error.message);
      return data ? res.json({ success: true }) : res.status(404).json({ success: false, msg: 'Material não encontrado.' });
    } catch (error) {
      console.error('[ISC] Falha ao remover material pessoal:', error.message);
      return res.status(503).json({ success: false, msg: 'Não foi possível remover este material agora.' });
    }
  });

  app.get('/api/isc/taxonomy', async (req, res) => {
    if (!ready(res)) return;
    try {
      const query = normalizeIscText(String(req.query?.q || '').slice(0, 120));
      const kind = String(req.query?.kind || '');
      const parentId = String(req.query?.parentId || '');
      const taxonomy = await getTaxonomy(supabase);
      const nodes = taxonomy.filter(node => (!kind || node.kind === kind) && (!parentId || node.parentId === parentId) &&
        (!query || normalizeIscText(`${node.name} ${(node.synonyms || []).join(' ')}`).includes(query)));
      res.set('Cache-Control', 'private, max-age=60');
      return res.json({ success: true, version: 1, items: nodes.slice(0, 200) });
    } catch (error) {
      console.error('[ISC] Falha ao carregar taxonomia:', error.message);
      return res.status(503).json({ success: false, msg: 'Não foi possível consultar a taxonomia curricular.' });
    }
  });

  app.post('/api/isc/search', async (req, res) => {
    if (!ready(res)) return;
    const query = String(req.body?.query || '').trim().slice(0, 240);
    if (query.length < 3) return res.status(400).json({ success: false, msg: 'Digite ao menos 3 caracteres para pesquisar.' });
    const rawTopics = req.body?.topicIds;
    const rawObjectives = req.body?.objectiveIds;
    if ((rawTopics !== undefined && !Array.isArray(rawTopics)) || (rawObjectives !== undefined && !Array.isArray(rawObjectives)) ||
        (Array.isArray(rawTopics) && (rawTopics.length > 20 || rawTopics.some(id => !safeId(id)))) ||
        (Array.isArray(rawObjectives) && (rawObjectives.length > 20 || rawObjectives.some(id => !safeId(id))))) {
      return res.status(400).json({ success: false, msg: 'Os filtros curriculares enviados são inválidos.' });
    }
    const inputTopics = Array.isArray(rawTopics) ? rawTopics : [];
    const objectiveIds = Array.isArray(rawObjectives) ? rawObjectives : [];
    const course = String(req.body?.course || '').trim().slice(0, 120);
    const discipline = String(req.body?.discipline || '').trim().slice(0, 120);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.body?.limit, 10) || 24));
    try {
      const config = getEmbeddingConfig();
      const taxonomy = (inputTopics.length || objectiveIds.length || discipline) ? await getTaxonomy(supabase) : [];
      const filters = resolveCurriculumFilters(taxonomy, { topicIds: inputTopics, objectiveIds, discipline });
      if ((inputTopics.length || objectiveIds.length || discipline) && !filters.topicIds.length) {
        return res.json({ success: true, indexVersion: 1, searchMode: 'insufficient_taxonomy_coverage',
          filters: { ...filters, course: course || null, status: 'insufficient_taxonomy_coverage' }, itens: [] });
      }
      let semanticRows = [], keywordRows = [];
      if (config.token) {
        const vector = await getQueryEmbedding(query, config, embedQuery);
        const { data, error } = await supabase.rpc('search_isc_resources', {
          p_query_embedding: vector,
          p_embedding_model: config.indexModel,
          p_topic_ids: filters.topicIds,
          p_result_limit: limit,
          p_course_filter: course || null
        });
        if (error) throw new Error(error.message);
        semanticRows = (data || []).map(row => ({ ...row, search_mode: 'semantic' }));
      }
      const { data: keywordData, error: keywordError } = await supabase.rpc('search_isc_resources_keywords', {
        p_query: query, p_topic_ids: filters.topicIds, p_course_filter: course || null, p_result_limit: limit
      });
      if (keywordError) throw new Error(keywordError.message);
      keywordRows = (keywordData || []).map(row => ({ ...row, search_mode: 'keyword' }));
      const rowsByKey = new Map();
      for (const row of [...semanticRows, ...keywordRows]) if (!rowsByKey.has(row.resource_key)) rowsByKey.set(row.resource_key, row);
      const entries = catalogEntries(getCatalog?.());
      return res.json({
        success: true,
        indexVersion: 1,
        searchMode: semanticRows.length ? 'hybrid' : 'metadata_keyword',
        embeddingModel: semanticRows.length ? config.indexModel : null,
        filters: { ...filters, course: course || null },
        itens: [...rowsByKey.values()].slice(0, limit).map(row => toSearchItem(row, entries))
      });
    } catch (error) {
      if (/^Filtro curricular desconhecido:/.test(error.message) || error.message === 'Disciplina ou pasta não encontrada na taxonomia curricular.') {
        return res.status(400).json({ success: false, msg: error.message });
      }
      console.error('[ISC] Falha na busca semântica:', error.message);
      return res.status(502).json({ success: false, msg: 'Não foi possível pesquisar no índice curricular agora.' });
    }
  });

  app.post('/api/isc/compare', async (req, res) => {
    if (!ready(res)) return;
    const rawKeys = Array.isArray(req.body?.resourceKeys) ? req.body.resourceKeys : [];
    if (rawKeys.length < 2 || rawKeys.length > 4 || rawKeys.some(key => !safeId(key)) || new Set(rawKeys).size !== rawKeys.length) {
      return res.status(400).json({ success: false, msg: 'Selecione de 2 a 4 recursos válidos para comparar.' });
    }
    const expectedTopicIds = Array.isArray(req.body?.objectiveIds) ? req.body.objectiveIds.slice(0, 30) : [];
    if (expectedTopicIds.some(id => !safeId(id))) return res.status(400).json({ success: false, msg: 'Objetivos de aprendizagem inválidos.' });
    try {
      const { data: resources, error: resourceError } = await supabase.from('isc_resources')
        .select('resource_key,resource_id,resource_kind,title,course,source_path,source_kind,index_status,metadata_confidence,is_active,scope,owner_username')
        .in('resource_key', rawKeys).eq('is_active', true);
      if (resourceError) throw new Error(resourceError.message);
      const ownedResources = (resources || []).filter(resource => resource.scope === 'catalog' ||
        (resource.scope === 'user' && resource.owner_username === String(req.user?.username || '').toLowerCase()));
      if (ownedResources.length !== rawKeys.length) return res.status(404).json({ success: false, msg: 'Um ou mais materiais não estão disponíveis para esta conta.' });
      const [{ data: topics, error: topicError }, { data: segments, error: segmentError }, taxonomy] = await Promise.all([
        supabase.from('isc_resource_topics').select('resource_key,topic_id,source_kind,confidence,coverage_level,depth_level,evidence_excerpt,evidence_ref,source_start,source_end,source_page,timestamp_start,timestamp_end').in('resource_key', rawKeys),
        supabase.from('isc_segments').select('resource_key,topic_ids,embedding,embedding_model,source_kind,confidence').in('resource_key', rawKeys),
        getTaxonomy(supabase)
      ]);
      if (topicError || segmentError) throw new Error(topicError?.message || segmentError?.message);
      const byKey = new Map(ownedResources.map(resource => [resource.resource_key, {
        ...resource,
        topics: (topics || []).filter(topic => topic.resource_key === resource.resource_key).map(topic => ({
          topicId: topic.topic_id, sourceKind: topic.source_kind, confidence: topic.confidence,
          coverageLevel: topic.coverage_level, depthLevel: topic.depth_level, evidence: topic.evidence_excerpt,
          sourceStart: topic.source_start, sourceEnd: topic.source_end, sourcePage: topic.source_page,
          timestampStart: topic.timestamp_start, timestampEnd: topic.timestamp_end
        })),
          segments: (segments || []).filter(segment => segment.resource_key === resource.resource_key).map(segment => ({
            ...segment, embeddingModel: segment.embedding_model
          }))
      }]));
      const items = rawKeys.map(key => byKey.get(key));
      const pairs = [];
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const result = compareIscResources(items[i], items[j], { taxonomy, expectedTopicIds });
        const topicName = id => taxonomy.find(node => node.id === id)?.name || id;
        pairs.push({ left: items[i].resource_key, right: items[j].resource_key, ...result,
          topicNames: {
            shared: result.sharedTopicIds.map(topicName),
            exclusiveLeft: result.exclusiveTopicIds.left.map(topicName),
            exclusiveRight: result.exclusiveTopicIds.right.map(topicName)
          }
        });
      }
      return res.json({ success: true, indexVersion: 1, resources: items.map(item => ({
        resourceKey: item.resource_key, resourceId: item.resource_id, resourceKind: item.resource_kind,
        title: item.title, course: item.course, sourcePath: item.source_path, sourceKind: item.source_kind,
        indexStatus: item.index_status, metadataConfidence: item.metadata_confidence, scope: item.scope
      })), pairs });
    } catch (error) {
      console.error('[ISC] Falha ao comparar materiais:', error.message);
      return res.status(502).json({ success: false, msg: 'Não foi possível comparar os materiais indexados.' });
    }
  });

  // Endpoint administrativo é apenas diagnóstico; a indexação pesada permanece no CLI retomável.
  app.get('/api/admin/isc/status', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, msg: 'Apenas administradores podem consultar o status do índice.' });
    if (!ready(res)) return;
    try {
      const [{ count, error }, { data: latest, error: latestError }] = await Promise.all([
        supabase.from('isc_resources').select('*', { count: 'exact', head: true }).eq('scope', 'catalog').eq('is_active', true),
        supabase.from('isc_resources').select('indexed_at,index_status').eq('scope', 'catalog').eq('is_active', true).order('indexed_at', { ascending: false }).limit(1)
      ]);
      if (error || latestError) throw new Error(error?.message || latestError?.message);
      return res.json({ success: true, resources: count || 0, lastIndexedAt: latest?.[0]?.indexed_at || null, lastStatus: latest?.[0]?.index_status || null });
    } catch (error) {
      console.error('[ISC] Falha ao consultar status:', error.message);
      return res.status(503).json({ success: false, msg: 'Não foi possível consultar o status do índice.' });
    }
  });
}
