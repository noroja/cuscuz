-- Índice de conteúdo de vídeo iniciado pelo usuário; nenhuma aula é varrida em lote.
alter table public.isc_resources drop constraint if exists isc_resources_source_kind_check;
alter table public.isc_resources add constraint isc_resources_source_kind_check
  check (source_kind in ('catalog_metadata', 'transcript', 'pdf_text', 'slides', 'video_analysis'));

alter table public.isc_resource_topics drop constraint if exists isc_resource_topics_source_kind_check;
alter table public.isc_resource_topics add constraint isc_resource_topics_source_kind_check
  check (source_kind in ('catalog_title', 'catalog_path', 'transcript', 'pdf_text', 'slides', 'video_analysis'));

alter table public.isc_segments drop constraint if exists isc_segments_source_kind_check;
alter table public.isc_segments add constraint isc_segments_source_kind_check
  check (source_kind in ('catalog_metadata', 'transcript', 'pdf_text', 'slides', 'video_analysis'));

create table if not exists public.isc_video_index_jobs (
  job_id uuid primary key default gen_random_uuid(),
  resource_key text not null references public.isc_resources(resource_key) on update cascade on delete cascade,
  source_hash text not null,
  requested_by text not null references public.users(username) on update cascade on delete cascade,
  status text not null check (status in ('uploading', 'media_processing', 'analyzing', 'completed', 'failed')),
  gemini_file_name text,
  gemini_file_uri text,
  gemini_mime_type text,
  duration_seconds real,
  interaction_id text,
  result_json jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (resource_key, source_hash)
);

alter table public.isc_video_index_jobs drop constraint if exists isc_video_index_jobs_status_check;
alter table public.isc_video_index_jobs add constraint isc_video_index_jobs_status_check
  check (status in ('uploading', 'media_processing', 'starting_analysis', 'analyzing', 'completed', 'failed'));

create index if not exists isc_video_index_jobs_status_idx
  on public.isc_video_index_jobs(status, updated_at desc);

alter table public.isc_video_index_jobs enable row level security;
revoke all on table public.isc_video_index_jobs from public, anon, authenticated;
grant select, insert, update on table public.isc_video_index_jobs to service_role;

create or replace function public.replace_isc_video_content_index(
  p_resource jsonb,
  p_topics jsonb
)
returns text
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  target_key text := p_resource->>'resource_key';
  target_hash text := p_resource->>'source_hash';
  topics_count integer;
begin
  if p_resource->>'resource_kind' is distinct from 'video'
    or p_resource->>'scope' is distinct from 'catalog'
    or p_resource->>'source_kind' is distinct from 'video_analysis'
    or nullif(target_key, '') is null
    or nullif(target_hash, '') is null
    or jsonb_typeof(coalesce(p_topics, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Índice de conteúdo inválido para videoaula do catálogo.';
  end if;
  topics_count := jsonb_array_length(coalesce(p_topics, '[]'::jsonb));

  if exists (
    select 1 from jsonb_to_recordset(coalesce(p_topics, '[]'::jsonb)) as x(
      resource_key text, source_hash text, source_kind text, topic_id text
    )
    where x.resource_key is distinct from target_key
      or x.source_hash is distinct from target_hash
      or x.source_kind is distinct from 'video_analysis'
      or nullif(x.topic_id, '') is null
  ) then
    raise exception 'O índice contém evidências de outra videoaula ou versão.';
  end if;

  update public.isc_resources as r
  set source_hash = target_hash,
      indexer_version = coalesce((p_resource->>'indexer_version')::integer, r.indexer_version),
      source_kind = 'video_analysis',
      index_status = case when topics_count > 0 then 'content_indexed' else 'insufficient_evidence' end,
      metadata_confidence = nullif(p_resource->>'metadata_confidence', '')::real,
      taxonomy_topic_ids = array(select jsonb_array_elements_text(coalesce(p_resource->'taxonomy_topic_ids', '[]'::jsonb))),
      metadata = r.metadata || coalesce(p_resource->'metadata', '{}'::jsonb),
      indexed_at = now(), updated_at = now()
  where r.resource_key = target_key and r.resource_kind = 'video'
    and r.scope = 'catalog' and r.owner_username is null and r.is_active = true;
  if not found then raise exception 'A videoaula não está disponível no catálogo ativo.'; end if;

  -- A substituição só ocorre após uma análise concluída e validada; a transação preserva o índice anterior em caso de falha.
  delete from public.isc_segments where resource_key = target_key;
  delete from public.isc_resource_topics where resource_key = target_key;

  insert into public.isc_resource_topics (
    resource_key, topic_id, source_hash, source_kind, evidence_ref, evidence_excerpt,
    confidence, coverage_level, depth_level, source_start, source_end, source_page,
    timestamp_start, timestamp_end
  )
  select x.resource_key, x.topic_id, x.source_hash, x.source_kind, x.evidence_ref, x.evidence_excerpt,
    x.confidence, x.coverage_level, x.depth_level, x.source_start, x.source_end, x.source_page,
    x.timestamp_start, x.timestamp_end
  from jsonb_to_recordset(coalesce(p_topics, '[]'::jsonb)) as x(
    resource_key text, topic_id text, source_hash text, source_kind text, evidence_ref text, evidence_excerpt text,
    confidence real, coverage_level text, depth_level smallint, source_start integer, source_end integer,
    source_page integer, timestamp_start real, timestamp_end real
  );

  return case when topics_count > 0 then 'content_indexed' else 'insufficient_evidence' end;
end;
$$;

revoke all on function public.replace_isc_video_content_index(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_isc_video_content_index(jsonb, jsonb) to service_role;
