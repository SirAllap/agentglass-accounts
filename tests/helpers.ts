import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const made: string[] = [];
/** A private scratch dir; `cleanup()` in afterAll removes only what this helper made. */
export function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "agx-acc-"));
  made.push(d);
  return d;
}
export function cleanup() { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); }

export interface Login { access: string; refresh: string; uuid: string; plan?: string; expiresAt?: number }
/** Invented credentials in the shape Claude Code writes. */
export function creds(l: Login, extra: Record<string, unknown> = {}) {
  return { claudeAiOauth: { accessToken: l.access, refreshToken: l.refresh, expiresAt: l.expiresAt ?? Date.now() + 3_600_000, scopes: ["user:inference", "user:profile"], subscriptionType: l.plan ?? "max" }, ...extra };
}

export interface Home { root: string; home: string; claudeDir: string; claudeJson: string; data: string; credsFile: string; env: Record<string, string> }
/** An isolated HOME with a live login, nothing shared with the real machine. */
export function makeHome(live?: Login): Home {
  const root = scratch();
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const data = join(root, "data");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const h: Home = { root, home, claudeDir, claudeJson: join(home, ".claude.json"), data, credsFile: join(claudeDir, ".credentials.json"),
    env: { HOME: home, PATH: join(root, "bin"), XDG_DATA_HOME: join(root, "xdg"), AGENTGLASS_PLUGIN_DATA: data } };
  mkdirSync(join(root, "bin"));
  if (live) setLive(h, live);
  return h;
}
export function setLive(h: Home, l: Login) {
  writeFileSync(h.credsFile, JSON.stringify(creds(l, { mcpOAuth: { keep: "me" } })), { mode: 0o600 });
  writeFileSync(h.claudeJson, JSON.stringify({ numStartups: 7, oauthAccount: { accountUuid: l.uuid, displayName: "Fixture" }, projects: { "/orbit": {} } }), { mode: 0o600 });
}
export const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

/** A stub program on the isolated PATH. */
export function stub(h: Home, name: string, body: string) {
  const f = join(h.root, "bin", name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
}

/** Hash of every file under dirs plus its mode: "byte-identical" in one comparison. */
export function treeHash(...paths: string[]): string {
  const h = createHash("sha256");
  const walk = (p: string) => {
    let st; try { st = statSync(p); } catch { h.update(`missing:${p}`); return; }
    if (st.isDirectory()) { for (const n of readdirSync(p).sort()) walk(join(p, n)); } else h.update(`${p}:${st.mode & 0o777}:`).update(readFileSync(p));
  };
  paths.forEach(walk);
  return h.digest("hex");
}

/**
 * The core's rules for an account list (shared/pluginAccounts.ts), copied so a
 * change there fails here instead of in a user's popover. Returns the first
 * problem or null.
 */
const TOKEN_SHAPED = /\bsk-|\beyJ|[^\s@]+@[^\s@]+|[A-Za-z0-9+/=]{24,}/;
const COLOURS = ["neutral", "blue", "violet", "green", "amber", "rose", "cyan", "teal"];
function plain(v: unknown, f: string, max: number, min: number): string | null {
  if (typeof v !== "string") return `${f} not a string`;
  if (v.length < min || v.length > max) return `${f} length`;
  if (/[\u0000-\u001f\u007f<>]/.test(v) || /[\p{Cf}\p{Co}\p{Cs}\p{Cn}]/u.test(v)) return `${f} not plain`;
  if (TOKEN_SHAPED.test(v.trim().normalize("NFKC"))) return `${f} token-shaped`;
  return null;
}
export function coreProblem(body: any): string | null {
  if (!body || body.provider !== "anthropic") return "provider";
  if (!Array.isArray(body.accounts) || body.accounts.length > 8) return "list";
  const ids = new Set<string>(), labels = new Set<string>();
  for (const [n, a] of body.accounts.entries()) {
    if (typeof a.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(a.id)) return `[${n}].id`;
    const bad = plain(a.id, "id", 32, 1) ?? plain(a.label, "label", 32, 1) ?? plain(a.plan, "plan", 24, 0);
    if (bad) return `[${n}] ${bad}`;
    const pieces = [a.id, a.label, a.plan].map((f: string) => f.trim().normalize("NFKC")).filter((f: string) => f && !/\s/.test(f)).map((f: string) => f.replace(/[-_]/g, "").toLowerCase());
    const own = pieces.filter((p: string, i: number) => p && !pieces.some((q: string, j: number) => j !== i && (q.includes(p) && (q !== p || j < i))));
    const joined = own.join("");
    if (own.length >= 2 && /[A-Za-z0-9+/=]{24,}/.test(joined) && (joined.match(/[a-z]\d|\d[a-z]/g)?.length ?? 0) >= 4) return `[${n}] split token`;
    if (!COLOURS.includes(a.colour)) return `[${n}].colour`;
    if (typeof a.active !== "boolean") return `[${n}].active`;
    if (a.storage !== "keyring" && a.storage !== "file") return `[${n}].storage`;
    if (!a.label.trim()) return `[${n}].label empty`;
    if (ids.has(a.id)) return "dup id";
    if (labels.has(a.label.trim().toLowerCase())) return "dup label";
    ids.add(a.id); labels.add(a.label.trim().toLowerCase());
    if (a.reading !== undefined) {
      if (!Array.isArray(a.reading.windows) || a.reading.windows.length > 6) return `[${n}].windows`;
      const wl = new Set<string>();
      for (const w of a.reading.windows) {
        const b = plain(w.label, "wlabel", 16, 1); if (b) return b;
        if (!Number.isInteger(w.minutes) || w.minutes < 1 || w.minutes > 44640) return "minutes";
        if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) return "usedPercent";
        if (w.resetsAt !== null && (typeof w.resetsAt !== "string" || w.resetsAt.length > 40 || Number.isNaN(Date.parse(w.resetsAt)))) return "resetsAt";
        if (wl.has(w.label.toLowerCase())) return "dup wlabel"; wl.add(w.label.toLowerCase());
      }
    }
  }
  if (body.accounts.filter((a: any) => a.active).length > 1) return "two active";
  return null;
}
