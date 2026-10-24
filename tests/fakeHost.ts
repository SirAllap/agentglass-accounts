import { coreProblem } from "./helpers.ts";

/** A stand-in for agentglass's /plugin/self/* routes, on localhost: records what the plugin posts, serves events it is given. */
export function fakeHost(token = "host-fixture-token") {
  const accounts: any[] = [];
  const panels: { id: string; tree: any }[] = [];
  const queue: unknown[] = [];
  const waiters = new Set<() => void>();
  const state = { status: 0, eventFailures: 0, polls: 0, acceptPanel: true, refuseAccounts: false, swapkin: false, gets: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 401 });
      if (state.status) return new Response("no", { status: state.status });
      if (u.pathname === "/plugin/self/accounts" && req.method === "POST") {
        const b = (await req.json()) as any;
        if (state.refuseAccounts) return Response.json({ ok: false, error: "refused: test" }, { status: 400 });
        // Whole or nothing, like the core.
        const bad = coreProblem(b);
        if (bad) return Response.json({ ok: false, error: `refused: ${bad}` }, { status: 400 });
        accounts.push(b);
        return Response.json({ ok: true, kept: b.accounts.length });
      }
      if (u.pathname === "/usage/accounts" && req.method === "GET") {
        // The core's own verdict: managed only when the plugin asked with deferTo AND Swapkin is there for the core to see.
        state.gets++;
        const l = accounts.at(-1);
        if (!l) return Response.json({ ok: true, providers: [] });
        const managed = state.swapkin && l.deferTo === "swapkin";
        return Response.json({ ok: true, providers: [{ provider: "anthropic", plugin: "accounts", ...(managed ? { managedBy: "swapkin" } : {}), accounts: l.accounts }] });
      }
      if (u.pathname === "/plugin/self/panel" && req.method === "POST") {
        const b = (await req.json()) as { id: string; tree: unknown };
        if (!state.acceptPanel) return Response.json({ ok: false, error: "panel refused" }, { status: 400 });
        panels.push(b as { id: string; tree: any });
        return Response.json({ ok: true });
      }
      if (u.pathname === "/plugin/self/events") {
        state.polls++;
        if (state.eventFailures > 0) { state.eventFailures--; return new Response("boom", { status: 500 }); }
        const wait = Math.min(Number(u.searchParams.get("wait") ?? 25000), 30000);
        if (!queue.length) await new Promise<void>((res) => { const t = setTimeout(done, wait); function done() { clearTimeout(t); waiters.delete(done); res(); } waiters.add(done); });
        return Response.json({ ok: true, events: queue.splice(0) });
      }
      return new Response("no", { status: 404 });
    },
  });
  return {
    token, accounts, panels, state,
    url: `http://127.0.0.1:${server.port}`,
    push(ev: Record<string, unknown>) { queue.push({ at: Date.now(), ...ev }); for (const w of [...waiters]) w(); },
    stop() { for (const w of [...waiters]) w(); server.stop(true); },
    last: () => accounts.at(-1),
    lastPanel: () => panels.at(-1)?.tree,
  };
}

export async function until(cond: () => boolean, ms = 4000, what = "condition") {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Every node of a drawn tree, depth first. */
export function nodes(t: any, out: any[] = []): any[] {
  if (!t || typeof t !== "object") return out;
  if (Array.isArray(t)) { t.forEach((x) => nodes(x, out)); return out; }
  if (typeof t.type === "string") out.push(t);
  for (const v of Object.values(t)) if (v && typeof v === "object") nodes(v, out);
  return out;
}
