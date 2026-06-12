# Shopping Search History API

Base URL: `https://cicd-accoreai-u73333.vm.elestio.app`

All endpoints require a Keycloak JWT:
```
Authorization: Bearer <access_token>
```

Get a token (client credentials — for server-side or testing only):
```
curl -X POST https://keycloak-acorreai-u73333.vm.elestio.app/realms/emerico-commerce/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=emerico-memory-api" \
  -d "client_secret=QaM2klYtknwqhpmmWzUtUeWNpcQKOAzm"
```

All responses scoped to the authenticated user — no `userId` in request bodies.

---

## Save a search

Called right after `GET /storefront/products` returns, when the user intentionally ran a search (typed a query + hit enter/search). Not on re-renders or sort changes.

If the user's most recently saved search has the same `query`, the existing row is updated in place (same browsing session). A different `query` always inserts a new row. History is capped at 20 rows per user (oldest pruned automatically).

```
POST /shopping/searches
Content-Type: application/json

{
  "query": "wireless earbuds",
  "results": {
    "products": [ ...UnifiedProduct[] ],
    "sources": [ { "name": "aliexpress", "available": true, "count": 32 }, ... ],
    "total": 48,
    "page": 1,
    "limit": 20
  }
}
```

Response `201 Created` (new row) or `200 OK` (dedup update):
```json
{
  "id": "ckv3x9q7g0001ab12cd34ef56",
  "query": "wireless earbuds",
  "results": { "products": [...], "sources": [...], "total": 48, "page": 1, "limit": 20 },
  "createdAt": "2026-06-11T14:32:07.123Z",
  "updatedAt": "2026-06-11T14:32:07.123Z"
}
```

---

## Resume the last search (page load)

Call this when the user lands on `/shopping` with no `?q=` in the URL. If a saved search exists, render its `results` immediately (no live supplier query), populate the search box with `query`, and wire the "Refresh" button to `PUT /shopping/searches/:id` using the returned `id`.

```
GET /shopping/searches/last
```

Response `200 OK`:
```json
{
  "id": "ckv3x9q7g0001ab12cd34ef56",
  "query": "wireless earbuds",
  "results": { "products": [...], "sources": [...], "total": 48, "page": 1, "limit": 20 },
  "createdAt": "2026-06-11T14:32:07.123Z",
  "updatedAt": "2026-06-11T14:32:07.123Z"
}
```

Response `204 No Content` — user has never searched; show the default empty `/shopping` state.

---

## Refresh a saved search

Called when the user clicks "Refresh". The frontend re-runs `GET /storefront/products?q=<query>` itself, then sends the fresh response here to replace the stored snapshot.

```
PUT /shopping/searches/:id
Content-Type: application/json

{
  "results": {
    "products": [ ...freshly fetched UnifiedProduct[] ],
    "sources": [...],
    "total": 51,
    "page": 1,
    "limit": 20
  }
}
```

Response `200 OK` — updated row (same shape as POST response).
Response `404 Not Found` — `:id` doesn't belong to the authenticated user.

---

## List recent searches (sidebar)

Lightweight — no `results` field (up to ~50 products each). Use for the "Search history" sidebar list.

```
GET /shopping/searches?limit=10
```

Default limit: `10`. Max: `50`.

Response `200 OK` — array, newest first:
```json
[
  { "id": "ckv3x9q7g0001ab12cd34ef56", "query": "wireless earbuds", "createdAt": "2026-06-11T14:32:07.123Z", "updatedAt": "2026-06-11T15:01:44.789Z" },
  { "id": "ckv3wk2p10002gh78ij90kl12", "query": "phone case",       "createdAt": "2026-06-11T13:10:02.456Z", "updatedAt": "2026-06-11T13:10:02.456Z" }
]
```

---

## Get one saved search with results

Lets the sidebar load a past search instantly using its cached results.

```
GET /shopping/searches/:id
```

Response `200 OK` — full row (same shape as POST response).
Response `404 Not Found` — `:id` doesn't belong to the authenticated user.

---

## Delete one search

```
DELETE /shopping/searches/:id
```

Response `204 No Content`.
Response `404 Not Found` — `:id` doesn't belong to the authenticated user.

After deleting the "last" search, `GET /shopping/searches/last` automatically falls back to the next most recent (or `204` if none remain).

---

## Clear all search history

```
DELETE /shopping/searches
```

Response `204 No Content` — always, even if no rows existed.

---

## Frontend integration flow

**On `/shopping` page load (no `?q=` in URL):**
1. Call `GET /shopping/searches/last`
2. `204` → show empty state, let user search
3. `200` → populate search box with `query`, render `results` directly, show "Refresh" button

**After every intentional search:**
1. User submits query → call `GET /storefront/products?q=...`
2. Results come back → call `POST /shopping/searches` with `{ query, results }`
3. Store the returned `id` — needed for the Refresh button

**Refresh button:**
1. Re-run `GET /storefront/products?q=<current query>`
2. Call `PUT /shopping/searches/:id` with the fresh `results`
3. Render updated results

**Sidebar "Search history" section:**
1. Call `GET /shopping/searches?limit=10` on sidebar open/mount
2. Render each entry as a clickable item
3. On click: call `GET /shopping/searches/:id` to load cached results instantly,
   or navigate to `/shopping?q=<query>` for a fresh search — your call

---

## Error responses

| Code | Meaning |
|------|---------|
| 400  | Missing or invalid field in request body |
| 401  | Missing, expired, or invalid JWT |
| 404  | Record not found or belongs to another user |
| 500  | Internal server error |

```json
{ "error": "query is required" }
```
