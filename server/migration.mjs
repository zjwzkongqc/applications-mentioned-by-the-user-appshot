import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { validatePublicOrigin } from './http.mjs';

const APP_ID = 'tennis-dazi-club-2026';
const SCHEMA_VERSION = 4;
const PAGES_ORIGIN = 'https://zjwzkongqc.github.io';
const TABLES = ['accounts', 'account_sessions', 'auth_failures', 'auth_registrations', 'clubs', 'club_invites', 'members', 'records', 'checkins', 'cheers', 'culture'];
const HEX_TOKEN = /^[a-f0-9]{64}$/;
const CLUB_ID = /^[a-f0-9-]{36}$/;
const PROOF_ID = /^[A-Za-z0-9_-]{1,80}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const badRequest = () => Object.assign(new Error('Invalid migration validation request.'), { status: 400 });

function json(request, data, status = 200) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' });
  if (request.headers.get('Origin') === PAGES_ORIGIN) headers.set('Access-Control-Allow-Origin', PAGES_ORIGIN);
  return new Response(JSON.stringify(data), { status, headers });
}

function pageBase(value) {
  const url = new URL(value);
  if (url.origin !== PAGES_ORIGIN || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) throw new Error('MIGRATION_PAGE_BASE_URL must be the GitHub Pages project URL ending in a slash.');
  return url.href;
}

async function importedReceipt(directory) {
  let file;
  try {
    file = await open(path.join(directory, 'migration-receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 20000 || (stat.mode & 0o077)) return null;
    return JSON.parse(await file.readFile({ encoding: 'utf8' }));
  } catch { return null; }
  finally { if (file) await file.close(); }
}

function receiptMatches(receipt, manifest) {
  if (!receipt || receipt.formatVersion !== 1 || receipt.credentialsPreserved !== true || !matches(HEX_TOKEN, receipt.sourceSnapshotSha256) || typeof receipt.importedAt !== 'string' || !Number.isFinite(Date.parse(receipt.importedAt))) return false;
  if (!Number.isSafeInteger(receipt.avatarCount) || receipt.avatarCount < 0) return false;
  if (!receipt.tableCounts || Object.keys(receipt.tableCounts).length !== TABLES.length || TABLES.some(table => !Number.isSafeInteger(receipt.tableCounts[table]) || receipt.tableCounts[table] < 0)) return false;
  return Object.entries(manifest).every(([key, value]) => receipt[key] === value);
}

/** The receipt is read once at startup. After an atomic import, restart the
 * process so both the SQLite handle and this receipt refer to the new data. */
export async function createMigrationService({ DB, dataDir, publicOrigin, migrationId, fromApiOrigin, pageBaseUrl }) {
  if (!migrationId) return { enabled: false, ready: false, handle: async request => ['/api/migration', '/api/migration/validate'].includes(new URL(request.url).pathname) ? json(request, { ready: false, error: '此服务尚未启用数据迁移。' }, 503) : null };
  if (!matches(HEX_TOKEN, migrationId)) throw new Error('MIGRATION_ID must be an explicit 64-character lowercase hexadecimal deployment identifier.');
  if (!DB?.prepare || !dataDir || !fromApiOrigin || !pageBaseUrl) throw new Error('Migration configuration requires a database, DATA_DIR, origin tuple, and Pages URL.');
  const manifest = Object.freeze({ appId: APP_ID, schemaVersion: SCHEMA_VERSION, migrationId, fromApiOrigin: validatePublicOrigin(fromApiOrigin), toApiOrigin: validatePublicOrigin(publicOrigin), pageBaseUrl: pageBase(pageBaseUrl), credentialsPreserved: true });
  if (manifest.fromApiOrigin === manifest.toApiOrigin) throw new Error('Migration source and destination origins must differ.');
  const ready = receiptMatches(await importedReceipt(dataDir), manifest);
  const one = (sql, ...args) => DB.prepare(sql).bind(...args).first();

  async function accepted(proof) {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || !matches(HEX_TOKEN, proof.token)) return false;
    const tokenHash = hash(proof.token), now = Date.now();
    if (proof.kind === 'account') return !!await one('SELECT a.id FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.session_hash=? AND s.expires_at>?', tokenHash, now);
    if (proof.kind === 'member') {
      if (proof.invite === undefined) return !!await one('SELECT id FROM members WHERE session_hash=? AND account_id IS NULL LIMIT 1', tokenHash);
      if (!matches(HEX_TOKEN, proof.invite)) return false;
      const inviteHash = hash(proof.invite);
      const club = await one('SELECT id FROM clubs WHERE invite_hash=?', inviteHash) || await one('SELECT club_id AS id FROM club_invites WHERE invite_hash=?', inviteHash);
      return !!club && !!await one('SELECT id FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL', club.id, tokenHash);
    }
    if (!matches(CLUB_ID, proof.clubId) || !['claim', 'registration'].includes(proof.kind)) return false;
    if (proof.kind === 'claim') return !!await one('SELECT id FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL', proof.clubId, tokenHash);
    if (!matches(HEX_TOKEN, proof.registrationNonce)) return false;
    if (await one('SELECT id FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL', proof.clubId, tokenHash)) return true;
    const receipt = await one('SELECT a.id,a.recovery_hash FROM auth_registrations g JOIN accounts a ON a.id=g.account_id JOIN members m ON m.club_id=g.club_id AND m.session_hash=g.legacy_hash AND m.account_id=g.account_id WHERE g.club_id=? AND g.legacy_hash=? AND g.nonce_hash=? AND g.expires_at>?', proof.clubId, tokenHash, hash(proof.registrationNonce), now);
    return !!receipt && hash(hash(`recovery-v1:${proof.token}:${proof.registrationNonce}:${receipt.id}`).slice(0, 40)) === receipt.recovery_hash;
  }

  return {
    enabled: true, ready,
    async handle(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/api/migration' && url.pathname !== '/api/migration/validate') return null;
      if (!ready) return json(request, { ready: false, error: '迁移数据尚未就绪，请稍后再试。' }, 503);
      if (url.pathname === '/api/migration' && request.method === 'GET') return json(request, manifest);
      if (url.pathname !== '/api/migration/validate' || request.method !== 'POST') return json(request, { error: '请求方式不正确。' }, 405);
      const origin = request.headers.get('Origin');
      if ((origin && origin !== manifest.toApiOrigin && origin !== PAGES_ORIGIN) || (request.headers.get('Sec-Fetch-Site') === 'cross-site' && origin !== PAGES_ORIGIN)) return json(request, { error: '请在原页面完成操作。' }, 403);
      if (!request.headers.get('Content-Type')?.includes('application/json')) return json(request, { error: '请提交有效内容。' }, 415);
      let body;
      try { const raw = await request.text(); if (Buffer.byteLength(raw) > 20000) throw badRequest(); body = JSON.parse(raw); } catch { throw badRequest(); }
      if (!body || body.migrationId !== migrationId || !Array.isArray(body.proofs) || body.proofs.length > 100) throw badRequest();
      const ids = body.proofs.map(proof => proof?.proofId);
      if (ids.some(id => typeof id !== 'string' || !PROOF_ID.test(id)) || new Set(ids).size !== ids.length) throw badRequest();
      const acceptedProofIds = [];
      for (const proof of body.proofs) if (await accepted(proof)) acceptedProofIds.push(proof.proofId);
      return json(request, { ...manifest, acceptedProofIds });
    }
  };
}
