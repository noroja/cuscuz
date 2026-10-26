-- Conteúdo pessoal privado, busca textual do catálogo e recuperação do Mentor IA.
create extension if not exists unaccent with schema extensions;

alter table public.isc_resources
  add column if not exists search_text text not null default '';

alter table public.isc_segments
  add column if not exists content_text text;

create or replace function public.isc_refresh_search_text()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  new.search_text := lower(unaccent(concat_ws(' ', new.title, new.course, new.source_path, new.metadata::text)));
  return new;
end;
$$;

drop trigger if exists isc_resources_refresh_search_text on public.isc_resources;
create trigger isc_resources_refresh_search_text
before insert or update of title, course, source_path, metadata on public.isc_resources
for each row execute function public.isc_refresh_search_text();

update public.isc_resources
set search_text = lower(unaccent(concat_ws(' ', title, course, source_path, metadata::text)))
where search_text = '';

create index if not exists isc_resources_search_text_idx
  on public.isc_resources using gin (to_tsvector('simple', search_text));

create or replace function public.search_isc_resources_keywords(
  p_query text,
  p_topic_ids text[] default '{}',
  p_course_filter text default null,
  p_result_limit integer default 24
)
returns table (
  resource_key text,
  resource_id text,
  resource_kind text,
  title text,
  course text,
  source_path text,
  topic_ids text[],
  score real,
  evidence_excerpt text,
  source_kind text,
  source_page integer,
  timestamp_start real,
  timestamp_end real
)
language sql
stable
security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  with input as (
    select plainto_tsquery('simple', unaccent(coalesce(nullif(btrim(p_query), ''), '__none__'))) as query
  )
  select r.resource_key, r.resource_id, r.resource_kind, r.title, r.course, r.source_path,
    r.taxonomy_topic_ids,
    ts_rank(to_tsvector('simple', r.search_text), input.query)::real as score,
    coalesce((select t.evidence_excerpt from public.isc_resource_topics t
      where t.resource_key = r.resource_key order by t.confidence desc limit 1), '') as evidence_excerpt,
    'catalog_metadata'::text as source_kind,
    null::integer as source_page,
    null::real as timestamp_start,
    null::real as timestamp_end
  from public.isc_resources r
  cross join input
  where r.scope = 'catalog' and r.is_active = true
    and to_tsvector('simple', r.search_text) @@ input.query
    and (coalesce(cardinality(p_topic_ids), 0) = 0 or r.taxonomy_topic_ids && p_topic_ids)
    and (nullif(btrim(p_course_filter), '') is null or
      position(lower(unaccent(btrim(p_course_filter))) in lower(unaccent(coalesce(r.course, '') || ' ' || coalesce(r.source_path, '')))) > 0)
  order by score desc, r.title
  limit least(greatest(coalesce(p_result_limit, 24), 1), 50);
$$;

create or replace function public.replace_isc_user_resource(p_resource jsonb, p_topics jsonb, p_segments jsonb)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_resource_key text;
  v_changed integer;
begin
  insert into public.isc_resources (
    resource_key, resource_id, resource_kind, title, course, source_path, source_hash,
    indexer_version, source_kind, index_status, metadata_confidence, taxonomy_topic_ids,
    catalog_generated_at, scope, owner_username, is_active, metadata, indexed_at, updated_at
  )
  select x.resource_key, x.resource_id, 'aula_dia', x.title, coalesce(x.course, ''), '', x.source_hash,
    x.indexer_version, x.source_kind, x.index_status, x.metadata_confidence, coalesce(x.taxonomy_topic_ids, '{}'::text[]),
    null, 'user', x.owner_username, true, coalesce(x.metadata, '{}'::jsonb), now(), now()
  from jsonb_to_record(p_resource) as x(
    resource_key text, resource_id text, title text, course text, source_hash text,
    indexer_version integer, source_kind text, index_status text, metadata_confidence real,
    taxonomy_topic_ids text[], owner_username text, metadata jsonb
  )
  where x.resource_key like 'user:' || x.owner_username || ':%'
    and x.owner_username is not null
  on conflict (resource_key) do update set
    resource_id = excluded.resource_id,
    title = excluded.title,
    course = excluded.course,
    source_hash = excluded.source_hash,
    indexer_version = excluded.indexer_version,
    source_kind = excluded.source_kind,
    index_status = excluded.index_status,
    metadata_confidence = excluded.metadata_confidence,
    taxonomy_topic_ids = excluded.taxonomy_topic_ids,
    metadata = excluded.metadata,
    is_active = true,
    indexed_at = now(),
    updated_at = now()
  where public.isc_resources.scope = 'user'
    and public.isc_resources.owner_username = excluded.owner_username;

  get diagnostics v_changed = row_count;
  if v_changed = 0 then raise exception 'ISC_USER_RESOURCE_OWNER_MISMATCH'; end if;
  select x.resource_key into v_resource_key from jsonb_to_record(p_resource) as x(resource_key text);

  delete from public.isc_resource_topics where resource_key = v_resource_key;
  delete from public.isc_segments where resource_key = v_resource_key;

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
  where x.resource_key = v_resource_key;

  insert into public.isc_segments (
    segment_id, resource_key, source_hash, segment_index, source_kind, topic_ids, evidence_ref,
    evidence_excerpt, content_text, source_start, source_end, source_page, timestamp_start, timestamp_end,
    confidence, embedding_model, embedding
  )
  select x.segment_id, x.resource_key, x.source_hash, x.segment_index, x.source_kind, coalesce(x.topic_ids, '{}'::text[]),
    x.evidence_ref, x.evidence_excerpt, x.content_text, x.source_start, x.source_end, x.source_page,
    x.timestamp_start, x.timestamp_end, x.confidence, x.embedding_model, x.embedding::extensions.vector(1024)
  from jsonb_to_recordset(coalesce(p_segments, '[]'::jsonb)) as x(
    segment_id text, resource_key text, source_hash text, segment_index integer, source_kind text, topic_ids text[],
    evidence_ref text, evidence_excerpt text, content_text text, source_start integer, source_end integer,
    source_page integer, timestamp_start real, timestamp_end real, confidence real, embedding_model text, embedding text
  )
  where x.resource_key = v_resource_key;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

create or replace function public.delete_isc_user_resource(p_resource_key text, p_owner_username text)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.isc_resources
  where resource_key = p_resource_key and scope = 'user' and owner_username = p_owner_username;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

create or replace function public.search_isc_user_resources(
  p_query_embedding extensions.vector(1024),
  p_embedding_model text,
  p_owner_username text,
  p_resource_key text default null,
  p_result_limit integer default 4
)
returns table (
  resource_key text,
  title text,
  source_hash text,
  segment_index integer,
  content_text text,
  evidence_ref text,
  source_kind text,
  source_start integer,
  source_end integer,
  source_page integer,
  timestamp_start real,
  timestamp_end real,
  score real
)
language sql
stable
security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select r.resource_key, r.title, s.source_hash, s.segment_index, s.content_text,
    s.evidence_ref, s.source_kind, s.source_start, s.source_end, s.source_page,
    s.timestamp_start, s.timestamp_end, (1 - (s.embedding <=> p_query_embedding))::real as score
  from public.isc_segments s
  join public.isc_resources r on r.resource_key = s.resource_key
  where r.scope = 'user' and r.is_active = true and r.owner_username = p_owner_username
    and (p_resource_key is null or r.resource_key = p_resource_key)
    and s.embedding_model = p_embedding_model and s.content_text is not null
  order by s.embedding <=> p_query_embedding
  limit least(greatest(coalesce(p_result_limit, 4), 1), 8);
$$;

revoke all on function public.search_isc_resources_keywords(text, text[], text, integer) from public, anon, authenticated;
revoke all on function public.replace_isc_user_resource(jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_isc_user_resource(text, text) from public, anon, authenticated;
revoke all on function public.search_isc_user_resources(extensions.vector, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.search_isc_resources_keywords(text, text[], text, integer) to service_role;
grant execute on function public.replace_isc_user_resource(jsonb, jsonb, jsonb) to service_role;
grant execute on function public.delete_isc_user_resource(text, text) to service_role;
grant execute on function public.search_isc_user_resources(extensions.vector, text, text, text, integer) to service_role;
