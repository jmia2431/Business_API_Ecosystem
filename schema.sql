create extension if not exists pgcrypto;

create table if not exists public.apis (
  id uuid primary key default gen_random_uuid(),
  api_name text not null,
  description text not null default '',
  api_endpoint text not null,
  instructions text not null default '',
  company_name text not null,
  website_url text not null default '',
  documentation_url text not null default '',
  category text not null check (category in ('Communication', 'Transformation', 'Validation')),
  authentication_method text not null default '',
  network text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  input_formats jsonb not null default '[]'::jsonb,
  output_formats jsonb not null default '[]'::jsonb,
  business_rules jsonb not null default '[]'::jsonb,
  client_types jsonb not null default '[]'::jsonb,
  review_status text not null default 'Draft'
    check (review_status in ('Published', 'Verified candidate', 'Draft')),
  source_url text not null default '',
  verified_at timestamptz,
  constraint api_company_name_unique unique (company_name, api_name)
);

create index if not exists apis_category_idx on public.apis (category);
create index if not exists apis_company_idx on public.apis (company_name);
create index if not exists apis_review_status_idx on public.apis (review_status);
create index if not exists apis_active_idx on public.apis (is_active);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
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

drop policy if exists "Active APIs are readable" on public.apis;
create policy "Active APIs are readable"
on public.apis for select
to anon, authenticated
using (is_active = true);

comment on table public.apis is
'Searchable business API catalog seeded from the client data and verified research candidates.';

