# Keycloak Setup Guide - Phase 1

This guide covers the steps to deploy and configure Keycloak on Elestio for the
Emerico AI Commerce Platform. Most of these are one-time dashboard actions - the
realm-export.json file in this folder pre-configures the realm structure for you,
but some steps (like creating client secrets and setting up SMTP) must be done
manually through the admin console.

---

## Variables you need to fill in .env for this phase

Work through this list in order as you complete each step below. Once all of them
are filled in, Phase 1 is environmentally complete.

### Keycloak variables

| Variable | Where it comes from | When |
|---|---|---|
| KEYCLOAK_ADMIN_USER | You choose it during Elestio deployment | Step 1 |
| KEYCLOAK_ADMIN_PASSWORD | You choose it during Elestio deployment | Step 1 |
| KEYCLOAK_BASE_URL | Elestio gives you the public URL after deployment | Step 1 |
| KEYCLOAK_REALM | Use: emerico-commerce | Step 2 |
| KEYCLOAK_ISSUER_URL | Derived: {KEYCLOAK_BASE_URL}/realms/emerico-commerce | Step 2 |
| KEYCLOAK_JWKS_URL | Derived: {KEYCLOAK_ISSUER_URL}/protocol/openid-connect/certs | Step 2 |
| KEYCLOAK_TIER_CLAIM | Use: tier | Step 2 |
| KC_FRONTEND_CLIENT_ID | Use: emerico-frontend | Step 2 |
| KC_LITELLM_CLIENT_ID | Use: emerico-litellm | Step 3 |
| KC_LITELLM_CLIENT_SECRET | Keycloak generates it when you click Regenerate | Step 3 |
| KC_MEMORY_CLIENT_ID | Use: emerico-memory-api | Step 3 |
| KC_MEMORY_CLIENT_SECRET | Keycloak generates it when you click Regenerate | Step 3 |
| KC_ZUPLO_CLIENT_ID | Use: emerico-zuplo | Step 3 |
| KC_ZUPLO_CLIENT_SECRET | Keycloak generates it when you click Regenerate | Step 3 |

### LiteLLM variables (filled during the LiteLLM steps in this phase)

| Variable | Where it comes from | When |
|---|---|---|
| LITELLM_MASTER_KEY | You generate: run `openssl rand -hex 32` | LiteLLM Step 1 |
| LITELLM_SALT_KEY | You generate: run `openssl rand -hex 32` | LiteLLM Step 1 |
| LITELLM_DATABASE_URL | Elestio gives you the Postgres URL in the LiteLLM service details | LiteLLM Step 1 |
| LITELLM_UI_USERNAME | You choose it | LiteLLM Step 1 |
| LITELLM_UI_PASSWORD | You choose it | LiteLLM Step 1 |
| LITELLM_JWT_AUDIENCE | Use: emerico-litellm (must match the KC_LITELLM_CLIENT_ID) | LiteLLM Step 4 |
| SELF_HOSTED_LLM_BASE_URL | Request from Emerico at kickoff | LiteLLM Step 2 |
| SELF_HOSTED_LLM_API_KEY | Request from Emerico at kickoff | LiteLLM Step 3 |

Variables that are not in this list (Zuplo, MongoDB, partner APIs) are not needed for
Phase 1 and can wait until Phases 2 and 3.

---

## Before you start

You need:
- An active Elestio account (dashboard login in your password manager, not in any env file)
- The workspace cloned locally so you can reference realm-export.json
- A domain or the default Elestio subdomain for your Keycloak instance
- The Vercel frontend app URL, if it exists yet - you will need it for the redirect URIs
  (if it does not exist yet, use the localhost placeholder and update it later)

---

## Step 1 - Deploy Keycloak on Elestio

1. Log into the Elestio dashboard.
2. Click "Create new service" and search for Keycloak.
3. Choose a region close to where you will deploy LiteLLM (same region = lower latency for JWKS lookups).
4. Set a strong admin username and password during the setup wizard.
   - Save both in your team password manager immediately.
   - These are operator credentials - they do not go in .env.
5. Wait for the deployment to complete, then open the admin console URL Elestio provides.

Set in your .env:
- KEYCLOAK_ADMIN_USER - the admin username you just chose
- KEYCLOAK_ADMIN_PASSWORD - the admin password you just chose
- KEYCLOAK_BASE_URL - the public URL Elestio assigns to your Keycloak instance

Security note: if Elestio supports IP allowlisting for the admin console path (/admin),
enable it now. Restrict access to your office or VPN IP range.

---

## Step 2 - Import the realm

Before importing, open keycloak/realm-export.json in your editor and update the
redirect URIs and web origins for the frontend client. Look for this section:

  "clientId": "emerico-frontend",
  ...
  "redirectUris": [
    "https://your-vercel-app.vercel.app/*",
    "http://localhost:3000/*"
  ],
  "webOrigins": [
    "https://your-vercel-app.vercel.app",
    "http://localhost:3000"
  ],

Replace "https://your-vercel-app.vercel.app" with your actual Vercel app URL before
importing. If the Vercel app URL does not exist yet, leave the localhost entries as-is
and do Step 4 (update via admin console) after the app is deployed.

Then import:
1. In the admin console, click "Create realm" in the top-left dropdown.
2. Select "Import realm" and upload keycloak/realm-export.json from this repo.
3. Click "Create".

This configures:
- All 5 tier roles: guest, free, silver, gold, platinum
- All 4 OIDC clients: frontend (public/PKCE), litellm, memory-api, zuplo (resource servers)
- The "tier" protocol mapper (adds the user's realm role as a "tier" claim in the JWT)
- The MFA authentication flow (TOTP required for all customer logins)
- Secure browser headers

Set in your .env:
- KEYCLOAK_REALM = emerico-commerce
- KEYCLOAK_ISSUER_URL = {KEYCLOAK_BASE_URL}/realms/emerico-commerce
- KEYCLOAK_JWKS_URL = {KEYCLOAK_BASE_URL}/realms/emerico-commerce/protocol/openid-connect/certs
- KEYCLOAK_TIER_CLAIM = tier

After importing, verify the JWKS endpoint is reachable:
  curl {KEYCLOAK_JWKS_URL}
You should get a JSON response with a "keys" array. If you get a 404, the realm did not import correctly.

---

## Step 3 - Set up client secrets

The realm import creates the 4 OIDC clients but does not generate client secrets
(those are produced by Keycloak itself). Do this for each resource-server client:

For emerico-litellm:
1. In the admin console, open Clients > emerico-litellm.
2. Go to the Credentials tab.
3. Click "Regenerate" under Client secret.
4. Copy the secret immediately - you will not see it again in full.

Set in your .env:
- KC_LITELLM_CLIENT_ID = emerico-litellm
- KC_LITELLM_CLIENT_SECRET = the secret you just copied

Repeat the same for emerico-memory-api and emerico-zuplo:

Set in your .env:
- KC_MEMORY_CLIENT_ID = emerico-memory-api
- KC_MEMORY_CLIENT_SECRET = ...
- KC_ZUPLO_CLIENT_ID = emerico-zuplo
- KC_ZUPLO_CLIENT_SECRET = ...

For the frontend client (emerico-frontend):
- This is a public client - it has no secret.
- Update the Redirect URIs to match your actual Vercel app URL.

Set in your .env:
- KC_FRONTEND_CLIENT_ID = emerico-frontend

---

## Step 4 - Update redirect URIs (if you did not do it before importing)

If you imported realm-export.json before updating the Vercel app URL, do it now:

1. Open Clients > emerico-frontend in the admin console.
2. Under "Valid redirect URIs", replace the placeholder with your actual Vercel domain.
   Example: https://emerico-commerce.vercel.app/*
3. Under "Web origins", do the same (without the /*).

---

## Step 5 - Configure SMTP for email verification

If you want email verification and password reset to work (you do), configure SMTP:

1. In the admin console, open Realm settings > Email.
2. Fill in your SMTP host, port, and credentials.
3. Click "Test connection" to verify it works.

If you are using a service like Resend, Mailgun, or AWS SES, use their SMTP gateway settings.

---

## Step 6 - Verify the MFA flow is active

The realm import sets up an MFA flow with TOTP as a required second factor. Check it
is attached as the default browser login flow:

1. Open Realm settings > Authentication.
2. Under "Browser flow", make sure it points to "browser-with-mfa" (the one from the import).
3. If it still shows the built-in browser flow, change it and save.

Also verify that CONFIGURE_TOTP is listed as a required action under
Realm settings > Required actions and that it is enabled.

---

## Step 7 - Smoke-test a login

1. Create a test user in Users > Add user.
2. Assign them the "free" role under their Role mappings tab.
3. Set a temporary password under Credentials.
4. Open the account console: {KEYCLOAK_BASE_URL}/realms/emerico-commerce/account
5. Log in as the test user - you should be prompted to set up TOTP.
6. Complete setup and log in fully.

Decode the resulting access token (paste it at jwt.io) and confirm:
- The "sub" claim is present (this is the user ID that all components use)
- The "tier" claim is present and equals "free"
- The "iss" claim matches your KEYCLOAK_ISSUER_URL
- The "aud" claim includes the values you will use for LITELLM_JWT_AUDIENCE and MEMORY_JWT_AUDIENCE

---

## Checklist

- [ ] Keycloak instance live on Elestio, admin console accessible over HTTPS
- [ ] Admin credentials in password manager
- [ ] Realm emerico-commerce imported and active
- [ ] JWKS endpoint reachable from LiteLLM, Zuplo, and memory API networks
- [ ] Client secrets generated and saved for litellm, memory-api, and zuplo clients
- [ ] Frontend client redirect URIs updated to actual Vercel domain
- [ ] SMTP configured and tested
- [ ] MFA (TOTP) flow active as default browser flow
- [ ] Test user can log in, token contains "sub" and "tier" claims
- [ ] All KEYCLOAK_* and KC_* variables filled in .env

---

## Troubleshooting

**JWKS returns 404**
The realm name in the URL must exactly match the realm ID in Keycloak. Check
KEYCLOAK_REALM matches what you see in the admin console top-left dropdown.

**Token does not contain the "tier" claim**
The protocol mapper may not have been applied from the import. Manually add it:
Clients > (any client) > Client scopes > Mappers > Add mapper by configuration.
Choose "User Realm Role" and set the token claim name to "tier", set Multivalued to off.
Make sure the user has a realm role assigned (guest, free, silver, gold, or platinum).

**Rate limiting in LiteLLM does not match the tier**
LiteLLM reads the team_id_jwt_field from the token. This must match the value in
KEYCLOAK_TIER_CLAIM. Also confirm the tier value in the token (jwt.io decode)
matches the team_id values in litellm_config.yaml exactly (case-sensitive).
