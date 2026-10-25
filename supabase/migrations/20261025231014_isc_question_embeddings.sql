-- Embeddings opcionais por questão; sem vetores, a busca textual continua disponível.
create table if not exists public.isc_question_embeddings (
  question_id text primary key references public.isc_question_index(question_id) on update cascade on delete cascade,
  content_hash text not null,
  embedding_model text not null,
  embedding extensions.vector(1024) not null,
  updated_at timestamptz not null default now()
);

create index if not exists isc_question_embeddings_model_idx
  on public.isc_question_embeddings(embedding_model);
create index if not exists isc_question_embeddings_vector_idx
  on public.isc_question_embeddings using hnsw (embedding extensions.vector_cosine_ops);

alter table public.isc_question_embeddings enable row level security;
revoke all on table public.isc_question_embeddings from public, anon, authenticated;
grant select, insert, update, delete on table public.isc_question_embeddings to service_role;

drop function if exists public.search_isc_questions(text, text[], text, integer, integer);
drop function if exists public.search_isc_questions(text, text[], text, integer, integer, extensions.vector, text);

create function public.search_isc_questions(
  p_query text,
  p_topic_ids text[],
  p_expected_hash text,
  p_indexer_version integer,
  p_result_limit integer default 200,
  p_query_embedding extensions.vector(1024) default null,
  p_embedding_model text default null
)
returns table (
  index_ready boolean,
  question_id text,
  canonical_topic_ids text[],
  topic_evidence jsonb,
  search_rank real,
  semantic_score real,
  text_score real,
  topic_match boolean
)
language sql
stable
security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  with state as (
    select coalesce((
      select s.source_hash = p_expected_hash
        and s.indexer_version = p_indexer_version
        and s.item_count = (
          select count(*) from public.isc_question_index q
          where q.source_collection = s.source_collection and q.is_active
        )
      from public.isc_question_index_state s
      where s.source_collection = 'local-bank'
    ), false) as ready
  ), query as (
    select case
      when nullif(btrim(p_query), '') is null then null::tsquery
      else websearch_to_tsquery('portuguese', left(p_query, 1200))
    end as tsq,
    coalesce(p_topic_ids, '{}'::text[]) as topic_ids
  ), scored as (
    select q.question_id, q.canonical_topic_ids, q.topic_evidence,
      (cardinality(query.topic_ids) > 0 and q.canonical_topic_ids && query.topic_ids) as has_topic_match,
      case when query.tsq is not null and numnode(query.tsq) > 0
        then ts_rank_cd(q.search_vector, query.tsq) else 0 end::real as lexical_score,
      case when p_query_embedding is not null and p_embedding_model is not null and e.embedding is not null
        then (1 - (e.embedding <=> p_query_embedding))::real else null end as vector_score,
      case when p_query_embedding is not null and p_embedding_model is not null and e.embedding is not null
        then (e.embedding <=> p_query_embedding)::real else null end as vector_distance
    from public.isc_question_index q
    cross join query
    cross join state
    left join public.isc_question_embeddings e
      on e.question_id = q.question_id and e.embedding_model = p_embedding_model
    where state.ready
      and q.source_collection = 'local-bank'
      and q.is_active
      and (
        (cardinality(query.topic_ids) > 0 and q.canonical_topic_ids && query.topic_ids)
        or (query.tsq is not null and numnode(query.tsq) > 0 and q.search_vector @@ query.tsq)
        or (p_query_embedding is not null and p_embedding_model is not null and e.embedding is not null)
      )
  ), matches as (
    select scored.*,
      row_number() over (
        order by has_topic_match desc, vector_score desc nulls last, lexical_score desc, question_id
      )::real as rank
    from scored
    order by has_topic_match desc, vector_score desc nulls last, lexical_score desc, question_id
    limit least(greatest(coalesce(p_result_limit, 200), 1), 500)
  )
  select state.ready, matches.question_id, matches.canonical_topic_ids, matches.topic_evidence,
    matches.rank, matches.vector_score, matches.lexical_score, matches.has_topic_match
  from state
  left join matches on true;
$$;

revoke all on function public.search_isc_questions(text, text[], text, integer, integer, extensions.vector, text)
  from public, anon, authenticated;
grant execute on function public.search_isc_questions(text, text[], text, integer, integer, extensions.vector, text)
  to service_role;
