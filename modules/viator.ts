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
    // Prefer Viator's own canonical product URL — fabricating a slug from the
    // user's query produces a 403 ("Access temporarily restricted") on viator.com.
    const rawUrl: string =
      p.productUrl
      ?? p.webURL
      ?? `https://www.viator.com/searchResults/all?text=${encodeURIComponent(p.title ?? "")}`;

    // dateOrVenue is intentionally omitted when the freetext payload carries no
    // per-product venue or schedule. We never echo body.destination — when chat
    // misroutes a product query here, that field is the user's query string.
    const primaryDestinationName: string | undefined =
      p.primaryDestinationName ?? p.destinations?.find((d: any) => d?.primary)?.name;

    /* Rating, review count and the from-price arrive on every product in the
     * freetext response and were being dropped. An attraction card without
     * them is just a photo and a title — the shopper has nothing to choose on.
     *
     * Guarded rather than defaulted: a product with no reviews yet must not be
     * rendered as 0 stars, and a missing price must not become 0.00. */
    const rating      = typeof p.reviews?.combinedAverageRating === "number"
      ? p.reviews.combinedAverageRating : undefined;
    const reviewCount = typeof p.reviews?.totalReviews === "number"
      ? p.reviews.totalReviews : undefined;

    const fromPrice   = p.pricing?.summary?.fromPrice;
    const priceFrom   = typeof fromPrice === "number"
      ? { amount: fromPrice, currency: p.pricing?.currency ?? body.currency ?? "USD" }
      : undefined;

    return {
      kind: "affiliate",
      provider: "viator",
      title: p.title ?? "",
      dateOrVenue: primaryDestinationName || undefined,
      imageUrl: p.images?.[0]?.variants?.find((v: any) => v.width >= 400)?.url
        ?? p.images?.[0]?.variants?.[0]?.url,
      deepLinkUrl: tagViatorUrl(rawUrl),
      rating,
      reviewCount,
      priceFrom,
    };
  });

  const response: ToolResponse<AffiliateCard> = {
    results,
    total: data?.products?.totalCount ?? results.length,
    source: "viator",
  };

  return jsonResponse(response);
}
