import type { Env } from "./swapkin.ts";
import type { Body } from "./accounts.ts";

/** The host said 401 or 403: the token is revoked, the plugin was switched off or removed. Nothing more to do. */
export class Gone extends Error {}

export interface HostEvent { type?: unknown; [k: string]: unknown }

/** The few `/plugin/self/*` routes this plugin uses. The bearer token never leaves this file. */
export function hostClient(env: Env, f: typeof fetch = fetch) {
  const base = env.AGENTGLASS_URL, token = env.AGENTGLASS_READ_TOKEN;
  if (!base || !token) throw new Error("AGENTGLASS_URL and AGENTGLASS_READ_TOKEN are required: run this plugin from agentglass.");
  const call = async (path: string, init: RequestInit & { timeoutMs: number }) => {
    const r = await f(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs)]) : AbortSignal.timeout(init.timeoutMs) });
    if (r.status === 401 || r.status === 403) throw new Gone();
    return r;
  };
  /** null when the host took it, else its sentence. */
  const post = async (path: string, body: unknown): Promise<string | null> => {
    const r = await call(path, { method: "POST", body: JSON.stringify(body), timeoutMs: 10_000 });
    if (r.ok) return null;
    const j = (await r.json().catch(() => null)) as { error?: unknown } | null;
    return typeof j?.error === "string" ? j.error.slice(0, 200) : `HTTP ${r.status}`;
  };
  return {
    postAccounts: (body: Body) => post("/plugin/self/accounts", body),
    postPanel: (id: string, tree: unknown) => post("/plugin/self/panel", { id, tree }),
    /** What the app says about the list it holds for anthropic: "swapkin" when it verified Swapkin itself. null when it cannot be read. */
    async managedBy(): Promise<string | null> {
      const r = await call("/usage/accounts", { timeoutMs: 10_000 });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { providers?: { provider?: unknown; managedBy?: unknown }[] } | null;
      const p = j?.providers?.find((x) => x.provider === "anthropic");
      return p && typeof p.managedBy === "string" ? p.managedBy : "";
    },
    /** Long poll. Resolves with the events queued, or none after `waitMs`; throws on a network error or a non-2xx. */
    async events(waitMs: number, signal?: AbortSignal): Promise<HostEvent[]> {
      const r = await call(`/plugin/self/events?wait=${waitMs}`, { signal, timeoutMs: waitMs + 10_000 });
      if (!r.ok) throw new Error(`events: HTTP ${r.status}`);
      const j = (await r.json()) as { events?: unknown };
      return Array.isArray(j.events) ? j.events.filter((e): e is HostEvent => !!e && typeof e === "object") : [];
    },
  };
}
export type Host = ReturnType<typeof hostClient>;
