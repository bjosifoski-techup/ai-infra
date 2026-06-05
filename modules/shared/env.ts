// Safe environment variable accessor for Zuplo's Web Workers runtime.
// Tries process.env first, then globalThis (some Zuplo versions expose
// env vars as globals rather than through process.env).
export function getenv(key: string): string | undefined {
  // Try process.env — works in Node.js and most Zuplo versions
  try {
    const val = process.env[key];
    if (val !== undefined && val !== "") return val;
  } catch {}

  // Fallback: some edge runtimes expose env vars directly on globalThis
  const globalVal = (globalThis as Record<string, unknown>)[key];
  if (typeof globalVal === "string" && globalVal !== "") return globalVal;

  return undefined;
}
