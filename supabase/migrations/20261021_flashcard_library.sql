-- Biblioteca compartilhada de flashcards importados do Google Drive/Anki.
-- O servidor usa a service_role; usuários não acessam estas tabelas diretamente.
create table if not exists public.flashcard_sources (
  drive_file_id text primary key,
  filename text not null,
  drive_path text,
  mime_type text,
  file_size_bytes bigint,
  modified_time timestamptz,
  md5_checksum text,
  version_key text not null,
  import_status text not null default 'pending' check (import_status in ('pending','downloading','extracting','validating','importing','completed','failed','retrying','cancelled','needs_review')),
  last_error text,
  imported_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.flashcard_import_jobs (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text not null references public.flashcard_sources(drive_file_id) on delete restrict,
  status text not null check (status in ('pending','downloading','extracting','validating','importing','completed','failed','retrying','cancelled','needs_review')),
  attempt integer not null default 1,
  cards_imported integer not null default 0,
  cards_rejected integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.flashcard_decks (
  id text primary key,
  source_file_id text not null references public.flashcard_sources(drive_file_id) on delete restrict,
  name text not null,
  drive_path text,
  card_count integer not null default 0 check (card_count >= 0),
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.flashcard_notes (
  id text primary key,
  source_file_id text not null references public.flashcard_sources(drive_file_id) on delete restrict,
  source_note_id text not null,
  model_id text,
  model_name text,
  original_tags text[] not null default '{}',
  fields jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (source_file_id, source_note_id)
);

-- Nome distinto da tabela legada public.flashcards (que pode usar id uuid).
-- Os IDs da biblioteca são hashes estáveis em texto e não alteram a tabela legada.
create table if not exists public.flashcard_library_cards (
  id text primary key,
  deck_id text not null references public.flashcard_decks(id) on delete restrict,
  note_id text not null references public.flashcard_notes(id) on delete restrict,
  source_file_id text not null references public.flashcard_sources(drive_file_id) on delete restrict,
  source_card_id text not null,
  card_type text not null default 'basic' check (card_type in ('basic','cloze')),
  front text not null,
  back text not null,
  front_html text not null default '',
  back_html text not null default '',
  subject text,
  topic text,
  tags text[] not null default '{}',
  cloze jsonb,
  content_hash text not null,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.flashcard_media (
  id text primary key,
  filename text not null,
  mime_type text not null,
  storage_path text not null unique,
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.flashcard_media_links (
  card_id text not null references public.flashcard_library_cards(id) on delete restrict,
  media_id text not null references public.flashcard_media(id) on delete restrict,
  position integer not null default 0,
  primary key (card_id, media_id)
);

-- Progresso do usuário é separado da biblioteca de origem.
create table if not exists public.flashcard_reviews (
  username text not null,
  card_id text not null references public.flashcard_library_cards(id) on delete restrict,
  due_at timestamptz,
  interval_days double precision not null default 0,
  ease double precision not null default 2.5,
  repetitions integer not null default 0,
  lapses integer not null default 0,
  last_grade smallint check (last_grade between 0 and 3),
  last_reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (username, card_id)
);

create table if not exists public.flashcard_review_events (
  event_id uuid primary key,
  username text not null,
  card_id text not null references public.flashcard_library_cards(id) on delete restrict,
  grade smallint not null check (grade between 0 and 3),
  reviewed_at timestamptz not null default now(),
  schedule_after jsonb not null default '{}'::jsonb
);

create index if not exists idx_flashcard_sources_status on public.flashcard_sources(import_status, updated_at desc);
create index if not exists idx_flashcard_jobs_source on public.flashcard_import_jobs(drive_file_id, started_at desc);
create index if not exists idx_flashcard_decks_source on public.flashcard_decks(source_file_id, is_active);
create index if not exists idx_flashcard_cards_deck on public.flashcard_library_cards(deck_id, is_active, id);
create index if not exists idx_flashcard_cards_source on public.flashcard_library_cards(source_file_id, is_active);
create index if not exists idx_flashcard_cards_tags on public.flashcard_library_cards using gin(tags);
create index if not exists idx_flashcard_reviews_due on public.flashcard_reviews(username, due_at);
create index if not exists idx_flashcard_review_events_user on public.flashcard_review_events(username, reviewed_at desc);

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'flashcard_sources','flashcard_import_jobs','flashcard_decks','flashcard_notes',
    'flashcard_library_cards','flashcard_media','flashcard_media_links','flashcard_reviews','flashcard_review_events'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on table public.%I from anon, authenticated', tbl);
    execute format('grant all on table public.%I to service_role', tbl);
  end loop;
end $$;
