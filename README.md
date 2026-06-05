# Emerico AI Infrastructure | Ai-Infra

Standalone AI infrastructure layer extending the Emerico AI Commerce Platform with three components:

1. **LiteLLM Proxy** - LLM gateway with Keycloak JWT auth and per-tier rate limiting (deployed on Elestio)
2. **MongoDB Memory API** - Short-term and long-term conversation memory, scoped per user
3. **MCP Servers via Zuplo** - Eight MCP servers exposing partner APIs as LLM tools

All three components share a dedicated Keycloak instance (deployed on Elestio, separate from the SSO project).

## Status

| Component | Code | Deployed |
|---|---|---|
| Keycloak realm config | Done - `keycloak/realm-export.json` | Pending - needs Elestio managed service |
| LiteLLM proxy config | Done - `litellm/litellm_config.yaml` | Pending - needs Elestio managed service |
| Memory API | Done - `memory-api/` | Pending - needs MongoDB Atlas URI + VPS |
| Zuplo MCP servers (8) | Done - `zuplo/` | Pending - needs Zuplo project setup |

Phase 1 (Keycloak + LiteLLM) is a hard dependency - nothing tests end-to-end without it.
Phase 2 (Memory API) and Phase 3 (Zuplo MCP) code is complete and ready to deploy once blockers are resolved.

## Structure

```
.env.example            - Copy to .env and fill in all values before running anything
.env                    - Your local secrets (gitignored, never commit this)
docs/                   - Reference specs and integration docs
litellm/
  litellm_config.yaml   - LiteLLM proxy config (models, JWT auth, rate limits)
keycloak/
  realm-export.json     - Importable Keycloak realm template
  SETUP.md              - Step-by-step Elestio + Keycloak deployment guide
memory-api/
  src/                  - Express app (middleware, models, routes, services)
  Dockerfile            - Multi-stage Docker build
  package.json
  tsconfig.json
zuplo/
  modules/              - TypeScript handlers for all 8 partner APIs
    shared/             - Shared types and affiliate URL tagging utilities
  routes.oas.json       - Route definitions with JWT policy config
  README.md             - Step-by-step Zuplo deployment guide
```

## Getting Started

### 1. Environment

```bash
cp .env.example .env
# Fill in all values in .env - see comments in the file for what comes from where
```

### 2. Phase 1 - Deploy Keycloak and LiteLLM

Follow `keycloak/SETUP.md` step by step. Both services are deployed as Elestio managed services (not a VPS). After deployment, fill in the Keycloak and LiteLLM variables in `.env`.

### 3. Phase 2 - Memory API

Requires `MONGODB_URI`, `KEYCLOAK_JWKS_URL`, and `KEYCLOAK_ISSUER_URL` to be set in `.env` first.

```bash
cd memory-api
npm install
npm run build        # compiles TypeScript to dist/
npm start            # runs dist/index.js
```

Or via Docker (recommended for VPS deployment):

```bash
docker build -t emerico-memory-api .
docker run -d -p 3001:3001 --env-file ../.env emerico-memory-api
```

### 4. Phase 3 - Zuplo MCP Servers

Code is complete in `zuplo/`. Follow `zuplo/README.md` to create a Zuplo project and deploy.
Requires `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_JWKS_URL`, and all partner API keys set in `.env` first.

## Reference Docs

- `docs/ai-infrastructure-dev-spec.html` - Full developer spec (blueprint)
- `docs/ai-infrastructure-implementation-guide.md` - Implementation reference
- `keycloak/SETUP.md` - Step-by-step Keycloak and LiteLLM deployment on Elestio
- `zuplo/README.md` - Zuplo project setup and deployment guide
- `docs/ai-infrastructure-implementation-plan.html` - Interactive progress tracker
- `docs/emerico-platform-integration.md` - How this project connects to the Commerce team's work

> Commercial terms (price, timeline, milestones) are in the client-facing proposal only.
> © TechUp Consulting
