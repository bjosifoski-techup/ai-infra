// Kayak Affiliate Network — flight & hotel search.
//
// Flights: POST {base}/i/api/affiliate/search/flight/v1/poll  (async, two-phase poll)
// Hotels:  GET  {base}/api/3.0/hotels                          (async, poll until isComplete)
//          + GET {base}/api/affiliate/autocomplete/v1/hotels   (resolve place name -> entityKey)
//
// Required env vars: KAYAK_API_KEY
// Optional env vars: KAYAK_BASE_URL   (default: sandbox host below)
//                    KAYAK_USER_AGENT (default: "kayakaffiliateapp")
//
// Auth: `apiKey` is a QUERY parameter (not a header). Every call also requires:
//   - a valid `User-Agent` header — MUST be "kayakaffiliateapp" (or an approved
//     browser UA); anything else returns 400 INVALID_USER_AGENT.
//   - `x-original-client-ip` header — the end user's IP (forwarded by the caller).
//   - `userTrackId` query param — a UUID, unique per user/session.
//
// Both search APIs are asynchronous: the first call kicks off the search and we
// poll until it reports completion (flights: `status === "complete"`, hotels:
// `isComplete === true`). Sandbox deep-links/images are placeholders; they
// resolve to real monetized links in production.
//
// Public API for this module:
//   - searchFlights(body, request) / searchHotels(body, request):
//       Callable cores. Return ToolResponse<AffiliateCard> on success,
//       throw on failure. Used by the merged handler in ./travel-merged.ts.
//   - flightsHandler / hotelsHandler:
//       Thin route wrappers — parse body, delegate to core, translate
//       thrown errors to errorResponse. Registered directly in
//       config/routes.oas.json for the /travel/kayak/... URLs.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
import { getenv } from "./shared/env.js";

const DEFAULT_BASE = "https://sandbox-en-us.kayakaffiliates.com";
const DEFAULT_UA   = "kayakaffiliateapp";
const POLL_MAX     = 5;
const POLL_DELAY_MS = 1200;
const MAX_CARDS    = 10;

export interface KayakFlightInput {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults?: number;
  cabin?: string;
  currency?: string;
}

export interface KayakHotelInput {
  destination: string;
  checkIn: string;
  checkOut: string;
  guests?: number;
  currency?: string;
}

function baseUrl(): string {
  return (getenv("KAYAK_BASE_URL") ?? DEFAULT_BASE).replace(/\/+$/, "");
}

// Kayak requires the end user's IP. The caller (App edge route) should forward it;
// fall back to a documented placeholder so sandbox calls still succeed.
function clientIp(request: ZuploRequest): string {
  const fwd = request.headers.get("x-original-client-ip")
    ?? request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "203.0.113.10";
}

function baseHeaders(request: ZuploRequest): Record<string, string> {
  return {
    "User-Agent": getenv("KAYAK_USER_AGENT") ?? DEFAULT_UA,
    "x-original-client-ip": clientIp(request),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// On a non-OK Kayak response, dump status + body + ALL response headers to the
// Zuplo log. For 403s the headers are the useful part — they reveal whether a
// WAF / bot-detection layer (and which one) rejected the egress IP, since the
// 403 body itself comes back empty.
function logKayakFailure(label: string, res: Response, body: string): void {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  console.error(
    `[Kayak] ${label} HTTP ${res.status} ${res.statusText} — body=${(body || "").slice(0, 300)} — headers=${JSON.stringify(headers)}`,
  );
}

// ─── Cores ─────────────────────────────────────────────────────────────────
// Both cores throw on any failure that would previously have produced a 502/503,
// so they compose cleanly with Promise.allSettled in the merged handler.

export async function searchFlights(
  body: KayakFlightInput,
  request: ZuploRequest,
): Promise<ToolResponse<AffiliateCard>> {
  const apiKey = getenv("KAYAK_API_KEY");
  if (!apiKey) throw new Error("Kayak credentials not configured");

  const origin      = body.origin.trim().toUpperCase();
  const destination = body.destination.trim().toUpperCase();
  const adults      = Math.min(9, Math.max(1, Number(body.adults ?? 1)));
  const cabin       = (body.cabin ?? "economy").toLowerCase();
  const userTrackId = crypto.randomUUID();

  const legs: any[] = [{
    origin:      { locationType: "airports", airports: [origin] },
    destination: { locationType: "airports", airports: [destination] },
    date: body.departureDate, flex: "exact",
  }];
  if (body.returnDate) {
    legs.push({
      origin:      { locationType: "airports", airports: [destination] },
      destination: { locationType: "airports", airports: [origin] },
      date: body.returnDate, flex: "exact",
    });
  }
  const passengers = Array(adults).fill("ADT");

  const pollUrl = `${baseUrl()}/i/api/affiliate/search/flight/v1/poll`
    + `?apiKey=${encodeURIComponent(apiKey)}&userTrackId=${userTrackId}`;
  const headers = { ...baseHeaders(request), "Content-Type": "application/json" };

  // Start the search.
  let res = await fetch(pollUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ searchStartParameters: { cabin, passengers, legs } }),
    signal: AbortSignal.timeout(15_000),
  });
  const startText = await res.text().catch(() => "");
  if (!res.ok) {
    logKayakFailure("flights start", res, startText);
    throw new Error(`Kayak flights start error: ${res.status} ${res.statusText} — ${(startText || "").slice(0, 200)}`);
  }

  let data: any;
  try { data = JSON.parse(startText); } catch { throw new Error("Kayak flights returned non-JSON"); }

  const searchId = data.searchId;
  const cluster  = data.cluster;

  // Poll until the search completes (or we run out of attempts).
  for (let i = 0; i < POLL_MAX && data.status !== "complete"; i++) {
    await sleep(POLL_DELAY_MS);
    res = await fetch(`${pollUrl}&cluster=${encodeURIComponent(String(cluster))}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ searchId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) break;
    data = await res.json().catch(() => data);
  }

  const currency = data.currency ?? body.currency ?? "USD";
  const tripType = body.returnDate ? "Return" : "One-way";

  const results: AffiliateCard[] = (data.results ?? [])
    .slice(0, MAX_CARDS)
    .map((r: any): AffiliateCard => {
      const bo = r.bookingOptions?.[0] ?? {};
      const price = bo.displayPrice?.displayPrice
        ?? (bo.displayPrice?.price != null ? `${bo.displayPrice.price} ${currency}` : "");
      return {
        kind: "affiliate",
        provider: "flights",
        title: `${origin} → ${destination}`
          + (bo.providerCode ? ` · ${bo.providerCode}` : "")
          + (price ? ` · ${price}` : ""),
        dateOrVenue: `${body.departureDate}${body.returnDate ? ` – ${body.returnDate}` : ""} · ${tripType}`,
        deepLinkUrl: bo.bookingUrl ?? "",
      };
    })
    .filter((c: AffiliateCard) => c.deepLinkUrl);

  return {
    results,
    total: data.totalCount ?? results.length,
    source: "kayak-flights",
  };
}

export async function searchHotels(
  body: KayakHotelInput,
  request: ZuploRequest,
): Promise<ToolResponse<AffiliateCard>> {
  const apiKey = getenv("KAYAK_API_KEY");
  if (!apiKey) throw new Error("Kayak credentials not configured");

  const headers     = baseHeaders(request);
  const currency    = body.currency ?? "USD";
  const guests      = Math.min(30, Math.max(1, Number(body.guests ?? 2)));
  const userTrackId = crypto.randomUUID();

  // Resolve a plain place name to an EntityKey (e.g. "Boston" -> "kplace:58075").
  // Entity keys (kplace:/khotel:/klatlon:/kpolygon:) are passed through as-is.
  let destinationKey = body.destination.trim();
  let placeName      = destinationKey;
  if (!/^k(place|hotel|latlon|polygon):/i.test(destinationKey)) {
    const acUrl = `${baseUrl()}/api/affiliate/autocomplete/v1/hotels`
      + `?apiKey=${encodeURIComponent(apiKey)}&searchTerm=${encodeURIComponent(destinationKey)}`;
    const acRes = await fetch(acUrl, { headers, signal: AbortSignal.timeout(10_000) });
    if (!acRes.ok) {
      const acBody = await acRes.text().catch(() => "");
      logKayakFailure("hotels autocomplete", acRes, acBody);
      throw new Error(`Kayak hotels autocomplete error: ${acRes.status} ${acRes.statusText} — ${(acBody || "").slice(0, 200)}`);
    }
    const ac = await acRes.json().catch(() => ({} as any));
    const first = ac.results?.[0];
    // No autocomplete match is a legitimate empty result, not a failure.
    if (!first?.entityKey) {
      return { results: [], total: 0, source: "kayak-hotels" };
    }
    destinationKey = first.entityKey;
    placeName = first.name ?? placeName;
  }

  const params = new URLSearchParams({
    apiKey,
    userTrackId,
    destination: destinationKey,
    checkin: body.checkIn,
    checkout: body.checkOut,
    rooms: String(guests),
    currencyCode: currency,
    onlyIfComplete: "false",
    responseOptions: "topRates,images",
    pageSize: String(MAX_CARDS),
  });
  const url = `${baseUrl()}/api/3.0/hotels?${params.toString()}`;

  // Poll until the search reports completion.
  let data: any = {};
  for (let i = 0; i < POLL_MAX; i++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      logKayakFailure("hotels search", res, text);
      throw new Error(`Kayak hotels error: ${res.status} ${res.statusText} — ${(text || "").slice(0, 200)}`);
    }
    try { data = JSON.parse(text); } catch { throw new Error("Kayak hotels returned non-JSON"); }
    if (data.isComplete) break;
    await sleep(POLL_DELAY_MS);
  }

  const cur = data.currencyCode ?? currency;

  const results: AffiliateCard[] = (data.results ?? [])
    .slice(0, MAX_CARDS)
    .map((h: any): AffiliateCard => {
      const rate = h.lowestRate != null ? `${h.lowestRate} ${cur}` : "";
      // Prefer the provider booking deep-link; fall back to the hotel's Kayak page.
      const deepLink = h.rates?.[0]?.bookUri ?? h.href ?? "";
      return {
        kind: "affiliate",
        provider: "hotels",
        title: `${h.name ?? "Hotel"}`
          + (h.starRating ? ` · ${h.starRating}★` : "")
          + (rate ? ` · ${rate}` : ""),
        dateOrVenue: `${placeName} · ${body.checkIn} – ${body.checkOut}`,
        imageUrl: h.images?.[0]?.large,
        deepLinkUrl: deepLink,
      };
    })
    .filter((c: AffiliateCard) => c.deepLinkUrl);

  return {
    results,
    total: data.totalResults ?? results.length,
    source: "kayak-hotels",
  };
}

// ─── Route wrappers ────────────────────────────────────────────────────────
// Thin: parse body, delegate to core, translate throws into errorResponse.
// A "credentials not configured" thrown message maps back to 503 to preserve
// the pre-refactor behaviour when Kayak env vars are missing.

function errorStatusFor(msg: string): number {
  return /credentials not configured/i.test(msg) ? 503 : 502;
}

export async function flightsHandler(
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  let body: KayakFlightInput;
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  if (!body.origin || !body.destination || !body.departureDate) {
    return errorResponse("origin, destination and departureDate are required", 400);
  }

  try {
    return jsonResponse(await searchFlights(body, request));
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return errorResponse(msg, errorStatusFor(msg));
  }
}

export async function hotelsHandler(
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  let body: KayakHotelInput;
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  if (!body.destination || !body.checkIn || !body.checkOut) {
    return errorResponse("destination, checkIn and checkOut are required", 400);
  }

  try {
    return jsonResponse(await searchHotels(body, request));
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return errorResponse(msg, errorStatusFor(msg));
  }
}
