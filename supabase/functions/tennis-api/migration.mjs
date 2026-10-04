const APP_ID = 'tennis-dazi-club-2026';
const TABLES = ['accounts', 'account_credentials', 'account_sessions', 'auth_failures', 'auth_registrations', 'clubs', 'club_invites', 'members', 'records', 'monthly_ratings', 'record_photos', 'audit_events', 'checkins', 'cheers', 'culture'];
const TOKEN = /^[a-f0-9]{64}$/;
const CLUB = /^[a-f0-9-]{36}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }

function trustedOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.port || url.search || url.hash) throw new Error('Migration configuration requires HTTPS origins.');
  return url.origin;
}

export function createEdgeMigration({ DB, publicOrigin, migrationId, migrationFromOrigin, migrationPageBaseUrl }) {
  if (!migrationId) return { enabled: false, inspect: async () => ({ ready: false }), validate: async () => { throw new Error('Migration is not configured.'); } };
  if (!matches(TOKEN, migrationId)) throw new Error('MIGRATION_ID requires 64 lowercase hexadecimal characters.');
  const page = new URL(migrationPageBaseUrl);
  if (page.origin !== 'https://zjwzkongqc.github.io' || page.username || page.password || page.search || page.hash || !page.pathname.endsWith('/')) throw new Error('Migration Pages configuration is invalid.');
  const manifest = Object.freeze({ appId: APP_ID, schemaVersion: 5, migrationId, fromApiOrigin: trustedOrigin(migrationFromOrigin), toApiOrigin: trustedOrigin(publicOrigin), pageBaseUrl: page.href, credentialsPreserved: true });
  if (manifest.fromApiOrigin === manifest.toApiOrigin) throw new Error('Migration origin tuple is invalid.');
  const one = (sql, ...values) => DB.prepare(sql).bind(...values).first();
  async function accepted(proof) {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || !matches(TOKEN, proof.token)) return false;
    const tokenHash = await hash(proof.token), now = Date.now();
    if (proof.kind === 'account') return !!await one('SELECT a.id FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.session_hash=? AND s.expires_at>?', tokenHash, now);
    if (proof.kind === 'member') {
      if (proof.invite === undefined) return !!await one('SELECT id FROM members WHERE session_hash=? AND account_id IS NULL AND removed_at IS NULL LIMIT 1', tokenHash);
      if (!matches(TOKEN, proof.invite)) return false;
      const inviteHash = await hash(proof.invite);
      const club = await one('SELECT id FROM clubs WHERE invite_hash=? AND invite_revoked_at IS NULL', inviteHash) || await one('SELECT club_id AS id FROM club_invites WHERE invite_hash=? AND revoked_at IS NULL AND (expires_at=0 OR expires_at>?)', inviteHash, now);
      return !!club && !!await one('SELECT id FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL AND removed_at IS NULL', club.id, tokenHash);
    }
    if (!matches(CLUB, proof.clubId) || !['claim', 'registration'].includes(proof.kind)) return false;
    if (proof.kind === 'claim') return !!await one('SELECT id FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL AND removed_at IS NULL', proof.clubId, tokenHash);
    if (!matches(TOKEN, proof.registrationNonce)) return false;
    if (await one('SELECT id FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL AND removed_at IS NULL', proof.clubId, tokenHash)) return true;
    const receipt = await one('SELECT a.id,a.recovery_hash FROM auth_registrations g JOIN accounts a ON a.id=g.account_id JOIN members m ON m.club_id=g.club_id AND m.session_hash=g.legacy_hash AND m.account_id=g.account_id AND m.removed_at IS NULL WHERE g.club_id=? AND g.legacy_hash=? AND g.nonce_hash=? AND g.expires_at>?', proof.clubId, tokenHash, await hash(proof.registrationNonce), now);
    return !!receipt && await hash((await hash(`recovery-v1:${proof.token}:${proof.registrationNonce}:${receipt.id}`)).slice(0, 40)) === receipt.recovery_hash;
  }
  return {
    enabled: true,
    async inspect() {
      const receipt = (await one("SELECT metadata FROM tennis_migration_receipt WHERE id='current'"))?.metadata;
      const valid = receipt && receipt.formatVersion === 1 && matches(TOKEN, receipt.sourceSnapshotSha256) && typeof receipt.importedAt === 'string' && Number.isFinite(Date.parse(receipt.importedAt)) && Number.isSafeInteger(receipt.avatarCount) && receipt.avatarCount >= 0 && receipt.tableCounts && Object.keys(receipt.tableCounts).length === TABLES.length && TABLES.every(table => Number.isSafeInteger(receipt.tableCounts[table]) && receipt.tableCounts[table] >= 0) && Object.entries(manifest).every(([key, value]) => receipt[key] === value);
      return { ready: !!valid, manifest: valid ? manifest : null };
    },
    async validate(body) {
      if (!body || body.migrationId !== migrationId || !Array.isArray(body.proofs) || body.proofs.length > 100) throw Object.assign(new Error('Migration proof request is invalid.'), { status: 400 });
      const ids = body.proofs.map(proof => proof?.proofId);
      if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) || new Set(ids).size !== ids.length) throw Object.assign(new Error('Migration proof IDs are invalid.'), { status: 400 });
      const acceptedProofIds = [];
      for (const proof of body.proofs) if (await accepted(proof)) acceptedProofIds.push(proof.proofId);
      return { ...manifest, acceptedProofIds };
    }
  };
}
