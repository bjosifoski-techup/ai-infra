// Viator experience and tour search via Viator Partner API.
// Docs: https://docs.viator.com/partner-api/technical/
//
// Required env vars: VIATOR_API_KEY, VIATOR_PARTNER_ID

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, ExperienceResult, ToolResponse } from "./shared/types.js";
import { tagViatorUrl } from "./shared/affiliate.js";

const API_BASE = "https://api.viator.com/partner";

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiKey = process.env.VIATOR_API_KEY;

  if (!apiKey) {
    return errorResponse("Viator credentials not configured", 503);
  }

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

  const searchPayload = {
    filtering: {
      destination: body.destination,
      ...(body.query ? { freeText: body.query } : {}),
    },
    sorting: {
      sort: "TRAVELER_RATING",
      order: "DESCENDING",
    },
    pagination: {
      start: 1,
      count: Math.min(body.pageSize ?? 10, 30),
    },
    currency: body.currency ?? "USD",
  };

  const res = await fetch(`${API_BASE}/products/search`, {
    method: "POST",
    headers: {
      "exp-api-key": apiKey,
      "Accept": "application/json;version=2.0",
      "Content-Type": "application/json",
      "Accept-Language": "en-US",
    },
    body: JSON.stringify(searchPayload),
  });

  if (res.status === 401) {
    return errorResponse("Viator API key invalid", 502);
  }

  if (!res.ok) {
    return errorResponse(`Viator API error: ${res.status}`, 502);
  }

  const data = await res.json() as any;
  const products: any[] = data?.products ?? [];

  const results: ExperienceResult[] = products.map((p: any) => {
    const price = p.pricing?.summary?.fromPrice;

    return {
      id: p.productCode ?? "",
      title: p.title ?? "",
      destination: body.destination,
      price: price ?? 0,
      currency: body.currency ?? "USD",
      duration: p.duration?.fixedDurationInMinutes
        ? `${p.duration.fixedDurationInMinutes} min`
        : p.duration?.variableDurationFromMinutes
          ? `${p.duration.variableDurationFromMinutes}-${p.duration.variableDurationToMinutes} min`
          : undefined,
      url: tagViatorUrl(
        `https://www.viator.com/tours/${body.destination.replace(/\s+/g, "-")}/${p.productCode}`
      ),
      imageUrl: p.images?.[0]?.variants?.[0]?.url,
    };
  });

  const response: ToolResponse<ExperienceResult> = {
    results,
    total: data?.totalCount ?? results.length,
    source: "viator",
  };

  return jsonResponse(response);
}
