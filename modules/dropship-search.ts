// Unified dropship product search — fans out to AliExpress, CJDropshipping, and BigBuy
// in parallel, normalizes to a common raw shape, and returns combined results.
//
// Markup is NOT applied here. Commerce API owns markup. This module returns raw
// supplier prices so the dependency flows Commerce → Infra, never the reverse.
//
// Required env vars (at least one supplier must be configured):
//   ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET  (+ ALIEXPRESS_ACCESS_TOKEN for keyword search)
//   CJ_API_KEY
//   BIGBUY_API_KEY  (+ BIGBUY_SANDBOX=true for sandbox)

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { RawProduct, errorResponse } from "./shared/types.js";
import { getenv } from "./shared/env.js";
import CryptoJS from "crypto-js";

// ─── AliExpress ──────────────────────────────────────────────────────────────

const AE_API_URL = "https://api-sg.aliexpress.com/sync";

function aeBuildSignedParams(
  appKey: string,
  appSecret: string,
  method: string,
  params: Record<string, string>
): URLSearchParams {
  const timestamp = Date.now().toString();
  const allParams: Record<string, string> = {
    app_key:        appKey,
    method,
    sign_method:    "sha256",
    timestamp,
    ...params,
  };

  const sortedKeys = Object.keys(allParams).sort();
  const stringToSign = sortedKeys.reduce(
    (acc, key) => acc + key + allParams[key],
    appSecret
  ) + appSecret;

  const sign = CryptoJS.HmacSHA256(stringToSign, appSecret)
    .toString(CryptoJS.enc.Hex)
    .toUpperCase();

  const query = new URLSearchParams({ ...allParams, sign });
  return query;
}

async function searchAliExpress(
  appKey: string,
  appSecret: string,
  accessToken: string | undefined,
  q: string,
  pageSize: number,
  minPrice?: number,
  maxPrice?: number
): Promise<RawProduct[]> {
  let params: Record<string, string>;
  let method: string;

  if (accessToken) {
    method = "aliexpress.ds.text.search";
    params = {
      access_token:   accessToken,
      search_key:     q,
      page_no:        "1",
      page_size:      String(pageSize),
      local_country:  "US",
      local_language: "EN",
    };
    if (minPrice !== undefined) params.min_sale_price = String(minPrice * 100);
    if (maxPrice !== undefined) params.max_sale_price = String(maxPrice * 100);
  } else {
    method = "aliexpress.ds.recommend.feed.get";
    params = {
      feed_name:    "best_seller",
      page_no:      "1",
      page_size:    String(pageSize),
      country:      "US",
      language:     "EN",
      currency:     "USD",
    };
  }

  const query = aeBuildSignedParams(appKey, appSecret, method, params);
  const res = await fetch(`${AE_API_URL}?${query.toString()}`, {
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) return [];

  const data = await res.json() as any;

  let items: any[] = [];
  if (method === "aliexpress.ds.text.search") {
    items = data?.aliexpress_ds_text_search_response?.data?.products?.traffic_product_d_t_o ?? [];
  } else {
    items = data?.aliexpress_ds_recommend_feed_get_response?.result?.mods?.item_list?.info ?? [];
  }

  return items.map((item: any): RawProduct => ({
    supplier:  "aliexpress",
    sourceId:  String(item.product_id ?? item.productId ?? item.item_id ?? ""),
    title:     item.product_main_image_url
                 ? (item.subject ?? item.title ?? item.product_title ?? "")
                 : (item.product_title ?? item.title ?? item.subject ?? ""),
    price:     parseFloat(item.app_sale_price ?? item.sale_price ?? item.price ?? "0"),
    currency:  item.app_sale_price_currency ?? item.currency ?? "USD",
    imageUrl:  item.product_main_image_url ?? item.imageUrl ?? undefined,
    url:       item.promotion_link ?? item.product_detail_url
                 ?? `https://www.aliexpress.com/item/${item.product_id ?? item.item_id}.html`,
  }));
}

// ─── CJDropshipping ──────────────────────────────────────────────────────────

const CJ_AUTH_URL  = "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken";
const CJ_API_BASE  = "https://developers.cjdropshipping.com/api2.0/v1";
const CJ_TOKEN_TTL = 13 * 24 * 60 * 60 * 1000; // 13 days (real expiry: 15 days)

let cjTokenCache: { token: string; expiry: number } | null = null;

async function getCJToken(apiKey: string): Promise<string> {
  if (cjTokenCache && Date.now() < cjTokenCache.expiry) {
    return cjTokenCache.token;
  }

  const res = await fetch(CJ_AUTH_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ email: "", password: "", apiKey }),
    signal:  AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`CJ auth failed: ${res.status}`);

  const data = await res.json() as any;
  const token = data?.data?.accessToken ?? "";
  if (!token) throw new Error("CJ auth returned no token");

  cjTokenCache = { token, expiry: Date.now() + CJ_TOKEN_TTL };
  return token;
}

async function searchCJ(
  apiKey: string,
  q: string,
  pageSize: number
): Promise<RawProduct[]> {
  let token: string;
  try {
    token = await getCJToken(apiKey);
  } catch {
    return [];
  }

  const url = new URL(`${CJ_API_BASE}/product/list`);
  url.searchParams.set("productNameEn", q);
  url.searchParams.set("pageNum",  "1");
  url.searchParams.set("pageSize", String(pageSize));

  const res = await fetch(url.toString(), {
    headers: { "CJ-Access-Token": token },
    signal:  AbortSignal.timeout(12_000),
  });

  if (!res.ok) return [];

  const data = await res.json() as any;
  const items: any[] = data?.data?.list ?? [];

  return items.map((item: any): RawProduct => ({
    supplier:  "cjdropshipping",
    sourceId:  String(item.pid ?? item.productId ?? ""),
    title:     item.productNameEn ?? item.productName ?? "",
    price:     parseFloat(item.sellPrice ?? item.price ?? "0"),
    currency:  "USD",
    imageUrl:  item.productImage ?? undefined,
    url:       item.productUrl
                 ?? `https://cjdropshipping.com/product/${item.pid ?? item.productId}.html`,
  }));
}

// ─── BigBuy ──────────────────────────────────────────────────────────────────

function getBigBuyBase(): string {
  const sandbox = getenv("BIGBUY_SANDBOX");
  return sandbox === "true"
    ? "https://api.sandbox.bigbuy.eu/rest"
    : "https://api.bigbuy.eu/rest";
}

async function searchBigBuy(
  apiKey: string,
  q: string,
  pageSize: number
): Promise<RawProduct[]> {
  const base = getBigBuyBase();
  const url  = new URL(`${base}/catalog/searchproducts.json`);
  url.searchParams.set("query",     q);
  url.searchParams.set("isoCode",   "en");
  url.searchParams.set("pageSize",  String(pageSize));
  url.searchParams.set("pageIndex", "0");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept:        "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) return [];

  const items = await res.json() as any[];
  if (!Array.isArray(items)) return [];

  return items.map((item: any): RawProduct => ({
    supplier:  "bigbuy",
    sourceId:  String(item.id ?? ""),
    title:     item.name ?? item.description ?? "",
    price:     parseFloat(String(item.retailPrice ?? item.price ?? "0")),
    currency:  "EUR",
    imageUrl:  item.images?.[0]?.url ?? undefined,
    url:       `https://www.bigbuy.eu/en/${item.id}.html`,
  }));
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  let body: {
    q:          string;
    pageSize?:  number;
    page?:      number;
    minPrice?:  number;
    maxPrice?:  number;
    currency?:  string;
    locale?:    string;
  };

  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.q?.trim()) {
    return errorResponse("q is required", 400);
  }

  const pageSize = Math.min(body.pageSize ?? 10, 40);
  // Request slightly more from each supplier so merged results fill the page
  const perSupplier = Math.ceil(pageSize * 0.6);

  const aeKey    = getenv("ALIEXPRESS_APP_KEY");
  const aeSecret = getenv("ALIEXPRESS_APP_SECRET");
  const aeToken  = getenv("ALIEXPRESS_ACCESS_TOKEN");
  const cjKey    = getenv("CJ_API_KEY");
  const bbKey    = getenv("BIGBUY_API_KEY");

  // Fan out to all configured suppliers in parallel; skip unconfigured ones silently
  const tasks: Promise<RawProduct[]>[] = [];

  if (aeKey && aeSecret) {
    tasks.push(
      searchAliExpress(aeKey, aeSecret, aeToken, body.q, perSupplier, body.minPrice, body.maxPrice)
        .catch(() => [])
    );
  }

  if (cjKey) {
    tasks.push(searchCJ(cjKey, body.q, perSupplier).catch(() => []));
  }

  if (bbKey) {
    tasks.push(searchBigBuy(bbKey, body.q, perSupplier).catch(() => []));
  }

  if (tasks.length === 0) {
    return errorResponse("No dropship suppliers configured", 503);
  }

  const allResults = await Promise.all(tasks);

  // Interleave results across suppliers so no single supplier dominates the top
  const merged: RawProduct[] = [];
  const maxLen = Math.max(...allResults.map((r) => r.length));
  for (let i = 0; i < maxLen && merged.length < pageSize; i++) {
    for (const results of allResults) {
      if (i < results.length && merged.length < pageSize) {
        merged.push(results[i]);
      }
    }
  }

  const sources = allResults
    .flatMap((r) => r.slice(0, 1).map((p) => p.supplier))
    .filter((v, i, a) => a.indexOf(v) === i);

  return new Response(
    JSON.stringify({
      products: merged,
      sources,
      total:    merged.length,
      page:     body.page ?? 1,
      limit:    pageSize,
    }),
    {
      status:  200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
