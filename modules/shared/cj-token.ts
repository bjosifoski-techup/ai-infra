// Shared CJDropshipping access-token provider.
//
// Mirrors the Commerce API adapter (src/lib/storefront/cj.ts) that is verified
// returning products: `.cn` host, module-level token cache, 13-day cap.
//
// Note on Zuplo Workers: a module-level cache lives only as long as the worker
// isolate. An isolate may be recycled, so this can re-auth occasionally across
// cold isolates — acceptable, since CJ tokens last ~15 days and the throttle is
// only hit by sustained re-auth, not the odd cold start. (A durable cross-isolate
// store was tried but reverted to keep parity with the proven Commerce path.)

const CJ_AUTH_URL = "https://developers.cjdropshipping.cn/api2.0/v1/authentication/getAccessToken";
// CJ access token real expiry ~15 days; cap the cache at 13 for a safety margin.
const MAX_TTL_MS = 13 * 24 * 60 * 60 * 1000;

let _token: string | null = null;
let _expiry = 0; // unix ms

/**
 * Return a CJ access token, served from the in-process cache when valid.
 * Only calls CJ's throttled getAccessToken endpoint on a cache miss.
 */
export async function getCJToken(apiKey: string): Promise<string> {
  // Serve cached token; expire 1 h early for safety.
  if (_token && Date.now() < _expiry - 3_600_000) return _token;

  const res = await fetch(CJ_AUTH_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ apiKey }),
    signal:  AbortSignal.timeout(10_000),
  });

  const body = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`CJ auth HTTP ${res.status}: ${body}`);

  let data: any;
  try { data = JSON.parse(body); } catch { throw new Error(`CJ auth non-JSON response: ${body.slice(0, 200)}`); }

  // CJ returns result:true on success; false means the key was rejected.
  if (!data.result || !data.data?.accessToken) {
    throw new Error(`CJ auth rejected: ${data.message ?? JSON.stringify(data).slice(0, 200)}`);
  }

  _token = data.data.accessToken as string;
  const serverExpiry = data.data.accessTokenExpiryDate
    ? new Date(data.data.accessTokenExpiryDate).getTime()
    : Number.POSITIVE_INFINITY;
  _expiry = Math.min(serverExpiry, Date.now() + MAX_TTL_MS);
  console.log(`[CJ] token refreshed (expiresAt=${data.data.accessTokenExpiryDate ?? "unknown"})`);
  return _token!;
}

/** Drop the cached token so the next getCJToken re-authenticates (after a 401). */
export function clearCJToken(): void {
  _token = null;
  _expiry = 0;
}
