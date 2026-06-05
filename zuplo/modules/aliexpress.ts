// AliExpress affiliate product search via AliExpress Open Platform API.
// Docs: https://developers.aliexpress.com/en/doc.htm?docId=45803
//
// Required env vars: ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { createHmac } from "crypto";
import { errorResponse, jsonResponse, ProductResult, ToolResponse } from "./shared/types.js";
import { tagAliExpressUrl } from "./shared/affiliate.js";

const API_BASE = "https://api-sg.aliexpress.com/sync";

function sign(params: Record<string, string>, appSecret: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
  return createHmac("sha256", appSecret)
    .update(sorted)
    .digest("hex")
    .toUpperCase();
}

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const appKey = process.env.ALIEXPRESS_APP_KEY;
  const appSecret = process.env.ALIEXPRESS_APP_SECRET;
  const trackingId = process.env.ALIEXPRESS_TRACKING_ID ?? "";

  if (!appKey || !appSecret) {
    return errorResponse("AliExpress credentials not configured", 503);
  }

  let body: { query: string; pageSize?: number; minPrice?: number; maxPrice?: number };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.query) {
    return errorResponse("query is required", 400);
  }

  const timestamp = Date.now().toString();

  const params: Record<string, string> = {
    app_key: appKey,
    method: "aliexpress.affiliate.product.query",
    timestamp,
    sign_method: "sha256",
    keywords: body.query,
    page_size: String(Math.min(body.pageSize ?? 10, 40)),
    target_currency: "USD",
    target_language: "EN",
    tracking_id: trackingId,
    ...(body.minPrice !== undefined ? { min_sale_price: String(body.minPrice * 100) } : {}),
    ...(body.maxPrice !== undefined ? { max_sale_price: String(body.maxPrice * 100) } : {}),
  };

  params.sign = sign(params, appSecret);

  const formData = new URLSearchParams(params);
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (!res.ok) {
    return errorResponse(`AliExpress API error: ${res.status}`, 502);
  }

  const data = await res.json() as any;
  const products = data?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product ?? [];

  const results: ProductResult[] = products.map((p: any) => ({
    id: String(p.product_id),
    title: p.product_title,
    price: parseFloat(p.target_sale_price) / 100,
    currency: p.target_sale_price_currency ?? "USD",
    url: tagAliExpressUrl(p.product_detail_url),
    imageUrl: p.product_main_image_url,
    supplier: "AliExpress",
  }));

  const response: ToolResponse<ProductResult> = {
    results,
    total: results.length,
    source: "aliexpress",
  };

  return jsonResponse(response);
}
