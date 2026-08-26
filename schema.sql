-- Run this file once in Supabase: SQL Editor -> New query -> Run.
-- It creates the repository table and keeps browser users read-only.

create extension if not exists pgcrypto;

create table if not exists public.apis (
  id uuid primary key default gen_random_uuid(),
  api_name text not null,
  official_api_name text not null default '',
  description text not null,
  api_endpoint text not null,
  instructions text not null default '',
  company_name text not null,
  official_company_name text not null default '',
  website_url text not null default '',
  documentation_url text not null,
  category text not null,
  authentication_method text not null,
  authentication_details text not null default '',
  network text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  input_formats text[] not null default '{}',
  output_formats text[] not null default '{}',
  business_rules text[] not null default '{}',
  client_types text[] not null default '{}',
  review_status text not null default 'Draft',
  source_url text not null default '',
  verified_at timestamptz
);

-- Safe, repeatable migration for a table created from the earlier version.
alter table public.apis
  add column if not exists official_api_name text not null default '',
  add column if not exists official_company_name text not null default '',
  add column if not exists authentication_details text not null default '';

create unique index if not exists apis_company_api_unique
  on public.apis (lower(company_name), lower(api_name));

create index if not exists apis_active_status_idx
  on public.apis (is_active, review_status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_apis_updated_at on public.apis;
create trigger set_apis_updated_at
before update on public.apis
for each row execute function public.set_updated_at();

alter table public.apis enable row level security;

drop policy if exists "Reviewed active APIs are readable" on public.apis;
create policy "Reviewed active APIs are readable"
on public.apis
for select
to anon, authenticated
using (
  is_active = true
  and review_status in ('Published', 'Verified candidate')
);

-- Public visitors submit through /api/apis, where fields are validated and
-- the server-only Supabase secret performs the insert. Browsers cannot write
-- directly to the table.
revoke insert, update, delete on table public.apis from anon, authenticated;
