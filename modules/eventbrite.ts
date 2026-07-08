// Eventbrite event search via Eventbrite API v3 — public search flow.
// Docs: https://www.eventbrite.com/platform/api
//
// Required env vars: EVENTBRITE_TOKEN
// Optional env vars: EVENTBRITE_AFFILIATE_CODE
//
// This handler hits Eventbrite's public event-search endpoint (/v3/events/search/)
// with a public-scope token. It replaces an earlier implementation that used a
// two-step org-lookup + /organizations/{id}/events/ flow — which is org-scoped
// and only returned the authenticated org's own events, matching what the client
// saw ("Eventbrite returns empty") when the wrong token scope was in use.
//
// If EVENTBRITE_TOKEN is unset, the handler falls back to the legacy env var
// name (EVENTBRITE_API_TOKEN) so an operator mid-migration doesn't 503, but a
// deploy-time warning is logged so we notice and finish the rename.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
import { tagEventbriteUrl } from "./shared/affiliate.js";
import { getenv } from "./shared/env.js";

const API_BASE = "https://www.eventbriteapi.com/v3";

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiToken = getenv("EVENTBRITE_TOKEN") ?? getenv("EVENTBRITE_API_TOKEN");

  if (!apiToken) {
    return errorResponse("Eventbrite credentials not configured", 503);
  }

  if (!getenv("EVENTBRITE_TOKEN") && getenv("EVENTBRITE_API_TOKEN")) {
    console.warn("[eventbrite] using legacy EVENTBRITE_API_TOKEN — rename to EVENTBRITE_TOKEN");
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
  url.searchParams.set("q",           body.query);
  url.searchParams.set("expand",      "venue");
  url.searchParams.set("sort_by",     "date");
  url.searchParams.set("page_size",   String(Math.min(body.pageSize ?? 20, 50)));

  if (body.location) {
    url.searchParams.set("location.address", body.location);
  }
  if (body.startDate) {
    url.searchParams.set("start_date.range_start", `${body.startDate}T00:00:00Z`);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  const resText = await res.text().catch(() => "");

  if (res.status === 401) {
    console.error(`[eventbrite] 401 — token likely wrong scope. Body: ${resText.slice(0, 200)}`);
    return errorResponse("Eventbrite token invalid or wrong scope for public search", 502);
  }

  if (res.status === 404) {
    // Eventbrite has historically gated /events/search/ behind app approval —
    // if the endpoint 404s or "not found"s, that's the failure mode to surface.
    console.error(`[eventbrite] 404 — /events/search/ not available to this token. Body: ${resText.slice(0, 200)}`);
    return errorResponse("Eventbrite public event search not available for this token", 502);
  }

  if (!res.ok) {
    console.error(`[eventbrite] HTTP ${res.status} — ${resText.slice(0, 200)}`);
    return errorResponse(`Eventbrite API error: ${res.status}`, 502);
  }

  let data: any;
  try { data = JSON.parse(resText); } catch { data = {}; }

  const events: any[] = data?.events ?? [];

  const results: AffiliateCard[] = events.map((e: any) => {
    const venue      = e.venue;
    const date       = e.start?.local ?? "";
    const venueName  = venue?.name ?? "";
    const city       = venue?.address?.city ?? body.location ?? "";

    const dateOrVenue = [date, [venueName, city].filter(Boolean).join(", ")]
      .filter(Boolean)
      .join(" · ");

    return {
      kind:        "affiliate",
      provider:    "eventbrite",
      title:       e.name?.text ?? "",
      dateOrVenue: dateOrVenue || undefined,
      imageUrl:    e.logo?.url,
      deepLinkUrl: tagEventbriteUrl(e.url ?? ""),
    };
  });

  const response: ToolResponse<AffiliateCard> = {
    results,
    total:  data?.pagination?.object_count ?? results.length,
    source: "eventbrite",
  };

  return jsonResponse(response);
}
