alter table orders
  add column if not exists retry_count integer not null default 0;

-- Cancel obviously-bogus test orders (quantity > 100 means price was set to near-zero)
update orders set status = 'cancelled' where quantity > 100 and status in ('failed', 'payment_detected');
