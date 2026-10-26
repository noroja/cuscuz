import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIscCatalogResource, hashIsc, ISC_INDEX_VERSION, normalizeIscText } from './isc-core.js';
import { embedIscTexts, semanticEmbeddingConfig } from './isc-embeddings.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUCKET = 'acervo';
const TAXONOMY_PATH = path.join(ROOT, 'data', 'isc-taxonomy.json');
const RESOURCE_BATCH_SIZE = 24;
const EMBEDDING_BATCH_SIZE = 96;

function normalizeCatalogEntry(item, kind) {
  if (!item?.id) return null;
  return {
    ...item,
    id: String(item.id),
    t: String(item.t || item.title || item.name || item.d || 'Material do acervo'),
    d: String(item.d || item.discipline || item.folder || ''),
    course: String(item.course || item.curso || 'Geral'),
    path: String(item.path || item.relativePath || ''),
    kind
  };
}

export function mergeIscCatalogs(base, incoming) {
  const byKey = new Map();
  const add = (item, kind, replace = false) => {
    const normalized = normalizeCatalogEntry(item, kind);
    if (!normalized) return;
    const key = `${kind}:${normalized.id}`;
    if (replace || !byKey.has(key)) byKey.set(key, normalized);
  };
  for (const item of base?.videos || []) add(item, 'video');
  for (const item of base?.materials || []) add(item, 'material');
  for (const item of incoming?.videos || []) add(item, 'video', true);
  for (const item of incoming?.materials || []) add(item, 'material', true);
  for (const item of incoming?.items || []) {
    const kind = item.kind === 'video' || /^video\//i.test(item.mimeType || '') ? 'video'
      : item.kind === 'material' || item.mimeType ? 'material' : null;
    if (kind) add(item, kind, true);
  }
  const videos = [], materials = [];
  for (const item of byKey.values()) (item.kind === 'video' ? videos : materials).push(item);
  const courses = [...new Set([...(base?.courses || []), ...(incoming?.courses || []), ...videos, ...materials]
    .map(item => typeof item === 'string' ? item : item.course).filter(Boolean))];
  return { generatedAt: incoming?.generatedAt || base?.generatedAt || null, totalVideos: videos.length, totalMaterials: materials.length, videos, materials, courses };
}

export async function loadIscTaxonomy(filePath = TAXONOMY_PATH) {
  const taxonomy = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!Number.isInteger(taxonomy.version) || !Array.isArray(taxonomy.nodes)) throw new Error('Taxonomia ISC inválida.');
  return taxonomy;
}

export async function loadIscCatalog(supabase, fallbackPath = path.join(ROOT, 'acervo-manifest.json'), { catalogFile = null, mergeBasePath = fallbackPath } = {}) {
  if (catalogFile) {
    const incoming = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
    const base = mergeBasePath ? JSON.parse(await fs.readFile(mergeBasePath, 'utf8')) : null;
    return { catalog: base ? mergeIscCatalogs(base, incoming) : incoming, source: 'explicit_local_catalog' };
  }
  if (supabase?.storage) {
    const { data, error } = await supabase.storage.from(BUCKET).download('acervo-manifest.json');
    if (!error && data) return { catalog: JSON.parse(await data.text()), source: 'supabase_storage' };
    if (error && ![404, '404'].includes(error.statusCode)) throw new Error(`Não foi possível ler o catálogo atual do Storage: ${error.message}`);
  }
  const catalog = JSON.parse(await fs.readFile(fallbackPath, 'utf8'));
  return { catalog, source: 'local_fallback' };
}

export function buildIscCatalogPlan(catalog, taxonomy) {
  const seen = new Set();
  const entries = [
    ...(catalog?.videos || []).map(item => [item, 'video']),
    ...(catalog?.materials || []).map(item => [item, 'material']),
    ...(catalog?.items || []).map(item => [item, item.kind === 'video' || /^video\//i.test(item.mimeType || '') ? 'video' : 'material'])
  ];
  const resources = [];
  const candidates = new Map();
  for (const [item, kind] of entries) {
    const indexed = buildIscCatalogResource(item, kind, taxonomy, catalog?.generatedAt || '');
    if (!indexed || seen.has(indexed.resource.resourceKey)) continue;
    seen.add(indexed.resource.resourceKey);
    resources.push(indexed);
    for (const node of indexed.taxonomyNodes) candidates.set(node.id, node);
  }
  return { resources, candidateNodes: [...candidates.values()] };
}

function normalizeTaxonomyNode(node) {
  return {
    id: node.id,
    kind: node.kind,
    parent_id: node.parentId || null,
    canonical_name: node.name,
    normalized_name: normalizeIscText(node.name),
    synonyms: node.synonyms || [],
    origin: node.origin || 'curated',
    is_canonical: node.canonical !== false,
    confidence: node.confidence ?? 1,
    metadata: { taxonomyVersion: node.taxonomyVersion || 1 }
  };
}

async function upsertTaxonomy(supabase, nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const depthOf = node => {
    let depth = 0, current = node, seen = new Set();
    while (current?.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id); depth++; current = byId.get(current.parentId);
    }
    return depth;
  };
  const rows = nodes.map(node => ({ ...normalizeTaxonomyNode(node), _depth: depthOf(node) }))
    .sort((a, b) => a._depth - b._depth || a.id.localeCompare(b.id));
  for (let start = 0; start < rows.length;) {
    const depth = rows[start]._depth;
    const batch = [];
    while (start < rows.length && rows[start]._depth === depth && batch.length < 200) batch.push(rows[start++]);
    const { error } = await supabase.from('isc_taxonomy_nodes').upsert(batch.map(({ _depth, ...row }) => row), { onConflict: 'id' });
    if (error) throw new Error(`Não foi possível persistir a taxonomia ISC: ${error.message}`);
  }
}

async function readExistingResources(supabase) {
  const rows = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from('isc_resources')
      .select('resource_key,source_hash,indexer_version,is_active,metadata')
      .eq('scope', 'catalog').order('resource_key').range(start, start + 999);
    if (error) throw new Error(`Não foi possível consultar o índice ISC persistido: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

export async function indexIscCatalog(supabase, catalog, {
  taxonomy, apply = false, maxResources = Infinity, embedTexts = embedIscTexts,
  embeddingConfig = semanticEmbeddingConfig(),
  onProgress = () => {}, resourceBatchSize = RESOURCE_BATCH_SIZE, metadataOnly = false
} = {}) {
  if (apply && !supabase) throw new Error('Supabase não está configurado para o índice ISC.');
  if (!taxonomy) taxonomy = await loadIscTaxonomy();
  const plan = buildIscCatalogPlan(catalog, taxonomy);
  const existing = apply ? await readExistingResources(supabase) : [];
  const existingByKey = new Map(existing.map(row => [row.resource_key, row]));
  const pending = plan.resources.filter(entry => {
    const row = existingByKey.get(entry.resource.resourceKey);
    return !row || row.source_hash !== entry.resource.sourceHash || row.indexer_version !== ISC_INDEX_VERSION || !row.is_active ||
      (!metadataOnly && row.metadata?.embeddingStatus === 'pending');
  });
  const changed = Number.isFinite(maxResources) ? pending.slice(0, Math.max(0, maxResources)) : pending;
  const inactivatedKeys = existing.filter(row => row.is_active && !plan.resources.some(entry => entry.resource.resourceKey === row.resource_key)).map(row => row.resource_key);
  const segmentCount = metadataOnly ? 0 : changed.reduce((sum, entry) => sum + entry.segments.length, 0);
  const report = {
    sourceGeneratedAt: catalog?.generatedAt || null,
    totalCatalogResources: plan.resources.length,
    taxonomyNodes: taxonomy.nodes.length + plan.candidateNodes.length,
    changed: changed.length,
    unchanged: apply ? Math.max(0, plan.resources.length - pending.length) : null,
    deferred: Math.max(0, pending.length - changed.length),
    segmentsToEmbed: segmentCount,
    inactivated: inactivatedKeys.length,
    applied: false
  };
  if (!apply) return report;

  const config = embeddingConfig;
  if (!metadataOnly && changed.some(entry => entry.segments.length) && !config.token) throw new Error('Configure um dos provedores de embeddings já usados pelo projeto antes de executar --apply.');
  const allTaxonomy = [...taxonomy.nodes, ...plan.candidateNodes];
  await upsertTaxonomy(supabase, allTaxonomy);

  const limiter = { nextRequestAt: 0 };
  let committed = 0;
  for (let start = 0; start < changed.length; start += resourceBatchSize) {
    const resourceBatch = changed.slice(start, start + resourceBatchSize);
    const segments = metadataOnly ? [] : resourceBatch.flatMap(entry => entry.segments);
    const segmentRows = [];
    for (let segmentStart = 0; segmentStart < segments.length; segmentStart += EMBEDDING_BATCH_SIZE) {
      const segmentBatch = segments.slice(segmentStart, segmentStart + EMBEDDING_BATCH_SIZE);
      const vectors = await embedTexts(segmentBatch.map(segment => segment.text), { purpose: 'document', config, limiter });
      if (vectors.length !== segmentBatch.length) throw new Error('O provedor retornou quantidade diferente de embeddings.');
      for (let index = 0; index < segmentBatch.length; index++) {
        const segment = segmentBatch[index];
        const owner = resourceBatch.find(entry => entry.resource.sourceHash === segment.sourceHash && entry.segments.includes(segment));
        if (!owner) throw new Error('Segmento sem recurso de origem durante a indexação.');
        segmentRows.push({
          segment_id: hashIsc(`${owner.resource.resourceKey}:${segment.sourceHash}:${segment.segmentIndex}:${segment.topicIds.join(',')}`),
          resource_key: owner.resource.resourceKey,
          source_hash: segment.sourceHash,
          segment_index: segment.segmentIndex,
          source_kind: segment.sourceKind,
          topic_ids: segment.topicIds,
          evidence_ref: segment.sourceRef,
          evidence_excerpt: segment.excerpt,
          source_start: segment.sourceStart,
          source_end: segment.sourceEnd,
          source_page: segment.sourcePage,
          timestamp_start: segment.timestampStart,
          timestamp_end: segment.timestampEnd,
          confidence: segment.confidence,
          embedding_model: config.indexModel,
          embedding: vectors[index]
        });
      }
    }

    const resourceRows = resourceBatch.map(entry => ({
      ...entry.resource,
      resource_key: entry.resource.resourceKey,
      resource_id: entry.resource.resourceId,
      resource_kind: entry.resource.resourceKind,
      source_hash: entry.resource.sourceHash,
      indexer_version: entry.resource.indexerVersion,
      source_kind: entry.resource.sourceKind,
      index_status: entry.resource.indexStatus,
      metadata_confidence: entry.resource.metadataConfidence,
      taxonomy_topic_ids: entry.resource.taxonomyTopicIds,
      catalog_generated_at: entry.resource.catalogGeneratedAt,
      owner_username: null,
      metadata: { ...entry.resource.metadata, taxonomyVersion: taxonomy.version, embeddingStatus: metadataOnly ? 'pending' : 'indexed' }
    }));
    const topicRows = resourceBatch.flatMap(entry => entry.topics.map(topic => ({
      resource_key: entry.resource.resourceKey,
      topic_id: topic.topicId,
      source_hash: topic.sourceHash,
      source_kind: topic.sourceKind,
      evidence_ref: topic.sourceRef,
      evidence_excerpt: topic.excerpt,
      confidence: topic.confidence,
      coverage_level: topic.coverageLevel,
      depth_level: topic.depthLevel,
      source_start: null,
      source_end: null,
      source_page: null,
      timestamp_start: null,
      timestamp_end: null
    })));
    const { error } = await supabase.rpc('replace_isc_catalog_batch', {
      p_resources: resourceRows,
      p_topics: topicRows,
      p_segments: segmentRows
    });
    if (error) throw new Error(`Falha ao persistir lote ISC ${start + 1}-${start + resourceBatch.length}: ${error.message}`);
    committed += resourceBatch.length;
    onProgress({ processed: committed, total: changed.length, segments: segmentRows.length });
  }

  for (let start = 0; start < inactivatedKeys.length; start += 500) {
    const keys = inactivatedKeys.slice(start, start + 500);
    const { error } = await supabase.from('isc_resources').update({ is_active: false, updated_at: new Date().toISOString() }).in('resource_key', keys);
    if (error) throw new Error(`Não foi possível invalidar recursos removidos do catálogo: ${error.message}`);
  }
  return { ...report, applied: true, processed: committed, embeddingModel: config.indexModel };
}
