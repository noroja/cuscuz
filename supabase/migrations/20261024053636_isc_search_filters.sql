-- Expande a busca curricular para filtros de curso/disciplinas e objetivos.
-- A assinatura anterior é removida para evitar ambiguidade com argumentos padrão.
drop function if exists public.search_isc_resources(extensions.vector, text, text[], integer);

create function public.search_isc_resources(
  p_query_embedding extensions.vector(1024),
  p_embedding_model text,
  p_topic_ids text[] default '{}',
  p_result_limit integer default 24,
  p_course_filter text default null
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
      and (nullif(btrim(p_course_filter), '') is null or
        position(lower(btrim(p_course_filter)) in lower(coalesce(r.course, '') || ' ' || coalesce(r.source_path, ''))) > 0)
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

revoke all on function public.search_isc_resources(extensions.vector, text, text[], integer, text) from public, anon, authenticated;
grant execute on function public.search_isc_resources(extensions.vector, text, text[], integer, text) to service_role;
