-- Índice Semântico Curricular: dados globais do acervo e evidências privadas por usuário.
create extension if not exists vector with schema extensions;

create table if not exists public.isc_taxonomy_nodes (
  id text primary key,
  kind text not null check (kind in ('discipline', 'subject', 'subtopic', 'learning_objective')),
  parent_id text references public.isc_taxonomy_nodes(id) on update cascade on delete restrict,
  canonical_name text not null,
  normalized_name text not null,
  synonyms text[] not null default '{}',
  origin text not null check (origin in ('curated', 'catalog_path')),
  is_canonical boolean not null default false,
  confidence real not null default 1 check (confidence >= 0 and confidence <= 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists isc_taxonomy_parent_idx on public.isc_taxonomy_nodes(parent_id);
create index if not exists isc_taxonomy_kind_idx on public.isc_taxonomy_nodes(kind);
create index if not exists isc_taxonomy_normalized_name_idx on public.isc_taxonomy_nodes(normalized_name);
create index if not exists isc_taxonomy_synonyms_idx on public.isc_taxonomy_nodes using gin (synonyms);

create table if not exists public.isc_resources (
  resource_key text primary key,
  resource_id text not null,
  resource_kind text not null check (resource_kind in ('video', 'material', 'aula_dia')),
  title text not null,
  course text not null default '',
  source_path text not null default '',
  source_hash text not null,
  indexer_version integer not null,
  source_kind text not null check (source_kind in ('catalog_metadata', 'transcript', 'pdf_text')),
  index_status text not null check (index_status in ('metadata_indexed', 'content_indexed', 'insufficient_evidence', 'stale', 'failed')),
  metadata_confidence real check (metadata_confidence >= 0 and metadata_confidence <= 1),
  taxonomy_topic_ids text[] not null default '{}',
  catalog_generated_at timestamptz,
  scope text not null default 'catalog' check (scope in ('catalog', 'user')),
  owner_username text references public.users(username) on update cascade on delete cascade,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  indexed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint isc_resource_owner_scope check ((scope = 'catalog' and owner_username is null) or (scope = 'user' and owner_username is not null))
);

create index if not exists isc_resources_course_idx on public.isc_resources(course);
create index if not exists isc_resources_active_idx on public.isc_resources(is_active, scope);
create index if not exists isc_resources_topic_ids_idx on public.isc_resources using gin (taxonomy_topic_ids);
create index if not exists isc_resources_hash_idx on public.isc_resources(source_hash);
create index if not exists isc_resources_owner_idx on public.isc_resources(owner_username) where owner_username is not null;

create table if not exists public.isc_resource_topics (
  resource_key text not null references public.isc_resources(resource_key) on update cascade on delete cascade,
  topic_id text not null references public.isc_taxonomy_nodes(id) on update cascade on delete restrict,
  source_hash text not null,
  source_kind text not null check (source_kind in ('catalog_title', 'catalog_path', 'transcript', 'pdf_text')),
  evidence_ref text not null,
  evidence_excerpt text not null,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  coverage_level text check (coverage_level in ('partial', 'complete')),
  depth_level smallint check (depth_level between 1 and 5),
  source_start integer,
  source_end integer,
  source_page integer,
  timestamp_start real,
  timestamp_end real,
  created_at timestamptz not null default now(),
  primary key (resource_key, topic_id),
  constraint isc_topic_source_offsets check (source_start is null or (source_start >= 0 and source_end > source_start)),
  constraint isc_topic_time_offsets check (timestamp_start is null or (timestamp_start >= 0 and timestamp_end >= timestamp_start))
);

create index if not exists isc_resource_topics_topic_idx on public.isc_resource_topics(topic_id, confidence desc);
create index if not exists isc_resource_topics_hash_idx on public.isc_resource_topics(resource_key, source_hash);

create table if not exists public.isc_segments (
  segment_id text primary key,
  resource_key text not null references public.isc_resources(resource_key) on update cascade on delete cascade,
  source_hash text not null,
  segment_index integer not null check (segment_index >= 0),
  source_kind text not null check (source_kind in ('catalog_metadata', 'transcript', 'pdf_text')),
  topic_ids text[] not null default '{}',
  evidence_ref text not null,
  evidence_excerpt text not null,
  source_start integer,
  source_end integer,
  source_page integer,
  timestamp_start real,
  timestamp_end real,
  confidence real check (confidence >= 0 and confidence <= 1),
  embedding_model text not null,
  embedding extensions.vector(1024) not null,
  created_at timestamptz not null default now(),
  unique (resource_key, source_hash, segment_index),
  constraint isc_segment_source_offsets check (source_start is null or (source_start >= 0 and source_end > source_start)),
  constraint isc_segment_time_offsets check (timestamp_start is null or (timestamp_start >= 0 and timestamp_end >= timestamp_start))
);

create index if not exists isc_segments_resource_idx on public.isc_segments(resource_key, source_hash);
create index if not exists isc_segments_topics_idx on public.isc_segments using gin (topic_ids);
create index if not exists isc_segments_model_idx on public.isc_segments(embedding_model);
create index if not exists isc_segments_embedding_hnsw_idx on public.isc_segments using hnsw (embedding extensions.vector_cosine_ops);

alter table public.isc_taxonomy_nodes enable row level security;
alter table public.isc_resources enable row level security;
alter table public.isc_resource_topics enable row level security;
alter table public.isc_segments enable row level security;

revoke all on table public.isc_taxonomy_nodes, public.isc_resources, public.isc_resource_topics, public.isc_segments from public, anon, authenticated;
grant select, insert, update, delete on table public.isc_taxonomy_nodes, public.isc_resources, public.isc_resource_topics, public.isc_segments to service_role;

create or replace function public.replace_isc_catalog_batch(p_resources jsonb, p_topics jsonb, p_segments jsonb)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  resource_keys text[];
  changed_count integer;
begin
  select coalesce(array_agg(x.resource_key), '{}'::text[]) into resource_keys
  from jsonb_to_recordset(coalesce(p_resources, '[]'::jsonb)) as x(resource_key text);

  if cardinality(resource_keys) = 0 then return 0; end if;

  insert into public.isc_resources (
    resource_key, resource_id, resource_kind, title, course, source_path, source_hash,
    indexer_version, source_kind, index_status, metadata_confidence, taxonomy_topic_ids,
    catalog_generated_at, scope, owner_username, is_active, metadata, indexed_at, updated_at
  )
  select x.resource_key, x.resource_id, x.resource_kind, x.title, coalesce(x.course, ''), coalesce(x.source_path, ''), x.source_hash,
    x.indexer_version, x.source_kind, x.index_status, x.metadata_confidence, coalesce(x.taxonomy_topic_ids, '{}'::text[]),
    x.catalog_generated_at, coalesce(x.scope, 'catalog'), x.owner_username, coalesce(x.is_active, true), coalesce(x.metadata, '{}'::jsonb), now(), now()
  from jsonb_to_recordset(coalesce(p_resources, '[]'::jsonb)) as x(
    resource_key text, resource_id text, resource_kind text, title text, course text, source_path text,
    source_hash text, indexer_version integer, source_kind text, index_status text, metadata_confidence real,
    taxonomy_topic_ids text[], catalog_generated_at timestamptz, scope text, owner_username text, is_active boolean, metadata jsonb
  )
  on conflict (resource_key) do update set
    resource_id = excluded.resource_id,
    resource_kind = excluded.resource_kind,
    title = excluded.title,
    course = excluded.course,
    source_path = excluded.source_path,
    source_hash = excluded.source_hash,
    indexer_version = excluded.indexer_version,
    source_kind = excluded.source_kind,
    index_status = excluded.index_status,
    metadata_confidence = excluded.metadata_confidence,
    taxonomy_topic_ids = excluded.taxonomy_topic_ids,
    catalog_generated_at = excluded.catalog_generated_at,
    scope = excluded.scope,
    owner_username = excluded.owner_username,
    is_active = excluded.is_active,
    metadata = excluded.metadata,
    indexed_at = now(),
    updated_at = now();

  delete from public.isc_resource_topics where resource_key = any(resource_keys);
  delete from public.isc_segments where resource_key = any(resource_keys);

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
  );

  insert into public.isc_segments (
    segment_id, resource_key, source_hash, segment_index, source_kind, topic_ids, evidence_ref,
    evidence_excerpt, source_start, source_end, source_page, timestamp_start, timestamp_end,
    confidence, embedding_model, embedding
  )
  select x.segment_id, x.resource_key, x.source_hash, x.segment_index, x.source_kind, coalesce(x.topic_ids, '{}'::text[]),
    x.evidence_ref, x.evidence_excerpt, x.source_start, x.source_end, x.source_page, x.timestamp_start,
    x.timestamp_end, x.confidence, x.embedding_model, x.embedding::extensions.vector(1024)
  from jsonb_to_recordset(coalesce(p_segments, '[]'::jsonb)) as x(
    segment_id text, resource_key text, source_hash text, segment_index integer, source_kind text, topic_ids text[],
    evidence_ref text, evidence_excerpt text, source_start integer, source_end integer, source_page integer,
    timestamp_start real, timestamp_end real, confidence real, embedding_model text, embedding text
  );

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

create or replace function public.search_isc_resources(
  p_query_embedding extensions.vector(1024),
  p_embedding_model text,
  p_topic_ids text[] default '{}',
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
  with ranked_segments as (
    select s.resource_key, s.topic_ids, s.evidence_excerpt, s.source_kind, s.source_page,
      s.timestamp_start, s.timestamp_end,
      (1 - (s.embedding <=> p_query_embedding))::real as similarity,
      row_number() over (partition by s.resource_key order by s.embedding <=> p_query_embedding) as resource_rank
    from public.isc_segments s
    join public.isc_resources r on r.resource_key = s.resource_key
    where r.is_active = true
      and r.scope = 'catalog'
      and s.embedding_model = p_embedding_model
      and (coalesce(cardinality(p_topic_ids), 0) = 0 or s.topic_ids && p_topic_ids)
    order by s.embedding <=> p_query_embedding
    limit least(greatest(coalesce(p_result_limit, 24), 1) * 5, 200)
  ), best_per_resource as (
    select distinct on (x.resource_key) x.*
    from ranked_segments x
    where x.resource_rank = 1
    order by x.resource_key, x.similarity desc
  )
  select r.resource_key, r.resource_id, r.resource_kind, r.title, r.course, r.source_path,
    best.topic_ids, best.similarity, best.evidence_excerpt, best.source_kind,
    best.source_page, best.timestamp_start, best.timestamp_end
  from best_per_resource best
  join public.isc_resources r on r.resource_key = best.resource_key
  order by best.similarity desc
  limit least(greatest(coalesce(p_result_limit, 24), 1), 50);
$$;

revoke all on function public.replace_isc_catalog_batch(jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.search_isc_resources(extensions.vector, text, text[], integer) from public, anon, authenticated;
grant execute on function public.replace_isc_catalog_batch(jsonb, jsonb, jsonb) to service_role;
grant execute on function public.search_isc_resources(extensions.vector, text, text[], integer) to service_role;
