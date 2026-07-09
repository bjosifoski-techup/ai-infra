// Travelpayouts flight and hotel search.
// Flights: Aviasales API v3  https://api.travelpayouts.com/aviasales/v3
// Hotels:  Hotellook API     https://engine.hotellook.com/api/v2
//
// Required env vars: TRAVELPAYOUTS_API_TOKEN, TRAVELPAYOUTS_MARKER
//
// Public API for this module:
//   - searchFlights(body) / searchHotels(body):
//       Callable cores. Return ToolResponse<AffiliateCard> on success,
//       throw on failure. Used by the merged handler in ./travel-merged.ts.
//   - flightsHandler / hotelsHandler:
//       Thin route wrappers — parse body, delegate to core, translate
//       thrown errors to errorResponse. Registered directly in
//       config/routes.oas.json.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
import { tagTravelpayoutsUrl } from "./shared/affiliate.js";
import { getenv } from "./shared/env.js";

const FLIGHTS_BASE = "https://api.travelpayouts.com/aviasales/v3";
const HOTELS_BASE = "https://engine.hotellook.com/api/v2";

export interface TravelpayoutsFlightInput {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults?: number;
  currency?: string;
}

export interface TravelpayoutsHotelInput {
  destination: string;
  checkIn: string;
  checkOut: string;
  guests?: number;
  currency?: string;
}

// ─── Cores ─────────────────────────────────────────────────────────────────
// Both cores throw on any failure that would previously have produced a 502/503,
// so they compose cleanly with Promise.allSettled in the merged handler.
// The IATA-code sanity check is here (not in the wrapper) so a merged call with
// city names causes just Travelpayouts to reject — Kayak (which also expects
// IATA) will still make its own attempt.

export async function searchFlights(
  body: TravelpayoutsFlightInput,
): Promise<ToolResponse<AffiliateCard>> {
  const apiToken = getenv("TRAVELPAYOUTS_API_TOKEN");
  if (!apiToken) throw new Error("Travelpayouts credentials not configured");

  const origin      = body.origin.trim().toUpperCase();
  const destination = body.destination.trim().toUpperCase();
  if (origin.length > 4 || destination.length > 4) {
    throw new Error(
      `origin and destination must be IATA airport codes (e.g. JFK, CDG), got: "${body.origin}", "${body.destination}"`,
    );
  }

  const url = new URL(`${FLIGHTS_BASE}/prices_for_dates`);
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("token", apiToken);
  url.searchParams.set("departure_at", body.departureDate);
  if (body.returnDate) {
    url.searchParams.set("return_at", body.returnDate);
  } else {
    url.searchParams.set("one_way", "true");
  }
  url.searchParams.set("currency", body.currency ?? "USD");
  url.searchParams.set("limit", "10");
  url.searchParams.set("sorting", "price");
  url.searchParams.set("unique", "false");

  const res = await fetch(url.toString(), {
    headers: { "x-access-token": apiToken },
    signal: AbortSignal.timeout(15_000),
  });

  const resText = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`Travelpayouts flights API error: ${res.status} — ${resText.slice(0, 200)}`);
  }

  let data: any;
  try { data = JSON.parse(resText); } catch { data = {}; }

  const flights: any[] = data?.data ?? [];
  if (flights.length === 0) {
    console.warn(`[flights] empty results for ${origin}→${destination} on ${body.departureDate}. success=${data?.success} raw=${resText.slice(0, 300)}`);
  }

  // Aviasales slug date format: DDMM (day-then-month, zero-padded), e.g. 23 July → "2307"
  function aviasalesDate(iso: string): string {
    const [, , mm, dd] = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? [];
    return `${dd ?? "01"}${mm ?? "01"}`;
  }

  const depSlug = aviasalesDate(body.departureDate);
  const retSlug = body.returnDate ? aviasalesDate(body.returnDate) : "";

  const results: AffiliateCard[] = flights.map((f: any) => {
    const rawUrl = body.returnDate
      ? `https://www.aviasales.com/search/${origin}${depSlug}${destination}${retSlug}1`
      : `https://www.aviasales.com/search/${origin}${depSlug}${destination}1`;
    const dateStr = f.departure_at ?? body.departureDate;
    const tripType = body.returnDate ? "Return" : "One-way";

    return {
      kind: "affiliate",
      provider: "flights",
      title: `${origin} → ${destination}${f.airline ? ` · ${f.airline}` : ""}`,
      dateOrVenue: `${dateStr}${body.returnDate ? ` – ${body.returnDate}` : ""} · ${tripType}`,
      deepLinkUrl: tagTravelpayoutsUrl(rawUrl),
    };
  });

  return {
    results,
    total: results.length,
    source: "travelpayouts-flights",
  };
}

export async function searchHotels(
  body: TravelpayoutsHotelInput,
): Promise<ToolResponse<AffiliateCard>> {
  const apiToken = getenv("TRAVELPAYOUTS_API_TOKEN");
  const marker = getenv("TRAVELPAYOUTS_MARKER") ?? "";

  if (!apiToken) throw new Error("Travelpayouts credentials not configured");

  const url = new URL(`${HOTELS_BASE}/cache.json`);
  url.searchParams.set("location", body.destination);
  url.searchParams.set("checkIn", body.checkIn);
  url.searchParams.set("checkOut", body.checkOut);
  url.searchParams.set("adults", String(body.guests ?? 2));
  url.searchParams.set("currency", body.currency ?? "USD");
  url.searchParams.set("limit", "10");
  url.searchParams.set("token", apiToken);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Travelpayouts hotels API error: ${res.status} — ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const hotels: any[] = Array.isArray(data) ? data : (data?.results ?? []);

  const results: AffiliateCard[] = hotels.map((h: any) => {
    const rawUrl = `https://www.hotellook.com/hotels?destination=${encodeURIComponent(body.destination)}&checkIn=${body.checkIn}&checkOut=${body.checkOut}&marker=${marker}`;

    return {
      kind: "affiliate",
      provider: "hotels",
      title: h.hotelName ?? h.name ?? "",
      dateOrVenue: `${body.destination} · ${body.checkIn} – ${body.checkOut}`,
      imageUrl: h.photos?.[0]?.url,
      deepLinkUrl: tagTravelpayoutsUrl(rawUrl),
    };
  });

  return {
    results,
    total: results.length,
    source: "travelpayouts-hotels",
  };
}

// ─── Route wrappers ────────────────────────────────────────────────────────
// Thin: parse body, delegate to core, translate throws into errorResponse.
// - "credentials not configured" → 503 (preserve pre-refactor behaviour)
// - IATA-code sanity check → 400 (was a 400 in the old handler too)
// - anything else → 502

function errorStatusFor(msg: string): number {
  if (/credentials not configured/i.test(msg)) return 503;
  if (/must be IATA airport codes/i.test(msg))  return 400;
  return 502;
}

export async function flightsHandler(
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  let body: TravelpayoutsFlightInput;
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  if (!body.origin || !body.destination || !body.departureDate) {
    return errorResponse("origin, destination and departureDate are required", 400);
  }

  try {
    return jsonResponse(await searchFlights(body));
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return errorResponse(msg, errorStatusFor(msg));
  }
}

export async function hotelsHandler(
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  let body: TravelpayoutsHotelInput;
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  if (!body.destination || !body.checkIn || !body.checkOut) {
    return errorResponse("destination, checkIn and checkOut are required", 400);
  }

  try {
    return jsonResponse(await searchHotels(body));
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return errorResponse(msg, errorStatusFor(msg));
  }
}
