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
  email text,
  settings jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  is_primary_admin boolean not null default false,
  last_login_at timestamp with time zone,
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
create index if not exists idx_users_email on public.users(email) where email is not null;
create index if not exists idx_users_email_lower on public.users(lower(email)) where email is not null;
create index if not exists idx_users_created_at on public.users(created_at);
create unique index if not exists idx_users_single_primary_admin on public.users(is_primary_admin) where is_primary_admin = true;
create index if not exists idx_sessions_token on public.sessions(token);
create index if not exists idx_sessions_username on public.sessions(username);
create index if not exists idx_conversations_username on public.conversations(username);
create index if not exists idx_conversations_updated_at on public.conversations(updated_at desc);

-- Habilitar RLS (Row Level Security)
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.conversations enable row level security;

-- Dados privados: somente o servidor com service_role pode acessar.
drop policy if exists "Permitir acesso total a users" on public.users;
drop policy if exists "Permitir acesso total a sessions" on public.sessions;
drop policy if exists "Permitir acesso total a conversations" on public.conversations;
revoke all on table public.users, public.sessions, public.conversations from public, anon, authenticated;
grant all on table public.users, public.sessions, public.conversations to service_role;

-- 4. Marcações do MedReader (sublinhados, bookmarks, anotações e dúvidas por apostila)
create table if not exists public.medreader_marcas (
  username text not null,
  apostila_id text not null,
  marcas jsonb not null default '[]'::jsonb,
  atualizado bigint not null default 0,
  primary key (username, apostila_id)
);
alter table public.medreader_marcas enable row level security;
drop policy if exists "Permitir acesso total a medreader_marcas" on public.medreader_marcas;
revoke all on table public.medreader_marcas from public, anon, authenticated;
grant all on table public.medreader_marcas to service_role;

-- 5. Mentor IA acadêmico: perfil acadêmico + plano por usuário (sobrevive à troca de dispositivo)
create table if not exists public.planner_estado (
  username text primary key,
  estado jsonb not null default '{}'::jsonb,
  atualizado bigint not null default 0
);
alter table public.planner_estado enable row level security;
drop policy if exists "Permitir acesso total a planner_estado" on public.planner_estado;
revoke all on table public.planner_estado from public, anon, authenticated;
grant all on table public.planner_estado to service_role;

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
revoke all on table public.system_configs from public, anon, authenticated;
grant select, insert, update, delete on table public.system_configs to service_role;

-- Convites e trilha de auditoria administrativa (sem armazenar token em claro).
create table if not exists public.user_invitations (
  token_hash text primary key,
  email text not null,
  username text not null references public.users(username) on update cascade on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin', 'super_admin')),
  display_name text not null,
  invited_by text not null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.auth_admin_audit (
  id bigint generated by default as identity primary key,
  actor_username text not null,
  action text not null,
  target_username text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.user_password_recoveries (
  token_hash text primary key,
  email text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_user_invitations_one_pending_email
  on public.user_invitations(lower(email)) where accepted_at is null and revoked_at is null;
create index if not exists idx_user_password_recoveries_expiry on public.user_password_recoveries(expires_at);
create index if not exists idx_user_password_recoveries_email_pending
  on public.user_password_recoveries(lower(email)) where consumed_at is null;
alter table public.user_invitations enable row level security;
alter table public.auth_admin_audit enable row level security;
alter table public.user_password_recoveries enable row level security;
revoke all on table public.user_invitations, public.auth_admin_audit, public.user_password_recoveries from public, anon, authenticated;
grant all on table public.user_invitations, public.auth_admin_audit, public.user_password_recoveries to service_role;
revoke all on sequence public.auth_admin_audit_id_seq from public, anon, authenticated;
grant all on sequence public.auth_admin_audit_id_seq to service_role;

create or replace function public.accept_user_invitation(
  p_token_hash text,
  p_email text,
  p_password_hash text,
  p_salt text
) returns table(username text, display_name text, role text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  invitation public.user_invitations%rowtype;
begin
  select * into invitation
  from public.user_invitations i
  where i.token_hash = p_token_hash
    and lower(i.email) = lower(p_email)
    and i.accepted_at is null
    and i.revoked_at is null
    and i.expires_at > now()
  for update;
  if not found then return; end if;

  update public.users u
  set password_hash = p_password_hash,
      salt = p_salt,
      is_active = true,
      email = lower(p_email),
      settings = coalesce(u.settings, '{}'::jsonb) || jsonb_build_object('email', lower(p_email))
  where u.username = invitation.username
    and lower(coalesce(u.email, u.settings->>'email', '')) = lower(p_email)
    and u.is_active = false;
  if not found then return; end if;

  update public.user_invitations i set accepted_at = now() where i.token_hash = p_token_hash;
  return query select u.username, coalesce(u.name, u.username), u.role
    from public.users u where u.username = invitation.username;
end;
$$;
revoke all on function public.accept_user_invitation(text, text, text, text) from public, anon, authenticated;
grant execute on function public.accept_user_invitation(text, text, text, text) to service_role;

create or replace function public.complete_user_password_recovery(
  p_token_hash text,
  p_email text,
  p_password_hash text,
  p_salt text
) returns table(username text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  challenge public.user_password_recoveries%rowtype;
  target_username text;
  match_count bigint;
begin
  select * into challenge
  from public.user_password_recoveries c
  where c.token_hash = p_token_hash
    and lower(c.email) = lower(p_email)
    and c.consumed_at is null
    and c.expires_at > now()
  for update;
  if not found then return; end if;

  select count(*) into match_count from public.users u
  where lower(u.email) = lower(p_email) and u.is_active = true;
  if match_count <> 1 then return; end if;

  select u.username into target_username
  from public.users u
  where lower(u.email) = lower(p_email) and u.is_active = true
  for update;
  if not found then return; end if;

  update public.users u set password_hash = p_password_hash, salt = p_salt
  where u.username = target_username;
  delete from public.sessions s where s.username = target_username;
  update public.user_password_recoveries c set consumed_at = now()
  where c.token_hash = p_token_hash;
  return query select target_username;
end;
$$;
revoke all on function public.complete_user_password_recovery(text, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_user_password_recovery(text, text, text, text) to service_role;
