-- Persiste um índice leve de título/pasta para a videoaula aberta, sem substituir conteúdo existente.
create or replace function public.ensure_isc_video_metadata_index(
  p_resource jsonb,
  p_taxonomy_nodes jsonb,
  p_topics jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  inserted_key text;
begin
  if p_resource->>'resource_kind' is distinct from 'video'
    or p_resource->>'scope' is distinct from 'catalog'
    or p_resource->>'source_kind' is distinct from 'catalog_metadata'
    or p_resource->>'owner_username' is not null then
    raise exception 'Somente metadados de vídeo do catálogo podem ser indexados por esta função.';
  end if;

  insert into public.isc_taxonomy_nodes (
    id, kind, parent_id, canonical_name, normalized_name, synonyms, origin, is_canonical, confidence, metadata
  )
  select x.id, x.kind, x.parent_id, x.canonical_name, x.normalized_name, coalesce(x.synonyms, '{}'),
    x.origin, coalesce(x.is_canonical, false), coalesce(x.confidence, 0.45), coalesce(x.metadata, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_taxonomy_nodes, '[]'::jsonb)) as x(
    id text, kind text, parent_id text, canonical_name text, normalized_name text, synonyms text[],
    origin text, is_canonical boolean, confidence real, metadata jsonb
  )
  on conflict (id) do nothing;

  insert into public.isc_resources (
    resource_key, resource_id, resource_kind, title, course, source_path, source_hash,
    indexer_version, source_kind, index_status, metadata_confidence, taxonomy_topic_ids,
    catalog_generated_at, scope, owner_username, is_active, metadata, indexed_at, updated_at
  )
  select x.resource_key, x.resource_id, x.resource_kind, x.title, coalesce(x.course, ''), coalesce(x.source_path, ''), x.source_hash,
    x.indexer_version, x.source_kind, x.index_status, x.metadata_confidence, coalesce(x.taxonomy_topic_ids, '{}'),
    x.catalog_generated_at, x.scope, null, coalesce(x.is_active, true), coalesce(x.metadata, '{}'::jsonb), now(), now()
  from jsonb_to_record(p_resource) as x(
    resource_key text, resource_id text, resource_kind text, title text, course text, source_path text,
    source_hash text, indexer_version integer, source_kind text, index_status text, metadata_confidence real,
    taxonomy_topic_ids text[], catalog_generated_at timestamptz, scope text, owner_username text,
    is_active boolean, metadata jsonb
  )
  on conflict (resource_key) do nothing
  returning resource_key into inserted_key;

  -- Um índice completo pode ter sido gravado em paralelo. Nunca o substitua por metadados.
  if inserted_key is null then return false; end if;

  insert into public.isc_resource_topics (
    resource_key, topic_id, source_hash, source_kind, evidence_ref, evidence_excerpt,
    confidence, coverage_level, depth_level, source_start, source_end, source_page, timestamp_start, timestamp_end
  )
  select x.resource_key, x.topic_id, x.source_hash, x.source_kind, x.evidence_ref, x.evidence_excerpt,
    x.confidence, x.coverage_level, x.depth_level, x.source_start, x.source_end, x.source_page, x.timestamp_start, x.timestamp_end
  from jsonb_to_recordset(coalesce(p_topics, '[]'::jsonb)) as x(
    resource_key text, topic_id text, source_hash text, source_kind text, evidence_ref text, evidence_excerpt text,
    confidence real, coverage_level text, depth_level smallint, source_start integer, source_end integer,
    source_page integer, timestamp_start real, timestamp_end real
  )
  where x.resource_key = inserted_key;

  return true;
end;
$$;

revoke all on function public.ensure_isc_video_metadata_index(jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ensure_isc_video_metadata_index(jsonb, jsonb, jsonb) to service_role;
