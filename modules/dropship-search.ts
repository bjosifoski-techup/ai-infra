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
import { getCJToken, clearCJToken } from "./shared/cj-token.js";

// ─── AliExpress ──────────────────────────────────────────────────────────────

const AE_API_URL = "https://api-sg.aliexpress.com/sync";

// AliExpress Open Platform legacy signing: MD5(secret + sorted_kv + secret), uppercase hex.
// Matches the Commerce API adapter that's verified in production.
async function aeSign(params: Record<string, string>, appSecret: string): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const signStr = appSecret + sortedKeys.map((k) => `${k}${params[k]}`).join("") + appSecret;
  const hash = await crypto.subtle.digest("MD5", new TextEncoder().encode(signStr));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
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
  const timestamp = Date.now().toString();
  let params: Record<string, string>;
  let method: string;

  if (accessToken) {
    // True keyword search via aliexpress.ds.text.search.
    // Param shape mirrors the Commerce API adapter (verified in production):
    //   keyWord (capital W), access_token, pageNo/pageSize (camel), language/currency/local_country.
    method = "aliexpress.ds.text.search";
    params = {
      app_key:       appKey,
      method,
      timestamp,
      format:        "json",
      v:             "2.0",
      sign_method:   "md5",
      access_token:  accessToken,
      keyWord:       q,
      language:      "en",
      currency:      "USD",
      local_country: "US",
      countryCode:   "US",
      local:         "en_US",
      pageNo:        "1",
      pageSize:      String(pageSize),
      sort:          "LAST_VOLUME_DESC",
    };
    if (minPrice !== undefined) params.min_sale_price = String(minPrice * 100);
    if (maxPrice !== undefined) params.max_sale_price = String(maxPrice * 100);
  } else {
    // Trending feed fallback keeps snake_case per AE's own docs for this method.
    method = "aliexpress.ds.recommend.feed.get";
    params = {
      app_key:     appKey,
      method,
      timestamp,
      format:      "json",
      v:           "2.0",
      sign_method: "md5",
      feed_name:   "best_seller",
      page_no:     "1",
      page_size:   String(pageSize),
      language:    "en",
      currency:    "USD",
      country:     "US",
    };
  }

  params.sign = await aeSign(params, appSecret);

  const res = await fetch(AE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) return [];

  const data = await res.json() as any;

  if (method === "aliexpress.ds.text.search") {
    const inner = data?.aliexpress_ds_text_search_response?.data;
    const items: any[] = inner?.products?.selection_search_product ?? [];
    return items.map((p: any): RawProduct => ({
      supplier:  "aliexpress",
      sourceId:  String(p.itemId ?? ""),
      title:     p.title ?? "",
      price:     parseFloat(p.targetSalePrice ?? p.salePrice ?? "0"),
      currency:  p.targetOriginalPriceCurrency ?? "USD",
      imageUrl:  p.itemMainPic
                   ? (p.itemMainPic.startsWith("//") ? `https:${p.itemMainPic}` : p.itemMainPic)
                   : undefined,
      url:       p.itemUrl
                   ? (p.itemUrl.startsWith("//") ? `https:${p.itemUrl}` : p.itemUrl)
                   : `https://www.aliexpress.com/item/${p.itemId}.html`,
    }));
  } else {
    const items: any[] = data?.aliexpress_ds_recommend_feed_get_response?.result?.products?.traffic_product_d_t_o ?? [];
    return items.map((p: any): RawProduct => ({
      supplier:  "aliexpress",
      sourceId:  String(p.product_id ?? ""),
      title:     p.product_title ?? "",
      price:     parseFloat(p.target_sale_price ?? p.sale_price ?? "0"),
      currency:  p.target_sale_price_currency ?? "USD",
      imageUrl:  p.product_main_image_url ?? undefined,
      url:       p.product_detail_url ?? `https://www.aliexpress.com/item/${p.product_id}.html`,
    }));
  }
}

// ─── CJDropshipping ──────────────────────────────────────────────────────────

// `.cn` host. Search is /product/list with productNameEn — this is the keyword
// search endpoint (verified live returning 200 + products). /product/query is a
// by-id lookup that 400s ("pid or productSku must be not empty") on a name. The
// access token is served from ZoneCache (see shared/cj-token.ts) so we don't
// re-auth per request and trip CJ's getAccessToken throttle (429).
const CJ_API_BASE = "https://developers.cjdropshipping.cn/api2.0/v1";

async function searchCJ(
  apiKey: string,
  q: string,
  pageSize: number,
  context: ZuploContext
): Promise<RawProduct[]> {
  let token: string;
  try {
    token = await getCJToken(apiKey, context);
  } catch (e: any) {
    console.error(`[CJ] auth failed, skipping supplier: ${e.message}`);
    return [];
  }

  const url = new URL(`${CJ_API_BASE}/product/list`);
  url.searchParams.set("productNameEn", q);
  url.searchParams.set("pageNum",       "1");
  url.searchParams.set("pageSize",      String(pageSize));

  let res = await fetch(url.toString(), {
    headers: { "CJ-Access-Token": token },
    signal:  AbortSignal.timeout(12_000),
  });

  // Token may have been invalidated server-side — clear cache, re-auth once, retry
  if (res.status === 401) {
    console.warn("[CJ] product list returned 401, clearing cache and retrying");
    await clearCJToken(context);
    try {
      token = await getCJToken(apiKey, context);
    } catch (e: any) {
      console.error(`[CJ] re-auth failed: ${e.message}`);
      return [];
    }
    res = await fetch(url.toString(), {
      headers: { "CJ-Access-Token": token },
      signal:  AbortSignal.timeout(12_000),
    });
  }

  if (!res.ok) {
    console.error(`[CJ] product list HTTP ${res.status}`);
    return [];
  }

  const data = await res.json() as any;
  const items: any[] = data?.data?.list ?? [];

  return items.map((item: any): RawProduct => ({
    supplier:  "cj",
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

// Env switch + listProducts+client-filter pattern mirror the Commerce API
// adapter (verified in production). BigBuy's /catalog/searchproducts.json is
// effectively dead; the durable approach is list-then-filter on title/category.
function getBigBuyBase(): string {
  return getenv("BIGBUY_ENV") === "sandbox"
    ? "https://api.sandbox.bigbuy.eu/rest"
    : "https://api.bigbuy.eu/rest";
}

async function searchBigBuy(
  apiKey: string,
  q: string,
  pageSize: number
): Promise<RawProduct[]> {
  const base = getBigBuyBase();
  const url  = new URL(`${base}/catalog/products.json`);
  url.searchParams.set("isoCode",  "en");
  url.searchParams.set("_locale",  "en");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("page",     "0");

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

  const ql = q.toLowerCase();
  const filtered = items.filter((item: any) => {
    const title = String(item.name ?? item.description ?? "").toLowerCase();
    const cat   = String(item.categories?.[0]?.name ?? "").toLowerCase();
    return title.includes(ql) || cat.includes(ql);
  });

  return filtered.slice(0, pageSize).map((item: any): RawProduct => ({
    supplier:  "bigbuy",
    sourceId:  String(item.id ?? item.sku ?? ""),
    title:     item.name ?? item.description ?? "",
    price:     parseFloat(String(item.retailPrice ?? item.lowestPrice ?? item.price ?? "0")),
    currency:  "EUR",
    imageUrl:  item.images?.[0]?.url ?? undefined,
    url:       `https://www.bigbuy.eu/en/products/${item.sku ?? item.id ?? ""}`,
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

  console.log(`[CJ] apiKey present=${!!cjKey} key=${cjKey?.slice(0, 20)}...`);

  // Fan out to all configured suppliers in parallel; skip unconfigured ones silently
  const tasks: Promise<RawProduct[]>[] = [];

  if (aeKey && aeSecret) {
    tasks.push(
      searchAliExpress(aeKey, aeSecret, aeToken, body.q, perSupplier, body.minPrice, body.maxPrice)
        .catch(() => [])
    );
  }

  if (cjKey) {
    tasks.push(searchCJ(cjKey, body.q, perSupplier, context).catch(() => []));
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
