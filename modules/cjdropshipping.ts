// CJDropshipping product search via CJDropshipping API v2.
// Docs: https://developers.cjdropshipping.cn/api2.0/v1
//
// Required env vars: CJ_API_KEY (permanent — never changes)
//
// The module auto-generates and caches the access token using the API key.
// Token is refreshed automatically when it expires or when a 401 is received.
// No manual token management required.
//
// Host + search-endpoint shape mirror the Commerce API adapter that's verified
// in production: `.cn` host, /product/query, productName param (capital N).

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, ProductResult, ToolResponse } from "./shared/types.js";
import { getenv } from "./shared/env.js";

const API_BASE = "https://developers.cjdropshipping.cn/api2.0/v1";

// Module-level token cache — persists across requests within the same worker instance.
let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

async function getAccessToken(apiKey: string): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch(`${API_BASE}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });

  const body = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`CJ auth HTTP ${res.status}: ${body}`);

  let data: any;
  try { data = JSON.parse(body); } catch { throw new Error(`CJ auth non-JSON response: ${body.slice(0, 200)}`); }

  if (!data.result || !data.data?.accessToken) {
    throw new Error(`CJ auth rejected: ${data.message ?? JSON.stringify(data).slice(0, 200)}`);
  }

  cachedToken = data.data.accessToken;
  const expiryDate = data.data.accessTokenExpiryDate as string | undefined;
  // Cache for 13 days (real expiry: 15 days)
  tokenExpiresAt = now + 13 * 24 * 60 * 60 * 1000;
  console.log(`[CJ-v1] token refreshed — expiresAt=${expiryDate ?? "unknown"}, caching for 13d`);

  return cachedToken!;
}

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const apiKey = getenv("CJ_API_KEY");

  console.log(`[CJ-v1] apiKey present=${!!apiKey} key=${apiKey?.slice(0, 20)}...`);

  if (!apiKey) {
    return errorResponse("CJDropshipping credentials not configured", 503);
  }

  let body: { query: string; pageSize?: number; pageNum?: number };
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
    accessToken = await getAccessToken(apiKey);
  } catch (e: any) {
    console.error(`[CJ-v1] auth failed: ${e.message}`);
    return errorResponse(`CJDropshipping auth failed: ${e.message}`, 502);
  }

  const url = new URL(`${API_BASE}/product/query`);
  url.searchParams.set("pageNum", String(body.pageNum ?? 1));
  url.searchParams.set("pageSize", String(Math.min(body.pageSize ?? 10, 20)));
  url.searchParams.set("productName", body.query);

  let res = await fetch(url.toString(), {
    headers: { "CJ-Access-Token": accessToken },
  });

  // Token may have been invalidated externally — force refresh once and retry
  if (res.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
    try {
      accessToken = await getAccessToken(apiKey);
    } catch (e: any) {
      return errorResponse(`CJDropshipping re-auth failed: ${e.message}`, 502);
    }
    res = await fetch(url.toString(), {
      headers: { "CJ-Access-Token": accessToken },
    });
  }

  if (!res.ok) {
    return errorResponse(`CJDropshipping API error: ${res.status}`, 502);
  }

  const data = await res.json() as any;

  if (!data.result) {
    return errorResponse("CJDropshipping returned no results", 502);
  }

  const products: any[] = data.data?.list ?? [];

  const results: ProductResult[] = products.map((p: any) => ({
    id: String(p.pid ?? p.productId ?? ""),
    title: p.productNameEn ?? p.productName ?? "",
    price: parseFloat(p.sellPrice ?? p.productPrice ?? "0"),
    currency: "USD",
    url: `https://cjdropshipping.com/product/${p.pid ?? ""}.html`,
    imageUrl: p.productImage,
    description: p.description,
    supplier: "CJDropshipping",
  }));

  const response: ToolResponse<ProductResult> = {
    results,
    total: data.data?.total ?? results.length,
    source: "cjdropshipping",
  };

  return jsonResponse(response);
}
