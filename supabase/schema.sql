-- Telegram пользователи
create table if not exists public.telegram_users (
  telegram_id bigint primary key,
  username text,
  first_name text,
  last_name text,
  is_admin boolean not null default false,
  client_login text,
  client_password text,
  has_access boolean not null default false,
  plan_code text,
  expires_at timestamptz,
  is_lifetime boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.telegram_users add column if not exists username text;
alter table public.telegram_users add column if not exists first_name text;
alter table public.telegram_users add column if not exists last_name text;
alter table public.telegram_users add column if not exists is_admin boolean not null default false;
alter table public.telegram_users add column if not exists client_login text;
alter table public.telegram_users add column if not exists client_password text;
alter table public.telegram_users add column if not exists has_access boolean not null default false;
alter table public.telegram_users add column if not exists plan_code text;
alter table public.telegram_users add column if not exists expires_at timestamptz;
alter table public.telegram_users add column if not exists is_lifetime boolean not null default false;
alter table public.telegram_users add column if not exists created_at timestamptz not null default now();
alter table public.telegram_users add column if not exists updated_at timestamptz not null default now();

-- уникальный логин клиента
create unique index if not exists telegram_users_client_login_idx
on public.telegram_users (client_login)
where client_login is not null;

-- HWID устройств, привязанных к telegram пользователю
create table if not exists public.hwids (
  id bigint generated always as identity primary key,
  telegram_id bigint not null
    references public.telegram_users(telegram_id)
    on delete cascade,
  hwid text not null,
  launch_count integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.hwids add column if not exists telegram_id bigint;
alter table public.hwids add column if not exists hwid text;
alter table public.hwids add column if not exists launch_count integer not null default 0;
alter table public.hwids add column if not exists created_at timestamptz not null default now();

create unique index if not exists hwids_telegram_id_hwid_idx
on public.hwids (telegram_id, hwid);

-- настройки бота
create table if not exists public.bot_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.bot_settings add column if not exists value text not null default '';
alter table public.bot_settings add column if not exists updated_at timestamptz not null default now();
