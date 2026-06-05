// Injects partner-specific affiliate tracking IDs into product/booking URLs.
// All tracking IDs are read from environment variables - never hardcoded.

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
  const trackingId = process.env.ALIEXPRESS_TRACKING_ID;
  if (!trackingId) return url;
  return appendParam(url, "aff_trace_key", trackingId);
}

export function tagTravelpayoutsUrl(baseUrl: string): string {
  const marker = process.env.TRAVELPAYOUTS_MARKER;
  if (!marker) return baseUrl;
  return appendParam(baseUrl, "marker", marker);
}

export function tagTicketmasterUrl(url: string): string {
  const affiliateId = process.env.TICKETMASTER_AFFILIATE_ID;
  if (!affiliateId) return url;
  return appendParam(url, "aId", affiliateId);
}

export function tagEventbriteUrl(url: string): string {
  const code = process.env.EVENTBRITE_AFFILIATE_CODE;
  if (!code) return url;
  return appendParam(url, "aff", code);
}

export function tagViatorUrl(url: string): string {
  const partnerId = process.env.VIATOR_PARTNER_ID;
  if (!partnerId) return url;
  return appendParam(url, "pid", partnerId);
}

export function tagStubHubUrl(url: string): string {
  const affiliateId = process.env.STUBHUB_AFFILIATE_ID;
  if (!affiliateId) return url;
  return appendParam(url, "stid", affiliateId);
}
