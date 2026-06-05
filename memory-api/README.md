# Emerico Memory API

Conversation memory service for the Emerico AI Commerce Platform. Stores and retrieves short-term session messages and long-term user data (preferences, conversation summaries, purchase history) in MongoDB Atlas. All data is scoped per user via Keycloak JWT — no user can read or write another user's data.

Part of the **Emerico AI Infrastructure** (Phase 2 of 3).

---

## How it fits in the architecture

```
Commerce Platform (frontend)
        │
        ├── Save user message     →  POST /short-term/:sessionId/messages
        ├── Load context          →  GET  /short-term/:sessionId
        │
        ├── Call LiteLLM (chat)
        │
        ├── Save AI response      →  POST /short-term/:sessionId/messages
        ├── Save summary          →  POST /long-term/summaries
        └── Load user profile     →  GET  /long-term
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Framework | Express 4 |
| Database | MongoDB Atlas (Mongoose ODM) |
| Auth | Keycloak OIDC JWT (RS256, JWKS validation) |
| Docs | Swagger UI at `/docs` |
| Container | Docker (multi-stage build) |

---

## Environment variables

Create a `.env` file in the project root (`AI Infrastructure/.env`) — the app reads from there when using docker-compose. Required variables:

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `MONGODB_DB_NAME` | Database name (default: `emerico-memory`) |
| `KEYCLOAK_JWKS_URL` | Keycloak JWKS endpoint for JWT validation |
| `KEYCLOAK_ISSUER_URL` | Keycloak issuer URL (must match `iss` claim) |
| `MEMORY_JWT_AUDIENCE` | Expected `aud` claim (default: `emerico-memory-api`) |
| `MEMORY_API_PORT` | Port to listen on (default: `3001`) |

---

## Running locally with Docker (recommended)

> Requires Docker Desktop to be running.

**1. Start the container:**
```bash
cd memory-api
docker-compose --env-file ../.env up -d
```

**2. Check it's running:**
```bash
docker ps
```

**3. Test the health endpoint:**
```bash
curl http://localhost:3001/health
```

Expected response:
```json
{ "status": "ok", "timestamp": "2026-06-03T12:00:00.000Z" }
```

**4. Open the API docs:**

Navigate to [http://localhost:3001/docs](http://localhost:3001/docs) in your browser.

**5. Stop the container:**
```bash
docker-compose down
```

**6. Rebuild after code changes:**
```bash
docker-compose --env-file ../.env up -d --build
```

---

## Running locally without Docker (dev mode)

> Requires Node.js 20+ and the env vars exported in your shell or a local `.env` inside `memory-api/`.

**1. Install dependencies:**
```bash
npm install
```

**2. Start in watch mode:**
```bash
npm run dev
```

The server restarts automatically on file changes.

---

## Getting a token to test endpoints

All endpoints except `/health` and `/docs` require a valid Keycloak JWT.

**Get a token via client credentials:**
```bash
curl -X POST "https://keycloak-acorreai-u73333.vm.elestio.app/realms/emerico-commerce/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=emerico-memory-api&client_secret=<client_secret>"
```

Copy the `access_token` from the response and use it as `Authorization: Bearer <token>` on all requests.

You can also paste the token directly into the **Authorize** button on the Swagger UI at `/docs`.

---

## Endpoint summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | None | Service health check |
| GET | `/docs` | None | Interactive API documentation |
| GET | `/short-term/sessions` | JWT | List all active session IDs for the user |
| GET | `/short-term/:sessionId` | JWT | Get all messages in a session |
| POST | `/short-term/:sessionId/messages` | JWT | Append a message (user/assistant/system) |
| DELETE | `/short-term/:sessionId` | JWT | Clear all messages in a session |
| GET | `/long-term` | JWT | Get full long-term memory document |
| PATCH | `/long-term/preferences` | JWT | Merge preferences (language, currency, etc.) |
| POST | `/long-term/summaries` | JWT | Append a conversation summary (capped at 50) |
| POST | `/long-term/purchases` | JWT | Record a purchase event |

Full request/response schemas are in the Swagger UI at `/docs`.

---

## Memory behaviour

**Short-term memory**
- One document per (userId, sessionId)
- Sliding window: keeps the last **100 messages**, older ones are dropped automatically
- TTL: documents expire **24 hours** after the last message

**Long-term memory**
- One document per userId (upserted)
- Summaries: capped at **50** — oldest removed when cap is reached
- Preferences: merged on every PATCH — existing keys overwritten, unmentioned keys kept
- Purchase history: append-only

---

## Project structure

```
memory-api/
├── src/
│   ├── index.ts              # App entry point, MongoDB connection, route mounting
│   ├── swagger.ts            # OpenAPI spec (served at /docs)
│   ├── middleware/
│   │   └── auth.ts           # Keycloak JWT validation middleware
│   ├── models/
│   │   ├── ShortTermMemory.ts  # Mongoose schema — session messages
│   │   └── LongTermMemory.ts   # Mongoose schema — user profile
│   ├── routes/
│   │   ├── shortTerm.ts      # Short-term memory endpoints
│   │   └── longTerm.ts       # Long-term memory endpoints
│   └── services/
│       └── memory.service.ts # Core database operations
├── Dockerfile                # Multi-stage build (builder + runner)
├── docker-compose.yml        # Local development stack
├── package.json
└── tsconfig.json
```
