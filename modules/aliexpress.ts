// AliExpress Dropship product search via AliExpress DS API (AE-Dropshipper).
// Docs: https://openservice.aliexpress.com
//
// Required env vars: ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET
// Optional env vars: ALIEXPRESS_ACCESS_TOKEN (OAuth token — enables true keyword search)
//                    ALIEXPRESS_TRACKING_ID  (affiliate link tagging)
//
// With ALIEXPRESS_ACCESS_TOKEN:    uses aliexpress.ds.text.search (real keyword search)
// Without ALIEXPRESS_ACCESS_TOKEN: falls back to aliexpress.ds.recommend.feed.get (trending feed)

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { errorResponse, jsonResponse, ProductResult, ToolResponse } from "./shared/types.js";
import { tagAliExpressUrl } from "./shared/affiliate.js";
import { getenv } from "./shared/env.js";

const API_BASE = "https://api-sg.aliexpress.com/sync";

// Feed fallback — maps query keywords to the closest curated DS feed.
const FEED_ROUTES: Array<{ pattern: RegExp; feed: string }> = [
  { pattern: /earbuds?|headphones?|earphones?|airpods?|tws|speaker|audio/i, feed: "AEB_PhoneAccessories_EG" },
  { pattern: /phone|smartphone|iphone|android|mobile|charging|charger|cable|screen.protector/i, feed: "AEB_PhoneAccessories_EG" },
  { pattern: /laptop|computer|keyboard|mouse|monitor|tablet|usb|ssd|ram|cpu|gaming/i, feed: "AEB_ComputerAccessories_EG" },
  { pattern: /home|kitchen|garden|furniture|lamp|lighting|decor|pillow|curtain|tool/i, feed: "AEB_US_Home&Garden_TopSellers" },
  { pattern: /summer|swimwear|bikini|beach|sunglasses|sandals/i, feed: "AEB_SummerProducts_EG" },
];
const DEFAULT_FEED = "AEB_i69_FullCategory_TopSellers_20241225";

async function sign(params: Record<string, string>, appSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const sorted = Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(sorted));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function toAbsoluteUrl(url: string): string {
  if (!url) return url;
  return url.startsWith("//") ? `https:${url}` : url;
}

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  const appKey = getenv("ALIEXPRESS_APP_KEY");
  const appSecret = getenv("ALIEXPRESS_APP_SECRET");

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

  const requestedSize = Math.min(body.pageSize ?? 10, 40);
  const accessToken = getenv("ALIEXPRESS_ACCESS_TOKEN");
  const trackingId = getenv("ALIEXPRESS_TRACKING_ID") ?? "";
  const timestamp = Date.now().toString();

  console.log(`[AliExpress-v1] accessToken present=${!!accessToken} token=${accessToken?.slice(0, 20)}... query="${body.query}"`);

  if (accessToken) {
    // True keyword search via aliexpress.ds.text.search
    const params: Record<string, string> = {
      app_key: appKey,
      method: "aliexpress.ds.text.search",
      timestamp,
      sign_method: "sha256",
      session: accessToken,
      search_key: body.query,
      page_no: "1",
      page_size: String(requestedSize),
      target_currency: "USD",
      target_language: "EN",
      sort: "SALE_PRICE_ASC",
      countryCode: "US",
      currency: "USD",
      local: "en_US",
    };
    params.sign = await sign(params, appSecret);

    const res = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });

    if (!res.ok) {
      return errorResponse(`AliExpress API error: ${res.status}`, 502);
    }

    const data = await res.json() as any;
    console.log(`[AliExpress-v1] text search raw keys=${Object.keys(data ?? {}).join(",")}`);
    const inner = data?.aliexpress_ds_text_search_response?.data;

    if (!inner) {
      console.error(`[AliExpress-v1] text search no data — full response: ${JSON.stringify(data).slice(0, 300)}`);
      return errorResponse("AliExpress text search returned no data", 502);
    }

    let raw: any[] = inner?.products?.selection_search_product ?? [];

    if (body.minPrice !== undefined || body.maxPrice !== undefined) {
      raw = raw.filter((p) => {
        const price = parseFloat(p.targetSalePrice ?? p.salePrice ?? "0");
        if (body.minPrice !== undefined && price < body.minPrice) return false;
        if (body.maxPrice !== undefined && price > body.maxPrice) return false;
        return true;
      });
    }

    const results: ProductResult[] = raw.slice(0, requestedSize).map((p: any) => {
      const detailUrl = toAbsoluteUrl(p.itemUrl ?? `//www.aliexpress.com/item/${p.itemId}.html`);
      return {
        id: String(p.itemId ?? ""),
        title: p.title ?? "",
        price: parseFloat(p.targetSalePrice ?? p.salePrice ?? "0"),
        currency: p.targetOriginalPriceCurrency ?? "USD",
        url: trackingId ? tagAliExpressUrl(detailUrl) : detailUrl,
        imageUrl: toAbsoluteUrl(p.itemMainPic ?? ""),
        description: p.discount && p.discount !== "0%"
          ? `${p.discount} off · ${p.evaluateRate ?? ""} rating · ${p.orders ?? "0"} orders`
          : undefined,
        supplier: "AliExpress",
      };
    });

    const response: ToolResponse<ProductResult> = {
      results,
      total: inner.totalCount ?? results.length,
      source: "aliexpress",
    };

    return jsonResponse(response);
  }

  // Fallback: feed-based trending products when no access token is configured
  const feedName = FEED_ROUTES.find((r) => r.pattern.test(body.query))?.feed ?? DEFAULT_FEED;

  const params: Record<string, string> = {
    app_key: appKey,
    method: "aliexpress.ds.recommend.feed.get",
    timestamp,
    sign_method: "sha256",
    feed_name: feedName,
    page_no: "1",
    page_size: String(requestedSize),
    target_currency: "USD",
    target_language: "EN",
    country: "US",
  };
  params.sign = await sign(params, appSecret);

  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

  if (!res.ok) {
    return errorResponse(`AliExpress API error: ${res.status}`, 502);
  }

  const data = await res.json() as any;
  let raw: any[] = data?.aliexpress_ds_recommend_feed_get_response?.result?.products?.traffic_product_d_t_o ?? [];

  if (body.minPrice !== undefined || body.maxPrice !== undefined) {
    raw = raw.filter((p) => {
      const price = parseFloat(p.target_sale_price ?? p.sale_price ?? "0");
      if (body.minPrice !== undefined && price < body.minPrice) return false;
      if (body.maxPrice !== undefined && price > body.maxPrice) return false;
      return true;
    });
  }

  const results: ProductResult[] = raw.slice(0, requestedSize).map((p: any) => {
    const detailUrl = p.product_detail_url ?? `https://www.aliexpress.com/item/${p.product_id}.html`;
    return {
      id: String(p.product_id ?? ""),
      title: p.product_title ?? "",
      price: parseFloat(p.target_sale_price ?? p.sale_price ?? "0"),
      currency: p.target_sale_price_currency ?? "USD",
      url: trackingId ? tagAliExpressUrl(detailUrl) : detailUrl,
      imageUrl: p.product_main_image_url ?? p.product_small_image_urls?.productSmallImageUrl?.[0],
      description: p.discount ? `${p.discount} off · ${p.evaluate_rate ?? ""} rating` : undefined,
      supplier: "AliExpress",
    };
  });

  const response: ToolResponse<ProductResult> = {
    results,
    total: data?.aliexpress_ds_recommend_feed_get_response?.result?.total_record_count ?? results.length,
    source: "aliexpress",
  };

  return jsonResponse(response);
}
