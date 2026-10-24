/**
 * The usage payload in the shape `omarchy-agent-usage-claude` reads (`probe_limits`, lines 742-761 and 677-708): percent-scaled buckets, the app-scoped weekly bucket next to
 * the plain one, null legacy per-model buckets, and a `limits` array that alone carries a model-scoped window. Values are invented.
 */
export const REAL_SHAPE = {
  five_hour: { utilization: 41.6, resets_at: "2026-10-24T18:00:00.123456+00:00" },
  seven_day: { utilization: 7, resets_at: "2026-10-29T09:00:00+00:00" },
  seven_day_oauth_apps: { utilization: 9.0, resets_at: "2026-10-30T09:00:00+00:00" },
  seven_day_opus: null,
  limits: [{ kind: "weekly_scoped", scope: { model: { id: "orbit-pro", display_name: "Orbit Pro" } }, percent: 55, resets_at: "2026-10-30T09:00:00+00:00" }],
};

/** A stand-in for the usage and token endpoints, on localhost, nothing real. */
export interface Hit { path: string; auth: string | null; body: string; beta: string | null; accept: string | null }
export function fakeServer(opts: { onUsage?: (token: string) => void; onToken?: () => void } = {}) {
  const hits: Hit[] = [];
  const state = { tokenStatus: 200, usageStatus: 200, retryAfter: "", refreshN: 0, usage: {} as Record<string, unknown> };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      const auth = req.headers.get("authorization");
      hits.push({ path: u.pathname, auth, body, beta: req.headers.get("anthropic-beta"), accept: req.headers.get("accept") });
      const headers: Record<string, string> = state.retryAfter ? { "retry-after": state.retryAfter } : {};
      if (u.pathname === "/token") {
        opts.onToken?.();
        if (state.tokenStatus !== 200) return new Response("{}", { status: state.tokenStatus, headers });
        const n = ++state.refreshN;
        return Response.json({ access_token: `fixture-rot-access-${n}`, refresh_token: `fixture-rot-refresh-${n}`, expires_in: 3600 });
      }
      if (u.pathname === "/usage") {
        const t = auth?.replace("Bearer ", "") ?? "";
        opts.onUsage?.(t);
        if (state.usageStatus !== 200) return new Response("{}", { status: state.usageStatus, headers });
        return Response.json(state.usage[t] ?? REAL_SHAPE);
      }
      return new Response("no", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { hits, state, base, env: { ACCOUNTS_USAGE_URL: `${base}/usage`, ACCOUNTS_TOKEN_URL: `${base}/token` }, stop: () => server.stop(true) };
}
