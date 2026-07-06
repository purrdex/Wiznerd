-- Page views with UTM source tracking for referral analytics
CREATE TABLE IF NOT EXISTS page_views (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id  text        NOT NULL,
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_views_collection ON page_views(collection_id, created_at DESC);
GRANT ALL ON TABLE page_views TO postgres, service_role, authenticated, anon;

-- Purge rows older than 90 days (call from a cron or manually)
CREATE OR REPLACE FUNCTION purge_old_page_views() RETURNS void LANGUAGE sql AS $$
  DELETE FROM page_views WHERE created_at < now() - interval '90 days';
$$;
