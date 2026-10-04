// Pure Web snapshot validation and private migration import. No platform secrets
// or third-party clients are loaded by this module.

export const APP_ID = 'tennis-dazi-club-2026';
export const FORMAT_VERSION = 1;
export const SCHEMA_VERSION = 4;
export const TABLE_COLUMNS = Object.freeze({
  accounts: ['id', 'display_name', 'recovery_hash', 'created_at'],
  clubs: ['id', 'invite_hash', 'name', 'slogan', 'owner_id', 'created_at'],
  members: ['id', 'club_id', 'session_hash', 'nickname', 'avatar_key', 'bio', 'created_at', 'account_id'],
  account_sessions: ['session_hash', 'account_id', 'expires_at', 'created_at'],
  club_invites: ['invite_hash', 'club_id', 'created_at'],
  auth_failures: ['key', 'window_start', 'failures'],
  auth_registrations: ['account_id', 'club_id', 'legacy_hash', 'nonce_hash', 'expires_at'],
  records: ['id', 'club_id', 'member_id', 'play_date', 'minutes', 'partners', 'venue', 'mood', 'note', 'created_at', 'forehand', 'backhand', 'serve', 'net', 'footwork', 'return_skill', 'training_projects', 'training_content', 'training_effect', 'effect_note', 'next_plan'],
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
export async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function canonicalStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
// The optional checksum covers the entire JSON value except its checksum field.
export async function snapshotChecksum(snapshot) {
  const { checksum, ...contents } = snapshot;
  return sha256(canonicalStringify(contents));
}
function encodeBase64(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) result += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(result);
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

export async function validateSnapshot(snapshot) {
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
        else if (column === 'account_id' && table === 'members') { if (value !== null) uuid(value, field); }
        else if (SKILLS.includes(column)) { if (value !== null && (!Number.isInteger(value) || value < 1 || value > 10)) fail(field, 'expected an optional 1–10 score'); }
        else if (column === 'id' || column.endsWith('_id')) uuid(value, field);
        else if (column.endsWith('_hash')) hash(value, field);
        else if (column === 'created_at') timestamp(value, field);
        else if (['expires_at', 'window_start', 'failures'].includes(column)) integer(value, field);
        else if (column === 'minutes') { integer(value, field, 1); if (value > 1440) fail(field, 'duration exceeds one day'); }
        else if (['play_date', 'checkin_date'].includes(column)) day(value, field);
        else text(value, field, column === 'key');
      }
      if (table === 'records') {
        const rated = SKILLS.filter(column => row[column] !== null).length;
        if (rated !== 0 && rated !== SKILLS.length) fail(label, 'incomplete self-assessment');
        if (!MOODS.has(row.mood) || !EFFECTS.has(row.training_effect)) fail(label, 'invalid record choice');
        let projects;
        try { projects = JSON.parse(row.training_projects); } catch { fail(label + '.training_projects', 'invalid project JSON'); }
        if (!Array.isArray(projects) || projects.some(project => !PROJECTS.has(project)) || new Set(projects).size !== projects.length) fail(label + '.training_projects', 'invalid training projects');
      }
      if (table === 'cheers' && !['👏', '🔥', '🎾'].includes(row.emoji)) fail(label, 'invalid reaction');
    });
    if (TABLE_COLUMNS[table].includes('id')) unique(rows, ['id'], `tables.${table}`);
  }
  for (const [table, columns, skipNull] of [
    ['accounts', ['recovery_hash']], ['account_sessions', ['session_hash']], ['clubs', ['invite_hash']],
    ['members', ['club_id', 'session_hash']], ['members', ['club_id', 'account_id'], true],
    ['club_invites', ['invite_hash']], ['auth_failures', ['key']],
    ['auth_registrations', ['club_id', 'legacy_hash', 'nonce_hash']], ['cheers', ['record_id', 'member_id']], ['checkins', ['member_id', 'checkin_date']]
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
  const referenced = new Set([...members.values()].map(row => row.avatar_key).filter(key => key !== null)), avatars = new Map();
  for (const [index, avatar] of snapshot.avatars.entries()) {
    const label = `avatars[${index}]`;
    keys(avatar, ['key', 'contentType', 'dataBase64', 'sha256'], label);
    validateObjectKey(avatar.key, label + '.key'); hash(avatar.sha256, label + '.sha256');
    if (!AVATAR_TYPES.has(avatar.contentType)) fail(label, 'invalid avatar content type');
    if (typeof avatar.dataBase64 !== 'string' || avatar.dataBase64.length > 2796204 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(avatar.dataBase64)) fail(label, 'invalid base64 body');
    const bytes = Uint8Array.from(atob(avatar.dataBase64), char => char.charCodeAt(0));
    if (bytes.length < 12 || bytes.length > 2 * 1024 * 1024 || encodeBase64(bytes) !== avatar.dataBase64 || await sha256(bytes) !== avatar.sha256) fail(label, 'invalid body size or SHA-256');
    const actual = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : [137, 80, 78, 71, 13, 10, 26, 10].every((byte, position) => bytes[position] === byte) ? 'image/png' : new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP' ? 'image/webp' : null;
    if (actual !== avatar.contentType || avatars.has(avatar.key) || !referenced.has(avatar.key)) fail(label, 'mismatched, duplicate, or unreferenced avatar');
    avatars.set(avatar.key, { ...avatar, bytes });
  }
  if (referenced.size !== avatars.size || [...referenced].some(key => !avatars.has(key))) fail('avatars', 'missing referenced avatar object');
  if (Object.hasOwn(snapshot, 'checksum')) {
    hash(snapshot.checksum, 'checksum');
    if (snapshot.checksum !== await snapshotChecksum(snapshot)) fail('checksum', 'snapshot checksum mismatch');
  }
  return { snapshot, tableCounts, avatarCount: avatars.size, avatars };
}

export const AVATAR_BUCKET = 'tennis-avatars';
const RECEIPT_TABLE = 'tennis_migration_receipt';
const NUMBER_COLUMNS = new Set(['expires_at', 'window_start', 'failures', 'minutes', 'forehand', 'backhand', 'serve', 'return_skill', 'net', 'footwork']);
export class ImportError extends Error {
  constructor(message, options = {}) {
    super(message); this.name = 'SupabaseImportError';
    this.commitUncertain = options.commitUncertain === true;
    this.storageUncertain = options.storageUncertain === true;
    this.existingObject = options.existingObject === true;
  }
}
const refuse = message => { throw new ImportError(message); };
function normalizedRow(table, row) {
  const result = {};
  for (const column of TABLE_COLUMNS[table]) {
    let value = row[column];
    if (NUMBER_COLUMNS.has(column) && value !== null) {
      if (typeof value === 'bigint' || (typeof value === 'string' && /^-?\d+$/.test(value))) value = Number(value);
      if (!Number.isSafeInteger(value)) refuse('A database integer cannot be preserved exactly.');
    }
    result[column] = value;
  }
  return result;
}
export function createImportDatabase(sql) {
  if (!sql?.unsafe || !sql?.begin) refuse('A private PostgreSQL transaction client is required.');
  const quoted = table => 'public."' + table + '"';
  const query = (statement, parameters = []) => sql.unsafe(statement, parameters);
  function methods(query) {
    return {
      async assertEmpty() {
        for (const table of [...TABLE_NAMES, RECEIPT_TABLE]) if (Number((await query('SELECT COUNT(*) AS n FROM ' + quoted(table), []))[0].n) !== 0) refuse('The target contains application data or a migration receipt; import refused.');
      },
      async insertRows(table, rows) {
        const columns = TABLE_COLUMNS[table];
        for (const row of rows) await query('INSERT INTO ' + quoted(table) + ' (' + columns.map(column => '"' + column + '"').join(',') + ') VALUES (' + columns.map((_, index) => '$' + (index + 1)).join(',') + ')', columns.map(column => row[column]));
      },
      async readRows(table) { return (await query('SELECT ' + TABLE_COLUMNS[table].map(column => '"' + column + '"').join(',') + ' FROM ' + quoted(table), [])).map(row => normalizedRow(table, row)); },
      async writeReceipt(receipt) { await query('INSERT INTO ' + quoted(RECEIPT_TABLE) + ' (id,metadata) VALUES ($1,$2::text::jsonb)', ['current', JSON.stringify(receipt)]); const rows = await query('SELECT metadata FROM ' + quoted(RECEIPT_TABLE) + ' WHERE id=$1', ['current']); if (rows.length !== 1 || canonicalStringify(rows[0].metadata) !== canonicalStringify(receipt)) refuse('The migration receipt could not be verified.'); }
    };
  }
  return {
    ...methods(query),
    async verifySchema() {
      const names = [...TABLE_NAMES, RECEIPT_TABLE];
      const columns = await query('SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])', ['public', names]);
      for (const table of names) {
        const expected = table === RECEIPT_TABLE ? ['id', 'metadata'] : TABLE_COLUMNS[table], actual = columns.filter(row => row.table_name === table);
        if (actual.length !== expected.length || actual.some(row => !expected.includes(row.column_name) || row.data_type !== (table === RECEIPT_TABLE && row.column_name === 'metadata' ? 'jsonb' : NUMBER_COLUMNS.has(row.column_name) ? 'bigint' : 'text'))) refuse('The target does not contain the exact private schema version 4.');
      }
      const security = await query('SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])', ['public', names]);
      if (security.length !== names.length || security.some(row => !row.relrowsecurity)) refuse('Every import table must have row-level security enabled.');
      if ((await query('SELECT tablename FROM pg_policies WHERE schemaname=$1 AND tablename=ANY($2::text[])', ['public', names])).length) refuse('Browser-access policies are not allowed on import tables.');
      const publicGrants = await query('SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(\'r\',c.relowner))) a WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.grantee=0', ['public', names]);
      if (publicGrants.length) refuse('Import tables must not grant access to PUBLIC.');
      const browserRoles = await query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])', [['anon', 'authenticated']]);
      for (const role of browserRoles) for (const table of names) {
        const privileges = await query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role.rolname, 'public.' + table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER']);
        if (privileges[0].allowed) refuse('Import tables must not grant access to browser roles.');
      }
    },
    async transaction(callback) {
      let phase = 'starting';
      try {
        const result = await sql.begin('isolation level serializable', async transaction => {
          phase = 'working';
          // Acquire every table before the first data SELECT establishes a
          // serializable snapshot. Concurrent staged imports may share exact
          // private objects, but only one can import into an empty database.
          await transaction.unsafe('LOCK TABLE ' + [...TABLE_NAMES, RECEIPT_TABLE].map(quoted).join(',') + ' IN ACCESS EXCLUSIVE MODE');
          const value = await callback(methods((statement, parameters) => transaction.unsafe(statement, parameters)));
          phase = 'committing'; return value;
        });
        phase = 'committed'; return result;
      } catch (error) {
        if (phase !== 'committing' && error instanceof ImportError) throw error;
        const state = /^[0-9A-Z]{5}$/.test(error?.code || '') ? ' SQLSTATE ' + error.code + '.' : '';
        throw new ImportError(phase === 'committing' ? 'Database commit acknowledgement was lost; private staged objects were retained for safe retry or owner inspection.' : 'The database transaction failed and was not published.' + state, { commitUncertain: phase === 'committing' });
      }
    }
  };
}

export function createImportBucket({ url, serviceRoleKey, fetch: request = globalThis.fetch }) {
  let origin;
  try { origin = new URL(url); } catch { refuse('A trusted private Storage project origin is required.'); }
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.supabase.co') || origin.origin !== url || origin.username || origin.password || origin.port || typeof serviceRoleKey !== 'string' || !serviceRoleKey || /[\r\n]/.test(serviceRoleKey)) refuse('A trusted private Storage project origin and server-only key are required.');
  const headers = { Authorization: 'Bearer ' + serviceRoleKey, apikey: serviceRoleKey };
  const root = url + '/storage/v1';
  const objectUrl = (key, authenticated = false) => root + '/object/' + (authenticated ? 'authenticated/' : '') + AVATAR_BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
  async function call(url, options = {}) {
    try { return await request(url, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error' }); }
    catch { refuse('A private storage request failed; no credentials were printed.'); }
  }
  return {
    async assertPrivate() {
      const response = await call(root + '/bucket/' + AVATAR_BUCKET);
      if (!response.ok) refuse('The configured private avatar bucket is unavailable.');
      let bucket; try { bucket = await response.json(); } catch { refuse('Invalid private bucket metadata.'); }
      if (bucket.id !== AVATAR_BUCKET || bucket.public !== false) refuse('The avatar bucket must be private.');
    },
    async upload(key, bytes, contentType) {
      validateObjectKey(key);
      let response;
      try { response = await call(objectUrl(key), { method: 'POST', headers: { 'Content-Type': contentType, 'x-upsert': 'false' }, body: bytes }); }
      catch { throw new ImportError('Avatar upload acknowledgement was lost; owner inspection of private staged objects is required.', { storageUncertain: true }); }
      if (response.status >= 500) { await response.body?.cancel(); throw new ImportError('Avatar upload outcome is uncertain; owner inspection of private staged objects is required.', { storageUncertain: true }); }
      if (!response.ok) {
        let duplicate = response.status === 409;
        // Storage also represents duplicate-object 409 errors inside a 400
        // JSON envelope. Only its documented conflict markers permit reuse.
        if (response.status === 400) { try { const error = await response.json(); duplicate = String(error.statusCode) === '409' || error.error === 'Duplicate'; } catch { /* Remains an ordinary rejection. */ } }
        else await response.body?.cancel();
        throw new ImportError(duplicate ? 'An avatar object already exists; overwrite refused.' : 'An avatar upload failed.', { existingObject: duplicate });
      }
      await response.body?.cancel();
    },
    async download(key) {
      validateObjectKey(key);
      const response = await call(objectUrl(key, true));
      if (!response.ok) { await response.body?.cancel(); refuse('An uploaded avatar could not be verified.'); }
      const reader = response.body?.getReader(), chunks = []; let size = 0;
      if (!reader) refuse('An uploaded avatar has no readable body.');
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); refuse('An uploaded avatar exceeds the private object size limit.'); }
          chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error instanceof ImportError ? error : new ImportError('An uploaded avatar body could not be verified.'); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { bytes, contentType: response.headers.get('Content-Type')?.split(';')[0].trim() };
    },
    async remove(keys) {
      if (!keys.length) return;
      keys.forEach(key => validateObjectKey(key));
      const response = await call(root + '/object/' + AVATAR_BUCKET, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: keys }) });
      if (!response.ok) { await response.body?.cancel(); refuse('Uploaded avatar cleanup was not acknowledged.'); }
      await response.body?.cancel();
    }
  };
}

// metadata must come from the trusted receiver configuration, after signature
// verification. Snapshot text remains private and is never included in errors.
export async function importPrivateSnapshot({ snapshotJson, metadata, db, bucket }) {
  if (typeof snapshotJson !== 'string' || !snapshotJson.isWellFormed() || new TextEncoder().encode(snapshotJson).byteLength > 32 * 1024 * 1024) refuse('The private snapshot must be valid text within the import size limit.');
  try {
    keys(metadata, ['migrationId', 'fromApiOrigin', 'toApiOrigin', 'pageBaseUrl', 'sourceSnapshotSha256'], 'metadata');
    hash(metadata.migrationId, 'migrationId'); hash(metadata.sourceSnapshotSha256, 'sourceSnapshotSha256');
    validateOrigin(metadata.fromApiOrigin); validateOrigin(metadata.toApiOrigin); validatePageBaseUrl(metadata.pageBaseUrl);
  } catch { refuse('The explicit migration metadata is invalid.'); }
  if (await sha256(snapshotJson) !== metadata.sourceSnapshotSha256) refuse('The private snapshot does not match its trusted source hash.');
  let snapshot, validated;
  try { snapshot = JSON.parse(snapshotJson); validated = await validateSnapshot(snapshot); }
  catch { refuse('The private snapshot failed complete version, row, relationship, or avatar validation.'); }
  if (snapshot.fromApiOrigin !== metadata.fromApiOrigin) refuse('The explicit source API origin does not match the snapshot.');
  const database = db?.unsafe ? createImportDatabase(db) : db;
  if (!database?.verifySchema || !database?.assertEmpty || !database?.transaction || !bucket?.assertPrivate || !bucket?.upload || !bucket?.download) refuse('Private database and Storage import adapters are required.');
  let committed = false; const created = [];
  try {
    await database.verifySchema(); await database.assertEmpty(); await bucket.assertPrivate();
    for (const avatar of validated.avatars.values()) {
      let reused = false;
      try { await bucket.upload(avatar.key, avatar.bytes, avatar.contentType); created.push(avatar.key); }
      catch (error) { if (!error?.existingObject) throw error; reused = true; }
      const restored = await bucket.download(avatar.key);
      if (restored.contentType !== avatar.contentType || restored.bytes.byteLength !== avatar.bytes.byteLength || await sha256(restored.bytes) !== avatar.sha256) refuse(reused ? 'An existing private avatar differs from the snapshot; overwrite refused.' : 'A staged avatar failed byte-for-byte verification.');
    }
    const receipt = { formatVersion: FORMAT_VERSION, appId: APP_ID, schemaVersion: SCHEMA_VERSION, ...metadata, credentialsPreserved: true, importedAt: new Date().toISOString(), tableCounts: validated.tableCounts, avatarCount: validated.avatarCount };
    await database.transaction(async transaction => {
      await transaction.assertEmpty();
      for (const table of TABLE_NAMES) await transaction.insertRows(table, snapshot.tables[table]);
      for (const table of TABLE_NAMES) {
        const expected = snapshot.tables[table].map(canonicalStringify).sort(), actual = (await transaction.readRows(table)).map(row => canonicalStringify(normalizedRow(table, row))).sort();
        if (expected.length !== actual.length || expected.some((row, index) => row !== actual[index])) refuse('Database rows do not exactly preserve the snapshot.');
      }
      await transaction.writeReceipt(receipt);
    });
    committed = true; return receipt;
  } catch (error) {
    // A Storage DELETE already in flight can outlive a failed import attempt.
    // Another isolate could then reuse the same object before
    // the old DELETE finishes. Never automatically delete failed stages;
    // private objects can be safely reused only after exact hash/type checks.
    const safe = error instanceof ImportError ? error : new ImportError('Import failed without publishing a verified migration receipt.');
    if (!committed && created.length) throw new ImportError(safe.message + ' Private staged objects were retained for safe retry or owner inspection.', { commitUncertain: safe.commitUncertain, storageUncertain: safe.storageUncertain, existingObject: safe.existingObject });
    throw safe;
  }
}
