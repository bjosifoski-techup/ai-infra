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

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
import { getenv } from "./shared/env.js";

const DEFAULT_BASE = "https://sandbox-en-us.kayakaffiliates.com";
const DEFAULT_UA   = "kayakaffiliateapp";
const POLL_MAX     = 5;
const POLL_DELAY_MS = 1200;
const MAX_CARDS    = 10;

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

// ─── Flights ───────────────────────────────────────────────────────────────

export async function flightsHandler(
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  const apiKey = getenv("KAYAK_API_KEY");
  if (!apiKey) return errorResponse("Kayak credentials not configured", 503);

  let body: {
    origin: string; destination: string; departureDate: string;
    returnDate?: string; adults?: number; cabin?: string; currency?: string;
  };
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  if (!body.origin || !body.destination || !body.departureDate) {
    return errorResponse("origin, destination and departureDate are required", 400);
  }

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
  if (!res.ok) return errorResponse(`Kayak flights start error: ${res.status} — ${startText.slice(0, 200)}`, 502);

  let data: any;
  try { data = JSON.parse(startText); } catch { return errorResponse("Kayak flights returned non-JSON", 502); }

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

  const response: ToolResponse<AffiliateCard> = {
    results,
    total: data.totalCount ?? results.length,
    source: "kayak-flights",
  };
  return jsonResponse(response);
}

// ─── Hotels ────────────────────────────────────────────────────────────────

export async function hotelsHandler(
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  const apiKey = getenv("KAYAK_API_KEY");
  if (!apiKey) return errorResponse("Kayak credentials not configured", 503);

  let body: {
    destination: string; checkIn: string; checkOut: string;
    guests?: number; currency?: string;
  };
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  if (!body.destination || !body.checkIn || !body.checkOut) {
    return errorResponse("destination, checkIn and checkOut are required", 400);
  }

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
    if (!acRes.ok) return errorResponse(`Kayak hotels autocomplete error: ${acRes.status}`, 502);
    const ac = await acRes.json().catch(() => ({} as any));
    const first = ac.results?.[0];
    if (!first?.entityKey) {
      return jsonResponse({ results: [], total: 0, source: "kayak-hotels" });
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
    if (!res.ok) return errorResponse(`Kayak hotels error: ${res.status} — ${text.slice(0, 200)}`, 502);
    try { data = JSON.parse(text); } catch { return errorResponse("Kayak hotels returned non-JSON", 502); }
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

  const response: ToolResponse<AffiliateCard> = {
    results,
    total: data.totalResults ?? results.length,
    source: "kayak-hotels",
  };
  return jsonResponse(response);
}
