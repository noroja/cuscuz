-- Índice curricular persistente de questões. A classificação lexical é exploratória,
-- não uma validação pedagógica nem uma indicação clínica revisada.
create table if not exists public.isc_question_index (
  question_id text primary key,
  source_collection text not null default 'local-bank',
  source_hash text not null,
  indexer_version integer not null,
  statement text not null,
  options jsonb not null default '[]'::jsonb,
  correct_index smallint,
  explanation text not null default '',
  difficulty text not null default '',
  specialty text not null default '',
  subspecialty text not null default '',
  source text not null default '',
  year smallint,
  tags text[] not null default '{}',
  canonical_topic_ids text[] not null default '{}',
  topic_evidence jsonb not null default '[]'::jsonb,
  search_text text not null default '',
  search_vector tsvector generated always as (to_tsvector('portuguese', coalesce(search_text, ''))) stored,
  index_status text not null check (index_status in ('indexed', 'unclassified', 'stale')),
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  indexed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint isc_question_correct_index check (correct_index is null or correct_index between 0 and 25),
  constraint isc_question_year_range check (year is null or year between 1900 and 2200)
);

create index if not exists isc_question_topic_ids_idx
  on public.isc_question_index using gin (canonical_topic_ids);
create index if not exists isc_question_search_vector_idx
  on public.isc_question_index using gin (search_vector);
create index if not exists isc_question_source_active_idx
  on public.isc_question_index(source_collection, is_active);

create table if not exists public.isc_question_index_state (
  source_collection text primary key,
  source_hash text not null,
  indexer_version integer not null,
  item_count integer not null check (item_count >= 0),
  completed_at timestamptz not null default now()
);

alter table public.isc_question_index enable row level security;
alter table public.isc_question_index_state enable row level security;
revoke all on table public.isc_question_index, public.isc_question_index_state from public, anon, authenticated;
grant select, insert, update, delete on table public.isc_question_index, public.isc_question_index_state to service_role;

create or replace function public.search_isc_questions(
  p_query text,
  p_topic_ids text[],
  p_expected_hash text,
  p_indexer_version integer,
  p_result_limit integer default 200
)
returns table (
  index_ready boolean,
  question_id text,
  canonical_topic_ids text[],
  topic_evidence jsonb,
  search_rank real
)
language sql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  with state as (
    select coalesce((
      select s.source_hash = p_expected_hash
        and s.indexer_version = p_indexer_version
        and s.item_count = (select count(*) from public.isc_question_index q where q.source_collection = s.source_collection and q.is_active)
      from public.isc_question_index_state s
      where s.source_collection = 'local-bank'
    ), false) as ready
  ), query as (
    select case
      when nullif(btrim(p_query), '') is null then null::tsquery
      else websearch_to_tsquery('portuguese', left(p_query, 1200))
    end as tsq,
    coalesce(p_topic_ids, '{}'::text[]) as topic_ids
  ), matches as (
    select q.question_id, q.canonical_topic_ids, q.topic_evidence,
      (
        case when cardinality(query.topic_ids) > 0 and q.canonical_topic_ids && query.topic_ids then 0.35 else 0 end +
        case when query.tsq is not null and numnode(query.tsq) > 0 then ts_rank_cd(q.search_vector, query.tsq) else 0 end
      )::real as rank
    from public.isc_question_index q
    cross join query
    cross join state
    where state.ready
      and q.source_collection = 'local-bank'
      and q.is_active
      and (
        (cardinality(query.topic_ids) > 0 and q.canonical_topic_ids && query.topic_ids)
        or (query.tsq is not null and numnode(query.tsq) > 0 and q.search_vector @@ query.tsq)
      )
    order by
      (cardinality(query.topic_ids) > 0 and q.canonical_topic_ids && query.topic_ids) desc,
      rank desc,
      q.question_id
    limit least(greatest(coalesce(p_result_limit, 200), 1), 500)
  )
  select state.ready, matches.question_id, matches.canonical_topic_ids, matches.topic_evidence, matches.rank
  from state
  left join matches on true;
$$;

revoke all on function public.search_isc_questions(text, text[], text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_isc_questions(text, text[], text, integer, integer) to service_role;
