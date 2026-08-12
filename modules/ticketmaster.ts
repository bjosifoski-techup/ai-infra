// Ticketmaster event search via Discovery API v2.
// Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
//
// Required env vars: TICKETMASTER_API_KEY, TICKETMASTER_AFFILIATE_ID

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
import { tagTicketmasterUrl } from "./shared/affiliate.js";
import { getenv } from "./shared/env.js";

const API_BASE = "https://app.ticketmaster.com/discovery/v2";

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiKey = getenv("TICKETMASTER_API_KEY");

  if (!apiKey) {
    return errorResponse("Ticketmaster credentials not configured", 503);
  }

  let body: {
    query: string;
    city?: string;
    countryCode?: string;
    latlong?: string;   // "lat,long" e.g. "48.85,2.35" — takes precedence over city
    radius?: number;    // miles; default 50 (Ticketmaster's default unit is miles)
    startDate?: string;
    endDate?: string;
    pageSize?: number;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.query) {
    return errorResponse("query is required", 400);
  }

  const url = new URL(`${API_BASE}/events.json`);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("keyword", body.query);
  url.searchParams.set("size", String(Math.min(body.pageSize ?? 10, 20)));
  url.searchParams.set("sort", "date,asc");

  // Geo takes precedence over city — Discovery API's fuzzy city match
  // can re-introduce cross-country ambiguity (Paris FR vs Paris NV vs
  // Perris CA all matched "Paris") on top of any geo filter, so city is
  // forwarded ONLY when latlong is absent.
  if (body.latlong) {
    url.searchParams.set("latlong", body.latlong);
    url.searchParams.set("radius",  String(body.radius ?? 50));
    url.searchParams.set("unit",    "miles");
  } else if (body.city) {
    url.searchParams.set("city", body.city);
  }
  if (body.countryCode) url.searchParams.set("countryCode", body.countryCode);
  if (body.startDate) url.searchParams.set("startDateTime", `${body.startDate}T00:00:00Z`);
  if (body.endDate) url.searchParams.set("endDateTime", `${body.endDate}T23:59:59Z`);

  const res = await fetch(url.toString());
  const resBody = await res.text().catch(() => "");

  if (res.status === 401) {
    return errorResponse(`Ticketmaster API key invalid — ${resBody}`, 502);
  }

  if (res.status === 429) {
    return errorResponse("Ticketmaster rate limit exceeded — try again in a few seconds", 429);
  }

  if (!res.ok) {
    return errorResponse(`Ticketmaster API error: ${res.status} — ${resBody}`, 502);
  }

  let data: any;
  try { data = JSON.parse(resBody); } catch { data = {}; }
  const events: any[] = data?._embedded?.events ?? [];

  const results: AffiliateCard[] = events.map((e: any) => {
    const venue = e._embedded?.venues?.[0];
    const date = e.dates?.start?.localDate ?? "";
    const venueName = venue?.name ?? "";
    const city = venue?.city?.name ?? body.city ?? "";

    const dateOrVenue = [date, [venueName, city].filter(Boolean).join(", ")]
      .filter(Boolean)
      .join(" · ");

    /* The parts, as well as the joined string.
     *
     * dateOrVenue pre-joins date, venue and city, which means a consumer can
     * only ever print it back verbatim. The new design needs a two-line date
     * badge and the city on its own row, so it needs the values apart — and
     * once they are separate, callers can also sort and filter by date, which
     * a formatted string never allowed.
     *
     * priceRange is in the Ticketmaster payload and was never read. */
    const endDate = e.dates?.end?.localDate as string | undefined;

    const tmPrice = Array.isArray(e.priceRanges) ? e.priceRanges[0] : undefined;
    const priceRange = tmPrice && typeof tmPrice.min === "number" && typeof tmPrice.max === "number"
      ? { min: tmPrice.min, max: tmPrice.max, currency: tmPrice.currency ?? "USD" }
      : undefined;

    return {
      kind: "affiliate",
      provider: "ticketmaster",
      title: e.name,
      dateOrVenue: dateOrVenue || undefined,
      imageUrl: e.images?.[0]?.url,
      deepLinkUrl: tagTicketmasterUrl(e.url ?? ""),
      startDate: date || undefined,
      endDate,
      venueName: venueName || undefined,
      city: city || undefined,
      priceRange,
    };
  });

  const response: ToolResponse<AffiliateCard> = {
    results,
    total: data?.page?.totalElements ?? results.length,
    source: "ticketmaster",
  };

  return jsonResponse(response);
}
