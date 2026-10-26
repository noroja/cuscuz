import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedIscTexts, normalizeIscVector, semanticEmbeddingConfig } from './isc-embeddings.js';

export const QUESTION_INDEX_VERSION = 1;
export const QUESTION_INDEX_SOURCE = 'local-bank';
export const QUESTION_INDEX_STAGING_REF = 'qbfcfxfzvahiuqvbflzf';
const QUESTION_EMBEDDING_BATCH_SIZE = 32;
const QUESTION_EMBEDDING_MAX_CHARS = 12000;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const STOP = new Set(['a', 'ao', 'aos', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'por', 'que', 'sem', 'sobre', 'uma']);

export function normalizeQuestionIndexText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function questionOptions(question) {
  const options = Array.isArray(question?.options) ? question.options : Array.isArray(question?.opts) ? question.opts : [];
  return options.map(option => typeof option === 'string' ? option : String(option?.text || option?.value || '')).filter(Boolean);
}

function questionId(question) {
  return String(question?.id || question?.remoteId || '').trim();
}

export function questionIndexId(question) {
  return questionId(question);
}

function correctIndex(question, options) {
  for (const value of [question?.correctIndex, question?.ans]) {
    if (Number.isInteger(value) && value >= 0 && value < options.length) return value;
  }
  const letter = String(question?.correctLetter || '').trim().toUpperCase();
  const byLetter = /^[A-Z]$/.test(letter) ? letter.charCodeAt(0) - 65 : -1;
  if (byLetter >= 0 && byLetter < options.length) return byLetter;
  if (typeof question?.correctAnswer === 'string') {
    const answer = options.indexOf(question.correctAnswer);
    return answer >= 0 ? answer : null;
  }
  return null;
}

function eligibleTaxonomyNodes(taxonomy) {
  return (taxonomy?.nodes || []).filter(node => node && node.id && node.canonical !== false && node.origin !== 'catalog_path' &&
    ['subject', 'subtopic', 'learning_objective'].includes(node.kind));
}

function taxonomyFingerprint(taxonomy) {
  const nodes = (taxonomy?.nodes || []).filter(node => node?.id).map(node => ({
    id: String(node.id), kind: String(node.kind || ''), parentId: String(node.parentId || ''),
    name: String(node.name || ''), synonyms: Array.isArray(node.synonyms) ? node.synonyms.map(String) : [],
    canonical: node.canonical !== false, origin: String(node.origin || '')
  })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify({ version: taxonomy?.version || 1, nodes })).digest('hex');
}

function searchableVariants(node) {
  return [...new Set([node.name, ...(Array.isArray(node.synonyms) ? node.synonyms : [])]
    .map(value => ({ raw: String(value || '').trim(), normalized: normalizeQuestionIndexText(value) }))
    .filter(value => {
      if (!value.normalized) return false;
      const words = value.normalized.split(' ');
      if (words.length > 1) return true;
      const originalIsAcronym = value.raw.length <= 5 && /^[A-Z0-9-]+$/.test(value.raw);
      return value.normalized.length >= 6 || originalIsAcronym;
    }).map(value => `${value.normalized}\u0000${value.raw}`))]
    .map(value => { const [normalized, raw] = value.split('\u0000'); return { normalized, raw }; })
    .sort((a, b) => b.normalized.length - a.normalized.length);
}

function containsPhrase(text, phrase) {
  if (!text || !phrase) return false;
  const paddedText = ` ${text} `;
  return paddedText.includes(` ${phrase} `);
}

function taxonomyAncestors(topicId, byId) {
  const parents = [];
  let current = byId.get(topicId);
  const seen = new Set([topicId]);
  while (current?.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) {
    const parent = byId.get(current.parentId);
    seen.add(parent.id);
    parents.push(parent.id);
    current = parent;
  }
  return parents;
}

export function classifyQuestionTopics(question, taxonomy) {
  const byId = new Map((taxonomy?.nodes || []).filter(node => node?.id).map(node => [node.id, node]));
  const fields = [
    ['statement', question?.statement || question?.q || question?.enunciado || ''],
    ['options', questionOptions(question).join(' ')],
    ['explanation', question?.explanation || question?.comment || question?.justification || ''],
    ['metadata', [question?.specialty, question?.subspecialty, question?.institution, question?.source,
      ...(Array.isArray(question?.tags) ? question.tags : [])].filter(Boolean).join(' ')]
  ].map(([name, text]) => ({ name, text: String(text || '').slice(0, 12000), normalized: normalizeQuestionIndexText(text) }));
  const topicEvidence = [];
  const topicIds = new Set();

  for (const node of eligibleTaxonomyNodes(taxonomy)) {
    const variants = searchableVariants(node);
    let match = null;
    for (const field of fields) {
      for (const variant of variants) {
        if (!containsPhrase(field.normalized, variant.normalized)) continue;
        match = { field, variant };
        break;
      }
      if (match) break;
    }
    if (!match) continue;

    const excerpt = match.field.text.replace(/\s+/g, ' ').trim().slice(0, 260);
    const ancestors = taxonomyAncestors(node.id, byId);
    topicIds.add(node.id);
    ancestors.forEach(id => topicIds.add(id));
    topicEvidence.push({
      topicId: node.id,
      canonicalName: node.name,
      sourceField: match.field.name,
      matchedTerm: match.variant.raw,
      matchKind: normalizeQuestionIndexText(node.name) === match.variant.normalized ? 'canonical_phrase' : 'synonym',
      excerpt,
      ancestorTopicIds: ancestors,
      confidence: null,
      validation: 'heuristic_unreviewed'
    });
  }

  return { topicIds: [...topicIds].sort(), topicEvidence };
}

function questionHash(question) {
  const options = questionOptions(question);
  const content = {
    id: questionId(question),
    statement: String(question?.statement || question?.q || question?.enunciado || '').trim(),
    options,
    explanation: String(question?.explanation || question?.comment || question?.justification || '').trim(),
    correctIndex: correctIndex(question, options),
    difficulty: String(question?.difficulty || ''),
    specialty: String(question?.specialty || ''),
    subspecialty: String(question?.subspecialty || ''),
    tags: Array.isArray(question?.tags) ? question.tags.map(String) : [],
    source: String(question?.source || ''),
    year: Number.isInteger(Number(question?.year)) ? Number(question.year) : null
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export function buildQuestionIndexRow(question, taxonomy, {
  taxonomyVersion = taxonomy?.version || 1,
  taxonomyHash = taxonomyFingerprint(taxonomy)
} = {}) {
  const id = questionId(question);
  const statement = String(question?.statement || question?.q || question?.enunciado || '').trim();
  if (!id || !statement) return null;

  const options = questionOptions(question);
  const classified = classifyQuestionTopics(question, taxonomy);
  const explanation = String(question?.explanation || question?.comment || question?.justification || '').trim();
  const tags = Array.isArray(question?.tags) ? [...new Set(question.tags.map(String).map(value => value.trim()).filter(Boolean))] : [];
  const searchText = [statement, ...options, explanation, question?.specialty, question?.subspecialty, question?.institution, ...tags]
    .filter(Boolean).join('\n').slice(0, 40000);
  const year = Number(question?.year);

  return {
    question_id: id,
    source_collection: QUESTION_INDEX_SOURCE,
    source_hash: createHash('sha256').update(`${questionHash(question)}|${taxonomyHash}|${QUESTION_INDEX_VERSION}`).digest('hex'),
    indexer_version: QUESTION_INDEX_VERSION,
    statement,
    options,
    correct_index: correctIndex(question, options),
    explanation,
    difficulty: String(question?.difficulty || '').slice(0, 40),
    specialty: String(question?.specialty || '').slice(0, 120),
    subspecialty: String(question?.subspecialty || '').slice(0, 120),
    source: String(question?.source || '').slice(0, 240),
    year: Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null,
    tags,
    canonical_topic_ids: classified.topicIds,
    topic_evidence: classified.topicEvidence,
    search_text: searchText,
    index_status: classified.topicEvidence.length ? 'indexed' : 'unclassified',
    is_active: true,
    metadata: { indexMethod: 'curated_taxonomy_lexical_v1', taxonomyVersion, taxonomyHash }
  };
}

export function buildQuestionIndexPlan(bank, taxonomy) {
  const taxonomyHash = taxonomyFingerprint(taxonomy);
  const rows = [];
  const seenIds = new Set();
  let skipped = 0;
  let duplicateIds = 0;
  for (const question of Array.isArray(bank) ? bank : []) {
    const row = buildQuestionIndexRow(question, taxonomy, { taxonomyHash });
    if (!row) { skipped++; continue; }
    if (seenIds.has(row.question_id)) { duplicateIds++; continue; }
    seenIds.add(row.question_id);
    rows.push(row);
  }
  rows.sort((a, b) => a.question_id.localeCompare(b.question_id));
  const sourceHash = createHash('sha256').update(JSON.stringify({
    version: QUESTION_INDEX_VERSION,
    taxonomyHash,
    rows: rows.map(row => [row.question_id, row.source_hash])
  })).digest('hex');
  return {
    rows,
    sourceHash,
    stats: {
      inputCount: Array.isArray(bank) ? bank.length : 0,
      indexedCount: rows.length,
      classifiedCount: rows.filter(row => row.topic_evidence.length).length,
      unclassifiedCount: rows.filter(row => !row.topic_evidence.length).length,
      skippedCount: skipped,
      duplicateIdCount: duplicateIds
    },
    taxonomyHash
  };
}

let taxonomyPromise = null;
let cachedBank = null;
let cachedTaxonomy = null;
let cachedPlan = null;

export async function loadQuestionIndexTaxonomy() {
  if (!taxonomyPromise) {
    taxonomyPromise = fs.readFile(path.join(ROOT, 'data', 'isc-taxonomy.json'), 'utf8')
      .then(JSON.parse)
      .then(taxonomy => {
        if (!Array.isArray(taxonomy?.nodes)) throw new Error('Taxonomia ISC inválida para indexar questões.');
        return taxonomy;
      })
      .catch(error => { taxonomyPromise = null; throw error; });
  }
  return taxonomyPromise;
}

export async function getQuestionIndexPlan(bank) {
  const taxonomy = await loadQuestionIndexTaxonomy();
  if (cachedBank !== bank || cachedTaxonomy !== taxonomy || !cachedPlan) {
    cachedBank = bank;
    cachedTaxonomy = taxonomy;
    cachedPlan = buildQuestionIndexPlan(bank, taxonomy);
  }
  return cachedPlan;
}

export function clearQuestionIndexPlanCache() {
  cachedBank = null;
  cachedTaxonomy = null;
  cachedPlan = null;
}

export function filterQuestionsByIndexRows(bank, indexRows) {
  const ids = new Set((Array.isArray(indexRows) ? indexRows : []).map(row => String(row?.questionId || row?.question_id || '')).filter(Boolean));
  return (Array.isArray(bank) ? bank : []).filter(question => ids.has(questionId(question)));
}

export function assertQuestionIndexTarget(supabaseUrl, targetRef) {
  let parsed;
  try { parsed = new URL(String(supabaseUrl || '')); }
  catch (_) { throw new Error('SUPABASE_URL inválida para indexar questões.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== `${QUESTION_INDEX_STAGING_REF}.supabase.co`) {
    throw new Error(`A indexação de questões está restrita ao staging ${QUESTION_INDEX_STAGING_REF}.`);
  }
  if (String(targetRef || '') !== QUESTION_INDEX_STAGING_REF) {
    throw new Error(`Confirme o destino de staging com --target-ref=${QUESTION_INDEX_STAGING_REF}.`);
  }
  return QUESTION_INDEX_STAGING_REF;
}

export async function searchPersistedQuestionIndex(supabase, {
  query = '', topicIds = [], sourceHash, limit = 200, queryEmbedding = null, embeddingModel = null
} = {}) {
  if (!supabase?.rpc || !sourceHash) return { available: false, ready: false, rows: [], reason: 'not_configured' };
  const { data, error } = await supabase.rpc('search_isc_questions', {
    p_query: String(query).slice(0, 1200),
    p_topic_ids: [...new Set((Array.isArray(topicIds) ? topicIds : []).map(String).filter(Boolean))].slice(0, 100),
    p_expected_hash: sourceHash,
    p_indexer_version: QUESTION_INDEX_VERSION,
    p_result_limit: Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 200)),
    p_query_embedding: Array.isArray(queryEmbedding) ? queryEmbedding : null,
    p_embedding_model: String(embeddingModel || '') || null
  });
  if (error) return { available: false, ready: false, rows: [], reason: 'query_failed', error };
  const rows = Array.isArray(data) ? data : [];
  const matches = rows.filter(row => row?.index_ready === true && row?.question_id).map(row => ({
    questionId: String(row.question_id),
    topicIds: Array.isArray(row.canonical_topic_ids) ? row.canonical_topic_ids : [],
    topicEvidence: Array.isArray(row.topic_evidence) ? row.topic_evidence : [],
    rank: Number.isFinite(Number(row.search_rank)) ? Number(row.search_rank) : 0,
    semanticScore: row.semantic_score == null || !Number.isFinite(Number(row.semantic_score)) ? null : Number(row.semantic_score),
    textScore: Number.isFinite(Number(row.text_score)) ? Number(row.text_score) : 0
  }));
  return {
    available: true,
    ready: rows.some(row => row?.index_ready === true),
    rows: matches,
    semanticEnabled: matches.some(row => row.semanticScore != null),
    reason: rows.some(row => row?.index_ready === true) ? null : rows[0]?.index_ready ? 'no_matches' : 'stale_or_incomplete'
  };
}

async function readExistingQuestionIndex(supabase) {
  const existing = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await supabase.from('isc_question_index')
      .select('question_id,source_hash,indexer_version,is_active')
      .eq('source_collection', QUESTION_INDEX_SOURCE).order('question_id').range(start, start + 499);
    if (error) throw new Error(`Não foi possível ler o índice persistente de questões: ${error.message}`);
    existing.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  return existing;
}

async function readExistingQuestionEmbeddings(supabase) {
  const existing = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await supabase.from('isc_question_embeddings')
      .select('question_id,content_hash,embedding_model').order('question_id').range(start, start + 499);
    if (error) throw new Error(`Não foi possível ler os embeddings persistidos das questões: ${error.message}`);
    existing.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  return existing;
}

export async function indexQuestionBank(supabase, bank, taxonomy, {
  apply = false, batchSize = 100, embed = false, embedTexts = embedIscTexts,
  embeddingConfig = semanticEmbeddingConfig(), embeddingBatchSize = QUESTION_EMBEDDING_BATCH_SIZE,
  onProgress = () => {}
} = {}) {
  if (apply && !supabase) throw new Error('Supabase não configurado para persistir o índice de questões.');
  const plan = buildQuestionIndexPlan(bank, taxonomy);
  const existing = apply ? await readExistingQuestionIndex(supabase) : [];
  const existingById = new Map(existing.map(row => [row.question_id, row]));
  const changed = plan.rows.filter(row => {
    const old = existingById.get(row.question_id);
    return !old || old.source_hash !== row.source_hash || old.indexer_version !== QUESTION_INDEX_VERSION || !old.is_active;
  });
  const existingEmbeddings = apply && embed ? await readExistingQuestionEmbeddings(supabase) : [];
  const embeddingsById = new Map(existingEmbeddings.map(row => [row.question_id, row]));
  const embeddingRows = embed ? plan.rows.filter(row => {
    const old = embeddingsById.get(row.question_id);
    const contentHash = createHash('sha256').update(row.search_text.slice(0, QUESTION_EMBEDDING_MAX_CHARS)).digest('hex');
    return !old || old.content_hash !== contentHash || old.embedding_model !== embeddingConfig.indexModel;
  }) : [];
  if (apply && embed && embeddingRows.length && !embeddingConfig.token) {
    throw new Error('A opção --embed requer um provedor de embeddings configurado; nenhuma questão foi persistida nesta execução.');
  }
  const activeIds = new Set(plan.rows.map(row => row.question_id));
  const removedIds = existing.filter(row => row.is_active && !activeIds.has(row.question_id)).map(row => row.question_id);
  const report = {
    ...plan.stats,
    changedCount: changed.length,
    unchangedCount: apply ? plan.rows.length - changed.length : null,
    deactivatedCount: removedIds.length,
    embeddingsRequested: embed,
    embeddingsToGenerate: embed ? (apply ? embeddingRows.length : plan.rows.length) : null,
    embeddingsUnchanged: embed && apply ? plan.rows.length - embeddingRows.length : null,
    sourceHash: plan.sourceHash,
    applied: false
  };
  if (!apply) return report;

  for (let start = 0; start < changed.length; start += Math.max(1, batchSize)) {
    const batch = changed.slice(start, start + Math.max(1, batchSize));
    const { error } = await supabase.from('isc_question_index').upsert(batch, { onConflict: 'question_id' });
    if (error) throw new Error(`Falha ao persistir questões ${start + 1}-${start + batch.length}: ${error.message}`);
    onProgress({ processed: Math.min(changed.length, start + batch.length), total: changed.length });
  }

  let embeddingsProcessed = 0;
  if (embed) {
    const limiter = { nextRequestAt: 0 };
    for (let start = 0; start < embeddingRows.length; start += Math.max(1, embeddingBatchSize)) {
      const batch = embeddingRows.slice(start, start + Math.max(1, embeddingBatchSize));
      const texts = batch.map(row => row.search_text.slice(0, QUESTION_EMBEDDING_MAX_CHARS));
      const vectors = await embedTexts(texts, { purpose: 'document', config: embeddingConfig, limiter });
      if (vectors.length !== batch.length) throw new Error('O provedor retornou quantidade diferente de embeddings para as questões.');
      const rows = batch.map((question, index) => ({
        question_id: question.question_id,
        content_hash: createHash('sha256').update(texts[index]).digest('hex'),
        embedding_model: embeddingConfig.indexModel,
        embedding: normalizeIscVector(vectors[index])
      }));
      const { error } = await supabase.from('isc_question_embeddings').upsert(rows, { onConflict: 'question_id' });
      if (error) throw new Error(`Falha ao persistir embeddings de questões ${start + 1}-${start + batch.length}: ${error.message}`);
      embeddingsProcessed += batch.length;
      onProgress({ embeddingsProcessed, embeddingsTotal: embeddingRows.length });
    }
  }

  for (let start = 0; start < removedIds.length; start += 200) {
    const batch = removedIds.slice(start, start + 200);
    const { error } = await supabase.from('isc_question_index').update({ is_active: false }).eq('source_collection', QUESTION_INDEX_SOURCE).in('question_id', batch);
    if (error) throw new Error(`Falha ao desativar questões removidas do banco: ${error.message}`);
  }

  const { error: stateError } = await supabase.from('isc_question_index_state').upsert({
    source_collection: QUESTION_INDEX_SOURCE,
    source_hash: plan.sourceHash,
    indexer_version: QUESTION_INDEX_VERSION,
    item_count: plan.rows.length,
    completed_at: new Date().toISOString()
  }, { onConflict: 'source_collection' });
  if (stateError) throw new Error(`Não foi possível concluir o estado do índice de questões: ${stateError.message}`);
  return { ...report, embeddingsProcessed, applied: true };
}
