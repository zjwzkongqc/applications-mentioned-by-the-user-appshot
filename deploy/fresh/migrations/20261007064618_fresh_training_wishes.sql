-- Fresh application only. Existing accounts and training history are unchanged.
-- This schema uses custom server-side sessions, not Supabase Auth users.
-- The non-login runner role is selected only by the trusted Edge Function.
CREATE TABLE tennis_fresh.training_wishes (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES tennis_fresh.accounts(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  target_cents bigint NOT NULL CHECK (target_cents BETWEEN 1 AND 100000000),
  image_key text,
  fulfilled_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX training_wishes_account_created_idx
  ON tennis_fresh.training_wishes(account_id, created_at DESC, id);
ALTER TABLE tennis_fresh.training_wishes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tennis_fresh.training_wishes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tennis_fresh.training_wishes TO tennis_fresh_runner;
CREATE POLICY training_wishes_runner ON tennis_fresh.training_wishes
  FOR ALL TO tennis_fresh_runner USING (true) WITH CHECK (true);
