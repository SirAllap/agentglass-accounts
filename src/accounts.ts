import { readFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { withLock } from "./lock.ts";
import { SecretStore, type Storage } from "./store.ts";
import { atomicWrite } from "./fsutil.ts";
import { claudePaths, readLive, writeLive, sameLogin, serialize, parseBundle, type Bundle, type ClaudePaths } from "./claude.ts";
import { swapkinPresent, mirror, type Env } from "./swapkin.ts";

/** An expected "no": its message is a sentence meant for the person, and never carries a token. */
export class Refused extends Error {}

export const DEFER_SENTENCE = "Swapkin manages your Claude logins on this machine, so this plugin changes nothing. Use Swapkin to switch, add or remove accounts.";
const MAX_ACCOUNTS = 8;
const COLOURS = ["blue", "violet", "green", "amber", "rose", "cyan", "teal", "neutral"];
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// shortcut: the refresh endpoint and client id are Claude Code's own and were not checked against a live one; ACCOUNTS_TOKEN_URL overrides the URL, upgrade when measured.
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-47d5-a7d5-7a22f64df5b9";
const PENDING_TTL_MS = 30 * 60_000;
const TIMELINE_MAX = 50;

export interface Window { label: string; minutes: number; usedPercent: number; resetsAt: string | null }
interface MetaAccount { id: string; label: string; colour: string; plan: string; storage: Storage; reading?: { at: number; windows: Window[] }; nextProbeAt?: number; failures?: number }
interface Meta { v: 1; accounts: MetaAccount[]; activeId: string | null; timeline: { at: string; from: string | null; to: string }[]; pending: { id: string; label: string; startedAt: number }[] }

export interface Body {
  provider: "anthropic";
  deferTo?: "swapkin";
  accounts: { id: string; label: string; plan: string; colour: string; active: boolean; storage: Storage; reading?: { windows: Window[] } }[];
}

/** Test seams: called at the points where a second writer could slip in. */
export interface Hooks { afterSave?: (round: number) => void | Promise<void>; beforeWrite?: () => void | Promise<void> }

export interface Options { store: SecretStore; hooks?: Hooks; now?: () => number }

// What a token or an email looks like (the core refuses a list that shows one), kept here so a label is cleaned before it is posted, not refused after.
const TOKEN_SHAPED = /\bsk-|\beyJ|[^\s@]+@[^\s@]+|[A-Za-z0-9+/=]{24,}/;
const BAD_CHARS = /[\u0000-\u001f\u007f<>\p{Cf}\p{Co}\p{Cs}\p{Cn}]/gu;
/** Shown text: bounded, plain, nothing token-shaped. Empty means "use a fallback". */
export function safeText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const t = v.replace(BAD_CHARS, "").trim().slice(0, max).trim();
  return TOKEN_SHAPED.test(t.normalize("NFKC")) ? "" : t;
}
export function slug(label: string, taken: Set<string>): string {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "");
  if (!base || /[a-z0-9]{24,}/.test(base)) base = "account";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}
const planOf = (oauth: Record<string, unknown>) => safeText(typeof oauth.subscriptionType === "string" ? oauth.subscriptionType.replace(/[^a-z]/gi, "").replace(/^./, (c) => c.toUpperCase()) : "", 24);

export class Accounts {
  private paths: ClaudePaths;
  private dir: string;
  private hooks: Hooks;
  private now: () => number;
  private store: SecretStore;

  constructor(private env: Env, o: Options) {
    if (!env.AGENTGLASS_PLUGIN_DATA) throw new Error("AGENTGLASS_PLUGIN_DATA is not set");
    this.dir = env.AGENTGLASS_PLUGIN_DATA;
    this.paths = claudePaths(env);
    this.store = o.store;
    this.hooks = o.hooks ?? {};
    this.now = o.now ?? Date.now;
  }

  static async open(env: Env, o: Partial<Options> = {}): Promise<Accounts> {
    if (!env.AGENTGLASS_PLUGIN_DATA) throw new Error("AGENTGLASS_PLUGIN_DATA is not set");
    return new Accounts(env, { ...o, store: o.store ?? (await SecretStore.open(env.AGENTGLASS_PLUGIN_DATA)) });
  }

  /** What the app reports. A boxed plugin has no PATH entry or folder to find Swapkin by, so the app's own look (same fact, outside the box) counts as much as ours. */
  hostSaysDeferred = false;
  deferred = () => this.hostSaysDeferred || swapkinPresent(this.env);
  /** Asked right before every write, not once at the top: Swapkin can be installed while a switch is running. */
  private guard() { if (this.deferred()) throw new Refused(DEFER_SENTENCE); }

  // ---- metadata (no secret, no email, no uuid) ----
  private metaFile = () => join(this.dir, "accounts.json");
  private loadMeta(): Meta {
    try {
      const m = JSON.parse(readFileSync(this.metaFile(), "utf8"));
      if (m?.v === 1 && Array.isArray(m.accounts)) return { activeId: null, timeline: [], pending: [], ...m };
    } catch { /* first run */ }
    return { v: 1, accounts: [], activeId: null, timeline: [], pending: [] };
  }
  private saveMeta(m: Meta) { this.guard(); atomicWrite(this.metaFile(), JSON.stringify(m, null, 2)); }
  private locked<T>(fn: () => Promise<T>) { return withLock(this.dir, fn); }

  // ---- identity ----
  private async bundleOf(id: string): Promise<Bundle | null> {
    const t = await this.store.get(id);
    if (t === null) return null;
    try { return parseBundle(t); } catch { return null; }
  }
  /** Which saved account the live login is, matched in memory only. */
  private async identify(meta: Meta, live: Bundle | null): Promise<string | null> {
    if (!live) return null;
    for (const a of meta.accounts) { const b = await this.bundleOf(a.id); if (b && sameLogin(live, b)) return a.id; }
    return null;
  }
  private async put(meta: Meta, id: string, b: Bundle) {
    this.guard();
    const kind = await this.store.set(id, serialize(b));
    const a = meta.accounts.find((x) => x.id === id);
    if (a) a.storage = kind;
    return kind;
  }

  // ---- what the app is told ----
  async body(): Promise<Body> {
    if (this.deferred()) return this.deferredBody();
    const meta = this.loadMeta();
    const active = await this.identify(meta, readLive(this.paths));
    return { provider: "anthropic", accounts: meta.accounts.map((a, i) => ({
      id: a.id, label: safeText(a.label, 32) || `Account ${i + 1}`, plan: safeText(a.plan, 24), colour: COLOURS.includes(a.colour) ? a.colour : "neutral",
      active: a.id === active, storage: a.storage,
      // the app measures the active login itself; a reading for it is ignored there, so none is sent
      ...(a.id !== active && a.reading ? { reading: { windows: a.reading.windows } } : {}),
    })) };
  }

  /** Read-only: Swapkin's public fields when it answers, else our own list with no readings and nobody marked active by us. */
  private async deferredBody(): Promise<Body> {
    const m = await mirror(this.env);
    const taken = new Set<string>(), seen = new Set<string>();
    if (m) {
      const accounts = m.slice(0, MAX_ACCOUNTS).map((a, i) => {
        let label = safeText(a.name, 32) || `Account ${i + 1}`;
        while (seen.has(label.toLowerCase())) label = `${label.slice(0, 28)} ${i + 1}`;
        seen.add(label.toLowerCase());
        const id = slug(label, taken); taken.add(id);
        const windows = a.windows.slice(0, 6).filter((w) => w.label && w.usedPercent >= 0 && w.usedPercent <= 100 && w.minutes >= 1 && w.minutes <= 44640);
        return { id, label, plan: safeText(a.plan, 24), colour: COLOURS[i % COLOURS.length], active: a.active, storage: "file" as Storage,
          ...(!a.active && windows.length ? { reading: { windows: windows.map((w) => ({ ...w, label: safeText(w.label, 16) || "window" })) } } : {}) };
      });
      if (accounts.filter((a) => a.active).length <= 1) return { provider: "anthropic", deferTo: "swapkin", accounts };
    }
    const meta = this.loadMeta();
    return { provider: "anthropic", deferTo: "swapkin", accounts: meta.accounts.map((a, i) => ({
      id: a.id, label: safeText(a.label, 32) || `Account ${i + 1}`, plan: safeText(a.plan, 24), colour: COLOURS.includes(a.colour) ? a.colour : "neutral", active: a.id === meta.activeId, storage: a.storage })) };
  }

  /** The manage page's view: ids, labels, whether one is active. No secrets. */
  pendingList() { return this.loadMeta().pending; }

  // ---- switch ----
  async use(id: string): Promise<void> {
    this.guard();
    return this.locked(async () => {
      this.guard();
      const meta = this.loadMeta();
      if (!meta.accounts.some((a) => a.id === id)) throw new Refused("That account is not saved here.");
      const incoming = await this.bundleOf(id);
      if (!incoming) throw new Refused("The saved login for that account could not be read. Remove it and add it again.");
      const live = readLive(this.paths);
      const outId = await this.identify(meta, live);
      if (live && !outId) throw new Refused("The login Claude Code is using now is not one of your saved accounts, so switching would lose it. Save it as an account first.");
      if (live && outId) {
        // Refresh tokens rotate: the outgoing login is written to ITS OWN slot before anything else, and again if it moved while we worked.
        let saved = live, round = 0;
        for (;;) {
          await this.put(meta, outId, saved);
          await this.hooks.afterSave?.(++round);
          const now = readLive(this.paths);
          if (!now || !sameLogin(now, saved)) throw new Refused("The Claude Code login changed while switching, so nothing was changed. Try again.");
          if (JSON.stringify(now.oauth) === JSON.stringify(saved.oauth)) break;
          if (round >= 5) throw new Refused("The Claude Code login kept changing while switching, so nothing was changed. Try again.");
          saved = now;
        }
      }
      await this.hooks.beforeWrite?.();
      if (outId === id) { meta.activeId = id; this.saveMeta(meta); return; }
      this.guard();
      writeLive(this.paths, incoming);
      meta.timeline = [...meta.timeline, { at: new Date(this.now()).toISOString(), from: outId, to: id }].slice(-TIMELINE_MAX);
      meta.activeId = id;
      this.saveMeta(meta);
    });
  }

  // ---- add ----
  private labelFor(meta: Meta, raw: string): string {
    const label = safeText(raw, 32);
    if (!label || label !== raw.trim()) throw new Refused("Pick a plain name up to 32 characters, with no email or key in it.");
    if (meta.accounts.some((a) => a.label.toLowerCase() === label.toLowerCase())) throw new Refused("Another account already has that name.");
    if (meta.accounts.length >= MAX_ACCOUNTS) throw new Refused(`At most ${MAX_ACCOUNTS} accounts can be kept.`);
    return label;
  }
  private addTo(meta: Meta, label: string, b: Bundle, storage: Storage): MetaAccount {
    const taken = new Set(meta.accounts.map((a) => a.id));
    const used = new Set(meta.accounts.map((a) => a.colour));
    const a: MetaAccount = { id: slug(label, taken), label, colour: COLOURS.find((c) => !used.has(c)) ?? "neutral", plan: planOf(b.oauth), storage };
    meta.accounts.push(a);
    return a;
  }

  /** "Save the login Claude Code has now as an account." */
  async saveCurrent(raw: string): Promise<{ id: string }> {
    this.guard();
    return this.locked(async () => {
      this.guard();
      const meta = this.loadMeta();
      const label = this.labelFor(meta, raw);
      const live = readLive(this.paths);
      if (!live) throw new Refused("Claude Code is not signed in, so there is no login to save.");
      const same = await this.identify(meta, live);
      if (same) throw new Refused(`That login is already saved as "${meta.accounts.find((a) => a.id === same)!.label}".`);
      const a = this.addTo(meta, label, live, "file");
      await this.put(meta, a.id, live);
      meta.activeId = a.id;
      this.saveMeta(meta);
      return { id: a.id };
    });
  }

  private pendingDir = (id: string) => {
    if (!/^[a-z0-9]{8,32}$/.test(id)) throw new Refused("Unknown add in progress.");
    return join(this.dir, "pending", id);
  };
  // The folder is recomputed from the id, never read from the metadata file, and removed only if it sits under pending/.
  private dropPending(meta: Meta, id: string) {
    const dir = resolve(this.pendingDir(id));
    if (dir.startsWith(resolve(this.dir, "pending") + sep)) rmSync(dir, { recursive: true, force: true });
    meta.pending = meta.pending.filter((p) => p.id !== id);
  }

  /** "Add another account": a throwaway Claude config dir the person logs in to. Nothing live is touched. */
  async startAdd(raw: string): Promise<{ pendingId: string; command: string }> {
    this.guard();
    return this.locked(async () => {
      this.guard();
      const meta = this.loadMeta();
      for (const p of meta.pending.filter((p) => this.now() - p.startedAt > PENDING_TTL_MS)) this.dropPending(meta, p.id);
      const label = this.labelFor(meta, raw);
      if (meta.pending.length >= 2) throw new Refused("Finish or cancel the add in progress first.");
      const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("");
      mkdirSync(this.pendingDir(id), { recursive: true, mode: 0o700 });
      chmodSync(this.pendingDir(id), 0o700);
      meta.pending.push({ id, label, startedAt: this.now() });
      this.saveMeta(meta);
      return { pendingId: id, command: this.addCommand(id) };
    });
  }

  /** The command to tell the person for an add in progress; the page shows it again after a redraw. */
  addCommand(pendingId: string): string { return `CLAUDE_CONFIG_DIR='${this.pendingDir(pendingId)}' claude auth login`; }

  /** Looks for the login the throwaway dir was given. `done:false` means "not yet". */
  async finishAdd(pendingId: string): Promise<{ done: boolean; id?: string }> {
    this.guard();
    return this.locked(async () => {
      this.guard();
      const meta = this.loadMeta();
      const p = meta.pending.find((x) => x.id === pendingId);
      if (!p) throw new Refused("Unknown add in progress.");
      if (this.now() - p.startedAt > PENDING_TTL_MS) { this.dropPending(meta, p.id); this.saveMeta(meta); throw new Refused("That add took too long and was cancelled. Start again."); }
      const dir = this.pendingDir(pendingId);
      const b = readLive({ creds: join(dir, ".credentials.json"), json: join(dir, ".claude.json") });
      if (!b) return { done: false };
      const same = await this.identify(meta, b);
      if (same) { this.dropPending(meta, p.id); this.saveMeta(meta); throw new Refused(`That login is already saved as "${meta.accounts.find((a) => a.id === same)!.label}".`); }
      const a = this.addTo(meta, this.labelFor(meta, p.label), b, "file");
      await this.put(meta, a.id, b);
      this.dropPending(meta, p.id);
      this.saveMeta(meta);
      return { done: true, id: a.id };
    });
  }

  async cancelAdd(pendingId: string): Promise<void> {
    return this.locked(async () => { const meta = this.loadMeta(); this.dropPending(meta, pendingId); this.saveMeta(meta); });
  }

  // ---- remove / edit ----
  async remove(id: string, opts: { force?: boolean } = {}): Promise<void> {
    this.guard();
    return this.locked(async () => {
      this.guard();
      const meta = this.loadMeta();
      if (!meta.accounts.some((a) => a.id === id)) throw new Refused("That account is not saved here.");
      if (!opts.force && (await this.identify(meta, readLive(this.paths))) === id)
        throw new Refused("That is the account Claude Code is using now. Switch to another one first, or remove it anyway to keep only the live login.");
      this.guard();
      await this.store.delete(id);
      meta.accounts = meta.accounts.filter((a) => a.id !== id);
      if (meta.activeId === id) meta.activeId = null;
      this.saveMeta(meta);
    });
  }

  async edit(id: string, change: { label?: string; colour?: string }): Promise<void> {
    this.guard();
    return this.locked(async () => {
      const meta = this.loadMeta();
      const a = meta.accounts.find((x) => x.id === id);
      if (!a) throw new Refused("That account is not saved here.");
      if (change.label !== undefined) a.label = this.labelFor({ ...meta, accounts: meta.accounts.filter((x) => x.id !== id) }, change.label);
      if (change.colour !== undefined) {
        if (!COLOURS.includes(change.colour)) throw new Refused("Unknown colour.");
        a.colour = change.colour;
      }
      this.saveMeta(meta);
    });
  }

  // ---- probe ----
  private usageUrl = () => this.env.ACCOUNTS_USAGE_URL || USAGE_URL;
  private tokenUrl = () => this.env.ACCOUNTS_TOKEN_URL || TOKEN_URL;

  /** One pass over every saved account that is not the live login. Returns the ids it read. */
  async probeAll(): Promise<string[]> {
    if (this.deferred()) return [];
    const read: string[] = [];
    for (const a of this.loadMeta().accounts) if (await this.probe(a.id)) read.push(a.id);
    return read;
  }

  private async probe(id: string): Promise<boolean> {
    // Phase 1, locked: choose the token, renewing it if needed. A renewal rotates the refresh token, so the new pair is stored before anything else and under the same lock a switch takes.
    const token = await this.locked(async () => {
      this.guard();
      const meta = this.loadMeta();
      const a = meta.accounts.find((x) => x.id === id);
      if (!a || (a.nextProbeAt ?? 0) > this.now()) return null;
      const b = await this.bundleOf(id);
      if (!b) return null;
      const live = readLive(this.paths);
      if (live && sameLogin(live, b)) return null; // the app measures the login in use
      const exp = typeof b.oauth.expiresAt === "number" ? b.oauth.expiresAt : 0;
      if (typeof b.oauth.accessToken === "string" && exp - this.now() > 60_000) return b.oauth.accessToken;
      const fresh = await this.renew(b);
      if ("retryMs" in fresh) { this.backoff(a, fresh.retryMs); this.saveMeta(meta); return null; }
      await this.put(meta, id, fresh);
      this.saveMeta(meta);
      return fresh.oauth.accessToken as string;
    });
    if (!token) return false;
    // Phase 2, unlocked: the usage read is slow and holds nothing that must not be shared.
    const res = await this.usage(token);
    return this.locked(async () => {
      this.guard();
      const meta = this.loadMeta();
      const a = meta.accounts.find((x) => x.id === id);
      if (!a) return false;
      if ("retryMs" in res) { this.backoff(a, res.retryMs); this.saveMeta(meta); return false; }
      a.reading = { at: this.now(), windows: res };
      a.failures = 0; delete a.nextProbeAt;
      this.saveMeta(meta);
      return true;
    });
  }

  /** A failed read waits: what the server asked for (Retry-After) if it said, else 5 minutes doubling to 2 hours. The last reading stays. */
  private backoff(a: MetaAccount, askedMs: number) {
    a.failures = (a.failures ?? 0) + 1;
    const wait = askedMs > 0 ? askedMs : 5 * 60_000 * 2 ** (a.failures - 1);
    a.nextProbeAt = this.now() + Math.min(wait, 2 * 3_600_000);
  }

  private async renew(b: Bundle): Promise<Bundle | Fail> {
    try {
      const r = await fetch(this.tokenUrl(), { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: b.oauth.refreshToken, client_id: CLIENT_ID }) });
      if (!r.ok) return { retryMs: retryAfter(r) };
      const j = (await r.json()) as Record<string, unknown>;
      if (typeof j.access_token !== "string") return { retryMs: 0 };
      const exp = typeof j.expires_in === "number" ? this.now() + j.expires_in * 1000 : this.now() + 3_600_000;
      return { account: b.account, oauth: { ...b.oauth, accessToken: j.access_token, refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : b.oauth.refreshToken, expiresAt: exp } };
    } catch { return { retryMs: 0 }; }
  }

  private async usage(token: string): Promise<Window[] | Fail> {
    try {
      const r = await fetch(this.usageUrl(), { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "agentglass-accounts" }, signal: AbortSignal.timeout(8000) });
      return r.ok ? windowsOf(await r.json()) : { retryMs: retryAfter(r) };
    } catch { return { retryMs: 0 }; }
  }
}

interface Fail { retryMs: number }

function retryAfter(r: Response): number {
  const s = Number(r.headers.get("retry-after"));
  return r.status === 429 && Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

/** The usage endpoint's two metered windows. Scoped model limits are not mapped (a ceiling, not a bug). */
export function windowsOf(j: any): Window[] {
  const out: Window[] = [];
  for (const [key, label, minutes] of [["five_hour", "5h", 300], ["seven_day", "7d", 10080]] as const) {
    const w = j?.[key];
    if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    const t = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    out.push({ label, minutes, usedPercent: Math.min(100, Math.max(0, Math.round(w.utilization))), resetsAt: Number.isNaN(t) ? null : new Date(t).toISOString() });
  }
  return out;
}
