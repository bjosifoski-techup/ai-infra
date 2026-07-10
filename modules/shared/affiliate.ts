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

// Ticketmaster runs its affiliate program through Impact (impact.com), NOT its
// own Partner Program. Impact does not attribute via appended query parameters
// on ticketmaster.com — it attributes via a redirect through Impact's tracking
// domain (ticketmaster.evyy.net), which sets a click-ID cookie and 302s to the
// destination URL in the `u=` parameter.
//
// The client's Impact template is set as TICKETMASTER_IMPACT_LINK_TEMPLATE and
// must contain a literal `{url}` placeholder — the Ticketmaster event URL is
// URL-encoded and substituted in. Example template:
//   https://ticketmaster.evyy.net/c/<PUB_ID>/<SHARED_ID>/<ACTION_ID>?u={url}
//
// If TICKETMASTER_IMPACT_LINK_TEMPLATE is unset, the URL passes through
// untagged — better an un-attributed link than a broken redirect.
//
// If the URL is ALREADY an Impact tracking link (ticketmaster.evyy.net or
// impact.com), it passes through unchanged. Ticketmaster's Discovery API
// returns pre-wrapped affiliate URLs for accounts with an active Impact
// integration (path segment carries the account's vanity slug, e.g.
// `evyy.net/c/acorre/...`). Wrapping those again produces a two-hop
// redirect that Impact rejects on the second hop as "The link you clicked
// on is malformed" — the user never reaches the event page.
export function tagTicketmasterUrl(url: string): string {
  if (/ticketmaster\.evyy\.net|impact\.com/i.test(url)) return url;

  const template = getenv("TICKETMASTER_IMPACT_LINK_TEMPLATE");
  if (!template || !template.includes("{url}")) return url;
  return template.replace("{url}", encodeURIComponent(url));
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
