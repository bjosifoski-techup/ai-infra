// BigBuy dropshipping catalogue search via BigBuy REST API.
// Docs: https://api.bigbuy.eu/doc
//
// Required env vars: BIGBUY_API_KEY
// Optional env vars: BIGBUY_ENV ("sandbox" | "production", default "production")
//
// Sandbox keys must go to api.sandbox.bigbuy.eu — a sandbox key sent to prod
// returns "Invalid Token". Param shape + listProducts+client-filter pattern
// mirrors the Commerce API adapter that's verified in production.
// BigBuy doesn't expose free-text search; /catalog/searchproducts.json was
// removed/deprecated. We fetch a page and substring-filter on title/category.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, ProductResult, ToolResponse } from "./shared/types.js";
import { getenv } from "./shared/env.js";

function bigBuyBase(): string {
  return getenv("BIGBUY_ENV") === "sandbox"
    ? "https://api.sandbox.bigbuy.eu/rest"
    : "https://api.bigbuy.eu/rest";
}

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiKey = getenv("BIGBUY_API_KEY");

  if (!apiKey) {
    return errorResponse("BigBuy credentials not configured", 503);
  }

  let body: { query: string; pageSize?: number };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.query) {
    return errorResponse("query is required", 400);
  }

  const pageSize = Math.min(body.pageSize ?? 10, 100);

  // Fetch a list page; client-side substring filter — the loose-match
  // fallback that Commerce verified works against BigBuy's sandbox.
  const url = new URL(`${bigBuyBase()}/catalog/products.json`);
  url.searchParams.set("isoCode",  "en");
  url.searchParams.set("_locale",  "en");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("page",     "0");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept:        "application/json",
    },
  });

  if (res.status === 401) {
    return errorResponse("BigBuy authentication failed - check BIGBUY_API_KEY", 502);
  }

  if (!res.ok) {
    return errorResponse(`BigBuy API error: ${res.status}`, 502);
  }

  const products = await res.json() as any[];
  const q = body.query.toLowerCase();
  const filtered = (Array.isArray(products) ? products : []).filter((p: any) => {
    const title = String(p.name ?? p.description ?? "").toLowerCase();
    const cat   = String(p.categories?.[0]?.name ?? "").toLowerCase();
    return title.includes(q) || cat.includes(q);
  });

  const results: ProductResult[] = filtered.slice(0, pageSize).map((p: any) => ({
    id:          String(p.id ?? p.sku ?? ""),
    title:       p.name ?? p.description ?? "",
    price:       parseFloat(p.retailPrice ?? p.lowestPrice ?? p.price ?? "0"),
    currency:    "EUR",
    url:         `https://www.bigbuy.eu/en/products/${p.sku ?? p.id ?? ""}`,
    imageUrl:    p.images?.[0]?.url,
    description: p.description,
    supplier:    "BigBuy",
  }));

  const response: ToolResponse<ProductResult> = {
    results,
    total:  results.length,
    source: "bigbuy",
  };

  return jsonResponse(response);
}
