// CJDropshipping product search via CJDropshipping API v2.
// Docs: https://developers.cjdropshipping.com/api2.0/v1
//
// Required env vars: CJ_API_KEY, CJ_ACCESS_TOKEN
//
// NOTE: CJ uses a short-lived access token. If requests start returning 401,
// the token has expired. CJ tokens can be refreshed via:
//   POST https://developers.cjdropshipping.com/api2.0/v1/authentication/refreshAccessToken
//   Body: { "refreshToken": "<your_refresh_token>" }
// For now, we use the long-lived access token from env directly.

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, ProductResult, ToolResponse } from "./shared/types.js";
import { getenv } from "./shared/env.js";

const API_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const accessToken = getenv("CJ_ACCESS_TOKEN");

  if (!accessToken) {
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

  const url = new URL(`${API_BASE}/product/list`);
  url.searchParams.set("pageNum", String(body.pageNum ?? 1));
  url.searchParams.set("pageSize", String(Math.min(body.pageSize ?? 10, 20)));
  url.searchParams.set("productNameEn", body.query);

  const res = await fetch(url.toString(), {
    headers: {
      "CJ-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 401) {
    return errorResponse("CJ access token expired or invalid - refresh token in Zuplo env vars", 502);
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
