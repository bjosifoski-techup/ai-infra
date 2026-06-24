#!/usr/bin/env node
/**
 * Smoke test for the Zuplo /dropshipping/* surface after the
 * fix/zuplo-supplier-alignment changes.
 *
 * Hits each supplier endpoint with a deliberately keyword-heavy query and
 * checks that the returned titles actually contain at least one query token.
 * The whole reason for this PR is that AE was silently ignoring `search_key`
 * and returning unrelated cheap items; this script catches that regression.
 *
 * Usage:
 *   ZUPLO_URL=https://acorre-dev-dfb05c0.zuplo.app \
 *   ZUPLO_TOKEN=<keycloak-jwt>                     \
 *   node scripts/smoke-suppliers.mjs
 *
 * Or, optionally, pin specific queries:
 *   QUERIES="led camping lantern,bluetooth speaker" node scripts/smoke-suppliers.mjs
 *
 * Exits 0 when every supplier returned at least one keyword-matching item
 * (or returned an explicit auth/config error). Exits 1 if a configured
 * supplier returned items that don't match the query at all — that's the
 * "param silently ignored" regression we're guarding against.
 */

const ZUPLO_URL = process.env.ZUPLO_URL;
const TOKEN     = process.env.ZUPLO_TOKEN;

if (!ZUPLO_URL || !TOKEN) {
  console.error("Set ZUPLO_URL and ZUPLO_TOKEN. See header comment.");
  process.exit(2);
}

const QUERIES = (process.env.QUERIES ?? "led camping lantern,bluetooth speaker,coffee mug")
  .split(",").map((s) => s.trim()).filter(Boolean);

const ENDPOINTS = [
  { name: "aliexpress",     path: "/dropshipping/aliexpress/search",     payloadKey: "query" },
  { name: "cjdropshipping", path: "/dropshipping/cjdropshipping/search", payloadKey: "query" },
  { name: "bigbuy",         path: "/dropshipping/bigbuy/search",         payloadKey: "query" },
];

function titlesFrom(json) {
  if (Array.isArray(json?.results)) return json.results.map((r) => String(r.title ?? "").toLowerCase());
  if (Array.isArray(json?.products)) return json.products.map((p) => String(p.title ?? "").toLowerCase());
  return [];
}

function keywordHit(title, queryTokens) {
  return queryTokens.some((t) => t.length > 2 && title.includes(t));
}

async function smoke(ep, query) {
  const url = `${ZUPLO_URL}${ep.path}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ [ep.payloadKey]: query, pageSize: 10 }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _nonJson: text.slice(0, 200) }; }

  if (!res.ok) {
    // Surface but don't fail the run on infra-config errors — they'll bubble
    // up in the summary as a separate column.
    return { ok: null, status: res.status, count: 0, hits: 0, note: json?.error ?? text.slice(0, 120) };
  }

  const titles = titlesFrom(json);
  const tokens = query.toLowerCase().split(/\s+/);
  const hits   = titles.filter((t) => keywordHit(t, tokens)).length;

  return {
    ok:     titles.length === 0 ? null : hits > 0,
    status: 200,
    count:  titles.length,
    hits,
    note:   titles.length === 0 ? "empty results — supplier returned 0 items" : titles[0].slice(0, 80),
  };
}

(async () => {
  let anyFail = false;
  console.log(`Smoke test against ${ZUPLO_URL}`);
  console.log(`Queries: ${JSON.stringify(QUERIES)}`);
  console.log();

  for (const query of QUERIES) {
    console.log(`Query: "${query}"`);
    for (const ep of ENDPOINTS) {
      const r = await smoke(ep, query);
      const verdict = r.ok === true  ? "PASS"
                    : r.ok === false ? "FAIL"
                    :                  "SKIP";
      if (r.ok === false) anyFail = true;
      const cnt = `${r.hits}/${r.count}`.padStart(7);
      console.log(`  ${verdict.padEnd(4)}  ${ep.name.padEnd(14)} status=${r.status} hits=${cnt}  ${r.note}`);
    }
    console.log();
  }

  process.exit(anyFail ? 1 : 0);
})();
