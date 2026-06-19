// Shared TypeScript interfaces used across all Zuplo module handlers.

// Raw normalized product from a dropship supplier — no markup applied.
// Consumed server-side by Commerce API, which applies markup before anything reaches the browser.
export interface RawProduct {
  supplier:       string;   // "aliexpress" | "cjdropshipping" | "bigbuy"
  sourceId:       string;   // supplier's product ID
  title:          string;
  price:          number;   // raw supplier price — cost basis, never shown to end users
  currency:       string;
  imageUrl?:      string;
  url:            string;   // direct product URL (affiliate-tagged where configured)
  variantId?:     string;
  variantOptions?: Record<string, string>;
}

/** @deprecated — kept only so old supplier modules compile until Task 5 removes them */
export interface ProductResult {
  id:        string;
  title:     string;
  price:     number;
  currency:  string;
  url:       string;
  imageUrl?: string;
  supplier:  string;
}

export interface AffiliateCard {
  kind: "affiliate";
  provider: string;
  title: string;
  dateOrVenue?: string;
  imageUrl?: string;
  deepLinkUrl: string;
}

export interface ToolResponse<T> {
  results: T[];
  total?: number;
  source: string;
}

export function errorResponse(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonResponse<T>(data: ToolResponse<T>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
