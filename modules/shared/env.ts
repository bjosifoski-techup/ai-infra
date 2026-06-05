// Safe environment variable accessor for Zuplo's Web Workers runtime.
// Falls back to globalThis if process is not defined.
export function getenv(key: string): string | undefined {
  try {
    return process.env[key];
  } catch {
    return (globalThis as Record<string, unknown>)[key] as string | undefined;
  }
}
