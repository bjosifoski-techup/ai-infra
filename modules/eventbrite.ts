// Eventbrite event search via Eventbrite API v3.
// Docs: https://www.eventbrite.com/platform/api
//
// Required env vars: EVENTBRITE_API_TOKEN, EVENTBRITE_AFFILIATE_CODE

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, EventResult, ToolResponse } from "./shared/types.js";
import { tagEventbriteUrl } from "./shared/affiliate.js";
import { getenv } from "./shared/env.js";

const API_BASE = "https://www.eventbriteapi.com/v3";

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiToken = getenv("EVENTBRITE_API_TOKEN");

  if (!apiToken) {
    return errorResponse("Eventbrite credentials not configured", 503);
  }

  let body: {
    query: string;
    location?: string;
    startDate?: string;
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

  const url = new URL(`${API_BASE}/events/search/`);
  url.searchParams.set("q", body.query);
  url.searchParams.set("expand", "venue");
  url.searchParams.set("page_size", String(Math.min(body.pageSize ?? 10, 50)));

  if (body.location) {
    url.searchParams.set("location.address", body.location);
    url.searchParams.set("location.within", "50km");
  }

  if (body.startDate) {
    // Eventbrite format: 2026-01-01T00:00:00Z
    url.searchParams.set("start_date.range_start", `${body.startDate}T00:00:00Z`);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  if (res.status === 401) {
    return errorResponse("Eventbrite API token invalid", 502);
  }

  if (!res.ok) {
    return errorResponse(`Eventbrite API error: ${res.status}`, 502);
  }

  const data = await res.json() as any;
  const events: any[] = data?.events ?? [];

  const results: EventResult[] = events.map((e: any) => {
    const venue = e.venue;
    const cost = e.ticket_availability?.minimum_ticket_price;

    return {
      id: e.id,
      name: e.name?.text ?? "",
      date: e.start?.local ?? "",
      venue: venue?.name ?? "",
      city: venue?.address?.city ?? body.location ?? "",
      url: tagEventbriteUrl(e.url ?? ""),
      imageUrl: e.logo?.url,
      priceRange: cost
        ? `${cost.currency} ${(cost.major_value ?? cost.value / 100).toFixed(2)}+`
        : e.is_free ? "Free" : undefined,
    };
  });

  const response: ToolResponse<EventResult> = {
    results,
    total: data?.pagination?.object_count ?? results.length,
    source: "eventbrite",
  };

  return jsonResponse(response);
}
