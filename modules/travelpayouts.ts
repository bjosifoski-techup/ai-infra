// Travelpayouts flight and hotel search.
// Flights: Aviasales API v3  https://api.travelpayouts.com/aviasales/v3
// Hotels:  Hotellook API     https://engine.hotellook.com/api/v2
//
// Required env vars: TRAVELPAYOUTS_API_TOKEN, TRAVELPAYOUTS_MARKER
//
// This module exports two handlers: flightsHandler and hotelsHandler.
// Each is registered as a separate route in routes.oas.json.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, FlightResult, HotelResult, ToolResponse } from "./shared/types.js";
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

  const url = new URL(`${FLIGHTS_BASE}/prices_for_dates`);
  url.searchParams.set("origin", body.origin.toUpperCase());
  url.searchParams.set("destination", body.destination.toUpperCase());
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
    return errorResponse(`Travelpayouts flights API error: ${res.status}`, 502);
  }

  const data = await res.json() as any;
  const flights: any[] = data?.data ?? [];

  const results: FlightResult[] = flights.map((f: any) => {
    const rawUrl = `https://www.aviasales.com/search/${body.origin}${body.departureDate.replace(/-/g, "")}${body.destination}1`;
    return {
      origin: body.origin.toUpperCase(),
      destination: body.destination.toUpperCase(),
      price: f.price,
      currency: body.currency ?? "USD",
      departureDate: f.departure_at ?? body.departureDate,
      returnDate: f.return_at,
      airline: f.airline,
      url: tagTravelpayoutsUrl(rawUrl),
    };
  });

  const response: ToolResponse<FlightResult> = {
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
    return errorResponse(`Travelpayouts hotels API error: ${res.status}`, 502);
  }

  const data = await res.json() as any;
  const hotels: any[] = Array.isArray(data) ? data : (data?.results ?? []);

  const results: HotelResult[] = hotels.map((h: any) => {
    const rawUrl = `https://www.hotellook.com/hotels?destination=${encodeURIComponent(body.destination)}&checkIn=${body.checkIn}&checkOut=${body.checkOut}&marker=${marker}`;
    return {
      id: String(h.id ?? h.hotelId ?? ""),
      name: h.hotelName ?? h.name ?? "",
      city: body.destination,
      stars: h.stars,
      pricePerNight: h.priceFrom ?? h.minPrice ?? 0,
      currency: body.currency ?? "USD",
      url: tagTravelpayoutsUrl(rawUrl),
      imageUrl: h.photoUrl,
    };
  });

  const response: ToolResponse<HotelResult> = {
    results,
    total: results.length,
    source: "travelpayouts-hotels",
  };

  return jsonResponse(response);
}
