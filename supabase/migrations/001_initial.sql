-- Wiznerd Platform — initial schema
-- Run this in the Supabase SQL editor or via supabase db push

create extension if not exists "pgcrypto";

-- ─── Projects ────────────────────────────────────────────────────────────────
create table if not exists projects (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  symbol              text not null,
  total_supply        integer not null,
  royalty_percent     integer default 0,
  status              text default 'draft',     -- draft | generating | complete | pinned | error
  generation_progress integer default 0,        -- 0-100
  ipfs_cid            text,
  created_at          timestamptz default now()
);

-- ─── Layers ──────────────────────────────────────────────────────────────────
create table if not exists layers (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references projects(id) on delete cascade,
  name        text not null,
  z_index     integer not null,
  created_at  timestamptz default now()
);

-- ─── Variants ────────────────────────────────────────────────────────────────
create table if not exists variants (
  id          uuid primary key default gen_random_uuid(),
  layer_id    uuid references layers(id) on delete cascade,
  name        text not null,
  weight      integer default 100,
  file_path   text,
  created_at  timestamptz default now()
);

-- ─── Incompatibilities ───────────────────────────────────────────────────────
create table if not exists incompatibilities (
  id          uuid primary key default gen_random_uuid(),
  variant_a   uuid references variants(id) on delete cascade,
  variant_b   uuid references variants(id) on delete cascade
);

-- ─── Generated Tokens ────────────────────────────────────────────────────────
create table if not exists generated_tokens (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references projects(id) on delete cascade,
  token_index  integer not null,
  traits       jsonb not null,
  image_path   text,
  metadata_uri text,
  status       text default 'pending'
);

create index if not exists generated_tokens_project_id_idx on generated_tokens(project_id);

-- ─── Storage buckets (create via Supabase dashboard or CLI) ──────────────────
-- supabase storage create layers   (public: false)
-- supabase storage create output   (public: true)

-- ─── Enable Realtime on projects table ───────────────────────────────────────
-- In Supabase dashboard: Database → Replication → enable for "projects" table

-- ─── RLS policies (permissive for dev — lock down for production) ─────────────
alter table projects          enable row level security;
alter table layers            enable row level security;
alter table variants          enable row level security;
alter table incompatibilities enable row level security;
alter table generated_tokens  enable row level security;

-- Allow all for service_role key (server uses this)
-- Use TO role syntax, not auth.role() JWT check — service_role bypasses RLS at the DB level
create policy "service_role full access on projects"
  on projects for all to service_role using (true) with check (true);
create policy "service_role full access on layers"
  on layers for all to service_role using (true) with check (true);
create policy "service_role full access on variants"
  on variants for all to service_role using (true) with check (true);
create policy "service_role full access on incompatibilities"
  on incompatibilities for all to service_role using (true) with check (true);
create policy "service_role full access on generated_tokens"
  on generated_tokens for all to service_role using (true) with check (true);

-- Allow anon read for public browsing
create policy "anon read projects"
  on projects for select using (true);
create policy "anon read generated_tokens"
  on generated_tokens for select using (true);
