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
// If the URL is ALREADY an Impact link (ticketmaster.evyy.net or impact.com),
// Ticketmaster's Discovery API has pre-wrapped it — but with a regional
// action-tracker (e.g. 2038753/23890 for ticketmaster.de) that a publisher
// enrolled only in the US Ticketmaster program isn't authorised for. Impact
// rejects the click server-side as "The link you clicked on is malformed."
//
// Fix: extract the underlying event URL from the `u=` parameter of the pre-
// wrap and re-wrap with OUR configured template. Verified that the US
// tracker in the template accepts any regional Ticketmaster destination
// (.de, .co.uk, .pl, etc.) and appends full click-tracking correctly, so
// attribution is preserved across all markets without additional Impact
// enrolment.
export function tagTicketmasterUrl(url: string): string {
  const template = getenv("TICKETMASTER_IMPACT_LINK_TEMPLATE");
  if (!template || !template.includes("{url}")) return url;

  let destination = url;
  if (/ticketmaster\.evyy\.net|impact\.com/i.test(url)) {
    try {
      const inner = new URL(url).searchParams.get("u");
      if (!inner) return url;
      destination = inner;
    } catch {
      return url;
    }
  }

  return template.replace("{url}", encodeURIComponent(destination));
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
