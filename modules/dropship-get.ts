// Dropship product by-id — fetches a single product from the appropriate supplier
// and returns the raw normalized shape (no markup).
//
// Used by Commerce API's POST /cart/items to re-derive cost before Openfront insertion.
//
// Required env vars depend on the requested supplier:
//   aliexpress:     ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_ACCESS_TOKEN
//   cjdropshipping: CJ_API_KEY
//   bigbuy:         BIGBUY_API_KEY  (+ BIGBUY_SANDBOX=true for sandbox)

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { RawProduct, errorResponse } from "./shared/types.js";
import { getenv } from "./shared/env.js";

// ─── AliExpress ──────────────────────────────────────────────────────────────

const AE_API_URL = "https://api-sg.aliexpress.com/sync";

async function aeSign(params: Record<string, string>, appSecret: string): Promise<string> {
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

async function getAliExpress(
  appKey: string,
  appSecret: string,
  accessToken: string,
  sourceId: string
): Promise<RawProduct | null> {
  const timestamp = Date.now().toString();
  const params: Record<string, string> = {
    app_key:        appKey,
    method:         "aliexpress.ds.product.get",
    sign_method:    "sha256",
    timestamp,
    session:        accessToken,
    product_id:     sourceId,
    local_country:  "US",
    local_language: "EN",
  };
  params.sign = await aeSign(params, appSecret);

  const res = await fetch(AE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) return null;

  const data   = await res.json() as any;
  const result = data?.aliexpress_ds_product_get_response?.result;
  if (!result) return null;

  const priceInfo = result.ae_item_sku_info_dtos?.ae_item_sku_info_d_t_o?.[0];
  const price = parseFloat(
    priceInfo?.sku_price ?? result.ae_item_base_info_dto?.original_price ?? "0"
  );

  return {
    supplier:  "aliexpress",
    sourceId,
    title:     result.ae_item_base_info_dto?.subject ?? "",
    price,
    currency:  priceInfo?.currency_code ?? "USD",
    imageUrl:  result.ae_item_base_info_dto?.product_images?.split(";")[0] ?? undefined,
    url:       result.ae_item_base_info_dto?.detail_url
                 ?? `https://www.aliexpress.com/item/${sourceId}.html`,
  };
}

// ─── CJDropshipping ──────────────────────────────────────────────────────────

const CJ_AUTH_URL  = "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken";
const CJ_API_BASE  = "https://developers.cjdropshipping.com/api2.0/v1";
const CJ_TOKEN_TTL = 13 * 24 * 60 * 60 * 1000;

let cjTokenCache: { token: string; expiry: number } | null = null;

async function getCJToken(apiKey: string): Promise<string> {
  if (cjTokenCache && Date.now() < cjTokenCache.expiry) {
    return cjTokenCache.token;
  }

  const res = await fetch(CJ_AUTH_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ apiKey }),
    signal:  AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`CJ auth failed: ${res.status}`);

  const data  = await res.json() as any;
  const token = data?.data?.accessToken ?? "";
  if (!token) throw new Error("CJ auth returned no token");

  cjTokenCache = { token, expiry: Date.now() + CJ_TOKEN_TTL };
  return token;
}

async function getCJ(apiKey: string, sourceId: string): Promise<RawProduct | null> {
  let token: string;
  try {
    token = await getCJToken(apiKey);
  } catch {
    return null;
  }

  const url = new URL(`${CJ_API_BASE}/product/query`);
  url.searchParams.set("pid", sourceId);

  const res = await fetch(url.toString(), {
    headers: { "CJ-Access-Token": token },
    signal:  AbortSignal.timeout(12_000),
  });

  if (!res.ok) return null;

  const data = await res.json() as any;
  const item = data?.data;
  if (!item) return null;

  return {
    supplier:  "cj",
    sourceId,
    title:     item.productNameEn ?? item.productName ?? "",
    price:     parseFloat(item.sellPrice ?? item.price ?? "0"),
    currency:  "USD",
    imageUrl:  item.productImage ?? undefined,
    url:       item.productUrl ?? `https://cjdropshipping.com/product/${sourceId}.html`,
  };
}

// ─── BigBuy ──────────────────────────────────────────────────────────────────

function getBigBuyBase(): string {
  return getenv("BIGBUY_SANDBOX") === "true"
    ? "https://api.sandbox.bigbuy.eu/rest"
    : "https://api.bigbuy.eu/rest";
}

async function getBigBuy(apiKey: string, sourceId: string): Promise<RawProduct | null> {
  const url = `${getBigBuyBase()}/catalog/product/${encodeURIComponent(sourceId)}.json`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept:        "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) return null;

  const item = await res.json() as any;
  if (!item) return null;

  return {
    supplier:  "bigbuy",
    sourceId,
    title:     item.name ?? item.description ?? "",
    price:     parseFloat(String(item.retailPrice ?? item.price ?? "0")),
    currency:  "EUR",
    imageUrl:  item.images?.[0]?.url ?? undefined,
    url:       `https://www.bigbuy.eu/en/${sourceId}.html`,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  let body: {
    supplier: string;
    sourceId: string;
  };

  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.supplier || !body.sourceId) {
    return errorResponse("supplier and sourceId are required", 400);
  }

  const { supplier, sourceId } = body;
  let product: RawProduct | null = null;

  switch (supplier) {
    case "aliexpress": {
      const appKey    = getenv("ALIEXPRESS_APP_KEY");
      const appSecret = getenv("ALIEXPRESS_APP_SECRET");
      const token     = getenv("ALIEXPRESS_ACCESS_TOKEN");
      if (!appKey || !appSecret || !token) {
        return errorResponse("AliExpress credentials not configured", 503);
      }
      product = await getAliExpress(appKey, appSecret, token, sourceId);
      break;
    }

    case "cj": {
      const apiKey = getenv("CJ_API_KEY");
      if (!apiKey) return errorResponse("CJ_API_KEY not configured", 503);
      product = await getCJ(apiKey, sourceId);
      break;
    }

    case "bigbuy": {
      const apiKey = getenv("BIGBUY_API_KEY");
      if (!apiKey) return errorResponse("BIGBUY_API_KEY not configured", 503);
      product = await getBigBuy(apiKey, sourceId);
      break;
    }

    default:
      return errorResponse(`Unknown supplier: ${supplier}`, 400);
  }

  if (!product) {
    return errorResponse(`Product not found: ${supplier}/${sourceId}`, 404);
  }

  return new Response(JSON.stringify(product), {
    status:  200,
    headers: { "Content-Type": "application/json" },
  });
}
