/**
 * Minimal Battle.net client for WoW: Forever.
 * Namespaces: dynamic-forever-{region}, static-forever-{region}; retail fallback static-{region}.
 * Endpoints are undocumented by Blizzard; see the README for where they were mapped.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ clientId, clientSecret, fetchImpl = fetch, log = console.log, minGapMs = 15 }) {
  let token = null;
  let tokenExp = 0;
  let lastCall = 0;
  let calls = 0;

  async function getToken() {
    if (token && Date.now() < tokenExp - 60_000) return token;
    const res = await fetchImpl("https://oauth.battle.net/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`Battle.net token request failed: HTTP ${res.status}`);
    const j = await res.json();
    token = j.access_token;
    tokenExp = Date.now() + (j.expires_in ?? 3600) * 1000;
    return token;
  }

  /**
   * GET a Game Data path. `ns` is "dynamic-forever", "static-forever" or "static" (retail).
   * Returns { status, lastModified, json }. 404 and 304 are returned, not thrown.
   */
  async function get(region, apiPath, ns, { locale, ifModifiedSince } = {}) {
    const url = new URL(`https://${region}.api.blizzard.com${apiPath}`);
    url.searchParams.set("namespace", `${ns}-${region}`);
    if (locale) url.searchParams.set("locale", locale);
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      calls++;
      const headers = { Authorization: `Bearer ${await getToken()}` };
      if (ifModifiedSince) headers["If-Modified-Since"] = ifModifiedSince;
      let res;
      try {
        res = await fetchImpl(url, { headers });
      } catch (e) {
        if (attempt >= 3) throw e;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const lastModified = res.headers.get("last-modified") ?? null;
      if (res.status === 304) return { status: 304, lastModified: lastModified ?? ifModifiedSince, json: null };
      if (res.status === 404) return { status: 404, lastModified, json: null };
      if (res.status === 401 && attempt < 1) {
        token = null;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const ra = Number(res.headers.get("retry-after")) || 2 ** attempt;
        log(`  ${res.status} on ${apiPath}, retrying in ${ra}s`);
        await sleep(ra * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`GET ${url.pathname} (${ns}-${region}) failed: HTTP ${res.status}`);
      return { status: res.status, lastModified, json: await res.json() };
    }
  }

  return { get, getToken, callCount: () => calls };
}
