-- v1.0.0 Marketplace & Minting Engine
-- Run after 003_ipfs_progress.sql in the Supabase SQL editor

-- ── Project additions ──────────────────────────────────────────────────────────
alter table projects add column if not exists mint_price_mojo   bigint default 0;
alter table projects add column if not exists launch_at         timestamptz;
alter table projects add column if not exists allowlist         text[] default '{}';
alter table projects add column if not exists reveal_type       text default 'instant';
alter table projects add column if not exists marketplace_status text default 'draft';
alter table projects add column if not exists mints_paused      boolean default false;

-- ── Orders table ───────────────────────────────────────────────────────────────
create table if not exists orders (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid references projects(id) on delete cascade,
  payment_address     text unique not null,
  payment_amount_mojo bigint not null default 0,
  buyer_address       text,
  token_id            uuid references generated_tokens(id),
  status              text default 'pending_payment',
  tx_id               text,
  created_at          timestamptz default now(),
  confirmed_at        timestamptz
);

create index if not exists orders_project_id_idx     on orders(project_id);
create index if not exists orders_status_idx         on orders(status);
create index if not exists orders_payment_addr_idx   on orders(payment_address);

-- ── RLS ────────────────────────────────────────────────────────────────────────
alter table orders enable row level security;

do $$ begin
  create policy "service_role orders all" on orders for all
    to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon read confirmed orders" on orders for select
    using (status = 'confirmed');
exception when duplicate_object then null; end $$;

grant all  on table orders to service_role, authenticated;
grant select on table orders to anon;

-- Allow marketplace browse (live/scheduled collections visible to everyone)
do $$ begin
  create policy "anon read live projects" on projects for select
    using (marketplace_status in ('live', 'scheduled', 'sold_out'));
exception when duplicate_object then null; end $$;
