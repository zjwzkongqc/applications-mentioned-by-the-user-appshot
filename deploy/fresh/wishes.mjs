// Fresh-app-only personal wishes. Values are motivational equivalents, never
// stored balances: edits and deletions of training records change the total.
const PAGES_ORIGIN = 'https://zjwzkongqc.github.io';
const ROOT = '/api/wishes';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const RATE_CENTS_PER_MINUTE = 250;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const encoder = new TextEncoder();

function problem(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function database(env) {
  if (!env.DB) problem('心愿暂时连不上，请稍后重试。', 503);
  return {
    one: (sql, ...values) => env.DB.prepare(sql).bind(...values).first(),
    all: async (sql, ...values) => (await env.DB.prepare(sql).bind(...values).all()).results
  };
}
async function account(request, q) {
  // Deliberately accepts only fresh-app header sessions. Cookies, invitation
  // links and legacy member tokens cannot select someone else's account.
  const token = request.headers.get('X-Tennis-Session');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) problem('请先登录自己的账号，再查看训练心愿。', 401);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)))].map(value => value.toString(16).padStart(2, '0')).join('');
  const identity = await q.one('SELECT a.id FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.session_hash=? AND s.expires_at>?', hash, Date.now());
  if (!identity) problem('登录已失效，请重新登录自己的账号。', 401);
  return identity.id;
}
async function bytes(request, limit) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) problem('提交的内容太大了，请缩小后重试。', 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) { await reader.cancel(); problem('提交的内容太大了，请缩小后重试。', 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function form(request, keys) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') problem('请使用心愿表单提交。', 415);
  const raw = await bytes(request, 20000); let value;
  try { value = JSON.parse(new TextDecoder().decode(raw)); } catch { problem('内容格式不正确，请重试。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) problem('请检查心愿内容后重试。');
  return value;
}
function nameInput(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 60) problem('请填写 1–60 个字的心愿名称。');
  return value.trim();
}
function targetInput(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000000) problem('心愿价格请填写 0.01–1,000,000 元。');
  return value;
}
function view(row) {
  return {
    id: row.id, name: row.name, targetCents: Number(row.target_cents),
    imageUrl: row.image_key ? `${ROOT}/${row.id}/image` : null,
    fulfilledAt: row.fulfilled_at, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
async function owned(q, accountId, id) {
  const wish = await q.one('SELECT * FROM training_wishes WHERE id=? AND account_id=?', id, accountId);
  if (!wish) problem('这个心愿不存在，或不属于当前账号。', 404);
  return wish;
}
function imageType(value) {
  if (value.length >= 12) {
    if (value[0] === 255 && value[1] === 216 && value[2] === 255) return 'image/jpeg';
    if (value.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10') return 'image/png';
    if (String.fromCharCode(...value.slice(0, 4)) === 'RIFF' && String.fromCharCode(...value.slice(8, 12)) === 'WEBP') return 'image/webp';
  }
  problem('图片支持 JPG、PNG 和 WebP，请重新选择。', 415);
}
async function cleanup(bucket, key) {
  // A successful database write must not be reported as failed only because
  // removal of a superseded private image needs retrying by maintenance.
  if (bucket && key) { try { await bucket.delete(key); } catch { /* No credentials or private paths in logs. */ } }
}
async function handle(request, env, path) {
  const origin = request.headers.get('Origin');
  if ((origin && origin !== PAGES_ORIGIN) || (request.headers.get('Sec-Fetch-Site') === 'cross-site' && origin !== PAGES_ORIGIN)) problem('请从网球小本本页面操作。', 403);
  if (request.method === 'OPTIONS') {
    const method = request.headers.get('Access-Control-Request-Method');
    const headers = (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (origin !== PAGES_ORIGIN || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method) || headers.some(value => !['authorization', 'content-type', 'x-tennis-session'].includes(value))) problem('请求方式无效。', 403);
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Tennis-Session',
      'Access-Control-Max-Age': '600'
    } });
  }
  const q = database(env), accountId = await account(request, q);
  if (path === ROOT) {
    if (request.method === 'GET') {
      // A record belongs to one member. Joining by both IDs retains that grain
      // across groups and excludes check-ins that have no recorded duration.
      const summary = await q.one('SELECT COALESCE(SUM(r.minutes),0) AS total_minutes FROM records r JOIN members m ON m.id=r.member_id AND m.club_id=r.club_id WHERE m.account_id=?', accountId);
      const totalMinutes = Number(summary.total_minutes), totalValueCents = totalMinutes * RATE_CENTS_PER_MINUTE;
      if (!Number.isSafeInteger(totalMinutes) || totalMinutes < 0 || !Number.isSafeInteger(totalValueCents)) problem('训练时长暂时无法计算，请稍后重试。', 503);
      const wishes = await q.all('SELECT * FROM training_wishes WHERE account_id=? ORDER BY created_at DESC,id', accountId);
      return json({ rateCentsPerHour: 15000, totalMinutes, totalValueCents, wishes: wishes.map(view) });
    }
    if (request.method === 'POST') {
      const input = await form(request, ['id', 'name', 'targetCents']);
      if (typeof input.id !== 'string' || !UUID.test(input.id)) problem('心愿编号无效，请重新打开表单。');
      const name = nameInput(input.name), target = targetInput(input.targetCents), now = new Date().toISOString();
      // The browser keeps its generated id across a network retry. A replay
      // cannot duplicate the wish or overwrite someone else's existing id.
      const inserted = await q.one('INSERT INTO training_wishes(id,account_id,name,target_cents,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING *', input.id, accountId, name, target, now, now);
      if (inserted) return json({ wish: view(inserted) }, 201);
      const existing = await q.one('SELECT * FROM training_wishes WHERE id=? AND account_id=?', input.id, accountId);
      if (!existing || existing.name !== name || Number(existing.target_cents) !== target) problem('心愿内容已变化，请刷新后重试。', 409);
      return json({ wish: view(existing) });
    }
    problem('请求方式无效。', 405);
  }
  const match = path.slice(ROOT.length + 1).split('/');
  if (match.length > 2 || !UUID.test(match[0]) || (match.length === 2 && match[1] !== 'image')) problem('页面不存在。', 404);
  const id = match[0], image = match.length === 2;
  if (image) {
    const existing = await owned(q, accountId, id);
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) problem('请求方式无效。', 405);
    if (!env.BUCKET) problem('心愿图片暂时无法使用，请稍后重试。', 503);
    if (request.method === 'GET') {
      if (!existing.image_key) problem('心愿还没有图片。', 404);
      const file = await env.BUCKET.get(existing.image_key);
      if (!file) problem('图片暂时不存在，请重新上传。', 404);
      const contentType = file.httpMetadata?.contentType;
      if (!IMAGE_TYPES.has(contentType)) problem('图片暂时无法加载。', 503);
      return new Response(file.body, { headers: { 'Content-Type': contentType } });
    }
    const now = new Date().toISOString();
    if (request.method === 'POST') {
      const data = await bytes(request, IMAGE_LIMIT), contentType = imageType(data);
      const key = `wishes/${accountId}/${id}/${crypto.randomUUID()}`;
      await env.BUCKET.put(key, data, { httpMetadata: { contentType } });
      let saved;
      try {
        // Compare the previous image key so overlapping uploads cannot orphan
        // the losing upload or delete the winning request's image.
        saved = await q.one('UPDATE training_wishes SET image_key=?,updated_at=? WHERE id=? AND account_id=? AND (image_key=? OR (image_key IS NULL AND ? IS NULL)) RETURNING *', key, now, id, accountId, existing.image_key, existing.image_key);
        if (!saved) problem('图片已在另一处更新，请刷新后重试。', 409);
      } catch (error) { await cleanup(env.BUCKET, key); throw error; }
      await cleanup(env.BUCKET, existing.image_key);
      return json({ wish: view(saved) });
    }
    const saved = await q.one('UPDATE training_wishes SET image_key=NULL,updated_at=? WHERE id=? AND account_id=? AND (image_key=? OR (image_key IS NULL AND ? IS NULL)) RETURNING *', now, id, accountId, existing.image_key, existing.image_key);
    if (!saved) problem('图片已在另一处更新，请刷新后重试。', 409);
    await cleanup(env.BUCKET, existing.image_key);
    return json({ wish: view(saved) });
  }
  if (request.method === 'PATCH') {
    const input = await form(request, ['name', 'targetCents', 'fulfilled']);
    if (!Object.keys(input).length) problem('请填写要更新的心愿内容。');
    const updates = [], values = [], now = new Date().toISOString();
    if (Object.hasOwn(input, 'name')) { updates.push('name=?'); values.push(nameInput(input.name)); }
    if (Object.hasOwn(input, 'targetCents')) { updates.push('target_cents=?'); values.push(targetInput(input.targetCents)); }
    if (Object.hasOwn(input, 'fulfilled')) {
      if (typeof input.fulfilled !== 'boolean') problem('请选择有效的心愿状态。');
      if (input.fulfilled) { updates.push('fulfilled_at=COALESCE(fulfilled_at,?)'); values.push(now); }
      else updates.push('fulfilled_at=NULL');
    }
    updates.push('updated_at=?'); values.push(now, id, accountId);
    const saved = await q.one(`UPDATE training_wishes SET ${updates.join(',')} WHERE id=? AND account_id=? RETURNING *`, ...values);
    if (!saved) problem('这个心愿不存在，或不属于当前账号。', 404);
    return json({ wish: view(saved) });
  }
  if (request.method === 'DELETE') {
    // RETURNING captures the actual current image even if an upload completed
    // between the request starting and this atomic deletion.
    const removed = await q.one('DELETE FROM training_wishes WHERE id=? AND account_id=? RETURNING image_key', id, accountId);
    if (!removed) problem('这个心愿不存在，或不属于当前账号。', 404);
    await cleanup(env.BUCKET, removed.image_key);
    return json({ ok: true });
  }
  problem('请求方式无效。', 405);
}

export async function handleWishes(request, env) {
  const path = new URL(request.url).pathname;
  if (path !== ROOT && !path.startsWith(ROOT + '/')) return null;
  let response;
  try { response = await handle(request, env, path); }
  catch (error) { response = json({ error: error?.status ? error.message : '心愿暂时连不上，请稍后重试。' }, error?.status || 503); }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Vary', 'Origin');
  if (request.headers.get('Origin') === PAGES_ORIGIN) headers.set('Access-Control-Allow-Origin', PAGES_ORIGIN);
  return new Response(response.body, { status: response.status, headers });
}
