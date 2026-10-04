// Restore the external prefix stripped by the Supabase gateway.
// Keep signed migration paths intact; do not trust forwarded hosts.
export function canonicalRequest(request, publicOrigin) {
  const url = new URL(request.url);
  const externalPrefix = '/functions/v1/tennis-api';
  const runtimePrefix = '/tennis-api';
  let pathname = url.pathname;
  if (pathname === runtimePrefix || pathname.startsWith(runtimePrefix + '/')) {
    pathname = '/functions/v1' + pathname;
  } else if (pathname !== externalPrefix && !pathname.startsWith(externalPrefix + '/')) {
    return null;
  }
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || !/^[a-z0-9]{20}\.supabase\.co$/.test(origin.hostname)) throw new Error('Invalid public origin.');
  return new Request(publicOrigin + pathname + url.search, request);
}
