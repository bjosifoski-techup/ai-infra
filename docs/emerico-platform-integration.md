# Emerico Platform - Integration Architecture

Cross-team reference. Covers how the AI Commerce Platform and the AI Infrastructure project connect into a single product, what is shared, what is separate, and what each team needs from the other.

References: `ai-commerce-dev-spec.html` and `ai-infrastructure-dev-spec.html`

---

## One Product, Two Engineering Teams

The Emerico AI Commerce Platform is a single product split into two separate engineering engagements. To the end user it is one website.

| Team | Project | What they build |
|---|---|---|
| Commerce team | AI Commerce Platform | Next.js app on Vercel - login, AI chat UI, storefront, cart, checkout, subscriptions, admin panel |
| Infrastructure team | AI Infrastructure | LiteLLM proxy, Keycloak identity provider, MongoDB memory layer, Zuplo MCP gateway |

---

## Request Flow

How a user request travels through both systems from browser to LLM response.

```
[User's browser]
    |
    |--- login / auth ---------> [Keycloak on Elestio]       // INFRA deploys. Issues JWT with sub + tier.
    |                               JWT (tier=silver, sub=user-id, aud=emerico-litellm)
    |
[Next.js on Vercel / Agent framework]   // COMMERCE team builds
    |
    |--- (1) fetch memory -----> [Memory API + MongoDB]       // INFRA builds. Returns past messages + profile.
    |
    |--- (2) AI chat + JWT ----> [LiteLLM on Elestio]         // INFRA deploys. ONLY does: validate JWT,
    |                                                         // enforce rate limit, route to LLM, return response.
    |                                |--- forwards to -------> [Client LLM on GCP]
    |                                                         // LLM processes prompt, may emit tool calls
    |
    |--- (3) tool call --------> [Zuplo MCP servers]          // INFRA builds. Called by agent framework,
    |                                                         // NOT by LiteLLM. Zuplo calls partner API,
    |                                                         // injects affiliate IDs, returns JSON.
    |
    |--- (4) save memory ------> [Memory API + MongoDB]       // Agent framework saves the new turn.
    |
    |--- storefront / cart ----> [Openfront GraphQL]          // COMMERCE team integrates
    |--- fulfillment ----------> [Openship]                   // COMMERCE team integrates
    |--- subscription ---------> [Stripe]                     // COMMERCE team integrates
```

> **Key distinction:** LiteLLM is stateless and only handles the main chat request (steps 2). It does not call the memory API, does not trigger MCP tool calls, and does not inject affiliate links. All of that is the responsibility of the agent framework or frontend orchestration layer. LiteLLM receives a prompt and returns a model response - nothing more.

---

## Keycloak - Auth for Both Projects

Keycloak is not just an infrastructure component. It is the identity provider for the entire platform, including the Commerce frontend. The Commerce spec lists "NextAuth.js or custom" for auth. Keycloak via NextAuth's Keycloak provider is the intended implementation.

The Infrastructure spec deploys a Keycloak instance specifically labelled "Commerce Platform customer identity, separate from the SSO project's realm." This is the same auth system the Commerce frontend needs.

**What Keycloak provides:**
- User login and registration
- TOTP MFA (required by both specs)
- Short-lived JWT access token (5 min default)
- Refresh token rotation (compatible with secure HttpOnly cookie strategy)
- Tier role claim in JWT (`tier: silver`)
- User ID in JWT (`sub` - scopes all memory reads/writes in the infrastructure)
- JWKS endpoint (validates tokens across all services)

**How the Commerce team integrates:**
- Use NextAuth.js with the built-in Keycloak provider
- Configure with `emerico-frontend` client ID (public PKCE client, already set up in realm-export.json)
- Pass the access token as a Bearer header on AI chat requests to LiteLLM
- When a Stripe webhook fires on plan change - call the Keycloak Admin API to update the user's realm role to the new tier (e.g. from `free` to `gold`)
- Rate limit enforcement in LiteLLM happens automatically from the `tier` claim in the token - no extra logic needed on the Commerce side

---

## Shared Between Both Teams

These values and components must be agreed and aligned across both teams. A mismatch breaks the integration.

| What | Who owns / deploys it | Who consumes it | When |
|---|---|---|---|
| Keycloak realm `emerico-commerce` | Infrastructure team (Elestio) | Commerce team - configure NextAuth | After Phase 1 infra |
| `emerico-frontend` client ID | Infrastructure team (pre-configured in realm-export.json) | Commerce team - set in NextAuth config | After realm import |
| Keycloak base URL, JWKS URL, issuer URL | Infrastructure team (from Elestio) | Commerce team `.env`, all infra services | After Keycloak deployed |
| Tier names (exact canonical strings) | Agreed at kickoff - both teams use the same | Commerce: Stripe plan names, role assignment; Infra: Keycloak roles, LiteLLM team config | Before either team writes tier logic |
| Vercel app redirect URI | Commerce team (their Vercel URL) | Infrastructure team - must update `emerico-frontend` client in Keycloak | Before Commerce login testing |
| LiteLLM public URL | Infrastructure team (from Elestio) | Commerce team - AI chat requests go here | After LiteLLM deployed |
| Admin tier handling | Agreed at kickoff | Infra: Keycloak role + LiteLLM rate limit; Commerce: admin panel auth | Before tier config is finalised |

---

## What Each Team Owns Independently

### Commerce team - no infrastructure dependency

- Next.js application and Vercel deployment
- Openfront GraphQL integration (cart, orders, checkout, returns, refunds, disputes)
- Openship order fulfillment sync
- Stripe subscription billing and webhook handling
- PhotonPay product checkout
- Storefront UI and product display (AliExpress, BigBuy, CJDropshipping)
- Admin panel (user management, subscription management)
- Email integration and in-app notifications
- Figma design implementation
- AliExpress audit compliance

### Infrastructure team - no Commerce dependency

- LiteLLM proxy deployment and configuration
- Keycloak realm setup and Elestio deployment
- Memory API (Node.js + TypeScript + Mongoose)
- MongoDB Atlas cluster and schema design
- Zuplo MCP servers (all 8 partner integrations)
- Affiliate tracking ID injection (server-side in Zuplo)
- Rate limiting enforcement (in LiteLLM, by tier)
- JWT validation middleware across all infra services
- Memory scoping by user ID (from Keycloak `sub` claim)

---

## Note on Dropshipping Partners

AliExpress, BigBuy, and CJDropshipping appear in both specs for different purposes. They are not duplicated systems.

| Partner | In Commerce Platform | In AI Infrastructure (Zuplo) |
|---|---|---|
| AliExpress | Live product feed displayed in storefront UI. Registered partner with audit compliance requirements. | MCP tool exposed to the AI agent for product lookup and search in chat. Affiliate tracking ID injected server-side. |
| BigBuy | Live product feed in storefront. | MCP tool for the AI agent to search BigBuy products. |
| CJDropshipping | Live product feed in storefront. | MCP tool for the AI agent to search products. |

Both teams will use the same partner API credentials. Coordinate with the client on which registered partner account to use - especially important for AliExpress, which has audit compliance requirements.

---

## Open Questions - Must Be Resolved at Kickoff

These are architecture decisions, not implementation details. They block both teams if left unresolved.

### 1. Admin tier in Keycloak

The Commerce spec defines 6 tiers including Admin. The Infrastructure spec defines 5 - no Admin. Should Admin be a sixth Keycloak realm role? If so, what rate limit does it get in LiteLLM - unlimited or same as Platinum?

**Decision needed from:** both teams + client. **Blocks:** Keycloak role setup, LiteLLM team config.

### 2. Canonical tier name spelling

"Registered Free" (Commerce spec) vs "Free" (Infrastructure spec). The Keycloak role name and the LiteLLM team name must match exactly what Stripe uses internally, because the Stripe webhook handler reads the plan name and assigns the Keycloak role.

**Agree on one canonical string** - e.g. `free` or `registered_free` - then both teams use it everywhere.

**Decision needed from:** both teams. **Blocks:** all tier-related code on both sides.

### 3. How the AI chat request reaches LiteLLM

The Commerce spec says the Next.js app connects to a "GCP-hosted AI agent backend via AG-UI/SSE." The Infrastructure spec describes LiteLLM as the AI gateway. Does the Commerce frontend talk to LiteLLM directly, or does it talk to a GCP agent which internally calls LiteLLM?

This changes how JWT forwarding works and whether the token audience needs to match `emerico-litellm` or something else.

**Decision needed from:** both teams + client. **Blocks:** Phase 1 LiteLLM config finalisation.

### 4. Stripe tier change - who updates the Keycloak role?

When a user upgrades from Free to Gold on Stripe, their Keycloak realm role must also change (from `free` to `gold`), so the next JWT they receive contains `tier: gold` and gets the correct LiteLLM rate limit.

The Commerce team's Stripe webhook handler must call the Keycloak Admin API to reassign the role. The Infrastructure team must provide a Keycloak Admin service account or client credentials for this call.

**Action for Infrastructure team:** create an admin API client in Keycloak and hand credentials to Commerce team.  
**Action for Commerce team:** implement role update call in the Stripe webhook handler.

---

## What Each Team Needs from the Other

### Infrastructure team provides to Commerce team

- Keycloak base URL (after Elestio deployment)
- Keycloak issuer URL and JWKS URL
- `emerico-frontend` client ID (already decided: `emerico-frontend`)
- Realm name (already decided: `emerico-commerce`)
- LiteLLM public URL (after Elestio deployment)
- Keycloak Admin API service account credentials (for Stripe tier sync webhook)
- Exact canonical tier role names used in Keycloak

### Commerce team provides to Infrastructure team

- Vercel app URL (for Keycloak `emerico-frontend` redirect URI)
- Confirmed canonical tier names (to match Stripe plan names)
- Decision on Admin tier: should it exist in Keycloak, and what rate limit
- Confirmation on whether frontend calls LiteLLM directly or via GCP agent
- AliExpress partner account details (shared API credentials)
