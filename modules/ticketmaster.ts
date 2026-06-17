// Ticketmaster event search via Discovery API v2.
// Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
//
// Required env vars: TICKETMASTER_API_KEY, TICKETMASTER_AFFILIATE_ID

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, EventResult, ToolResponse } from "./shared/types.js";
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
    startDate?: string;
    endDate?: string;
    countryCode?: string;
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

  if (body.city) url.searchParams.set("city", body.city);
  if (body.countryCode) url.searchParams.set("countryCode", body.countryCode);
  // Ticketmaster date format: 2026-01-01T00:00:00Z
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

  const results: EventResult[] = events.map((e: any) => {
    const venue = e._embedded?.venues?.[0];
    const priceRange = e.priceRanges?.[0];

    return {
      id: e.id,
      name: e.name,
      date: e.dates?.start?.localDate ?? "",
      venue: venue?.name ?? "",
      city: venue?.city?.name ?? body.city ?? "",
      url: tagTicketmasterUrl(e.url ?? ""),
      imageUrl: e.images?.[0]?.url,
      priceRange: priceRange
        ? `${priceRange.currency} ${priceRange.min} - ${priceRange.max}`
        : undefined,
    };
  });

  const response: ToolResponse<EventResult> = {
    results,
    total: data?.page?.totalElements ?? results.length,
    source: "ticketmaster",
  };

  return jsonResponse(response);
}
