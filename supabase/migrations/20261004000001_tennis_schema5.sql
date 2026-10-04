-- Add the version-five application tables without changing any preserved IDs,
-- credential hashes, historical text, nullable scores or zero-valued integers.
CREATE TABLE public.account_credentials (
  account_id text PRIMARY KEY REFERENCES public.accounts (id),
  email text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX idx_account_credentials_email ON public.account_credentials (email);

CREATE TABLE public.audit_events (
  id text PRIMARY KEY,
  club_id text NOT NULL REFERENCES public.clubs (id),
  actor_member_id text NOT NULL REFERENCES public.members (id),
  action text NOT NULL,
  target_id text NOT NULL,
  details text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX idx_audit_events_club ON public.audit_events (club_id, created_at);

CREATE TABLE public.monthly_ratings (
  member_id text NOT NULL REFERENCES public.members (id),
  month text NOT NULL,
  forehand bigint,
  backhand bigint,
  serve bigint,
  return_skill bigint,
  net bigint,
  footwork bigint,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (member_id, month)
);

CREATE TABLE public.record_photos (
  id text PRIMARY KEY,
  club_id text NOT NULL REFERENCES public.clubs (id),
  member_id text NOT NULL REFERENCES public.members (id),
  record_id text NOT NULL REFERENCES public.records (id) ON DELETE CASCADE,
  object_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX idx_record_photos_record ON public.record_photos (record_id);
CREATE INDEX idx_record_photos_club ON public.record_photos (club_id);

ALTER TABLE public.club_invites ADD COLUMN revoked_at text;
ALTER TABLE public.club_invites ADD COLUMN expires_at bigint NOT NULL DEFAULT 0;
ALTER TABLE public.clubs ADD COLUMN invite_revoked_at text;
ALTER TABLE public.members ADD COLUMN removed_at text;
ALTER TABLE public.members ADD COLUMN public_share_hash text;

-- The existing eleven tables and private receipt remain protected by their
-- original migration. New tables have the same server-only access contract.
DO $tennis_schema5_permissions$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'account_credentials', 'audit_events', 'monthly_ratings', 'record_photos'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', table_name);
    END IF;
  END LOOP;
END;
$tennis_schema5_permissions$;
