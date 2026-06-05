import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { getenv } from "./shared/env.js";

// Proxies requests to LiteLLM, replacing the Keycloak JWT with the
// LiteLLM master key. The Keycloak JWT is validated by the inbound
// keycloak-jwt-auth policy before this handler runs.

export default async function (request: ZuploRequest, context: ZuploContext) {
  const litellmBaseUrl = getenv("LITELLM_BASE_URL");
  const litellmMasterKey = getenv("LITELLM_MASTER_KEY");

  if (!litellmBaseUrl || !litellmMasterKey) {
    return new Response(
      JSON.stringify({ error: "LiteLLM proxy is not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const url = new URL(request.url);
  const targetUrl = `${litellmBaseUrl}${url.pathname}${url.search}`;

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${litellmMasterKey}`);
  headers.set("Content-Type", request.headers.get("Content-Type") || "application/json");

  // Forward any additional headers the client sent (except Authorization)
  for (const [key, value] of request.headers.entries()) {
    if (
      key.toLowerCase() !== "authorization" &&
      key.toLowerCase() !== "host" &&
      key.toLowerCase() !== "content-type"
    ) {
      headers.set(key, value);
    }
  }

  const body = request.method !== "GET" && request.method !== "HEAD"
    ? await request.text()
    : undefined;

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
