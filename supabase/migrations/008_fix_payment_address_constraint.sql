-- Drop the old unique constraint on payment_address (no longer valid with shared project addresses)
alter table orders drop constraint if exists orders_payment_address_key;

-- Deduplicate by (project_id, tx_id) instead
create unique index if not exists orders_project_tx_id_idx
  on orders(project_id, tx_id)
  where tx_id is not null;
