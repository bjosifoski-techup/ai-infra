# Emerico AI Infrastructure - Implementation Guide (for an AI agent)

> **Audience:** an AI coding/ops agent executing this build.
> **Goal of this document:** give you enough context, conventions, and explicit
> step-by-step instructions to implement the three infrastructure components
> without guessing. Read the whole file before starting any phase.

---

## 0. Context - what you are building and why

You are extending an existing product, the **Emerico AI Commerce Platform**, with a
**separate AI infrastructure layer**. The end-product is a **conversational commerce
assistant**: a logged-in customer chats with an AI that can search real partner
catalogs, generate affiliate booking links, and remember the customer across sessions.

There are **three components**, glued together by **one dedicated Keycloak instance**:

1. **LiteLLM Proxy** - the front door to the LLM. Authenticates customers, enforces
   per-tier rate limits, maps RBAC, routes chat to the client's self-hosted model.
2. **MCP Servers via Zuplo** - eight MCP servers that expose partner APIs as tools
   the LLM can call (product search, event search, affiliate deep links).
3. **MongoDB Atlas Memory** - short-term (sliding conversation window) and long-term
   (preferences, summaries, purchase history) memory, scoped per user.

**Commercial premise:** the partner links are *affiliate deep links* carrying Emerico's
tracking parameters. When a customer buys/books through them, Emerico earns commission.
Affiliate link generation with correct tracking IDs is therefore a first-class
requirement, not a nice-to-have.

### Request lifecycle (one chat turn) - internalize this

```
1. Agent framework calls Memory API   -> GET /short-term/messages (past N messages for context)
                                       -> GET /long-term/profile (user preferences + history)

2. Agent framework calls LiteLLM      -> POST /chat/completions with full prompt + JWT
   LiteLLM: validate JWT via JWKS -> read tier claim -> rate-limit check -> route to LLM

3. Self-hosted LLM reasons, optionally emits tool calls (structured JSON, not HTTP calls)

4. Agent framework sees tool calls    -> calls Zuplo MCP server directly (not via LiteLLM)
   Zuplo: validate JWT -> call partner API -> inject affiliate tracking IDs -> return JSON
   Agent framework feeds results back to LLM -> LLM writes final response

5. Agent framework calls Memory API   -> POST /short-term/messages (save new turn)
                                       -> POST /long-term/summaries (if session ends)
```

**LiteLLM only handles step 2.** It is stateless: it validates the JWT, enforces the rate limit, forwards the prompt, and returns the model response. It does not call the memory API, does not trigger Zuplo tool calls, and does not inject affiliate links. Those are all the agent framework's responsibility.

**Affiliate IDs are injected by Zuplo** (step 4), before the results are returned to the LLM. The LLM receives already-tagged links and includes them in its response text as-is.

**Two invariants on every hop:** the Keycloak JWT travels with the request, and every
data access is scoped to that user's ID (`sub` claim).

---

## 1. Global conventions - apply these everywhere

- **Language/runtime:** Node.js + TypeScript for all gateway, memory, and integration code.
- **ODM:** Mongoose for all MongoDB schema and indexing.
- **Secrets & config:** everything (API keys, endpoints, JWKS URLs, DB URIs, affiliate
  IDs, master keys) comes from **environment variables**. Never hard-code secrets.
  Provide a committed `.env.example` listing every variable with a description and a
  placeholder value - but never commit real secrets. The full list is in Section 1.5.
- **Identity:** the **dedicated Keycloak instance is the single trust anchor**. All three
  components validate the *same* tokens against the *same* JWKS endpoint. This Keycloak
  is **separate from the SSO project's realm**.
- **Independent codebase:** do not modify the Commerce Platform repo. This engagement is
  a standalone codebase that integrates via configured endpoints only.
- **Stateless gateways:** LiteLLM and Zuplo hold no user state - they authorize and
  route. All persistent state lives in MongoDB, always keyed by user ID.
- **User scoping is non-negotiable:** every memory read/write must be filtered by the
  authenticated user's ID, enforced centrally in middleware (see Phase 2).
- **Deliverables:** full source + config to the client repository, technical docs for
  all three components, and a knowledge-transfer session.
- **Build order rule:** within Phase 3, build partners with the cleanest OpenAPI specs
  first to surface effort variance early.

### Open questions to resolve with the client before/early in Phase 1

1. **Does the self-hosted LLM support tool/function calling?** This is *critical* -
   Phase 3 (MCP tools) is worthless if the model cannot call tools. Confirm before
   committing to Phase 3.
2. **What is the self-hosted LLM's API shape?** OpenAI-compatible vs custom - this
   decides how LiteLLM registers the model.
3. **Which Zuplo plan tier is in use?** It must support MCP server features.
4. **What affiliate/tracking IDs and partner API credentials exist?** Some affiliate
   programs require account approval with lead time - request these at kickoff.

---

## 1.5 Secrets & Credentials Register

Every key, secret, and credential the build needs. Each variable is marked on **two
independent dimensions** - read **Origin** first:

**ORIGIN - who produces the value:**

- **`[SET-UP]`** - *you* create or generate this yourself. It comes from a system you
  control (Keycloak, LiteLLM, MongoDB Atlas, Zuplo). Nothing to procure - you decide
  the value or your own deployed service generates it.
- **`[EXTERNAL]`** - you must **obtain** this from a third party: a partner API
  provider, an affiliate program, or the client. **These have procurement lead time -
  request them at project kickoff.**

**TYPE - sensitivity:**

- **`[secret]`** - sensitive. Store in Elestio / Zuplo environment secrets or a
  dedicated secret manager. Never commit. Never log.
- **`[config]`** - non-sensitive value, but still loaded from environment variables.

Provide a `.env.example` that lists **all** variables below with placeholder values
and a one-line comment each. Real values go only into the secret stores.

> **Quick read:** everything marked `[EXTERNAL]` is the procurement checklist -
> `SELF_HOSTED_LLM_*` from the client, and all partner API keys + affiliate IDs.
> Everything marked `[SET-UP]` you produce as part of doing the build.

### Operator credentials - NOT env vars

The **Elestio account** and the **Zuplo account** are single dashboard logins
(email + password, ideally with 2FA) used by a person to deploy and manage services.
They are **not application secrets** and must **not** appear in any `.env` file -
keep them in a password manager / shared vault.

Deployment here is the **manual one-click flow** via the Elestio dashboard, so there
is **no `ELESTIO_*` env var at all**. If deployment is later automated via CI /
Terraform, add exactly one secret - `ELESTIO_API_TOKEN` - for that automation; until
then, do not invent one.

### Platform & deployment (env vars)

| Variable | Origin | Type | Source / notes |
|---|---|---|---|
| `ZUPLO_API_KEY` | `[SET-UP]` | `[secret]` | You generate it in your Zuplo account → project settings. Used by the Zuplo CLI / git deploy. |
| `ZUPLO_PROJECT_NAME` | `[SET-UP]` | `[config]` | Name you choose for the Zuplo gateway project. |
| `ZUPLO_GATEWAY_API_KEY` | `[SET-UP]` | `[secret]` | Service key you generate so the chat layer can call the gateway. |
| `ZUPLO_MCP_BASE_URL` | `[SET-UP]` | `[config]` | Public base URL of your deployed Zuplo MCP gateway. |

### Keycloak - identity

| Variable | Origin | Type | Source / notes |
|---|---|---|---|
| `KEYCLOAK_ADMIN_USER` | `[SET-UP]` | `[secret]` | Admin console username - you choose it at deployment. |
| `KEYCLOAK_ADMIN_PASSWORD` | `[SET-UP]` | `[secret]` | Admin console password - you choose it at deployment. |
| `KEYCLOAK_BASE_URL` | `[SET-UP]` | `[config]` | Public URL of your Keycloak instance. |
| `KEYCLOAK_REALM` | `[SET-UP]` | `[config]` | Realm name you choose, e.g. `emerico-commerce`. |
| `KEYCLOAK_ISSUER_URL` | `[SET-UP]` | `[config]` | OIDC issuer URL of your realm; validates the `iss` claim. |
| `KEYCLOAK_JWKS_URL` | `[SET-UP]` | `[config]` | JWKS endpoint of your realm. |
| `KEYCLOAK_TIER_CLAIM` | `[SET-UP]` | `[config]` | Name of the tier claim - set by the protocol mapper you create. |
| `KC_FRONTEND_CLIENT_ID` | `[SET-UP]` | `[config]` | Public OIDC client ID you create for the Vercel frontend (PKCE, no secret). |
| `KC_LITELLM_CLIENT_ID` | `[SET-UP]` | `[config]` | Resource-server client ID you create for LiteLLM. |
| `KC_LITELLM_CLIENT_SECRET` | `[SET-UP]` | `[secret]` | Client secret - generated by your own Keycloak when you create the client. |
| `KC_MEMORY_CLIENT_ID` | `[SET-UP]` | `[config]` | Resource-server client ID you create for the memory API. |
| `KC_MEMORY_CLIENT_SECRET` | `[SET-UP]` | `[secret]` | Client secret - generated by your own Keycloak. |
| `KC_ZUPLO_CLIENT_ID` | `[SET-UP]` | `[config]` | Resource-server client ID you create for the Zuplo gateway. |
| `KC_ZUPLO_CLIENT_SECRET` | `[SET-UP]` | `[secret]` | Client secret - generated by your own Keycloak. |

### LiteLLM - LLM proxy

| Variable | Origin | Type | Source / notes |
|---|---|---|---|
| `LITELLM_MASTER_KEY` | `[SET-UP]` | `[secret]` | Master admin key - you generate a strong random value. |
| `LITELLM_SALT_KEY` | `[SET-UP]` | `[secret]` | Salt that encrypts stored credentials - you generate it once. |
| `LITELLM_DATABASE_URL` | `[SET-UP]` | `[secret]` | Postgres connection string for key/log storage - provisioned with your Elestio deployment. |
| `LITELLM_UI_USERNAME` | `[SET-UP]` | `[secret]` | Username you choose to protect the LiteLLM admin UI. |
| `LITELLM_UI_PASSWORD` | `[SET-UP]` | `[secret]` | Password you choose to protect the LiteLLM admin UI. |
| `LITELLM_JWT_AUDIENCE` | `[SET-UP]` | `[config]` | Expected `aud` claim value - you decide it. |
| `SELF_HOSTED_LLM_BASE_URL` | `[EXTERNAL]` | `[config]` | Endpoint of the client's self-hosted model. **Request from Emerico.** |
| `SELF_HOSTED_LLM_API_KEY` | `[EXTERNAL]` | `[secret]` | API key for the self-hosted model. **Request from Emerico.** |

### MongoDB Atlas - memory

| Variable | Origin | Type | Source / notes |
|---|---|---|---|
| `ATLAS_API_PUBLIC_KEY` | `[SET-UP]` | `[secret]` | Programmatic API key you generate in your own Atlas account (optional if cluster is created manually). |
| `ATLAS_API_PRIVATE_KEY` | `[SET-UP]` | `[secret]` | Programmatic API private key from your Atlas account. |
| `MONGODB_DB_USER` | `[SET-UP]` | `[secret]` | Least-privilege database user you create in Atlas. |
| `MONGODB_DB_PASSWORD` | `[SET-UP]` | `[secret]` | Password you set for the database user. |
| `MONGODB_URI` | `[SET-UP]` | `[secret]` | Full Atlas connection string (embeds the user & password you created). |
| `MONGODB_DB_NAME` | `[SET-UP]` | `[config]` | Database name you choose for the memory collections. |
| `MEMORY_API_PORT` | `[SET-UP]` | `[config]` | Port the memory API service you build listens on. |
| `MEMORY_API_BASE_URL` | `[SET-UP]` | `[config]` | Public base URL of the memory API service you build. |
| `MEMORY_JWT_AUDIENCE` | `[SET-UP]` | `[config]` | Expected `aud` claim value for the memory API - you decide it. |

### Partner APIs - dropshipping

| Variable | Origin | Type | Source / notes |
|---|---|---|---|
| `ALIEXPRESS_APP_KEY` | `[EXTERNAL]` | `[secret]` | App key issued by the AliExpress Open Platform developer console. |
| `ALIEXPRESS_APP_SECRET` | `[EXTERNAL]` | `[secret]` | App secret issued by the AliExpress Open Platform. |
| `ALIEXPRESS_TRACKING_ID` | `[EXTERNAL]` | `[secret]` | AliExpress affiliate tracking ID / PID - required for commission. |
| `BIGBUY_API_KEY` | `[EXTERNAL]` | `[secret]` | REST API key issued by the BigBuy account dashboard. |
| `CJ_EMAIL` | `[SET-UP]` | `[secret]` | Your CJDropshipping account email (you chose it when registering). |
| `CJ_API_KEY` | `[EXTERNAL]` | `[secret]` | API key issued by CJDropshipping; used to obtain an access token. |
| `CJ_ACCESS_TOKEN` | `[EXTERNAL]` | `[secret]` | Short-lived token returned by the CJDropshipping API (refreshed from the API key). |

### Partner APIs - travel & events

| Variable | Origin | Type | Source / notes |
|---|---|---|---|
| `TRAVELPAYOUTS_API_TOKEN` | `[EXTERNAL]` | `[secret]` | API token issued by the Travelpayouts dashboard. |
| `TRAVELPAYOUTS_MARKER` | `[EXTERNAL]` | `[secret]` | Affiliate marker issued by Travelpayouts - injected into deep links for commission. |
| `TICKETMASTER_API_KEY` | `[EXTERNAL]` | `[secret]` | Discovery API consumer key from the Ticketmaster developer portal. |
| `TICKETMASTER_API_SECRET` | `[EXTERNAL]` | `[secret]` | Discovery API consumer secret from the Ticketmaster developer portal. |
| `TICKETMASTER_AFFILIATE_ID` | `[EXTERNAL]` | `[secret]` | Affiliate / partner ID issued by Ticketmaster for tracked deep links. |
| `EVENTBRITE_API_TOKEN` | `[EXTERNAL]` | `[secret]` | OAuth / private token from the Eventbrite developer account. |
| `EVENTBRITE_AFFILIATE_CODE` | `[EXTERNAL]` | `[secret]` | Affiliate code issued by Eventbrite, appended to event deep links. |
| `VIATOR_API_KEY` | `[EXTERNAL]` | `[secret]` | Partner API key - requires an approved Viator affiliate account. |
| `VIATOR_PARTNER_ID` | `[EXTERNAL]` | `[secret]` | Partner / campaign ID issued by Viator for tracked deep links. |
| `STUBHUB_CLIENT_ID` | `[EXTERNAL]` | `[secret]` | OAuth client ID from the StubHub developer / partner program. |
| `STUBHUB_CLIENT_SECRET` | `[EXTERNAL]` | `[secret]` | OAuth client secret from the StubHub developer / partner program. |
| `STUBHUB_AFFILIATE_ID` | `[EXTERNAL]` | `[secret]` | Affiliate ID issued by StubHub for tracked ticket deep links. |

> **Lead-time note:** every `[EXTERNAL]` item is a procurement dependency. The
> affiliate IDs/markers and several partner API keys require approved accounts.
> Request the `SELF_HOSTED_LLM_*` values from Emerico and apply for all partner keys
> at project kickoff, not at Phase 3.

---

## 2. Phase 1 - Keycloak & LiteLLM Setup

**Purpose:** stand up the identity backbone and the user-facing LLM path. This phase
blocks Phases 2 and 3 - do it first.

### 2A. Keycloak

**Step 1 - Deploy Keycloak on Elestio.**
- Use the Elestio one-click Keycloak deployment.
- Immediately set strong admin credentials. Restrict admin-console access (IP allowlist
  if possible). Enforce HTTPS.
- **You set up `[SET-UP]`:** `KEYCLOAK_ADMIN_USER`, `KEYCLOAK_ADMIN_PASSWORD` (both
  secrets - you choose them).
- **Operator credential (not an env var):** the Elestio dashboard login - keep it in a
  password manager.

**Step 2 - Create a dedicated realm.**
- Create a new realm, e.g. `emerico-commerce`. Do **not** reuse the SSO realm.
- This realm manages Commerce Platform customer identity only.
- **You set up `[SET-UP]`:** `KEYCLOAK_BASE_URL`, `KEYCLOAK_REALM`,
  `KEYCLOAK_ISSUER_URL` (config values from your own deployment).

**Step 3 - Define 5 user-tier realm roles.**
- Create realm roles: `guest`, `free`, `silver`, `gold`, `platinum`.
- These drive both rate limiting (LiteLLM) and RBAC.
- **Secrets/keys:** none - Keycloak configuration only.

**Step 4 - Create OIDC clients.**
- **Frontend client** (for the Vercel app): public client, standard flow with
  **Authorization Code + PKCE**, correct redirect URIs.
- **Resource servers** (LiteLLM, Zuplo, memory API): these only *validate* tokens -
  configure them as bearer-only / confidential clients as needed; they do not perform
  interactive login.
- **You set up `[SET-UP]`:** `KC_FRONTEND_CLIENT_ID` (config); `KC_LITELLM_CLIENT_ID` +
  `KC_LITELLM_CLIENT_SECRET`; `KC_MEMORY_CLIENT_ID` + `KC_MEMORY_CLIENT_SECRET`;
  `KC_ZUPLO_CLIENT_ID` + `KC_ZUPLO_CLIENT_SECRET`. The client secrets are generated by
  your own Keycloak when you create each client.

**Step 5 - Add a protocol mapper for the tier claim.**
- Ensure the user's tier role is present in the **access token** in a predictable place
  (e.g. `realm_access.roles`, or a flattened custom claim like `tier`).
- LiteLLM and Zuplo will read this claim - record the exact claim name.
- **You set up `[SET-UP]`:** `KEYCLOAK_TIER_CLAIM`.

**Step 6 - Configure MFA.**
- Enable TOTP as a required action for customers; consider a conditional/step-up
  authentication flow.
- Apply a **stricter authentication flow for admin logins**.
- **Secrets/keys:** none - Keycloak authentication-flow configuration only.

**Step 7 - Verify the JWKS endpoint.**
- Confirm `https://<keycloak>/realms/emerico-commerce/protocol/openid-connect/certs`
  and the `.well-known/openid-configuration` are reachable from where LiteLLM, Zuplo,
  and the memory API run.
- **You set up `[SET-UP]`:** `KEYCLOAK_JWKS_URL`.

**Keycloak acceptance criteria:**
- A test user can log in via the frontend client with PKCE.
- The issued access token contains the user ID and the tier role claim.
- MFA is enforced on login.

### 2B. LiteLLM

**Step 1 - Deploy LiteLLM on Elestio managed cloud** (one-click LiteLLM deployment,
via the Elestio dashboard login).
- **You set up `[SET-UP]`:** `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`,
  `LITELLM_DATABASE_URL`, `LITELLM_UI_USERNAME`, `LITELLM_UI_PASSWORD`.

**Step 2 - Confirm the self-hosted LLM contract** (see open questions). Document the
API shape and tool-calling capability before proceeding.
- **Get externally `[EXTERNAL]`:** `SELF_HOSTED_LLM_BASE_URL` - request from the client.

**Step 3 - Register the self-hosted LLM as a model.**
- In the LiteLLM proxy config, add a model entry pointing at the client's self-hosted
  endpoint. Endpoint URL and API key come from environment variables.
- **Get externally `[EXTERNAL]`:** `SELF_HOSTED_LLM_BASE_URL`,
  `SELF_HOSTED_LLM_API_KEY` - both supplied by the client.

**Step 4 - Enable JWT auth against Keycloak.**
- Configure LiteLLM's JWT auth to validate tokens via the Keycloak **JWKS URL**.
- Map the JWT claims: the user ID claim and the tier/role claim (from Step 5 above).
- Reject requests with missing, invalid, or expired tokens.
- **You set up `[SET-UP]`:** `KEYCLOAK_JWKS_URL`, `KEYCLOAK_ISSUER_URL`,
  `LITELLM_JWT_AUDIENCE`.

**Step 5 - Define 5 rate-limit tiers.**
- Configure RPM / TPM / budget limits per tier:
  `guest` (lowest) < `free` < `silver` < `gold` < `platinum` (highest).
- Limits should be driven by the tier claim, not by individual API keys.
- **Secrets/keys:** none - LiteLLM proxy configuration only.

**Step 6 - Configure RBAC.**
- Map roles to which models/endpoints each tier may access.
- **Secrets/keys:** none - LiteLLM proxy configuration only.

**Step 7 - Security hardening.**
- TLS only. Set the LiteLLM master key. Protect or do not publicly expose the admin UI.
- All secrets in env. Confirm no secrets in logs.
- **You set up `[SET-UP]`:** `LITELLM_MASTER_KEY`, `LITELLM_UI_USERNAME`,
  `LITELLM_UI_PASSWORD`.

**Step 8 - Smoke test end-to-end.**
- Perform a full chat round-trip: Vercel frontend → LiteLLM → self-hosted LLM.
- Verify rate limiting actually triggers (a low-tier user hits its ceiling before a
  high-tier user does).
- **You set up `[SET-UP]`:** `LITELLM_MASTER_KEY` + a test-user Keycloak login.

**Phase 1 exit gate:** a logged-in user can chat through LiteLLM to the LLM; an
invalid/expired token is rejected; tier-based rate limiting demonstrably works.

---

## 3. Phase 2 - MongoDB Memory Setup

**Purpose:** give the assistant short-term and long-term memory. Depends only on
Phase 1 (Keycloak JWT validation). Can run in parallel with Phase 3.

**Step 1 - Provision the Atlas cluster.**
- Choose a region **close to the Elestio deployment** - memory fetch is on the hot path
  of every chat turn, so latency matters.
- Lock down network access (IP allowlist or private endpoint). Create a
  **least-privilege database user** (read/write to this DB only).
- **You set up `[SET-UP]`:** `ATLAS_API_PUBLIC_KEY`, `ATLAS_API_PRIVATE_KEY`,
  `MONGODB_DB_USER`, `MONGODB_DB_PASSWORD`, `MONGODB_URI`, `MONGODB_DB_NAME`.

**Step 2 - Design the short-term memory schema (Mongoose).**
- Collection e.g. `shortTermMemory`. Suggested fields:
  - `userId` (string, indexed) - from JWT `sub`.
  - `sessionId` (string, indexed).
  - `messages` (array of `{ role, content, createdAt }`) - the sliding window.
  - `updatedAt` (date).
- Cap the window by message count or token budget. Add a **TTL index** so stale
  sessions expire automatically.
- **Secrets/keys:** none - Mongoose schema design only.

**Step 3 - Design the long-term memory schema (Mongoose).**
- Collection e.g. `longTermMemory`, one document per `userId`. Suggested fields:
  - `userId` (string, unique, indexed).
  - `preferences` (object) - durable user preferences.
  - `summaries` (array) - rolling conversation summaries.
  - `purchaseHistory` (array) - past purchases/bookings.
  - `updatedAt` (date).
- **Secrets/keys:** none - Mongoose schema design only.

**Step 4 - Create indexes.**
- Compound indexes leading with `userId` (then `sessionId` and/or `updatedAt`).
- Every query is user-scoped - these indexes are what keep reads fast.
- **You set up `[SET-UP]`:** `MONGODB_URI`.

**Step 5 - Build the JWT user-scoping middleware. *(SECURITY CORE)*
- Express/Node middleware that:
  1. Extracts the bearer token, validates it against the Keycloak JWKS.
  2. Extracts the user ID (`sub`).
  3. Injects the user ID into the request context.
  4. Rejects any request without a valid token (hard 401).
- **Every** memory query must filter by this injected user ID. Design the data-access
  layer so a query *cannot* run without a user ID - do not rely on each call site
  remembering to add the filter.
- **You set up `[SET-UP]`:** `KEYCLOAK_JWKS_URL`, `KEYCLOAK_ISSUER_URL`,
  `MEMORY_JWT_AUDIENCE`.

**Step 6 - Build the memory read/write API.**
- Operations: get short-term window, append to short-term window, get long-term
  profile, update preferences/summaries/purchase history.
- Expose as endpoints or an internal module - whichever the chat layer needs.
- **You set up `[SET-UP]`:** `MONGODB_URI`, `MEMORY_API_PORT`.

**Step 7 - Integrate memory into the chat layer.**
- **Before** each LLM call: fetch the short-term window + relevant long-term profile,
  prepend to the LLM context.
- **After** each turn: append the new messages to short-term memory.
- **Periodically:** summarize older turns and fold them into long-term memory so the
  context stays bounded.
- **You set up `[SET-UP]`:** `MEMORY_API_BASE_URL` + a service token / JWT.

**Step 8 - Security review & cross-user access test.**
- Explicitly attempt to read/write another user's memory with a mismatched token and
  confirm it fails.
- Verify the scoping middleware cannot be bypassed by any code path.
- **Secrets/keys:** none - uses two test-user Keycloak logins.

**Phase 2 exit gate:** memory persists across turns; long-term preferences influence
later answers; user A provably cannot access user B's memory.

---

## 4. Phase 3 - MCP Servers via Zuplo

**Purpose:** give the LLM "hands" - eight MCP servers exposing partner APIs as tools.
Depends on Phase 1; benefits from a confirmed tool-calling LLM. Can run in parallel
with Phase 2.

### 4A. Pre-checks (do these first)

- **Confirm the Zuplo plan supports MCP server features.** Blocking - do not start
  building servers until verified. This is an operator check via the Zuplo dashboard
  login (not an env var).
- **Apply for partner API credentials early.** Several affiliate programs require
  account approval with lead time. Start applications at project kickoff.
  **Get externally `[EXTERNAL]`:** `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`,
  `BIGBUY_API_KEY`, `CJ_API_KEY`, `TRAVELPAYOUTS_API_TOKEN`, `TICKETMASTER_API_KEY`,
  `EVENTBRITE_API_TOKEN`, `VIATOR_API_KEY`, `STUBHUB_CLIENT_ID`,
  `STUBHUB_CLIENT_SECRET` (plus all affiliate IDs/markers - see register).
- **Zuplo project setup:** create the gateway project, define environments, route
  structure, and configure secrets storage.
  **You set up `[SET-UP]`:** `ZUPLO_API_KEY`, `ZUPLO_PROJECT_NAME`.

### 4B. Build the 8 MCP servers

For **each** partner:
1. If a clean **OpenAPI spec** exists, import it into Zuplo and let it **auto-generate
   tools**.
2. If no clean spec exists, **hand-write the tool definitions**.
3. **Build cleanest-spec partners first** to surface effort variance early.

**Dropshipping partners** - tools: product search, filtering, product detail.
- **AliExpress** MCP server (AliExpress Open Platform).
  **Get externally `[EXTERNAL]`:** `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`,
  `ALIEXPRESS_TRACKING_ID`.
- **BigBuy** MCP server (BigBuy REST API).
  **Get externally `[EXTERNAL]`:** `BIGBUY_API_KEY`.
- **CJDropshipping** MCP server (CJDropshipping API).
  **You set up `[SET-UP]`:** `CJ_EMAIL` (your account email).
  **Get externally `[EXTERNAL]`:** `CJ_API_KEY`, `CJ_ACCESS_TOKEN`.

**Travel & events partners** - tools: search/filter + **affiliate deep-link generation**.
All partner keys below are **`[EXTERNAL]`** - obtain them from each provider.
- **Travelpayout** MCP server - affiliate deep links with tracking parameters.
  **Get externally `[EXTERNAL]`:** `TRAVELPAYOUTS_API_TOKEN`, `TRAVELPAYOUTS_MARKER`.
- **Ticketmaster** MCP server - event search + affiliate deep links.
  **Get externally `[EXTERNAL]`:** `TICKETMASTER_API_KEY`, `TICKETMASTER_API_SECRET`,
  `TICKETMASTER_AFFILIATE_ID`.
- **Eventbrite** MCP server - event search + affiliate deep links.
  **Get externally `[EXTERNAL]`:** `EVENTBRITE_API_TOKEN`, `EVENTBRITE_AFFILIATE_CODE`.
- **Viator** MCP server - experience search + affiliate deep links.
  **Get externally `[EXTERNAL]`:** `VIATOR_API_KEY`, `VIATOR_PARTNER_ID`.
- **StubHub** MCP server - ticket search + affiliate deep links.
  **Get externally `[EXTERNAL]`:** `STUBHUB_CLIENT_ID`, `STUBHUB_CLIENT_SECRET`,
  `STUBHUB_AFFILIATE_ID`.

**Affiliate link requirement:** every generated deep link must embed Emerico's
affiliate/tracking parameters (the `*_TRACKING_ID` / `*_MARKER` / `*_AFFILIATE_*`
values from env config). Verify this on every travel/events server - it is the
commercial point of the integration.

### 4C. Gateway policies & integration

- **Apply Zuplo rate-limiting and auth policies uniformly across all 8 servers.** Auth
  validates the Keycloak JWT (or a service token issued from the chat layer).
  **You set up `[SET-UP]`:** `KEYCLOAK_JWKS_URL`, `ZUPLO_GATEWAY_API_KEY`.
- **MCP-UI client integration:** wire the MCP Apps / MCP-UI TypeScript SDK so tool
  results render as product/event cards inside the chat interface.
  **You set up `[SET-UP]`:** `ZUPLO_MCP_BASE_URL`.
- **End-to-end test every tool:** chat → LLM tool call → Zuplo → partner API →
  rendered card. Confirm the LLM selects the correct tool and that affiliate links
  carry the correct tracking IDs. **Secrets/keys:** none new - exercises all keys above.

**Phase 3 exit gate:** all 8 servers respond through Zuplo; the LLM picks the right
tool; results render as cards; affiliate links are correctly tagged.

---

## 5. Sequencing

```
Phase 1 (Keycloak + LiteLLM)  --+--> Phase 2 (Memory)        --+--> Integration + E2E
                                |                              |
                                +--> Phase 3 (MCP via Zuplo)  --+
```

- **Phase 1 is the hard dependency** - nothing tests end-to-end without it.
- **Phases 2 and 3 are independent of each other** and may be parallelized.

---

## 6. Risks to actively manage

| Risk | Severity | Mitigation |
|---|---|---|
| Self-hosted LLM may not support tool calling | High | Confirm in Phase 1 before committing to Phase 3 |
| Self-hosted LLM API shape unknown | Medium | Clarify with client; drives LiteLLM provider config |
| OpenAPI spec quality varies per partner | Medium | Build cleanest-spec partners first |
| Affiliate API approvals have lead time | Medium | Apply for keys + affiliate IDs at kickoff |
| Zuplo plan may not include MCP | Medium | Confirm plan tier before Phase 3 |
| Cross-user memory leakage | High | Enforce JWT-scoping middleware; adversarial test |
| End-to-end latency stacks up | Medium | Co-locate Atlas with Elestio; index all queries |
| A secret leaks into the repo or logs | High | All secrets via env / secret manager; `.env.example` only; scrub logs |

---

## 7. Definition of Done

The build is feature-complete when **all** of the following are verified end-to-end in
production:

- [ ] Keycloak instance live on Elestio with all 5 tier roles and MFA configured.
- [ ] LiteLLM proxy live on Elestio with Keycloak JWT validation and per-tier rate
      limiting verified.
- [ ] LiteLLM connected to the client's self-hosted LLM and smoke-tested end-to-end.
- [ ] MongoDB Atlas cluster live with short-term and long-term memory schemas operational.
- [ ] Keycloak JWT user scoping verified on all memory reads and writes (cross-user
      access proven to fail).
- [ ] All 8 MCP servers live and tested through Zuplo (AliExpress, BigBuy,
      CJDropshipping, Travelpayout, Ticketmaster, Eventbrite, Viator, StubHub).
- [ ] MCP-UI client integration rendering tool results in the chat interface verified.
- [ ] Affiliate deep links verified to carry correct tracking IDs.
- [ ] Rate limiting and auth policies applied and tested across all components.
- [ ] All secrets stored in env / secret managers; `.env.example` committed; no secrets
      in the repo or logs.
- [ ] Full source code and configuration files delivered to the client repository.
- [ ] Technical documentation covering all three components delivered.
- [ ] Knowledge-transfer session completed with the client.

---

## 8. Testing strategy summary

- **Phase 1:** valid token passes; invalid/expired rejected; rate limits trigger at
  the correct tier thresholds; full chat round-trip works.
- **Phase 2:** memory persists across turns; long-term preferences affect later
  answers; cross-user access attempt fails.
- **Phase 3:** each of the 8 servers tested individually through Zuplo; LLM selects
  correct tools; cards render; affiliate links carry tracking IDs.
- **Integration:** the full request lifecycle (Section 0) exercised under each of the
  5 user tiers.
