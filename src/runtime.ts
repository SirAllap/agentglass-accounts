import { Accounts, Refused, type Body } from "./accounts.ts";
import { Gone, hostClient, type Host, type HostEvent } from "./host.ts";
import { manageTree, type Notice } from "./panel.ts";
import type { Env } from "./swapkin.ts";

export interface RunOptions {
  acc?: Accounts;
  host?: Host;
  signal?: AbortSignal;
  /** Long-poll wait, ms. The host caps it at 30 000. */
  waitMs?: number;
  /** First backoff after a failed poll, ms; doubles to 30 s. */
  retryMs?: number;
  /** Failed polls in a row after which the run ends: a host that is gone must not leave this process polling for ever. */
  maxFailures?: number;
  /** How often the app is asked again whether it sees Swapkin, even when nothing changed. */
  verdictMs?: number;
  /** Delay before the first probe pass, then the period (jittered +-25%). */
  firstProbeMs?: number;
  probeMs?: number;
  log?: (line: string) => void;
}

const PANEL = "accounts";
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Posts the account list and the manage page, then serves the host's events
 * until `signal` aborts or the host revokes the token. A switch is answered
 * only by posting the new list: the core has no other acknowledgement.
 */
export async function run(env: Env, o: RunOptions = {}): Promise<void> {
  const host = o.host ?? hostClient(env);
  const acc = o.acc ?? (await Accounts.open(env));
  // Only the error's class and code are logged: a message from a parser can quote the file it choked on.
  const log = o.log ?? ((l: string) => console.error(`accounts: ${l}`));
  const why = (e: unknown) => `${(e as Error)?.name ?? "error"}${(e as { code?: string })?.code ? ` ${(e as { code?: string }).code}` : ""}`;
  const waitMs = o.waitMs ?? 25_000;
  // Own controller: ending the run (a revoked token) must also stop the probe timer.
  const stopper = new AbortController();
  const signal = stopper.signal;
  o.signal?.addEventListener("abort", () => stopper.abort(), { once: true });
  if (o.signal?.aborted) stopper.abort();
  let notice: Notice | null = null;
  let lastBody = "", lastTree = "", lastErr = "";
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  let lastVerdict = 0;
  /**
   * Posts what changed since the last time (all of it when `force`). A list the
   * host refused is tried again on the next pass. Every list carries
   * `deferTo: "swapkin"`: the app drops it unless it finds Swapkin itself, and
   * what it answers is read back, because inside a box this process has no way
   * to find Swapkin and the app does.
   */
  const publish = (force = false): Promise<void> => serial(async () => {
    for (let round = 0; round < 2; round++) {
      const body: Body = { ...(await acc.body()), deferTo: "swapkin" };
      const text = JSON.stringify(body);
      let again = false;
      if (force || text !== lastBody) {
        const err = await host.postAccounts(body);
        if (err === null) {
          lastBody = text; lastErr = ""; lastVerdict = Date.now();
          const verdict = await host.managedBy().catch((e) => { if (e instanceof Gone) throw e; return null; });
          if (verdict !== null && (verdict === "swapkin") !== acc.hostSaysDeferred) { acc.hostSaysDeferred = verdict === "swapkin"; again = true; }
        } else if (err !== lastErr) { lastErr = err; log(`the app refused the list: ${err}`); }
      }
      if (again) { force = true; continue; } // the list differs now (read-only, mirrored): say so
      await draw(body);
      return;
    }
  });
  const draw = async (body: Body) => {
    const tree = manageTree({ accounts: body.accounts, deferred: acc.deferred(), notice,
      pending: acc.pendingList().map((p) => ({ id: p.id, label: p.label, command: acc.addCommand(p.id) })) });
    const t = JSON.stringify(tree);
    if (t !== lastTree) { const err = await host.postPanel(PANEL, tree); if (err === null) lastTree = t; else log(`the app refused the page: ${err}`); }
  };

  const say = (text: string, tone: Notice["tone"] = "success") => { notice = { text, tone }; };
  const attempt = async (fn: () => Promise<string | void>) => {
    try { const ok = await fn(); notice = ok ? { text: ok, tone: "success" } : null; }
    catch (e) {
      if (e instanceof Refused) say(e.message, "warning");
      else { log(`failed: ${why(e)}`); say("That did not work and nothing was changed.", "danger"); }
    }
  };

  const handle = async (ev: HostEvent) => {
    // Asked again right before anything that writes: Swapkin can arrive between two polls.
    if (ev.type === "account.switch" || ev.type === "action") await publish(true);
    if (ev.type === "account.switch") {
      const id = str(ev.id);
      if (ev.provider !== "anthropic" || id === null) return;
      await attempt(async () => { await acc.use(id); return "Switched."; });
    } else if (ev.type === "account.manage") {
      notice = null;
    } else if (ev.type === "action") {
      const a = rec(ev.action), payload = rec(a.payload), values = rec(ev.values);
      const id = str(payload.id), label = str(values.label);
      switch (a.id) {
        case "use": if (id !== null) await attempt(async () => { await acc.use(id); return "Switched."; }); break;
        case "remove": if (id !== null) await attempt(async () => { await acc.remove(id); return "Removed."; }); break;
        case "save": await attempt(async () => { await acc.saveCurrent(label ?? ""); return "Saved the login Claude Code has now."; }); break;
        case "add": await attempt(async () => { await acc.startAdd(label ?? ""); return "Run the command below, sign in, then press check."; }); break;
        case "cancel": if (id !== null) await attempt(async () => { await acc.cancelAdd(id); }); break;
        case "check": if (id !== null) await attempt(async () => (await acc.finishAdd(id)).done ? "Added." : "Not signed in yet. Run the command and sign in, then check again."); break;
        default: return;
      }
    } else return;
    await publish();
  };

  const sleep = (ms: number) => new Promise<void>((res) => {
    if (signal.aborted) return res();
    const t = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); res(); }
  });

  const probes = (async () => {
    let wait = o.firstProbeMs ?? 5_000;
    while (!signal.aborted) {
      await sleep(wait);
      wait = (o.probeMs ?? 4 * 60_000) * (0.75 + Math.random() * 0.5);
      if (signal.aborted || acc.deferred()) continue;
      try { if ((await acc.probeAll()).length) await publish(); } catch (e) { if (e instanceof Gone) return; log(`probe failed: ${why(e)}`); }
    }
  })();

  let failures = 0;
  try {
    await publish();
    while (!signal.aborted) {
      try {
        const events = await host.events(waitMs, signal);
        failures = 0;
        for (const ev of events) await handle(ev);
        // A login changed by Claude Code, a late Swapkin, a probe: no event says so, so each poll looks.
        await publish(Date.now() - lastVerdict > (o.verdictMs ?? 5 * 60_000));
      } catch (e) {
        if (e instanceof Gone) return;
        if (signal.aborted) return;
        log(`poll failed: ${why(e)}`);
        if (failures + 1 >= (o.maxFailures ?? 8)) return;
        await sleep(Math.min((o.retryMs ?? 2_000) * 2 ** failures++, 30_000));
      }
    }
  } finally {
    stopper.abort();
    await probes.catch(() => {});
  }
}
