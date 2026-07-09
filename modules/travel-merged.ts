// Merged flight and hotel search — fans out to Kayak + Travelpayouts in parallel
// and returns a single interleaved list of AffiliateCards.
//
// Design invariants:
//   - Providers are called concurrently via Promise.allSettled. A rejection from
//     one provider (missing creds, HTTP error, timeout) is logged but does NOT
//     fail the whole call — the surviving provider's cards are returned with 200.
//   - Only if BOTH providers reject do we return 502, naming both statuses so
//     an operator sees the full failure surface, not just one.
//   - Merge policy is round-robin interleave (not price-sort — AffiliateCard has
//     no structured price field yet; a future PR can add price?: number and
//     switch this to a price-ascending sort).
//   - Cap the merged list at MAX_CARDS so a strong provider doesn't drown out
//     the weaker one and so the payload stays predictable for the FE parser.
//   - The `source` field is the joined list of providers that actually returned,
//     e.g. "kayak-flights+travelpayouts-flights" or just "travelpayouts-flights"
//     when Kayak fails (currently common — Kayak IP-blocks datacentre egress).
//
// Timeouts: each provider core enforces its own AbortSignal.timeout(15_000)
// internally, so the merged call's wall-clock is bounded by the slower provider,
// not by their sum.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
import * as kayak from "./kayak.js";
import * as travelpayouts from "./travelpayouts.js";

const MAX_CARDS = 10;

// Round-robin: take one card from each provider's list in order, repeating until
// we hit the cap or every provider is exhausted. Preserves per-provider ranking.
function interleave(arrays: AffiliateCard[][], cap: number): AffiliateCard[] {
  const out: AffiliateCard[] = [];
  const maxLen = arrays.reduce((m, a) => Math.max(m, a.length), 0);
  for (let i = 0; i < maxLen && out.length < cap; i++) {
    for (const a of arrays) {
      if (i < a.length && out.length < cap) out.push(a[i]);
    }
  }
  return out;
}

function summariseFailures(
  labels: string[],
  settled: PromiseSettledResult<ToolResponse<AffiliateCard>>[],
): string {
  return settled
    .map((s, idx) => s.status === "rejected"
      ? `${labels[idx]}=${(s.reason?.message ?? String(s.reason)).slice(0, 200)}`
      : null)
    .filter(Boolean)
    .join(" | ");
}

function buildMerged(
  kind: "flights" | "hotels",
  labels: string[],
  settled: PromiseSettledResult<ToolResponse<AffiliateCard>>[],
): Response {
  const successes: ToolResponse<AffiliateCard>[] = [];
  settled.forEach((s, idx) => {
    if (s.status === "fulfilled") {
      successes.push(s.value);
    } else {
      const message = s.reason?.message ?? String(s.reason);
      console.error(`[merged/${kind}] ${labels[idx]} failed: ${message}`);
    }
  });

  if (successes.length === 0) {
    return errorResponse(
      `All ${kind} providers failed: ${summariseFailures(labels, settled)}`,
      502,
    );
  }

  const merged = interleave(successes.map(s => s.results), MAX_CARDS);
  const total  = successes.reduce((sum, s) => sum + (s.total ?? s.results.length), 0);
  const source = successes.map(s => s.source ?? "unknown").join("+");

  return jsonResponse({ results: merged, total, source });
}

// ─── Flights ───────────────────────────────────────────────────────────────
// Fields are the union of Kayak's and Travelpayouts's flight inputs — the
// Kayak-only `cabin` is optional on both. Both cores treat unknown extra
// fields as no-ops, so passing the same body to both is safe.

interface MergedFlightInput {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults?: number;
  cabin?: string;   // Kayak-only; ignored by Travelpayouts
  currency?: string;
}

export async function flightsHandler(
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  let body: MergedFlightInput;
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  if (!body.origin || !body.destination || !body.departureDate) {
    return errorResponse("origin, destination and departureDate are required", 400);
  }

  const settled = await Promise.allSettled([
    kayak.searchFlights(body, request),
    travelpayouts.searchFlights(body),
  ]);
  return buildMerged("flights", ["kayak-flights", "travelpayouts-flights"], settled);
}

// ─── Hotels ────────────────────────────────────────────────────────────────

interface MergedHotelInput {
  destination: string;
  checkIn: string;
  checkOut: string;
  guests?: number;
  currency?: string;
}

export async function hotelsHandler(
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  let body: MergedHotelInput;
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body", 400); }

  if (!body.destination || !body.checkIn || !body.checkOut) {
    return errorResponse("destination, checkIn and checkOut are required", 400);
  }

  const settled = await Promise.allSettled([
    kayak.searchHotels(body, request),
    travelpayouts.searchHotels(body),
  ]);
  return buildMerged("hotels", ["kayak-hotels", "travelpayouts-hotels"], settled);
}
