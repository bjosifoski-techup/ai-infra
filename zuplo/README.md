# Zuplo MCP Gateway - Deployment Guide

9 HTTP endpoints (8 partner tools + 1 test route) deployed on Zuplo's managed platform.
No VPS or Docker required. JWT validation runs against the Keycloak instance on Elestio.

## Prerequisites

- Keycloak deployed on Elestio with `KEYCLOAK_ISSUER_URL` and `KEYCLOAK_JWKS_URL` known
- A Zuplo account at zuplo.com
- Partner API keys in `.env`

## Route map

| Route | Handler | Partner |
|---|---|---|
| `POST /dropshipping/aliexpress/search` | `aliexpress.ts` | AliExpress Open Platform |
| `POST /dropshipping/bigbuy/search` | `bigbuy.ts` | BigBuy REST API |
| `POST /dropshipping/cjdropshipping/search` | `cjdropshipping.ts` | CJDropshipping API v2 |
| `POST /travel/flights/search` | `travelpayouts.ts` (flightsHandler) | Aviasales via Travelpayouts |
| `POST /travel/hotels/search` | `travelpayouts.ts` (hotelsHandler) | Hotellook via Travelpayouts |
| `POST /travel/ticketmaster/search` | `ticketmaster.ts` | Ticketmaster Discovery API |
| `POST /travel/eventbrite/search` | `eventbrite.ts` | Eventbrite API v3 |
| `POST /travel/viator/search` | `viator.ts` | Viator Partner API |
| `POST /travel/stubhub/search` | `stubhub.ts` | StubHub API v3 |

All routes require a valid Keycloak Bearer token in the `Authorization` header.

## Deploy steps

### 1. Create a Zuplo project

1. Log in at zuplo.com
2. Click "New Project" - name it `emerico-ai-gateway`
3. Select "Start from scratch"

### 2. Upload the code

Option A - Git-backed deployment (recommended):
- Push this repo to GitHub (private repo)
- In the Zuplo dashboard, connect the project to the GitHub repo
- Set the source root to `zuplo/`
- Zuplo deploys on every push to `main`

Option B - Zuplo CLI:
```bash
npm install -g zuplo
zuplo login
cd zuplo/
zuplo deploy
```

### 3. Set environment variables

In the Zuplo dashboard, go to Settings > Environment Variables and add:

| Variable | Value (from your .env) |
|---|---|
| `KEYCLOAK_ISSUER_URL` | e.g. `https://keycloak.yourelestio.com/realms/emerico-commerce` |
| `KEYCLOAK_JWKS_URL` | e.g. `https://keycloak.yourelestio.com/realms/emerico-commerce/protocol/openid-connect/certs` |
| `LITELLM_JWT_AUDIENCE` | `emerico-litellm` |
| `ALIEXPRESS_APP_KEY` | from `.env` |
| `ALIEXPRESS_APP_SECRET` | from `.env` |
| `ALIEXPRESS_TRACKING_ID` | from `.env` (can be blank if not enrolled in affiliate program yet) |
| `BIGBUY_API_KEY` | from `.env` |
| `CJ_ACCESS_TOKEN` | from `.env` |
| `TRAVELPAYOUTS_API_TOKEN` | from `.env` |
| `TRAVELPAYOUTS_MARKER` | from `.env` (blank if not enrolled yet) |
| `TICKETMASTER_API_KEY` | from `.env` |
| `TICKETMASTER_AFFILIATE_ID` | from `.env` (blank if not enrolled yet) |
| `EVENTBRITE_API_TOKEN` | from `.env` |
| `EVENTBRITE_AFFILIATE_CODE` | from `.env` (blank if not enrolled yet) |
| `VIATOR_API_KEY` | from `.env` |
| `VIATOR_PARTNER_ID` | from `.env` (blank if not enrolled yet) |
| `STUBHUB_CLIENT_ID` | from `.env` |
| `STUBHUB_CLIENT_SECRET` | from `.env` |
| `STUBHUB_AFFILIATE_ID` | from `.env` (blank if not enrolled yet) |

### 4. Get the gateway URL

After deployment, Zuplo gives you a URL like:
```
https://emerico-ai-gateway-main-abc123.zuplo.app
```

Put this in your `.env` as `ZUPLO_MCP_BASE_URL`.

### 5. Generate a gateway API key (optional)

If you want an additional API key layer on top of JWT auth:
1. Go to Zuplo dashboard > API Key Service
2. Create a consumer and generate a key
3. Put the key in `.env` as `ZUPLO_GATEWAY_API_KEY`

## Testing a route

Once deployed, test with a valid Keycloak JWT:

```bash
curl -X POST https://<your-zuplo-url>/travel/ticketmaster/search \
  -H "Authorization: Bearer <keycloak_access_token>" \
  -H "Content-Type: application/json" \
  -d '{"query": "Taylor Swift", "city": "London"}'
```

Expected response:
```json
{
  "results": [...],
  "total": 5,
  "source": "ticketmaster"
}
```

## JWT auth notes

The `keycloak-jwt-auth` policy in `routes.oas.json` uses Zuplo's built-in
`OpenIdJwtInboundPolicy`. It validates:
- Token signature against the Keycloak JWKS endpoint
- Token issuer matches `KEYCLOAK_ISSUER_URL`
- Token audience matches `LITELLM_JWT_AUDIENCE`

Any request without a valid token gets a `401 Unauthorized` before the handler runs.

## Affiliate IDs

Affiliate tracking IDs are injected into response URLs by the handlers themselves,
not by the client. If a variable like `ALIEXPRESS_TRACKING_ID` is not set,
the URL is returned without modification. The AI model and the end user never see
the raw affiliate parameters - they just get a normal-looking URL that contains
your tracking code.

## Notes on specific partners

**AliExpress** - Requires HMAC-SHA256 request signing. The `sign()` function in
`aliexpress.ts` handles this. No changes needed unless AliExpress rotates their API shape.

**CJDropshipping** - The access token expires. If you see 401 errors from CJ routes,
regenerate the access token in the CJDropshipping developer portal and update
`CJ_ACCESS_TOKEN` in Zuplo's environment variables.

**StubHub** - Fetches an OAuth2 client credentials token per request. This adds one
extra HTTP round trip per call. For high traffic, consider caching the token in a
Zuplo plugin or key-value store until it expires.

**Travelpayouts** - Flights use the Aviasales v3 prices API (cached prices, very fast).
For real-time pricing, Travelpayouts has a separate search API that requires polling
- out of scope for this phase.
