// Shared CJDropshipping access-token provider.
//
// CJ throttles the getAccessToken endpoint hard (~1 call / 5 min per account),
// so re-authing on every request returns 429. A module-level variable does NOT
// help on Zuplo's Cloudflare Workers — each isolate is ephemeral, so the cache
// almost never survives to the next request and we re-auth on nearly every call.
//
// ZoneCache persists the token across requests/isolates within a colo, so
// getAccessToken runs roughly once per token lifetime instead of once per
// request. This is what stops the 429s.

import { ZoneCache, ZuploContext } from "@zuplo/runtime";

const CJ_AUTH_URL = "https://developers.cjdropshipping.cn/api2.0/v1/authentication/getAccessToken";
const CACHE_NAME  = "cj-token";
const CACHE_KEY   = "access-token";
// CJ access token real expiry ~15 days; cache 13 days for a safety margin.
const CACHE_TTL_SECONDS = 13 * 24 * 60 * 60;

/**
 * Return a CJ access token, served from ZoneCache when present. Only calls
 * CJ's throttled getAccessToken endpoint on a cache miss (cold start or after
 * the cached token expires / is cleared).
 */
export async function getCJToken(apiKey: string, context: ZuploContext): Promise<string> {
  const cache = new ZoneCache<string>(CACHE_NAME, context);

  const cached = await cache.get(CACHE_KEY);
  if (cached) return cached;

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

  const token = data.data.accessToken as string;
  await cache.put(CACHE_KEY, token, CACHE_TTL_SECONDS);
  console.log(`[CJ] token refreshed & cached ${CACHE_TTL_SECONDS / 86400}d (expiresAt=${data.data.accessTokenExpiryDate ?? "unknown"})`);
  return token;
}

/**
 * Drop the cached token so the next getCJToken re-authenticates. Call this
 * after a 401 from a product call (token invalidated server-side).
 */
export async function clearCJToken(context: ZuploContext): Promise<void> {
  const cache = new ZoneCache<string>(CACHE_NAME, context);
  await cache.delete(CACHE_KEY);
}
