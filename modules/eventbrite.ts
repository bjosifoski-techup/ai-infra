// Eventbrite event search via Eventbrite API v3.
// Docs: https://www.eventbrite.com/platform/api
//
// Required env vars: EVENTBRITE_API_TOKEN
// Optional env vars: EVENTBRITE_AFFILIATE_CODE
//
// NOTE: Eventbrite removed /v3/events/search/ public search for third-party apps.
// This handler uses /v3/organizations/{id}/events/ to list events created by the
// authenticated user's organization. It also supports a text filter (name_filter).
//
// The org ID is discovered automatically from the token via /v3/users/me/organizations/.
// If the org has no public events, results will be empty.
//
// For general public event search, Ticketmaster (/travel/ticketmaster/search) is the
// recommended alternative — it has a full public search API with no restrictions.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
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

  const headers = { Authorization: `Bearer ${apiToken}` };

  // Step 1: discover the authenticated organization ID
  const orgRes = await fetch(`${API_BASE}/users/me/organizations/`, { headers });
  if (orgRes.status === 401) {
    return errorResponse("Eventbrite API token invalid", 502);
  }
  if (!orgRes.ok) {
    return errorResponse(`Eventbrite org lookup failed: ${orgRes.status}`, 502);
  }
  const orgData = await orgRes.json() as any;
  const orgId: string | undefined = orgData?.organizations?.[0]?.id;

  if (!orgId) {
    return jsonResponse({
      results: [],
      total: 0,
      source: "eventbrite",
      note: "No Eventbrite organization found for this token. Public event search requires Ticketmaster.",
    } as any);
  }

  // Step 2: list the org's events with optional name filter
  const eventsUrl = new URL(`${API_BASE}/organizations/${orgId}/events/`);
  eventsUrl.searchParams.set("status", "live");
  eventsUrl.searchParams.set("order_by", "start_asc");
  eventsUrl.searchParams.set("expand", "venue");
  eventsUrl.searchParams.set("page_size", String(Math.min(body.pageSize ?? 20, 50)));

  if (body.query) {
    eventsUrl.searchParams.set("name_filter", body.query);
  }

  if (body.startDate) {
    eventsUrl.searchParams.set("start_date.range_start", `${body.startDate}T00:00:00Z`);
  }

  const evRes = await fetch(eventsUrl.toString(), { headers });
  if (!evRes.ok) {
    return errorResponse(`Eventbrite events fetch failed: ${evRes.status}`, 502);
  }

  const data = await evRes.json() as any;
  const events: any[] = data?.events ?? [];

  const results: AffiliateCard[] = events.map((e: any) => {
    const venue = e.venue;
    const date = e.start?.local ?? "";
    const venueName = venue?.name ?? "";
    const city = venue?.address?.city ?? body.location ?? "";

    const dateOrVenue = [date, [venueName, city].filter(Boolean).join(", ")]
      .filter(Boolean)
      .join(" · ");

    return {
      kind: "affiliate",
      provider: "eventbrite",
      title: e.name?.text ?? "",
      dateOrVenue: dateOrVenue || undefined,
      imageUrl: e.logo?.url,
      deepLinkUrl: tagEventbriteUrl(e.url ?? ""),
    };
  });

  const response: ToolResponse<AffiliateCard> & { note?: string } = {
    results,
    total: data?.pagination?.object_count ?? results.length,
    source: "eventbrite",
    note: "Results show events from the authenticated Eventbrite organization only. For broader public event search, use the Ticketmaster tool.",
  };

  return jsonResponse(response);
}
