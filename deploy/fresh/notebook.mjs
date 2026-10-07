// Fresh-only, reversible notebook archive. The archived data, identities,
// private wishes and historical training totals stay in their existing tables.
// This guard restricts routes; it never creates membership or changes a row.
import { ACTIVE_NOTEBOOK } from './settings.mjs';
export const ACTIVE_NOTEBOOK_ID = ACTIVE_NOTEBOOK.id;
export const ACTIVE_NOTEBOOK_NAME = ACTIVE_NOTEBOOK.name;
export const NOTEBOOK_POLICY_VERSION = 'single-notebook-v1';

const PAGES_ORIGIN = 'https://zjwzkongqc.github.io';
const encoder = new TextEncoder();
const archived = '这本记录本已归档，原来的资料与训练记录仍然保留。请返回首页，继续使用现有记录本。';

function json(request, data, status) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Origin'
  };
  if (request.headers.get('Origin') === PAGES_ORIGIN) headers['Access-Control-Allow-Origin'] = PAGES_ORIGIN;
  return new Response(JSON.stringify(data), { status, headers });
}

function contextual(path) {
  if (!path.startsWith('/api/')) return false;
  if (path === '/api/auth/register' || path === '/api/auth/bind') return true;
  return !path.startsWith('/api/auth/') && !path.startsWith('/api/public/')
    && path !== '/api/wishes' && !path.startsWith('/api/wishes/');
}

async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function createNotebookPolicy({ activeClubId = ACTIVE_NOTEBOOK_ID } = {}) {
  if (typeof activeClubId !== 'string' || !/^[a-f0-9-]{36}$/.test(activeClubId)) throw new TypeError('Invalid active notebook ID.');
  const rejectArchived = request => json(request, { error: archived, code: 'NOTEBOOK_ARCHIVED' }, 410);
  return {
    async before(request, env) {
      const url = new URL(request.url), path = url.pathname;
      // Let the existing worker validate and answer CORS preflights.
      if (request.method === 'OPTIONS') return null;
      if (path === '/api/clubs' && request.method === 'POST') {
        return json(request, { error: '目前只使用一本记录本，不再创建新的记录本。', code: 'NOTEBOOK_CREATION_DISABLED' }, 403);
      }
      if (!contextual(path)) return null;
      // Do not substitute the active notebook: its existing authorization and
      // invitation checks must still decide whether this visitor can enter.
      // Reject mixed targets too, even though the worker prioritizes invites.
      if (url.searchParams.has('club') && url.searchParams.getAll('club').some(id => id !== activeClubId)) return rejectArchived(request);
      const invite = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!invite) return null;
      try {
        const hash = await digest(invite);
        const original = await env.DB.prepare('SELECT id FROM clubs WHERE invite_hash=?').bind(hash).first();
        const club = original || await env.DB.prepare('SELECT club_id AS id FROM club_invites WHERE invite_hash=?').bind(hash).first();
        // Look up revoked/expired links as well, so an archived link explains
        // the archive. Unknown/invalid active links retain the worker's errors.
        return club && club.id !== activeClubId ? rejectArchived(request) : null;
      } catch {
        // A failed policy lookup must never fall through to a less restricted
        // request, and must not disclose database errors or invitation hashes.
        return json(request, { error: '记录本暂时连不上，请稍后重试。' }, 503);
      }
    },

    async after(request, response) {
      const path = new URL(request.url).pathname;
      const key = path === '/api/auth/me' && request.method === 'GET' ? 'clubs'
        : path === '/api/auth/register' && request.method === 'POST' ? 'legacyClubs' : null;
      if (!key || !response.ok || !response.headers.get('Content-Type')?.includes('application/json')) return response;
      const data = await response.clone().json();
      if (!Array.isArray(data[key])) return response;
      const filtered = data[key].filter(club => club.id === activeClubId);
      if (filtered.length === data[key].length) return response;
      const headers = new Headers(response.headers);
      headers.delete('Content-Length');
      headers.delete('ETag');
      headers.set('Cache-Control', 'no-store');
      return new Response(JSON.stringify({ ...data, [key]: filtered }), { status: response.status, statusText: response.statusText, headers });
    }
  };
}
