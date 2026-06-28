-- Wiznerd Platform — project persistence additions
-- Run in the Supabase SQL editor after 001_initial.sql

alter table projects add column if not exists creator_address text;
alter table projects add column if not exists current_step   integer default 1;
alter table projects add column if not exists updated_at     timestamptz default now();

create index if not exists projects_creator_address_idx on projects(creator_address);

-- Allow anon to insert/update their own projects (create screen uses anon key for Realtime)
-- Full write access for service_role is already granted; this allows the frontend supabase
-- client (anon) to subscribe to realtime changes without permission errors.
create policy "anon read layers"
  on layers for select using (true);
create policy "anon read variants"
  on variants for select using (true);
