-- The shared application keeps IDs, hashes, calendar dates and ISO timestamps
-- as text. Integer fields use bigint to preserve existing SQLite values.
CREATE TABLE public.accounts (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  recovery_hash text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX idx_accounts_recovery_hash ON public.accounts (recovery_hash);

CREATE TABLE public.account_sessions (
  session_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES public.accounts (id),
  expires_at bigint NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX idx_account_sessions_account ON public.account_sessions (account_id);
CREATE INDEX idx_account_sessions_expiry ON public.account_sessions (expires_at);

CREATE TABLE public.auth_failures (
  key text PRIMARY KEY,
  window_start bigint NOT NULL,
  failures bigint NOT NULL
);

CREATE TABLE public.clubs (
  id text PRIMARY KEY,
  invite_hash text NOT NULL,
  name text NOT NULL,
  slogan text NOT NULL,
  owner_id text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX idx_clubs_invite_hash ON public.clubs (invite_hash);

CREATE TABLE public.club_invites (
  invite_hash text PRIMARY KEY,
  club_id text NOT NULL REFERENCES public.clubs (id),
  created_at text NOT NULL
);
CREATE INDEX idx_club_invites_club ON public.club_invites (club_id);

CREATE TABLE public.members (
  id text PRIMARY KEY,
  club_id text NOT NULL REFERENCES public.clubs (id),
  account_id text REFERENCES public.accounts (id),
  session_hash text NOT NULL,
  nickname text NOT NULL,
  avatar_key text,
  bio text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX idx_members_club ON public.members (club_id);
CREATE UNIQUE INDEX idx_members_club_session ON public.members (club_id, session_hash);
CREATE UNIQUE INDEX idx_members_club_account ON public.members (club_id, account_id);
CREATE INDEX idx_members_account ON public.members (account_id);

CREATE TABLE public.auth_registrations (
  account_id text NOT NULL REFERENCES public.accounts (id),
  club_id text NOT NULL REFERENCES public.clubs (id),
  legacy_hash text NOT NULL,
  nonce_hash text NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (club_id, legacy_hash, nonce_hash)
);
CREATE INDEX idx_auth_registrations_expiry ON public.auth_registrations (expires_at);

CREATE TABLE public.records (
  id text PRIMARY KEY,
  club_id text NOT NULL REFERENCES public.clubs (id),
  member_id text NOT NULL REFERENCES public.members (id),
  play_date text NOT NULL,
  minutes bigint NOT NULL,
  partners text NOT NULL,
  venue text NOT NULL,
  mood text NOT NULL,
  note text NOT NULL,
  created_at text NOT NULL,
  forehand bigint,
  backhand bigint,
  serve bigint,
  return_skill bigint,
  net bigint,
  footwork bigint,
  training_projects text NOT NULL DEFAULT '[]',
  training_content text NOT NULL DEFAULT '',
  training_effect text NOT NULL DEFAULT '',
  effect_note text NOT NULL DEFAULT '',
  next_plan text NOT NULL DEFAULT ''
);
CREATE INDEX idx_records_club_date ON public.records (club_id, play_date);
CREATE INDEX idx_records_member ON public.records (member_id);

CREATE TABLE public.culture (
  id text PRIMARY KEY,
  club_id text NOT NULL REFERENCES public.clubs (id),
  member_id text NOT NULL REFERENCES public.members (id),
  content text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX idx_culture_club ON public.culture (club_id);

CREATE TABLE public.cheers (
  record_id text NOT NULL REFERENCES public.records (id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES public.members (id),
  emoji text NOT NULL
);
CREATE UNIQUE INDEX idx_cheers_record_member ON public.cheers (record_id, member_id);

CREATE TABLE public.checkins (
  id text PRIMARY KEY,
  club_id text NOT NULL REFERENCES public.clubs (id),
  member_id text NOT NULL REFERENCES public.members (id),
  checkin_date text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX idx_checkins_member_date ON public.checkins (member_id, checkin_date);
CREATE INDEX idx_checkins_club_date ON public.checkins (club_id, checkin_date);

-- Import metadata is separate from the eleven preserved application tables.
CREATE TABLE public.tennis_migration_receipt (
  id text PRIMARY KEY CHECK (id = 'current'),
  metadata jsonb NOT NULL
);

-- Browser keys cannot access application tables. All access passes through
-- the Edge Function's server-side database connection and application checks.
DO $tennis_permissions$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts', 'account_sessions', 'auth_failures', 'auth_registrations',
    'clubs', 'club_invites', 'members', 'records', 'checkins', 'cheers', 'culture',
    'tennis_migration_receipt'
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
$tennis_permissions$;

-- Supabase Storage serves avatars only through the authenticated Edge API.
-- No public bucket or browser-role object policy is created by this migration.
DO $tennis_avatar_bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('tennis-avatars', 'tennis-avatars', false, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
    ON CONFLICT (id) DO NOTHING;
    IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'tennis-avatars' AND public IS DISTINCT FROM false) THEN
      RAISE EXCEPTION 'The tennis avatar bucket must be private.';
    END IF;
  END IF;
END;
$tennis_avatar_bucket$;
