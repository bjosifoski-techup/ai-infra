// CJDropshipping product search via CJDropshipping API v2.
// Docs: https://developers.cjdropshipping.cn/api2.0/v1
//
// Required env vars: CJ_API_KEY (permanent — never changes)
//
// The module auto-generates and caches the access token using the API key.
// Token is refreshed automatically when it expires or when a 401 is received.
// No manual token management required.
//
// `.cn` host. Search is /product/list with productNameEn — the keyword search
// endpoint (verified live returning 200 + products). /product/query is a by-id
// lookup that 400s on a name. Token caching lives in shared/cj-token.ts and
// mirrors the Commerce API adapter that's verified returning products.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, ProductResult, ToolResponse } from "./shared/types.js";
import { getenv } from "./shared/env.js";
import { getCJToken, clearCJToken } from "./shared/cj-token.js";

const API_BASE = "https://developers.cjdropshipping.cn/api2.0/v1";

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
    accessToken = await getCJToken(apiKey);
  } catch (e: any) {
    console.error(`[CJ-v1] auth failed: ${e.message}`);
    return errorResponse(`CJDropshipping auth failed: ${e.message}`, 502);
  }

  const url = new URL(`${API_BASE}/product/list`);
  url.searchParams.set("pageNum", String(body.pageNum ?? 1));
  url.searchParams.set("pageSize", String(Math.min(body.pageSize ?? 10, 20)));
  url.searchParams.set("productNameEn", body.query);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "CJ-Access-Token": accessToken },
      signal:  AbortSignal.timeout(12_000),
    });
  } catch (e: any) {
    // Timeout (AbortError) or network failure — without this, an aborted fetch
    // produces a bodyless gateway 502 with no trace in the logs.
    console.error(`[CJ-v1] product list fetch threw: ${e.name} ${e.message}`);
    return errorResponse(`CJDropshipping fetch failed: ${e.name} ${e.message}`, 502);
  }

  // Token may have been invalidated externally — clear cache, re-auth once, retry
  if (res.status === 401) {
    console.warn("[CJ-v1] product list returned 401, clearing cache and retrying");
    clearCJToken();
    try {
      accessToken = await getCJToken(apiKey);
    } catch (e: any) {
      return errorResponse(`CJDropshipping re-auth failed: ${e.message}`, 502);
    }
    try {
      res = await fetch(url.toString(), {
        headers: { "CJ-Access-Token": accessToken },
        signal:  AbortSignal.timeout(12_000),
      });
    } catch (e: any) {
      console.error(`[CJ-v1] product list retry fetch threw: ${e.name} ${e.message}`);
      return errorResponse(`CJDropshipping retry fetch failed: ${e.name} ${e.message}`, 502);
    }
  }

  if (!res.ok) {
    // Surface CJ's own message so 429 / 500 / 503 etc. don't vanish silently.
    const body = await res.text().catch(() => "");
    console.error(`[CJ-v1] product list HTTP ${res.status}: ${body.slice(0, 200)}`);
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
