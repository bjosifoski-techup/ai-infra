// Injects partner-specific affiliate tracking IDs into product/booking URLs.
// All tracking IDs are read from environment variables - never hardcoded.
import { getenv } from "./env.js";

function appendParam(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    // If URL parsing fails, return original unchanged
    return url;
  }
}

export function tagAliExpressUrl(url: string): string {
  const trackingId = getenv("ALIEXPRESS_TRACKING_ID");
  if (!trackingId) return url;
  return appendParam(url, "aff_trace_key", trackingId);
}

export function tagTravelpayoutsUrl(baseUrl: string): string {
  const marker = getenv("TRAVELPAYOUTS_MARKER");
  if (!marker) return baseUrl;
  return appendParam(baseUrl, "marker", marker);
}

export function tagTicketmasterUrl(url: string): string {
  const affiliateId = getenv("TICKETMASTER_AFFILIATE_ID");
  if (!affiliateId) return url;
  return appendParam(url, "aId", affiliateId);
}

export function tagEventbriteUrl(url: string): string {
  const code = getenv("EVENTBRITE_AFFILIATE_CODE");
  if (!code) return url;
  return appendParam(url, "aff", code);
}

export function tagViatorUrl(url: string): string {
  const partnerId = getenv("VIATOR_PARTNER_ID");
  if (!partnerId) return url;
  return appendParam(url, "pid", partnerId);
}

export function tagStubHubUrl(url: string): string {
  const affiliateId = getenv("STUBHUB_AFFILIATE_ID");
  if (!affiliateId) return url;
  return appendParam(url, "stid", affiliateId);
}
