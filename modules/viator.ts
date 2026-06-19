// Viator experience and tour search via Viator Partner API.
// Docs: https://docs.viator.com/partner-api/technical/
//
// Required env vars: VIATOR_API_KEY
// Optional env vars: VIATOR_SANDBOX (set to "true" to use sandbox URL)
//                    VIATOR_PARTNER_ID (for affiliate link tagging)
//
// NOTE on keys:
//   Sandbox key → set VIATOR_SANDBOX=true  → uses https://api.sandbox.viator.com/partner
//   Production key → leave VIATOR_SANDBOX unset → uses https://api.viator.com/partner
//
// This module uses the /search/freetext endpoint (works on both sandbox and production)
// rather than /products/search which requires a numeric destinationId and production access.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, AffiliateCard, ToolResponse } from "./shared/types.js";
import { tagViatorUrl } from "./shared/affiliate.js";
import { getenv } from "./shared/env.js";

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiKey = getenv("VIATOR_API_KEY");

  if (!apiKey) {
    return errorResponse("Viator credentials not configured", 503);
  }

  const isSandbox = getenv("VIATOR_SANDBOX") === "true";
  const API_BASE = isSandbox
    ? "https://api.sandbox.viator.com/partner"
    : "https://api.viator.com/partner";

  let body: {
    destination: string;
    query?: string;
    pageSize?: number;
    currency?: string;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.destination) {
    return errorResponse("destination is required", 400);
  }

  const searchTerm = body.query
    ? `${body.query} ${body.destination}`
    : body.destination;

  const pageSize = Math.min(body.pageSize ?? 10, 30);

  const searchPayload = {
    searchTerm,
    searchTypes: [
      {
        searchType: "PRODUCTS",
        pagination: {
          start: 1,
          count: pageSize,
        },
      },
    ],
    currency: body.currency ?? "USD",
  };

  const res = await fetch(`${API_BASE}/search/freetext`, {
    method: "POST",
    headers: {
      "exp-api-key": apiKey,
      "Accept": "application/json;version=2.0",
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: JSON.stringify(searchPayload),
  });

  if (res.status === 401) {
    return errorResponse("Viator API key invalid or expired", 502);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return errorResponse(`Viator API error: ${res.status} ${errText}`, 502);
  }

  const data = await res.json() as any;
  const products: any[] = data?.products?.results ?? [];

  const results: AffiliateCard[] = products.map((p: any) => {
    const duration = p.duration?.fixedDurationInMinutes
      ? `${p.duration.fixedDurationInMinutes} min`
      : p.duration?.variableDurationFromMinutes
        ? `${p.duration.variableDurationFromMinutes}-${p.duration.variableDurationToMinutes} min`
        : undefined;

    const deepLinkUrl = tagViatorUrl(
      `https://www.viator.com/tours/${body.destination.replace(/\s+/g, "-")}/${p.productCode}`
    );

    return {
      kind: "affiliate",
      provider: "viator",
      title: p.title ?? "",
      dateOrVenue: [body.destination, duration].filter(Boolean).join(" · ") || undefined,
      imageUrl: p.images?.[0]?.variants?.find((v: any) => v.width >= 400)?.url
        ?? p.images?.[0]?.variants?.[0]?.url,
      deepLinkUrl,
    };
  });

  const response: ToolResponse<AffiliateCard> = {
    results,
    total: data?.products?.totalCount ?? results.length,
    source: "viator",
  };

  return jsonResponse(response);
}
