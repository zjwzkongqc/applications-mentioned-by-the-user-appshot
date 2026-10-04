import { createHash } from 'node:crypto';

export const APP_ID = 'tennis-dazi-club-2026';
export const FORMAT_VERSION = 1;
export const SCHEMA_VERSION = 5;
export const TABLE_COLUMNS = Object.freeze({
  accounts: ['id', 'display_name', 'recovery_hash', 'created_at'],
  account_credentials: ['account_id', 'email', 'password_hash', 'password_salt', 'updated_at'],
  clubs: ['id', 'invite_hash', 'name', 'slogan', 'owner_id', 'created_at', 'invite_revoked_at'],
  members: ['id', 'club_id', 'session_hash', 'nickname', 'avatar_key', 'bio', 'created_at', 'account_id', 'removed_at', 'public_share_hash'],
  account_sessions: ['session_hash', 'account_id', 'expires_at', 'created_at'],
  club_invites: ['invite_hash', 'club_id', 'created_at', 'revoked_at', 'expires_at'],
  auth_failures: ['key', 'window_start', 'failures'],
  auth_registrations: ['account_id', 'club_id', 'legacy_hash', 'nonce_hash', 'expires_at'],
  records: ['id', 'club_id', 'member_id', 'play_date', 'minutes', 'partners', 'venue', 'mood', 'note', 'created_at', 'forehand', 'backhand', 'serve', 'net', 'footwork', 'return_skill', 'training_projects', 'training_content', 'training_effect', 'effect_note', 'next_plan'],
  monthly_ratings: ['member_id', 'month', 'forehand', 'backhand', 'serve', 'return_skill', 'net', 'footwork', 'created_at', 'updated_at'],
  record_photos: ['id', 'club_id', 'member_id', 'record_id', 'object_key', 'content_type', 'byte_size', 'created_at'],
  audit_events: ['id', 'club_id', 'actor_member_id', 'action', 'target_id', 'details', 'created_at'],
  culture: ['id', 'club_id', 'member_id', 'content', 'created_at'],
  cheers: ['record_id', 'member_id', 'emoji'],
  checkins: ['id', 'club_id', 'member_id', 'checkin_date', 'created_at']
});
export const TABLE_NAMES = Object.freeze(Object.keys(TABLE_COLUMNS));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const SKILLS = ['forehand', 'backhand', 'serve', 'return_skill', 'net', 'footwork'];
const PROJECTS = new Set(['forehand', 'backhand', 'serve', 'return_skill', 'net', 'footwork', 'fitness', 'match', 'other']);
const MOODS = new Set(['手感在线', '快乐拉球', '认真练球', '虽败犹荣', '饭后消食']);
const EFFECTS = new Set(['', 'improved', 'some', 'practice', 'exploring']);
const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIT_ACTIONS = new Set(['create-invite', 'revoke-invite', 'edit-profile', 'edit-rating', 'remove-member', 'restore-member', 'delete-photo', 'delete-record', 'export-backup']);

export class BackupValidationError extends Error {
  constructor(message) { super(message); this.name = 'BackupValidationError'; }
}
function fail(label, detail) { throw new BackupValidationError(`${label}: ${detail}.`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label, 'expected an object');
}
function keys(value, expected, label, optional = []) {
  object(value, label);
  const actual = Object.keys(value);
  if (expected.some(key => !Object.hasOwn(value, key)) || actual.some(key => !expected.includes(key) && !optional.includes(key))) fail(label, 'missing or unexpected fields');
}
function text(value, label, nonempty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || (nonempty && !value.length)) fail(label, 'expected valid text');
}
function hash(value, label) { if (typeof value !== 'string' || !HASH.test(value)) fail(label, 'expected a SHA-256 hash'); }
function uuid(value, label) { if (typeof value !== 'string' || !UUID.test(value)) fail(label, 'expected a member or object identifier'); }
function integer(value, label, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail(label, 'expected a safe integer'); }
function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(label, 'expected an ISO timestamp');
}
function day(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail(label, 'expected a calendar date');
}
export function validateOrigin(value, label = 'origin') {
  let url;
  try { url = new URL(value); } catch { fail(label, 'expected an explicit HTTP origin'); }
  if (typeof value !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) fail(label, 'expected an explicit HTTP origin');
  return value;
}
export function validatePageBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('pageBaseUrl', 'expected an explicit HTTP page URL'); }
  if (typeof value !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href !== value) fail('pageBaseUrl', 'expected an explicit HTTP page URL');
  return value;
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonicalStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
// The optional checksum covers the entire JSON value except its checksum field.
export function snapshotChecksum(snapshot) {
  const { checksum, ...contents } = snapshot;
  return sha256(canonicalStringify(contents));
}
export function validateObjectKey(value, label = 'avatar key') {
  text(value, label, true);
  if (value.length > 1024 || value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail(label, 'unsafe object key');
  return value;
}
function unique(rows, columns, label, skipNull = false) {
  const seen = new Set();
  for (const row of rows) {
    if (skipNull && columns.some(column => row[column] === null)) continue;
    const key = JSON.stringify(columns.map(column => row[column]));
    if (seen.has(key)) fail(label, 'duplicate identifier or unique key');
    seen.add(key);
  }
}

export function validateBackup(snapshot) {
  keys(snapshot, ['formatVersion', 'appId', 'schemaVersion', 'createdAt', 'fromApiOrigin', 'tables', 'avatars'], 'snapshot', ['checksum']);
  if (snapshot.formatVersion !== FORMAT_VERSION || snapshot.appId !== APP_ID || snapshot.schemaVersion !== SCHEMA_VERSION) fail('snapshot', 'unsupported format, application, or schema version');
  timestamp(snapshot.createdAt, 'createdAt');
  validateOrigin(snapshot.fromApiOrigin, 'fromApiOrigin');
  keys(snapshot.tables, TABLE_NAMES, 'tables');
  if (!Array.isArray(snapshot.avatars)) fail('avatars', 'expected an array');
  const tableCounts = {};
  for (const table of TABLE_NAMES) {
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows)) fail(`tables.${table}`, 'expected rows');
    tableCounts[table] = rows.length;
    rows.forEach((row, index) => {
      const label = `tables.${table}[${index}]`;
      keys(row, TABLE_COLUMNS[table], label);
      for (const column of TABLE_COLUMNS[table]) {
        const value = row[column], field = label + '.' + column;
        if (column === 'avatar_key') { if (value !== null) validateObjectKey(value, field); }
        else if (column === 'object_key') validateObjectKey(value, field);
        else if (['removed_at', 'revoked_at', 'invite_revoked_at'].includes(column)) { if (value !== null) timestamp(value, field); }
        else if (column === 'public_share_hash') { if (value !== null) hash(value, field); }
        else if (column === 'password_salt') { if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) fail(field, 'expected the original 128-bit password salt'); }
        else if (column === 'email') { text(value, field, true); if (value.length > 254 || value !== value.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(field, 'expected the original normalized email address'); }
        else if (column === 'month') { if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) fail(field, 'expected a calendar month'); }
        else if (column === 'target_id') text(value, field, true);
        else if (column === 'account_id' && table === 'members') { if (value !== null) uuid(value, field); }
        else if (SKILLS.includes(column)) { if (value !== null && (!Number.isInteger(value) || value < 0 || value > 10)) fail(field, 'expected an independent optional 0–10 score'); }
        else if (column === 'id' || column.endsWith('_id')) uuid(value, field);
        else if (column.endsWith('_hash')) hash(value, field);
        else if (['created_at', 'updated_at'].includes(column)) timestamp(value, field);
        else if (['expires_at', 'window_start', 'failures'].includes(column)) integer(value, field);
        else if (column === 'byte_size') { integer(value, field, 12); if (value > 2 * 1024 * 1024) fail(field, 'photo exceeds the image size limit'); }
        else if (column === 'content_type') { if (!AVATAR_TYPES.has(value)) fail(field, 'expected an original image content type'); }
        else if (column === 'minutes') { integer(value, field, 1); if (value > 1440) fail(field, 'duration exceeds one day'); }
        else if (['play_date', 'checkin_date'].includes(column)) day(value, field);
        else text(value, field, column === 'key');
      }
      if (table === 'records') {
        if (!MOODS.has(row.mood) || !EFFECTS.has(row.training_effect)) fail(label, 'invalid record choice');
        let projects;
        try { projects = JSON.parse(row.training_projects); } catch { fail(label + '.training_projects', 'invalid project JSON'); }
        if (!Array.isArray(projects) || projects.some(project => !PROJECTS.has(project)) || new Set(projects).size !== projects.length) fail(label + '.training_projects', 'invalid training projects');
      }
      if (table === 'audit_events') {
        if (!AUDIT_ACTIONS.has(row.action)) fail(label, 'invalid audit action');
        let details; try { details = JSON.parse(row.details); } catch { fail(label + '.details', 'invalid original audit JSON'); }
        object(details, label + '.details');
      }
      if (table === 'cheers' && !['👏', '🔥', '🎾'].includes(row.emoji)) fail(label, 'invalid reaction');
    });
    if (TABLE_COLUMNS[table].includes('id')) unique(rows, ['id'], `tables.${table}`);
  }
  for (const [table, columns, skipNull] of [
    ['accounts', ['recovery_hash']], ['account_credentials', ['account_id']], ['account_credentials', ['email']], ['account_sessions', ['session_hash']], ['clubs', ['invite_hash']],
    ['members', ['club_id', 'session_hash']], ['members', ['club_id', 'account_id'], true],
    ['club_invites', ['invite_hash']], ['auth_failures', ['key']],
    ['auth_registrations', ['club_id', 'legacy_hash', 'nonce_hash']], ['monthly_ratings', ['member_id', 'month']], ['cheers', ['record_id', 'member_id']], ['checkins', ['member_id', 'checkin_date']]
  ]) unique(snapshot.tables[table], columns, `tables.${table}`, skipNull);
  const map = table => new Map(snapshot.tables[table].map(row => [row.id, row]));
  const accounts = map('accounts'), clubs = map('clubs'), members = map('members'), records = map('records');
  const requireRow = (rows, id, label) => { const row = rows.get(id); if (!row) fail(label, 'missing referenced row'); return row; };
  for (const member of members.values()) {
    requireRow(clubs, member.club_id, 'members.club_id');
    if (member.account_id !== null) requireRow(accounts, member.account_id, 'members.account_id');
  }
  for (const club of clubs.values()) if (requireRow(members, club.owner_id, 'clubs.owner_id').club_id !== club.id) fail('clubs.owner_id', 'owner belongs to another group');
  for (const row of snapshot.tables.account_sessions) requireRow(accounts, row.account_id, 'account_sessions.account_id');
  for (const row of snapshot.tables.account_credentials) requireRow(accounts, row.account_id, 'account_credentials.account_id');
  for (const row of snapshot.tables.monthly_ratings) requireRow(members, row.member_id, 'monthly_ratings.member_id');
  const inviteHashes = new Set(snapshot.tables.clubs.map(row => row.invite_hash));
  for (const row of snapshot.tables.club_invites) {
    requireRow(clubs, row.club_id, 'club_invites.club_id');
    if (inviteHashes.has(row.invite_hash)) fail('club_invites.invite_hash', 'ambiguous invitation hash');
    inviteHashes.add(row.invite_hash);
  }
  for (const table of ['records', 'culture', 'checkins']) for (const row of snapshot.tables[table]) {
    requireRow(clubs, row.club_id, table + '.club_id');
    if (requireRow(members, row.member_id, table + '.member_id').club_id !== row.club_id) fail(table, 'member belongs to another group');
  }
  for (const row of snapshot.tables.cheers) if (requireRow(records, row.record_id, 'cheers.record_id').club_id !== requireRow(members, row.member_id, 'cheers.member_id').club_id) fail('cheers', 'reaction crosses groups');
  for (const row of snapshot.tables.auth_registrations) {
    requireRow(accounts, row.account_id, 'auth_registrations.account_id');
    requireRow(clubs, row.club_id, 'auth_registrations.club_id');
    if (![...members.values()].some(member => member.club_id === row.club_id && member.session_hash === row.legacy_hash && member.account_id === row.account_id)) fail('auth_registrations', 'receipt lacks its bound original member');
  }
  for (const row of snapshot.tables.record_photos) {
    requireRow(clubs, row.club_id, 'record_photos.club_id');
    const member = requireRow(members, row.member_id, 'record_photos.member_id'), record = requireRow(records, row.record_id, 'record_photos.record_id');
    if (member.club_id !== row.club_id || record.club_id !== row.club_id || record.member_id !== row.member_id) fail('record_photos', 'photo author or record belongs to another group or member');
  }
  for (const row of snapshot.tables.audit_events) {
    requireRow(clubs, row.club_id, 'audit_events.club_id');
    if (requireRow(members, row.actor_member_id, 'audit_events.actor_member_id').club_id !== row.club_id) fail('audit_events', 'audit actor belongs to another group');
  }
  // The envelope keeps its original field name, but contains every referenced
  // avatar and record photo, including media belonging to removed members.
  const referenced = new Set([...members.values()].map(row => row.avatar_key).filter(key => key !== null));
  for (const row of snapshot.tables.record_photos) referenced.add(row.object_key);
  const avatars = new Map();
  snapshot.avatars.forEach((avatar, index) => {
    const label = `avatars[${index}]`;
    keys(avatar, ['key', 'contentType', 'dataBase64', 'sha256'], label);
    validateObjectKey(avatar.key, label + '.key'); hash(avatar.sha256, label + '.sha256');
    if (!AVATAR_TYPES.has(avatar.contentType)) fail(label, 'invalid avatar content type');
    if (typeof avatar.dataBase64 !== 'string' || avatar.dataBase64.length > 2796204 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(avatar.dataBase64)) fail(label, 'invalid base64 body');
    const bytes = Buffer.from(avatar.dataBase64, 'base64');
    if (bytes.length < 12 || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== avatar.dataBase64 || sha256(bytes) !== avatar.sha256) fail(label, 'invalid body size or SHA-256');
    const actual = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
    if (actual !== avatar.contentType || avatars.has(avatar.key) || !referenced.has(avatar.key)) fail(label, 'mismatched, duplicate, or unreferenced avatar');
    avatars.set(avatar.key, { ...avatar, bytes });
  });
  if (referenced.size !== avatars.size || [...referenced].some(key => !avatars.has(key))) fail('avatars', 'missing referenced avatar object');
  for (const row of snapshot.tables.record_photos) {
    const media = avatars.get(row.object_key);
    if (media.contentType !== row.content_type || media.bytes.length !== row.byte_size) fail('record_photos', 'original photo metadata does not match its media object');
  }
  if (Object.hasOwn(snapshot, 'checksum')) {
    hash(snapshot.checksum, 'checksum');
    if (snapshot.checksum !== snapshotChecksum(snapshot)) fail('checksum', 'snapshot checksum mismatch');
  }
  return { snapshot, tableCounts, avatarCount: avatars.size, avatars };
}
