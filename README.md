# Emerico AI Infrastructure | TEST

This repo contains all server-side infrastructure for the Emerico AI Commerce Platform. It is one of three repos that together make up the product.

| Repo | Purpose |
|---|---|
| **AI Infrastructure** (this repo) | Zuplo gateway, LiteLLM proxy handler, Memory API (Node/Express/MongoDB) |
| **AI Commerce** | Next.js frontend, Edge chat route, SYSTEM_PROMPT, cart UI |
| **AI Commerce API** | Fastify backend, Postgres, supplier adapters, markup rules, cart endpoint |

GitHub org: `tech-up-dev`. All repos branch from `dev`.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Zuplo Gateway](#2-zuplo-gateway)
3. [LiteLLM Proxy](#3-litellm-proxy)
4. [Memory API](#4-memory-api)
5. [Keycloak Identity](#5-keycloak-identity)
6. [Shared Types](#6-shared-types)
7. [Affiliate Tracking](#7-affiliate-tracking)
8. [Environment Variables](#8-environment-variables)
9. [Running Locally](#9-running-locally)
10. [Deployment](#10-deployment)
11. [Adding a New MCP Server](#11-adding-a-new-mcp-server)
12. [MCP-UI Integration Note](#12-mcp-ui-integration-note)
13. [Dropshipping Architecture: Chat Path vs. Direct Integration Path](#13-dropshipping-architecture-chat-path-vs-direct-integration-path)
14. [Why Modules Are Hand-Built](#14-why-modules-are-hand-built-not-auto-generated-from-openapi)
15. [Known Bugs & Status](#15-known-bugs--status)
16. [v2 Implementation Status](#16-v2-implementation-status)

---

## 1. System Architecture

### The Three Repos and How They Connect

```
[Browser]
    |
    |-- Auth ─────────────────────────────► [Keycloak on Elestio]
    |                                        Realm: emerico-commerce
    |                                        Issues JWT (sub + tier claim)
    |
[AI Commerce — Next.js on Vercel]
    |
    |-- (1) GET /short-term/:sessionId ──► [Memory API — this repo]
    |   GET /long-term                      MongoDB Atlas, scoped by JWT sub
    |
    |-- (2) POST /v1/chat/completions ───► [Zuplo Gateway — this repo]
    |        + Keycloak JWT                 JWT validation → LiteLLM proxy handler
    |                                             |
    |                                             └──► [LiteLLM on Elestio]
    |                                                        |
    |                                                        └──► [Gemma 3 12B on Koyeb]
    |                                                             (client's self-hosted)
    |
    |-- (3) Dropship search ─────────────► [AI Commerce API]
    |        GET /storefront/products         App's dropship_product_search routes HERE
    |        (markup applied, rawPrice        NOT to Infra. Infra's /dropshipping/*
    |         never leaves server)            is the future #34 surface, not wired now.
    |
    |-- (4) Affiliate tool calls ─────────► [Zuplo tool endpoints — this repo]
    |        POST /travel/flights/search     Called directly by route.ts in App
    |        POST /travel/hotels/search      NOT by LiteLLM
    |        ... etc                         Returns AffiliateCard[] only
    |
    |-- (5) POST /short-term/:sessionId/messages ► [Memory API — this repo]
    |        POST /long-term/summaries              Save turn after response
    |
    └── Storefront / Cart ─────────────► [AI Commerce API]
                                          Fastify, Postgres, supplier adapters
                                          Applies markup, manages cart, re-derives
                                          cost at cart time via its own by-id
```

### Two Separate Product Search Paths

**AI Chat** (`/home` tab in App):
- User sends message → App's Edge route (`route.ts`) → Zuplo `/v1/chat/completions` → LiteLLM → Gemma
- Gemma returns `tool_calls` → `route.ts` calls Zuplo tool endpoints directly
- Tool results injected back as `"user"` role message (Gemma doesn't support `"tool"` role)
- Gemma synthesizes final text → streamed as AG-UI SSE events to browser

**Shopping tab** (`/shopping` in App):
- `GET /storefront/products?q=...` → AI Commerce API aggregator
- Fans out to Openfront GraphQL, AliExpress DS API, CJ API, BigBuy REST
- `applyMarkupToProducts()` applied → `UnifiedProduct[]` returned to browser

### Key Infrastructure

| Service | URL / Location | Role |
|---|---|---|
| Zuplo gateway | `https://acorre-dev-dfb05c0.zuplo.app` | JWT validation + tool endpoint execution |
| LiteLLM | Elestio (pass-through) | Rate limiting by tier, routes to Gemma |
| Gemma 3 12B | Koyeb (`emerico-chat` alias in LiteLLM) | The LLM — client's self-hosted |
| Keycloak | Elestio, realm `emerico-commerce` | Identity provider for all 3 repos |
| Memory API | This repo, `memory-api/` | Short-term (24h TTL) + long-term per-user memory |
| MongoDB Atlas | Cloud | Backing store for memory API |
| AI Commerce API | Port 4000 locally | Markup, supplier adapters, cart, storefront |
| Next.js App | Port 3000 locally | Frontend |

---

## 2. Zuplo Gateway

Zuplo is the REST gateway. It handles two things:
1. **`/v1/chat/completions`** — validates the Keycloak JWT, then proxies to LiteLLM (strips Keycloak token, injects LiteLLM master key).
2. **Tool endpoints** — each tool is a route that calls a real external API via a TypeScript module handler.

### Routes

All routes are defined in [`config/routes.oas.json`](config/routes.oas.json).

#### Chat / LiteLLM Proxy

| Method | Path | Module | Notes |
|---|---|---|---|
| POST | `/v1/chat/completions` | `modules/litellm-proxy.ts` | Keycloak JWT validated by inbound policy, then swapped for LiteLLM master key |
| GET | `/v1/models` | `modules/litellm-proxy.ts` | List available models |
| POST | `/v1/completions` | `modules/litellm-proxy.ts` | Text completions (non-chat) |
| POST | `/v1/embeddings` | `modules/litellm-proxy.ts` | Embeddings endpoint |

#### Dropshipping (issue #34 surface — built, not wired into live chat path)

These routes exist and are deployed but **the App does not call them**. The App's `dropship_product_search` tool routes to Commerce API's `GET /storefront/products` (where markup is applied). These routes are the future consolidation surface for issue #34, when Commerce will source raw cost from Infra instead of its own adapters. No code change in the App is needed when that happens — only Commerce changes.

| Method | Path | Module | Returns |
|---|---|---|---|
| POST | `/dropshipping/search` | `modules/dropship-search.ts` | `RawProduct[]` — fans out to AliExpress + CJ + BigBuy in parallel. Raw prices, no markup. |
| POST | `/dropshipping/get` | `modules/dropship-get.ts` | Single `RawProduct` by `{ supplier, sourceId }`. Used by Commerce to re-derive cost at cart time (deferred — Commerce uses its own by-id today). |

**Supplier values:** `"aliexpress"`, `"cj"`, `"bigbuy"`. Note: `"cj"` not `"cjdropshipping"` — this is locked because Commerce's `externalId = "{supplier}:{sourceId}"` and Openship's fulfillment routing depend on it.

#### Dropshipping (v1 — legacy, pending removal in Task 4/5)

| Method | Path | Module | Notes |
|---|---|---|---|
| POST | `/dropshipping/aliexpress/search` | `modules/aliexpress.ts` | Returns old `ProductResult[]` shape |
| POST | `/dropshipping/bigbuy/search` | `modules/bigbuy.ts` | Returns old `ProductResult[]` shape |
| POST | `/dropshipping/cjdropshipping/search` | `modules/cjdropshipping.ts` | Returns old `ProductResult[]` shape |

#### Travel & Events

| Method | Path | Module | Returns |
|---|---|---|---|
| POST | `/travel/flights/search` | `modules/travelpayouts.ts` | `AffiliateCard[]` |
| POST | `/travel/hotels/search` | `modules/travelpayouts.ts` | `AffiliateCard[]` |
| POST | `/travel/kayak/flights/search` | `modules/kayak.ts` | `AffiliateCard[]` |
| POST | `/travel/kayak/hotels/search` | `modules/kayak.ts` | `AffiliateCard[]` |
| POST | `/travel/viator/search` | `modules/viator.ts` | `AffiliateCard[]` |
| POST | `/travel/stubhub/search` | `modules/stubhub.ts` | `AffiliateCard[]` |
| POST | `/travel/ticketmaster/search` | `modules/ticketmaster.ts` | `AffiliateCard[]` |
| POST | `/travel/eventbrite/search` | `modules/eventbrite.ts` | `AffiliateCard[]` |

### Module Files

| File | Purpose |
|---|---|
| `modules/litellm-proxy.ts` | Strips Keycloak JWT, injects LiteLLM master key, proxies request |
| `modules/dropship-search.ts` | Fans out to AliExpress / CJ / BigBuy in parallel, normalizes to `RawProduct[]` |
| `modules/dropship-get.ts` | Fetches single product by-id from the appropriate supplier |
| `modules/aliexpress.ts` | Legacy — individual AliExpress search (v1, pending deletion in Task 5) |
| `modules/bigbuy.ts` | Legacy — individual BigBuy search (v1, pending deletion in Task 5) |
| `modules/cjdropshipping.ts` | Legacy — individual CJ search (v1, pending deletion in Task 5) |
| `modules/travelpayouts.ts` | Flights + hotels search via Travelpayouts API |
| `modules/kayak.ts` | Flights + hotels search via Kayak Affiliate Network (async poll APIs) |
| `modules/viator.ts` | Experience search via Viator API |
| `modules/stubhub.ts` | Ticket search via StubHub API |
| `modules/ticketmaster.ts` | Event search via Ticketmaster Discovery API |
| `modules/eventbrite.ts` | Event search via Eventbrite API |
| `modules/shared/types.ts` | Shared interfaces: `RawProduct`, `AffiliateCard`, `ToolResponse<T>` |
| `modules/shared/affiliate.ts` | Injects partner tracking IDs into URLs |
| `modules/shared/env.ts` | Safe env var accessor for Zuplo's Web Workers runtime |

### Request Payloads

#### `POST /dropshipping/search`

```json
{
  "q": "wireless headphones",
  "pageSize": 10,
  "page": 1,
  "minPrice": 10,
  "maxPrice": 100,
  "currency": "USD",
  "locale": "en"
}
```

Returns:
```json
{
  "products": [
    {
      "supplier": "aliexpress",
      "sourceId": "1234567890",
      "title": "...",
      "price": 12.99,
      "currency": "USD",
      "imageUrl": "https://...",
      "url": "https://..."
    }
  ],
  "sources": ["aliexpress", "cj", "bigbuy"],
  "total": 10,
  "page": 1,
  "limit": 10
}
```

#### `POST /dropshipping/get`

```json
{ "supplier": "aliexpress", "sourceId": "1234567890" }
```

Returns a single `RawProduct` object or `404`.

#### `POST /travel/flights/search`

```json
{
  "origin": "JFK",
  "destination": "LAX",
  "departureDate": "2026-08-01",
  "returnDate": "2026-08-08",
  "adults": 1,
  "currency": "USD",
  "pageSize": 10
}
```

#### `POST /travel/hotels/search`

```json
{
  "destination": "Paris",
  "checkIn": "2026-08-01",
  "checkOut": "2026-08-07",
  "guests": 2,
  "currency": "USD"
}
```

#### `POST /travel/kayak/flights/search`

```json
{
  "origin": "BOS",
  "destination": "JFK",
  "departureDate": "2026-08-10",
  "returnDate": "2026-08-17",
  "adults": 1,
  "cabin": "economy",
  "currency": "USD"
}
```

`origin`, `destination`, `departureDate` are required (`origin`/`destination` are IATA codes). `cabin` is one of `economy | premium | business | first`. The handler starts the async Kayak search (`POST /i/api/affiliate/search/flight/v1/poll`) and polls until `status: "complete"`, then maps `results[].bookingOptions[].bookingUrl` into each card's `deepLinkUrl`.

#### `POST /travel/kayak/hotels/search`

```json
{
  "destination": "Boston",
  "checkIn": "2026-08-10",
  "checkOut": "2026-08-12",
  "guests": 2,
  "currency": "USD"
}
```

`destination` accepts a plain place name (resolved to a Kayak `entityKey` via `/api/affiliate/autocomplete/v1/hotels`) or a raw `entityKey` such as `kplace:58075`. The handler polls `GET /api/3.0/hotels` until `isComplete`, requesting `responseOptions=topRates,images` so each card gets an image and the provider booking link (`rates[].bookUri`).

> **Kayak specifics:** auth is the `apiKey` **query** param; every call also sends `User-Agent: kayakaffiliateapp` (any other value → `400 INVALID_USER_AGENT`), an `x-original-client-ip` header, and a per-request `userTrackId` UUID. In the sandbox, deep links and images are placeholders — they resolve to real monetized links in production.

#### `POST /travel/viator/search`

```json
{ "destination": "Rome", "query": "cooking class", "pageSize": 10, "currency": "USD" }
```

`destination` is required. `query` is optional.

#### `POST /travel/ticketmaster/search`

```json
{
  "query": "Taylor Swift",
  "city": "London",
  "countryCode": "GB",
  "startDate": "2026-07-01",
  "endDate": "2026-12-31",
  "pageSize": 10
}
```

#### `POST /travel/eventbrite/search`

```json
{ "query": "tech conference", "location": "New York", "startDate": "2026-08-01", "pageSize": 10 }
```

#### `POST /travel/stubhub/search`

```json
{ "query": "NBA Finals", "city": "Boston", "startDate": "2026-06-01", "pageSize": 10 }
```

All travel/event endpoints return:
```json
{
  "results": [
    {
      "kind": "affiliate",
      "provider": "ticketmaster",
      "title": "Taylor Swift — Eras Tour",
      "dateOrVenue": "2026-08-15 · Wembley Stadium, London",
      "imageUrl": "https://...",
      "deepLinkUrl": "https://www.ticketmaster.com/event/...?aId=AFFILIATE_ID"
    }
  ],
  "total": 5,
  "source": "ticketmaster"
}
```

---

## 3. LiteLLM Proxy

LiteLLM is deployed on Elestio. It is **stateless** — it only validates the JWT, enforces per-tier rate limits, and forwards to Gemma. It does not call the memory API, does not trigger tool calls, and does not inject affiliate links.

The Zuplo handler `modules/litellm-proxy.ts` sits in front of it:

```
App → POST /v1/chat/completions (Keycloak JWT)
      → Zuplo inbound policy validates JWT
      → litellm-proxy.ts strips Keycloak JWT, injects LITELLM_MASTER_KEY
      → LiteLLM on Elestio receives Bearer <master-key>
      → LiteLLM rate-limits by tier claim, routes to Gemma
      → Response streams back
```

### Rate Limit Tiers

Configured in [`litellm/litellm_config.yaml`](litellm/litellm_config.yaml). Tier is read from the `tier` claim in the Keycloak JWT. LiteLLM enforces it automatically.

| Tier | RPM | TPM | Daily budget |
|---|---|---|---|
| `guest` | 5 | 5,000 | $0.10 |
| `free` | 20 | 20,000 | $0.50 |
| `silver` | 60 | 60,000 | $2.00 |
| `gold` | 120 | 120,000 | $5.00 |
| `platinum` | 300 | 300,000 | $15.00 |
| `admin` | — | — | — (not in config, unlimited by convention) |

### Models

| Alias | Model | Notes |
|---|---|---|
| `emerico-chat` | Gemma 3 12B on Koyeb | Default chat model |
| `emerico-chat-pro` | Gemma 27B on Koyeb | Higher-capability model — stored in LiteLLM DB, not in `litellm_config.yaml`. Verify it exists via the LiteLLM admin UI if it stops working. |

Both models are hosted on Koyeb by the client (Emerico AI Sdn Bhd).

### Key LiteLLM Config Notes

- `drop_params: true` is set — this silently drops parameters the model doesn't support (e.g. unsupported tool formats). If tool calling stops working, check this setting first and try `drop_params: false` to surface the real error.
- Does **not** support the `"tool"` role — tool results are injected as `"user"` role messages in `route.ts`
- Detects `tool_code` blocks in Gemma text output and suppresses them with a retry in `route.ts`

---

## 4. Memory API

Node.js + Express + Mongoose service in `memory-api/`. Runs separately from Zuplo. All routes require a valid Keycloak JWT — the `sub` claim is the user ID for all reads/writes. Cross-user access is impossible by design.

### Starting the Memory API

```bash
cd memory-api
npm install
npm run dev   # listens on MEMORY_API_PORT (default 3001)
```

Swagger UI: `GET /docs` (no auth). Health check: `GET /health`.

### Short-Term Memory

Sliding conversation window. **TTL: 24 hours** after last activity. **Cap: 100 messages** per session (oldest dropped).

#### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/short-term/sessions` | List all session IDs for the authenticated user |
| `GET` | `/short-term/:sessionId` | Get all messages for a session |
| `POST` | `/short-term/:sessionId/messages` | Append a message to a session |
| `DELETE` | `/short-term/:sessionId` | Clear a session |

#### `POST /short-term/:sessionId/messages` body

```json
{
  "role": "user",
  "content": "Find me headphones under $50",
  "toolCalls": []
}
```

`role` must be `"user"`, `"assistant"`, or `"system"`. Either `content` or `toolCalls` is required.

#### MongoDB Schema — `shortTermMemory` collection

```
userId        String   (indexed)
sessionId     String
messages[]
  role        "user" | "assistant" | "system"
  content     String
  toolCalls[] { name, arguments }
  timestamp   Date
lastActivity  Date     TTL index — expires 24h after last activity
```

Compound unique index: `{ userId, sessionId }`.

### Long-Term Memory

One document per user. **Cap: 50 conversation summaries, 50 cart activity records** (oldest dropped on save).

#### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/long-term` | Get the full long-term profile for the user |
| `PATCH` | `/long-term/preferences` | Merge-update user preferences |
| `POST` | `/long-term/summaries` | Append a conversation summary |
| `POST` | `/long-term/cart-activity` | Record an add-to-cart event |
| `POST` | `/long-term/purchases` | Record a completed purchase |

#### `PATCH /long-term/preferences` body

Any JSON object — merged into existing preferences:
```json
{ "language": "en", "currency": "USD", "preferredCategories": ["electronics"] }
```

#### `POST /long-term/summaries` body

```json
{ "summary": "User looking for Sony headphones, budget $50-$100." }
```

#### `POST /long-term/cart-activity` body

```json
{
  "source": "aliexpress",
  "productId": "1234567890",
  "productName": "Sony WH-1000XM5",
  "variantId": null,
  "price": 49.99,
  "currency": "USD",
  "thumbnail": "https://...",
  "addedAt": "2026-06-19T10:00:00Z"
}
```

**Upsert behavior:** if `productId` already exists in the user's `cartActivity`, the entry is updated in place (`addedAt`, `price`, `productName`, `thumbnail` refreshed) rather than appending a duplicate.

#### `POST /long-term/purchases` body

```json
{
  "orderId": "ORD-123",
  "source": "aliexpress",
  "productId": "1234567890",
  "productName": "Sony WH-1000XM5",
  "amount": 49.99,
  "currency": "USD",
  "purchasedAt": "2026-06-19T12:00:00Z"
}
```

#### MongoDB Schema — `longTermMemory` collection

```
userId                  String    (unique index)
preferences             Object    (open schema — any key-value pairs)
  language              String?
  currency              String?
  preferredCategories   String[]
conversationSummaries[]
  summary               String
  createdAt             Date
purchaseHistory[]
  orderId               String
  source                String
  productId             String
  productName           String
  amount                Number
  currency              String
  purchasedAt           Date
cartActivity[]
  source                String
  productId             String
  productName           String
  variantId             String?
  price                 Number
  currency              String
  thumbnail             String?
  addedAt               Date
```

### Shopping Search History

Stores the user's past shopping searches and their results. **Cap: 20 searches per user** (oldest pruned automatically). De-duplicates: if the most recent search has the same query, results are updated in place rather than creating a new entry.

#### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/shopping/searches` | Save a search query + results |
| `GET` | `/shopping/searches` | List past searches (metadata only, no results) — `?limit=10` (max 50) |
| `GET` | `/shopping/searches/last` | Get the most recent search with full results. Returns `204` if none. |
| `GET` | `/shopping/searches/:id` | Get a specific search with full results |
| `PUT` | `/shopping/searches/:id` | Update results on an existing search |
| `DELETE` | `/shopping/searches/:id` | Delete a specific search |
| `DELETE` | `/shopping/searches` | Clear all searches for the user |

#### `POST /shopping/searches` body

```json
{
  "query": "wireless headphones",
  "results": { "products": [...] }
}
```

`results` can be any JSON object — the schema is open (`Mixed` type).

#### Frontend integration contract

- Call `POST /shopping/searches` only when the user **intentionally submits a search** (not on re-renders, sort changes, or pagination).
- On `/shopping` page load with **no `?q=` in the URL**: call `GET /shopping/searches/last`. If `200`, render cached results immediately and populate the search box — no live supplier query needed. If `204`, show the empty state.
- **Refresh button**: re-run `GET /storefront/products?q=<query>` yourself, then call `PUT /shopping/searches/:id` with the fresh results.
- **Search history sidebar**: `GET /shopping/searches?limit=10` — returns metadata only (no `results`), suitable for rendering a list of past queries.

See [`memory-api/SHOPPING_SEARCH_API.md`](memory-api/SHOPPING_SEARCH_API.md) for the full integration spec.

#### MongoDB Schema — `shoppingsearches` collection

```
userId     String   (indexed)
query      String
results    Mixed    (any JSON object — the raw search response)
createdAt  Date
updatedAt  Date
```

Compound index: `{ userId, createdAt: -1 }`.

### Auth Middleware

`memory-api/src/middleware/auth.ts` — validates Keycloak JWT via JWKS, extracts `sub` as `userId` and `tier`. Every route handler uses `req.userId` — it cannot be omitted or bypassed.

---

## 5. Keycloak Identity

Deployed on Elestio. Realm: `emerico-commerce`.

**DO NOT rename the realm or any client IDs** — they are referenced across all three repos and in the NextAuth config.

### OIDC Clients

| Client ID | Type | Used by |
|---|---|---|
| `emerico-frontend` | Public, PKCE | Next.js app (NextAuth) |
| `emerico-litellm` | Confidential | LiteLLM (validates JWTs) |
| `emerico-memory-api` | Confidential | Memory API (validates JWTs) |
| `emerico-zuplo` | Confidential | Zuplo gateway (validates JWTs) |
| `emerico-backend` | Confidential, client_credentials | Service-to-service calls and testing. Use this to get a token for manual API testing — `grant_type=client_credentials`. |

### Tier Roles

| Role | Access level |
|---|---|
| `guest` | Unauthenticated / no subscription |
| `free` | Registered, free plan |
| `silver` | Paid tier 1 |
| `gold` | Paid tier 2 |
| `platinum` | Paid tier 3 |
| `admin` | Platform admin |

The `tier` claim is added to every JWT by a protocol mapper. LiteLLM reads it for rate limiting. Memory API reads it and attaches it to `req.tier`.

### JWT Claims Used

| Claim | Value | Used by |
|---|---|---|
| `sub` | User UUID | Memory API (scopes all reads/writes) |
| `tier` | Role name e.g. `"silver"` | LiteLLM (rate limiting), Memory API |
| `iss` | Keycloak issuer URL | All validators |
| `aud` | Client ID | LiteLLM + Memory API audience check |

### Setup

See [`keycloak/SETUP.md`](keycloak/SETUP.md) for full step-by-step. The realm is pre-exported to [`keycloak/realm-export.json`](keycloak/realm-export.json) — import it and then only set client secrets and redirect URIs manually.

When a user upgrades their Stripe plan, the Commerce API calls the Keycloak Admin API to update the user's realm role so the next token contains the new `tier` claim.

---

## 6. Shared Types

Defined in [`modules/shared/types.ts`](modules/shared/types.ts). Load-bearing contracts between Infra, App, and Commerce API.

### `RawProduct`

Returned by `/dropshipping/search` and `/dropshipping/get`. Raw supplier prices — **no markup applied**. Markup is applied exclusively in AI Commerce API.

```typescript
interface RawProduct {
  supplier:        string;   // "aliexpress" | "cj" | "bigbuy"
  sourceId:        string;   // supplier's product ID
  title:           string;
  price:           number;   // raw supplier price — cost basis, never shown to end users
  currency:        string;
  imageUrl?:       string;
  url:             string;   // direct product URL (affiliate-tagged where configured)
  variantId?:      string;
  variantOptions?: Record<string, string>;
}
```

### `AffiliateCard`

Returned by all travel and event tool endpoints.

```typescript
interface AffiliateCard {
  kind:         "affiliate";
  provider:     string;   // "travelpayouts" | "viator" | "ticketmaster" | "eventbrite" | "stubhub"
  title:        string;
  dateOrVenue?: string;   // e.g. "2026-08-15 · Wembley Stadium, London"
  imageUrl?:    string;
  deepLinkUrl:  string;   // affiliate-tagged URL
}
```

### `ToolResponse<T>`

Wrapper for all tool endpoint responses:

```typescript
interface ToolResponse<T> {
  results: T[];
  total?:  number;
  source:  string;
}
```

### `ProductResult` (deprecated)

Kept as a stub so the old v1 supplier modules (`aliexpress.ts`, `bigbuy.ts`, `cjdropshipping.ts`) compile until they are deleted in Task 5. Do not use in new code.

---

## 7. Affiliate Tracking

Implemented in [`modules/shared/affiliate.ts`](modules/shared/affiliate.ts). Every travel/event deep link has the partner tracking ID appended before the result is returned. The LLM receives already-tagged links and includes them verbatim.

| Function | Env var | Param added |
|---|---|---|
| `tagAliExpressUrl(url)` | `ALIEXPRESS_TRACKING_ID` | `aff_trace_key` |
| `tagTravelpayoutsUrl(url)` | `TRAVELPAYOUTS_MARKER` | `marker` |
| `tagTicketmasterUrl(url)` | `TICKETMASTER_AFFILIATE_ID` | `aId` |
| `tagEventbriteUrl(url)` | `EVENTBRITE_AFFILIATE_CODE` | `aff` |
| `tagViatorUrl(url)` | `VIATOR_PARTNER_ID` | `pid` |
| `tagStubHubUrl(url)` | `STUBHUB_AFFILIATE_ID` | `stid` |

If the env var is not set, the original URL is returned unchanged.

---

## 8. Environment Variables

A complete `.env.example` covering every variable for every component lives at the repo root: [`.env.example`](.env.example). Copy it to `.env` and fill in the values. The `.env` file is gitignored — never commit it.

The memory API uses a **separate** `memory-api/.env` — see its own variables below.

### Zuplo Gateway

Set these in the Zuplo dashboard → Project settings → Environment variables.

#### Zuplo platform

| Variable | Notes |
|---|---|
| `ZUPLO_API_KEY` | Generated in Zuplo account → project settings. Used by the Zuplo CLI / git deploy. |
| `ZUPLO_PROJECT_NAME` | Name of the Zuplo gateway project. |
| `ZUPLO_GATEWAY_API_KEY` | Service key so the chat layer can call the gateway. |
| `ZUPLO_MCP_BASE_URL` | Public base URL of the deployed Zuplo gateway, e.g. `https://acorre-dev-dfb05c0.zuplo.app` |

#### Keycloak (Zuplo JWT policy)

| Variable | Notes |
|---|---|
| `KEYCLOAK_ISSUER_URL` | e.g. `https://<keycloak>/realms/emerico-commerce` — verifies `iss` claim |
| `KEYCLOAK_JWKS_URL` | e.g. `{KEYCLOAK_ISSUER_URL}/protocol/openid-connect/certs` — fetches signing keys |

#### LiteLLM proxy

| Variable | Notes |
|---|---|
| `LITELLM_BASE_URL` | LiteLLM public URL on Elestio |
| `LITELLM_MASTER_KEY` | Used by `litellm-proxy.ts` to authenticate with LiteLLM |

#### AliExpress

| Variable | Required | Notes |
|---|---|---|
| `ALIEXPRESS_APP_KEY` | Yes | App key from AliExpress Open Platform |
| `ALIEXPRESS_APP_SECRET` | Yes | App secret, used for HMAC-SHA256 request signing |
| `ALIEXPRESS_ACCESS_TOKEN` | **Recommended** | OAuth session token. If set, enables true keyword search (`aliexpress.ds.text.search`). Without it, falls back to the best-seller feed — results are not query-relevant. **Set this in Zuplo env vars.** |
| `ALIEXPRESS_TRACKING_ID` | No | Affiliate tracking ID — appended as `aff_trace_key` |

**AliExpress DS API signing (verified against live API):** All requests are `POST` to `https://api-sg.aliexpress.com/sync` with `Content-Type: application/x-www-form-urlencoded`. The signature is `HMAC-SHA256(sorted_key_value_pairs, key=appSecret)` where sorted means alphabetically sorted concatenation of `key+value` pairs from all params including `app_key`, `method`, `sign_method`, `timestamp`. **Do not wrap with appSecret prefix/suffix** — that is the old MD5 pattern and produces wrong signatures.

`aliexpress.ds.product.get` requires `ship_to_country` as a **mandatory** param (in addition to `product_id`, `session`, `local_country`, `local_language`). Without it the API returns a `MissingParameter` error.

#### CJDropshipping

| Variable | Required | Notes |
|---|---|---|
| `CJ_API_KEY` | Yes | Used to obtain a short-lived access token (auto-refreshed, 13-day TTL) |
| `CJ_EMAIL` | No | CJDropshipping account email — not read by code at runtime, kept for reference |

#### BigBuy

| Variable | Required | Notes |
|---|---|---|
| `BIGBUY_API_KEY` | Yes | Bearer token for BigBuy REST API |
| `BIGBUY_SANDBOX` | No | Set to `"true"` to use `api.sandbox.bigbuy.eu` |

#### Travelpayouts (Flights + Hotels)

| Variable | Required | Notes |
|---|---|---|
| `TRAVELPAYOUTS_API_TOKEN` | Yes | API token from Travelpayouts dashboard |
| `TRAVELPAYOUTS_MARKER` | No | Affiliate marker — appended as `marker` |

#### Kayak (Flights + Hotels)

| Variable | Required | Notes |
|---|---|---|
| `KAYAK_API_KEY` | Yes | Kayak Affiliate Network API key, sent as the `apiKey` query param |
| `KAYAK_BASE_URL` | No | Defaults to `https://sandbox-en-us.kayakaffiliates.com`; swap to the production host once approved |
| `KAYAK_USER_AGENT` | No | Defaults to `kayakaffiliateapp` — Kayak rejects any other value with `400 INVALID_USER_AGENT` |

#### Viator

| Variable | Required | Notes |
|---|---|---|
| `VIATOR_API_KEY` | Yes | Partner API key (requires approved Viator affiliate account) |
| `VIATOR_SANDBOX` | No | Set to `"true"` to use Viator's sandbox environment |
| `VIATOR_PARTNER_ID` | No | Affiliate partner ID — appended as `pid` |

#### Ticketmaster

| Variable | Required | Notes |
|---|---|---|
| `TICKETMASTER_API_KEY` | Yes | Discovery API consumer key |
| `TICKETMASTER_API_SECRET` | Yes | Discovery API consumer secret |
| `TICKETMASTER_AFFILIATE_ID` | No | Appended as `aId` |

#### Eventbrite

| Variable | Required | Notes |
|---|---|---|
| `EVENTBRITE_API_TOKEN` | Yes | OAuth / private token |
| `EVENTBRITE_AFFILIATE_CODE` | No | Appended as `aff` |

> **Account scope limitation:** The current `EVENTBRITE_API_TOKEN` is an organization-scoped token tied to a specific event organizer account. The Eventbrite API uses this token to determine which events are accessible — an org-scoped token can only read events belonging to that organization, not the public Eventbrite catalog. The proposal's "event search and affiliate deep link generation" deliverable requires public event search scope. To unblock this, the client needs to either (a) provide a Personal OAuth token generated under an Eventbrite account with the `event:read` public scope that covers all public listings, or (b) confirm that the intended use is exclusively showing the organization's own events (in which case the current integration is correct and results will always be limited to their listings).

#### StubHub

| Variable | Required | Notes |
|---|---|---|
| `STUBHUB_CLIENT_ID` | Yes | OAuth2 client ID |
| `STUBHUB_CLIENT_SECRET` | Yes | OAuth2 client secret |
| `STUBHUB_AFFILIATE_ID` | No | Appended as `stid` |

### LiteLLM (Elestio service env vars)

| Variable | Notes |
|---|---|
| `LITELLM_MASTER_KEY` | Master admin key — generate with `openssl rand -hex 32`. Do not change after first use. |
| `LITELLM_SALT_KEY` | Encrypts stored API keys in the DB — generate once with `openssl rand -hex 32`. Rotating it breaks stored keys. |
| `LITELLM_DATABASE_URL` | Postgres connection string — provisioned automatically by Elestio alongside LiteLLM. |
| `LITELLM_UI_USERNAME` | Protects the `/ui` admin panel. |
| `LITELLM_UI_PASSWORD` | Protects the `/ui` admin panel. |
| `LITELLM_JWT_AUDIENCE` | Expected `aud` claim — must match `KC_LITELLM_CLIENT_ID` (`emerico-litellm`). |
| `SELF_HOSTED_LLM_BASE_URL` | Koyeb endpoint for Gemma 3 12B (`emerico-chat` alias). |
| `SELF_HOSTED_LLM_API_KEY` | API key for the 12B deployment. |
| `SELF_HOSTED_LLM_MODEL_NAME` | Model name for 12B — defaults to `custom-model` if not set. |
| `SELF_HOSTED_LLM_PRO_BASE_URL` | Koyeb endpoint for Gemma 3 27B (`emerico-chat-pro` alias). **Different deployment from 12B — different URL and key.** |
| `SELF_HOSTED_LLM_PRO_API_KEY` | API key for the 27B deployment. |
| `SELF_HOSTED_LLM_PRO_MODEL_NAME` | Model name for 27B — defaults to `google/gemma-3-27b-it` if not set. |
| `KEYCLOAK_JWKS_URL` | LiteLLM validates JWTs against this. |
| `KEYCLOAK_ISSUER_URL` | LiteLLM verifies the `iss` claim against this. |
| `KEYCLOAK_TIER_CLAIM` | JWT claim name for the tier — `tier` (matches the Keycloak protocol mapper). |

### Keycloak (Elestio service env vars)

| Variable | Notes |
|---|---|
| `KEYCLOAK_ADMIN_USER` | Admin console username — set at Elestio deployment. Keep in password manager, not in app env. |
| `KEYCLOAK_ADMIN_PASSWORD` | Admin console password. Keep in password manager. |
| `KEYCLOAK_BASE_URL` | Public URL Elestio assigns to the Keycloak instance. |
| `KEYCLOAK_REALM` | `emerico-commerce` — do not change. |
| `KC_FRONTEND_CLIENT_ID` | `emerico-frontend` |
| `KC_LITELLM_CLIENT_ID` | `emerico-litellm` |
| `KC_LITELLM_CLIENT_SECRET` | Generated by Keycloak → Clients → emerico-litellm → Credentials → Regenerate. |
| `KC_MEMORY_CLIENT_ID` | `emerico-memory-api` |
| `KC_MEMORY_CLIENT_SECRET` | Generated by Keycloak → Clients → emerico-memory-api → Credentials → Regenerate. |
| `KC_ZUPLO_CLIENT_ID` | `emerico-zuplo` |
| `KC_ZUPLO_CLIENT_SECRET` | Generated by Keycloak → Clients → emerico-zuplo → Credentials → Regenerate. |

### MongoDB Atlas

| Variable | Notes |
|---|---|
| `ATLAS_API_PUBLIC_KEY` | Programmatic API public key from Atlas account (optional if cluster created manually). |
| `ATLAS_API_PRIVATE_KEY` | Programmatic API private key. |
| `MONGODB_DB_USER` | Least-privilege Atlas database user (read/write this DB only). |
| `MONGODB_DB_PASSWORD` | Password for the Atlas database user. |

### Memory API

Set in `memory-api/.env`. The docker-compose.yml picks these up automatically.

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | Yes | Full Atlas connection string including user + password |
| `MONGODB_DB_NAME` | No | Database name (default: `emerico-memory`) |
| `MEMORY_API_PORT` | No | Port to listen on (default: `3001`) |
| `MEMORY_API_BASE_URL` | No | Public base URL — used by other services to call the memory API |
| `KEYCLOAK_JWKS_URL` | Yes | e.g. `https://<keycloak>/realms/emerico-commerce/protocol/openid-connect/certs` |
| `KEYCLOAK_ISSUER_URL` | Yes | e.g. `https://<keycloak>/realms/emerico-commerce` |
| `MEMORY_JWT_AUDIENCE` | Yes | Expected `aud` claim — must match `emerico-memory-api` |

---

## 9. Running Locally

```bash
# Memory API (port 3001 by default)
cd memory-api
# Uses the ROOT .env (../.env from memory-api/) — same file that docker-compose reads.
  # Fill in the Memory API vars from Section 8 in the root .env.example then cp to .env
npm install
npm run dev

# The other repos (AI Commerce App, AI Commerce API) have their own READMEs and run independently.
```

Zuplo runs in the cloud — there is no local Zuplo. All chat requests from the App hit `https://acorre-dev-dfb05c0.zuplo.app`.

### Getting a test token

Use the `emerico-backend` service account to get a bearer token for manual API testing:

```bash
KC=https://keycloak-acorreai-u73333.vm.elestio.app/realms/emerico-commerce
TOKEN=$(curl -s -X POST $KC/protocol/openid-connect/token \
  -d "grant_type=client_credentials&client_id=emerico-backend&client_secret=<secret>" \
  | jq -r .access_token)

# Then use it against any Zuplo endpoint:
curl -X POST https://acorre-dev-dfb05c0.zuplo.app/dropshipping/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q":"wireless headphones","pageSize":5}'
```

The `emerico-backend` client secret is in the Keycloak admin console → Clients → emerico-backend → Credentials. See [`runbooks/litellm-zuplo-mcp.md`](runbooks/litellm-zuplo-mcp.md) for more test commands.

---

## 10. Deployment

### Zuplo

Deploys automatically on push. Changes in `config/routes.oas.json` and `modules/**/*.ts` take effect immediately. Env vars are set in the Zuplo dashboard (never committed).

Push to `dev` for production. Feature branches deploy to a preview environment.

### Memory API

**With Docker (recommended for production):**

```bash
cd memory-api
# docker-compose reads from the ROOT .env (../.env), not memory-api/.env
docker-compose --env-file ../.env up -d

# Rebuild after code changes:
docker-compose --env-file ../.env up -d --build

# Stop:
docker-compose down
```

**Without Docker:**

```bash
cd memory-api
npm install
npm run build   # compiles TypeScript → dist/
npm start       # runs dist/index.js
```

**Deployed URL:** `https://cicd-accoreai-u73333.vm.elestio.app`

MongoDB Atlas must be reachable from the deployment network.

### LiteLLM

Deployed on Elestio — one-click deployment. The config file is at [`litellm/litellm_config.yaml`](litellm/litellm_config.yaml) in this repo. On Elestio, set `LITELLM_CONFIG_PATH` to point at it, or mount it as a volume. Models `emerico-chat` (12B) and `emerico-chat-pro` (27B) both point to Koyeb.

See [`runbooks/litellm-zuplo-mcp.md`](runbooks/litellm-zuplo-mcp.md) for the live operational runbook, known issues, and acceptance test curl commands.

### Keycloak

Deployed on Elestio. Follow [`keycloak/SETUP.md`](keycloak/SETUP.md). Import [`keycloak/realm-export.json`](keycloak/realm-export.json) for the pre-configured realm.

---

## 11. Adding a New MCP Server

Four steps, in order:

**1. Create the module file**

Add `modules/<name>.ts`. Use an existing module as the template — `modules/ticketmaster.ts` is the cleanest example for a travel/event server; `modules/dropship-search.ts` for a product search server. Every handler must:
- Import `ZuploContext`, `ZuploRequest` from `@zuplo/runtime`
- Import `getenv` from `./shared/env.js`
- Import `errorResponse` / `jsonResponse` from `./shared/types.js`
- Read all credentials via `getenv()` — never hardcode values
- Return `AffiliateCard[]` (travel/events) or `RawProduct[]` (dropship) wrapped in `ToolResponse<T>`

**2. Add the route to `config/routes.oas.json`**

Copy an existing route block and update `path`, `operationId`, `summary`, and the `handler` reference in `x-zuplo-route`. Every new route must include the inbound policy:
```json
"policies": { "inbound": ["keycloak-jwt-auth"] }
```
No route should ever be deployed without this policy.

**3. Set env vars in the Zuplo dashboard**

Go to Zuplo project settings → Environment variables. Add the new partner's API key(s) and any affiliate tracking ID. Variables set here are available via `getenv()` at runtime. Never commit secrets to the repo.

**4. Deploy**

Push to `dev`. Zuplo auto-deploys on push. Changes to `config/routes.oas.json` and `modules/**/*.ts` take effect immediately.

---

## 12. MCP-UI Integration Note

The proposal references the MCP Apps / MCP-UI TypeScript SDK as the mechanism for rendering tool results in chat. The implemented architecture achieves the same outcome via a different, more tightly integrated path.

The App's Edge route (`app/api/chat/stream/route.ts`) streams AG-UI SSE events (`TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`) directly to the browser. The client-side hook (`lib/use-chat-agent.ts`) consumes these events, passes each `TOOL_CALL_RESULT` payload to `lib/tool-result-parser.ts`, and renders the output as `ProductCard` or `AffiliateCard` components inside the chat thread.

This approach uses the Vercel AI SDK's native streaming primitives and avoids introducing a separate SDK dependency. The functional outcome matches the proposal requirement: tool results are rendered as typed cards in the chat interface, persist across conversation reloads, and support Add to Cart and Buy Now actions.

**The MCP-UI SDK was not used.** Do not add it as a dependency without a specific reason — the current architecture is complete for the v2 scope.

For the consumer-side implementation, see the AI Commerce repo: `lib/tool-result-parser.ts`, `lib/use-chat-agent.ts`, `components/products/ProductCard.tsx`, `components/products/AffiliateCard.tsx`.

---

## 13. Dropshipping Architecture: Chat Path vs. Direct Integration Path

There are two separate paths for dropshipping product access, and they are intentionally different:

**Chat path (active):**
The App's `dropship_product_search` chat tool calls Commerce API's `GET /storefront/products`. Commerce fans out to its own supplier adapters, applies markup, and returns `UnifiedProduct[]` to the App. This is the only path used in chat. Markup is applied here — the sell price the user sees is set by Commerce.

**Direct integration path (Infra, issue #34 surface):**
Infra's `/dropshipping/search` and `/dropshipping/get` endpoints call suppliers directly and return `RawProduct[]` with no markup applied. These routes are deployed and tested but are not wired into the live chat flow. They are intended for future use cases: mobile clients, Storefront tab direct queries, or as the source of truth when Commerce eventually sources raw cost from Infra rather than its own adapters.

Both code paths exist, are independently tested, and serve different consumers by design. The chat consumer uses the Commerce API path because markup must be applied server-side, not in Zuplo or the model.

---

## 14. Why Modules Are Hand-Built (Not Auto-Generated from OpenAPI)

We evaluated auto-generation from each partner's OpenAPI spec during Phase 3. Several partners required custom handling that OpenAPI import tools could not express cleanly:

- **AliExpress:** HMAC-SHA256 request signing with a specific concatenation scheme; all requests must be POST with `application/x-www-form-urlencoded` body regardless of what the spec says
- **BigBuy:** Bearer auth header with sandbox/production URL switching based on env var
- **CJDropshipping:** Two-step OAuth flow with automatic token caching and a 13-day TTL (the API returns 15 days but we refresh 2 days early)
- **Viator:** Non-standard pagination (`start`/`count` instead of `offset`/`limit`); production vs sandbox key distinction
- **StubHub:** Post-2022 API migration with significantly changed domains and endpoints

Hand-building the modules with a consistent structure (`getenv()` for credentials, `errorResponse()` / `jsonResponse()` wrappers, `AffiliateCard[]` return shape) preserved the proposal's outcome — 8 MCP servers exposing search, filtering, and deep-link tools — while accommodating per-partner integration realities that auto-generation would have produced broken or fragile output for.

---

## 15. Known Bugs & Status

| # | Module | Bug | Status |
|---|---|---|---|
| 1 | `modules/cjdropshipping.ts` | Token TTL set to 150 days. Real expiry is 15 days. | Fixed in the new `dropship-search.ts` and `dropship-get.ts` (13-day TTL). Old module still has the bug — deleted in Task 5. |
| 2 | `modules/viator.ts` | Pagination sent as `{ offset, limit }`. Viator expects `{ start, count }`. | Fixed (Task 2). |
| 3 | `modules/travelpayouts.ts` | Hotels image field was `h.photoUrl` (doesn't exist). Real field: `h.photos?.[0]?.url`. | Fixed (Task 2). |
| 4 | `modules/stubhub.ts` | Entire module based on pre-2022 StubHub API — domain, endpoints, and params all changed in migration. | Blocked — waiting on client to provide new credentials (GitHub issue #38). |
| 5 | `modules/dropship-search.ts` + `dropship-get.ts` | AliExpress signing was wrong: CryptoJS HMAC of `appSecret+sorted+appSecret` instead of Web Crypto HMAC of `sorted` only. All requests sent as GET instead of POST. Text search used wrong response path (`.traffic_product_d_t_o`) and wrong params (`local_country`/`local_language`). Feed response path was `.mods.item_list.info` instead of `.result.products.traffic_product_d_t_o`. | Fixed. |
| 6 | `modules/dropship-get.ts` | `aliexpress.ds.product.get` was missing mandatory `ship_to_country` param — returned `MissingParameter` error for every call. | Fixed. Verified against live API. |
| 7 | `modules/dropship-search.ts` + `dropship-get.ts` | CJ supplier value returned as `"cjdropshipping"` — must be `"cj"` to match Commerce's `externalId` key and Openship's fulfillment routing. | Fixed. |
| 8 | `modules/eventbrite.ts` | `EVENTBRITE_API_TOKEN` is org-scoped (event organizer access), not the public-search scope required by the proposal. Returns only the organization's own events — public catalog search is blocked at the API level. | Blocked — requires a Personal OAuth token with public `event:read` scope, or client confirmation that org-only use is intended. |
| 9 | `modules/dropship-search.ts` | CJ auth and product-list errors were silently swallowed by a bare `catch {}` — CJ consistently returned `[]` with no indication of failure. | Fixed: auth errors now log via `console.error`, include CJ's own message, and check `data.result`. Added 401 retry on product list (matching v1 behaviour). |

---

## 16. v2 Implementation Status

The v2 plan fixes the core bug where the App receives `TOOL_CALL_RESULT` SSE events but discards their content, rendering no product cards for dropship or affiliate results.

### Infra Tasks (this repo)

| Task | Description | Branch | Status |
|---|---|---|---|
| Task 1 | Add `AffiliateCard` type, remove legacy result types | `feat/v2-affiliate-cards` | Done (`ef1091b`) |
| Task 2 | Reshape all travel/event tools to return `AffiliateCard[]`, fix Viator pagination and hotel image bugs | `feat/v2-affiliate-cards` | Done (`d09b03c`) |
| Task 3 | Add `/dropshipping/search` and `/dropshipping/get` as the issue #34 surface (built, not wired into live chat path). Multiple fix commits: AliExpress signing, GET→POST, response paths, `ship_to_country`, CJ enum. | `feat/v2-affiliate-cards` | Done |
| Task 4 | Remove old 3 legacy dropship routes from `routes.oas.json` | — | Pending — App already left Infra's dropship path, so no simultaneous cutover needed. Remove when confident nothing calls the old routes. |
| Task 5 | Delete `aliexpress.ts`, `bigbuy.ts`, `cjdropshipping.ts`, and `ProductResult` stub | — | Pending — after Task 4. |

### Locked Architecture Decisions

- **Infra is NOT in the dropship search path.** The App's `dropship_product_search` tool routes to Commerce API (`GET /storefront/products`). Infra's `/dropshipping/*` routes are the issue #34 future consolidation surface — built but not wired.
- **Affiliate tools only.** Infra serves affiliate results (`kind: "affiliate"`) for travel and events. Dropship search and markup live entirely in Commerce API.
- **Supplier enum locked:** `"cj"` not `"cjdropshipping"`. Commerce's `externalId = "{supplier}:{sourceId}"` and Openship fulfillment routing depend on this exact value.
- **Affiliate card shape locked:** `{ kind: "affiliate", provider, title, dateOrVenue, imageUrl, deepLinkUrl }`. `dateOrVenue` is one field, not split. App's `normaliseAffiliate()` reads these exact names.
- `rawPrice` (supplier cost) never leaves the server — not in any response to the browser
- Markup lives only in Commerce API — never in Zuplo, never in the LLM prompt
- Chat loop stays in the App's Edge route — no new orchestrator
- Guest carts deferred — authenticated-only for v1
- USD/en only in v1
- DO NOT rename `emerico` backend identifiers (Keycloak realm `emerico-commerce`, client IDs `emerico-frontend` / `emerico-litellm` / `emerico-memory-api` / `emerico-zuplo`, env vars referencing them)
