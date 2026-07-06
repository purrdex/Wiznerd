-- Verification requests: creators apply to get a verified badge on their collections
CREATE TABLE IF NOT EXISTS verify_requests (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id  text        NOT NULL,
  creator_address text       NOT NULL,
  twitter        text,
  website        text,
  note           text,
  status         text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verify_requests_collection ON verify_requests(collection_id);
CREATE INDEX IF NOT EXISTS verify_requests_creator    ON verify_requests(creator_address, status);
GRANT ALL ON TABLE verify_requests TO postgres, service_role, authenticated, anon;
