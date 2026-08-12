// Shared TypeScript interfaces used across all Zuplo module handlers.

// Raw normalized product from a dropship supplier — no markup applied.
// Consumed server-side by Commerce API, which applies markup before anything reaches the browser.
export interface RawProduct {
  supplier:       string;   // "aliexpress" | "cj" | "bigbuy"
  sourceId:       string;   // supplier's product ID
  title:          string;
  price:          number;   // raw supplier price — cost basis, never shown to end users
  currency:       string;
  imageUrl?:      string;
  url:            string;   // direct product URL (affiliate-tagged where configured)
  variantId?:     string;
  variantOptions?: Record<string, string>;
}

/** @deprecated — kept only so old supplier modules compile until Task 5 removes them */
export interface ProductResult {
  id:        string;
  title:     string;
  price:     number;
  currency:  string;
  url:       string;
  imageUrl?: string;
  supplier:  string;
}

/**
 * Fields every affiliate card carries, whatever it is.
 *
 * `dateOrVenue` is a pre-formatted convenience string kept for the existing
 * consumers. New surfaces should read the structured fields below it instead:
 * a card cannot render a two-line date badge, or sort by price, from a string
 * that already joined those values together.
 */
interface AffiliateCardBase {
  kind: "affiliate";
  title: string;
  imageUrl?: string;
  deepLinkUrl: string;
  /** @deprecated Prefer the per-provider structured fields. */
  dateOrVenue?: string;
}

export interface Money {
  amount:   number;
  currency: string;
}

/**
 * A tour, activity or attraction ticket.
 *
 * Viator returns rating, review count and a from-price on every product in
 * /search/freetext. They were being discarded here, so the app could not build
 * a card showing "4.7 (12.8K) · RM 79.00" even though the data had arrived.
 */
export interface AttractionCard extends AffiliateCardBase {
  provider:     "viator";
  /** 0–5. Absent when the product has no reviews yet — which is not 0 stars. */
  rating?:      number;
  reviewCount?: number;
  /** Lowest price across ages/options, i.e. the "from" price. */
  priceFrom?:   Money;
}

/**
 * A dated, ticketed event.
 *
 * Start and end are separate so a card can render a range ("NOV 15 – DEC 25")
 * and so callers can filter by date. Venue and city are separate for the same
 * reason: the design puts the city on its own line.
 */
export interface EventCard extends AffiliateCardBase {
  provider:    "ticketmaster" | "eventbrite" | "stubhub";
  /** ISO date, local to the venue. */
  startDate?:  string;
  endDate?:    string;
  venueName?:  string;
  city?:       string;
  priceRange?: { min: number; max: number; currency: string };
}

/**
 * One flight option.
 *
 * `logoUrl` is included because no flight API returns one directly — it is
 * assembled from the carrier's IATA code, and doing that per-consumer means
 * every app rebuilds the same URL.
 *
 * `price.perPerson` is explicit rather than assumed: providers differ on
 * whether the amount covers one passenger or the whole party, and a card that
 * guesses wrong misprices the trip.
 */
export interface FlightCard extends AffiliateCardBase {
  provider:         "flights";
  airlineIata?:     string;
  airlineName?:     string;
  airlineLogoUrl?:  string;
  originIata?:      string;
  destinationIata?: string;
  /** ISO 8601 with offset, so "+1 day" arrivals are derivable. */
  departAt?:        string;
  arriveAt?:        string;
  durationMinutes?: number;
  /** 0 = direct. */
  stops?:           number;
  price?:           Money & { perPerson: boolean };
}

/** Anything else, until it earns its own shape. */
export interface GenericAffiliateCard extends AffiliateCardBase {
  provider: string;
}

/**
 * Discriminated on `provider`, so a consumer cannot read a rating off a flight
 * or a duration off a museum tour without the compiler stopping it.
 *
 * Every added field is optional, and the base is unchanged — existing
 * consumers that only read title/imageUrl/deepLinkUrl keep compiling
 * untouched. This widens the contract; it does not break it.
 */
export type AffiliateCard =
  | AttractionCard
  | EventCard
  | FlightCard
  | GenericAffiliateCard;

export interface ToolResponse<T> {
  results: T[];
  total?: number;
  source: string;
}

export function errorResponse(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonResponse<T>(data: ToolResponse<T>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
