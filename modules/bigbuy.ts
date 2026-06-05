// BigBuy dropshipping catalogue search via BigBuy REST API.
// Docs: https://api.bigbuy.eu/doc
//
// Required env vars: BIGBUY_API_KEY

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, ProductResult, ToolResponse } from "./shared/types.js";
import { getenv } from "./shared/env.js";

const API_BASE = "https://api.bigbuy.eu/rest";

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiKey = getenv("BIGBUY_API_KEY");

  if (!apiKey) {
    return errorResponse("BigBuy credentials not configured", 503);
  }

  let body: { query: string; pageSize?: number; language?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.query) {
    return errorResponse("query is required", 400);
  }

  const pageSize = Math.min(body.pageSize ?? 10, 100);
  const language = body.language ?? "en";

  // BigBuy product search endpoint
  const url = new URL(`${API_BASE}/catalog/products.json`);
  url.searchParams.set("language", language);
  url.searchParams.set("search", body.query);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", "0");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (res.status === 401) {
    return errorResponse("BigBuy authentication failed - check BIGBUY_API_KEY", 502);
  }

  if (!res.ok) {
    return errorResponse(`BigBuy API error: ${res.status}`, 502);
  }

  const products = await res.json() as any[];

  const results: ProductResult[] = (Array.isArray(products) ? products : []).map((p: any) => ({
    id: String(p.id ?? p.sku ?? ""),
    title: p.name ?? p.description ?? "",
    price: parseFloat(p.retailPrice ?? p.price ?? "0"),
    currency: "EUR",
    url: `https://www.bigbuy.eu/en/${p.id ?? ""}.html`,
    imageUrl: p.images?.[0]?.url,
    description: p.description,
    supplier: "BigBuy",
  }));

  const response: ToolResponse<ProductResult> = {
    results,
    total: results.length,
    source: "bigbuy",
  };

  return jsonResponse(response);
}
