/** A stand-in for the usage and token endpoints, on localhost, nothing real. */
export interface Hit { path: string; auth: string | null; body: string }
export function fakeServer(opts: { onUsage?: (token: string) => void } = {}) {
  const hits: Hit[] = [];
  const state = { tokenStatus: 200, usageStatus: 200, retryAfter: "", refreshN: 0, usage: {} as Record<string, unknown> };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      const auth = req.headers.get("authorization");
      hits.push({ path: u.pathname, auth, body });
      const headers: Record<string, string> = state.retryAfter ? { "retry-after": state.retryAfter } : {};
      if (u.pathname === "/token") {
        if (state.tokenStatus !== 200) return new Response("{}", { status: state.tokenStatus, headers });
        const n = ++state.refreshN;
        return Response.json({ access_token: `fixture-rot-access-${n}`, refresh_token: `fixture-rot-refresh-${n}`, expires_in: 3600 });
      }
      if (u.pathname === "/usage") {
        const t = auth?.replace("Bearer ", "") ?? "";
        opts.onUsage?.(t);
        if (state.usageStatus !== 200) return new Response("{}", { status: state.usageStatus, headers });
        return Response.json(state.usage[t] ?? { five_hour: { utilization: 41.6, resets_at: "2026-10-24T18:00:00Z" }, seven_day: { utilization: 7, resets_at: null }, seven_day_opus: { utilization: 99 } });
      }
      return new Response("no", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { hits, state, base, env: { ACCOUNTS_USAGE_URL: `${base}/usage`, ACCOUNTS_TOKEN_URL: `${base}/token` }, stop: () => server.stop(true) };
}
