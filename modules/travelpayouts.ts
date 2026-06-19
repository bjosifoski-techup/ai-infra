// Travelpayouts flight and hotel search.
// Flights: Aviasales API v3  https://api.travelpayouts.com/aviasales/v3
// Hotels:  Hotellook API     https://engine.hotellook.com/api/v2
//
// Required env vars: TRAVELPAYOUTS_API_TOKEN, TRAVELPAYOUTS_MARKER
//
// This module exports two handlers: flightsHandler and hotelsHandler.
// Each is registered as a separate route in routes.oas.json.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
import { tagTravelpayoutsUrl } from "./shared/affiliate.js";
import { getenv } from "./shared/env.js";

const FLIGHTS_BASE = "https://api.travelpayouts.com/aviasales/v3";
const HOTELS_BASE = "https://engine.hotellook.com/api/v2";

export async function flightsHandler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiToken = getenv("TRAVELPAYOUTS_API_TOKEN");

  if (!apiToken) {
    return errorResponse("Travelpayouts credentials not configured", 503);
  }

  let body: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    adults?: number;
    currency?: string;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.origin || !body.destination || !body.departureDate) {
    return errorResponse("origin, destination and departureDate are required", 400);
  }

  const origin      = body.origin.trim().toUpperCase();
  const destination = body.destination.trim().toUpperCase();
  if (origin.length > 4 || destination.length > 4) {
    return errorResponse(
      `origin and destination must be IATA airport codes (e.g. JFK, CDG), got: "${body.origin}", "${body.destination}"`,
      400,
    );
  }

  const url = new URL(`${FLIGHTS_BASE}/prices_for_dates`);
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("token", apiToken);
  url.searchParams.set("departure_at", body.departureDate);
  if (body.returnDate) url.searchParams.set("return_at", body.returnDate);
  url.searchParams.set("currency", body.currency ?? "USD");
  url.searchParams.set("limit", "10");
  url.searchParams.set("sorting", "price");
  url.searchParams.set("unique", "false");

  const res = await fetch(url.toString(), {
    headers: { "x-access-token": apiToken },
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    return errorResponse(`Travelpayouts flights API error: ${res.status} — ${errBody}`, 502);
  }

  const data = await res.json() as any;
  const flights: any[] = data?.data ?? [];

  const results: AffiliateCard[] = flights.map((f: any) => {
    const rawUrl = `https://www.aviasales.com/search/${origin}${body.departureDate.replace(/-/g, "")}${destination}1`;
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

  const response: ToolResponse<AffiliateCard> = {
    results,
    total: results.length,
    source: "travelpayouts-flights",
  };

  return jsonResponse(response);
}

export async function hotelsHandler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiToken = getenv("TRAVELPAYOUTS_API_TOKEN");
  const marker = getenv("TRAVELPAYOUTS_MARKER") ?? "";

  if (!apiToken) {
    return errorResponse("Travelpayouts credentials not configured", 503);
  }

  let body: {
    destination: string;
    checkIn: string;
    checkOut: string;
    guests?: number;
    currency?: string;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.destination || !body.checkIn || !body.checkOut) {
    return errorResponse("destination, checkIn and checkOut are required", 400);
  }

  const url = new URL(`${HOTELS_BASE}/cache.json`);
  url.searchParams.set("location", body.destination);
  url.searchParams.set("checkIn", body.checkIn);
  url.searchParams.set("checkOut", body.checkOut);
  url.searchParams.set("adults", String(body.guests ?? 2));
  url.searchParams.set("currency", body.currency ?? "USD");
  url.searchParams.set("limit", "10");
  url.searchParams.set("token", apiToken);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    return errorResponse(`Travelpayouts hotels API error: ${res.status} — ${errBody}`, 502);
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

  const response: ToolResponse<AffiliateCard> = {
    results,
    total: results.length,
    source: "travelpayouts-hotels",
  };

  return jsonResponse(response);
}
