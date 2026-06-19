// StubHub secondary ticket marketplace search.
// Docs: https://developer.stubhub.com
//
// Required env vars: STUBHUB_CLIENT_ID, STUBHUB_CLIENT_SECRET, STUBHUB_AFFILIATE_ID
//
// StubHub uses OAuth2 client credentials. We fetch a token per request.
// For production, consider caching the token until it expires.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
import { tagStubHubUrl } from "./shared/affiliate.js";
import { getenv } from "./shared/env.js";

const AUTH_URL = "https://account.stubhub.com/oauth2/token";
const API_BASE = "https://api.stubhub.com";

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=read:events",
  });

  if (!res.ok) {
    throw new Error(`StubHub auth failed: ${res.status}`);
  }

  const data = await res.json() as any;
  return data.access_token;
}

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const clientId = getenv("STUBHUB_CLIENT_ID");
  const clientSecret = getenv("STUBHUB_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    return errorResponse("StubHub credentials not configured", 503);
  }

  let body: {
    query: string;
    city?: string;
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

  let accessToken: string;
  try {
    accessToken = await getAccessToken(clientId, clientSecret);
  } catch (err: any) {
    return errorResponse(err.message ?? "StubHub authentication failed", 502);
  }

  const url = new URL(`${API_BASE}/sellers/search/events/v3`);
  url.searchParams.set("name", body.query);
  url.searchParams.set("rows", String(Math.min(body.pageSize ?? 10, 20)));
  url.searchParams.set("start", "0");
  url.searchParams.set("sort", "eventDateLocal asc");

  if (body.city) url.searchParams.set("city", body.city);
  if (body.startDate) url.searchParams.set("dateLocal", body.startDate);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    return errorResponse(`StubHub API error: ${res.status}`, 502);
  }

  const data = await res.json() as any;
  const events: any[] = data?.events ?? [];

  const results: AffiliateCard[] = events.map((e: any) => {
    const venueName = e.venue?.name ?? "";
    const city = e.venue?.city ?? body.city ?? "";
    const dateOrVenue = [e.eventDateLocal, [venueName, city].filter(Boolean).join(", ")]
      .filter(Boolean)
      .join(" · ");

    return {
      kind: "affiliate",
      provider: "stubhub",
      title: e.name ?? "",
      dateOrVenue: dateOrVenue || undefined,
      deepLinkUrl: tagStubHubUrl(e.webURI ? `https://www.stubhub.com${e.webURI}` : ""),
    };
  });

  const response: ToolResponse<AffiliateCard> = {
    results,
    total: data?.numFound ?? results.length,
    source: "stubhub",
  };

  return jsonResponse(response);
}
