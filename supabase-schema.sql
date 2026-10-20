-- ============================================================
-- Supabase Schema para Multi-Usuários e Conversas no Cuscuz-MED
-- ============================================================

-- 1. Criação da tabela de usuários (caso prefira gerenciar usuários no Supabase)
create table if not exists public.users (
  id uuid default gen_random_uuid() primary key,
  username text unique not null,
  name text,
  password_hash text not null,
  salt text not null,
  role text default 'user',
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. Criação da tabela de sessões para multi-usuários
create table if not exists public.sessions (
  token text primary key,
  username text not null,
  created_at bigint not null,
  expires_at bigint not null
);

-- 3. Criação da tabela de conversas
create table if not exists public.conversations (
  id text primary key,
  username text not null,
  title text default 'Nova Conversa',
  messages jsonb not null default '[]'::jsonb,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Índices para busca rápida
create index if not exists idx_users_username on public.users(username);
create index if not exists idx_sessions_token on public.sessions(token);
create index if not exists idx_conversations_username on public.conversations(username);
create index if not exists idx_conversations_updated_at on public.conversations(updated_at desc);

-- Habilitar RLS (Row Level Security)
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.conversations enable row level security;

-- Políticas de acesso permissivas para chave anon/service_role
create policy "Permitir acesso total a users" on public.users for all using (true) with check (true);
create policy "Permitir acesso total a sessions" on public.sessions for all using (true) with check (true);
create policy "Permitir acesso total a conversations" on public.conversations for all using (true) with check (true);

-- 4. Marcações do MedReader (sublinhados, bookmarks, anotações e dúvidas por apostila)
create table if not exists public.medreader_marcas (
  username text not null,
  apostila_id text not null,
  marcas jsonb not null default '[]'::jsonb,
  atualizado bigint not null default 0,
  primary key (username, apostila_id)
);
alter table public.medreader_marcas enable row level security;
create policy "Permitir acesso total a medreader_marcas" on public.medreader_marcas for all using (true) with check (true);

-- 5. Mentor IA acadêmico: perfil acadêmico + plano por usuário (sobrevive à troca de dispositivo)
create table if not exists public.planner_estado (
  username text primary key,
  estado jsonb not null default '{}'::jsonb,
  atualizado bigint not null default 0
);
alter table public.planner_estado enable row level security;
create policy "Permitir acesso total a planner_estado" on public.planner_estado for all using (true) with check (true);

-- 6. Configurações duráveis do sistema (serverless/stateless)
--    Substitui arquivos como data/hwq-token.json, que não sobrevivem ao /tmp da Vercel.
--    Chaves usadas: 'hwq_token' → { token, savedAt }
create table if not exists public.system_configs (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamp with time zone not null default timezone('utc'::text, now())
);

-- Token de API é segredo: NÃO criar policy permissiva para anon.
-- A service_role ignora RLS e é a única chave que deve ser usada pelo servidor.
alter table public.system_configs enable row level security;
drop policy if exists "Permitir acesso total a system_configs" on public.system_configs;
create policy "Service role gerencia system_configs" on public.system_configs
  for all to service_role using (true) with check (true);
revoke all on table public.system_configs from anon, authenticated;
grant select, insert, update, delete on table public.system_configs to service_role;
