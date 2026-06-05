// Safe environment variable accessor for Zuplo's Web Workers runtime.
// Zuplo exposes env vars via `environment` from @zuplo/runtime.
import { environment } from "@zuplo/runtime";

export function getenv(key: string): string | undefined {
  // Primary: Zuplo's environment object (correct way for Zuplo handlers)
  const zuploVal = (environment as Record<string, unknown>)[key];
  if (typeof zuploVal === "string" && zuploVal !== "") return zuploVal;

  // Fallback: process.env (Node.js / other runtimes)
  try {
    const val = process.env[key];
    if (val !== undefined && val !== "") return val;
  } catch {}

  return undefined;
}
