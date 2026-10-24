import { readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, overwriteJsonInPlace } from "./fsutil.ts";
import type { Env } from "./swapkin.ts";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Everything that makes a Claude Code login "this account": the token block and the account key. In memory or in a secret store only. */
export interface Bundle { oauth: Rec; account: Rec | null }
export interface ClaudePaths { creds: string; json: string }

export function claudePaths(env: Env): ClaudePaths {
  const dir = env.ACCOUNTS_CLAUDE_DIR || env.CLAUDE_CONFIG_DIR || join(env.HOME ?? "", ".claude");
  const json = env.ACCOUNTS_CLAUDE_JSON || (env.CLAUDE_CONFIG_DIR && !env.ACCOUNTS_CLAUDE_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(env.HOME ?? "", ".claude.json"));
  return { creds: join(dir, ".credentials.json"), json };
}

function readObj(f: string): Rec | null {
  if (!existsSync(f)) return null;
  const j: unknown = JSON.parse(readFileSync(f, "utf8")); // a half-written file throws: never overwrite what cannot be read
  if (!isRec(j)) throw new Error(`${f} is not a JSON object`);
  return j;
}

/** The live login, or null when Claude Code is signed out. */
export function readLive(p: ClaudePaths): Bundle | null {
  const oauth = readObj(p.creds)?.claudeAiOauth;
  if (!isRec(oauth) || typeof oauth.refreshToken !== "string") return null;
  const acct = readObj(p.json)?.oauthAccount;
  return { oauth, account: isRec(acct) ? acct : null };
}

/** The live login moved between the caller's last look and the write: a refresh landed, so nothing was written. */
export class LiveMoved extends Error {}
export interface WriteOpts {
  /** Where the live files are copied to before they are replaced. */
  backupDir: string;
  /** The `claudeAiOauth` the caller saved a moment ago. If the file holds anything else now, nothing is written. */
  expect?: Rec;
}

const COPY = { creds: "credentials.json", json: "claude.json" } as const;
const KEYS = ["creds", "json"] as const;

function copyLive(p: ClaudePaths, dir: string) {
  for (const k of KEYS) {
    if (existsSync(p[k])) atomicWrite(join(dir, COPY[k]), readFileSync(p[k], "utf8"));
    else rmSync(join(dir, COPY[k]), { force: true });
  }
}

/**
 * Makes `b` the live login. Only `claudeAiOauth` and `oauthAccount` change;
 * every other key in both files is kept as it was read. The files are written
 * where they stand (the box binds the two files, not their folder, so there
 * is no rename and no temp file), which a crash can cut short: so the content
 * they had is copied to `backupDir` first, and `recoverLive` puts it back. If
 * the second file fails the first is put back, so the pair never ends up
 * from two logins.
 */
export function writeLive(p: ClaudePaths, b: Bundle, o: WriteOpts) {
  const credsText = existsSync(p.creds) ? readFileSync(p.creds, "utf8") : null;
  const creds = readObj(p.creds) ?? {};
  const json = readObj(p.json) ?? {};
  if (o.expect && JSON.stringify(creds.claudeAiOauth) !== JSON.stringify(o.expect)) throw new LiveMoved("the Claude Code login changed");
  const nextCreds = { ...creds, claudeAiOauth: b.oauth };
  const { oauthAccount: _old, ...rest } = json;
  const nextJson = b.account ? { ...rest, oauthAccount: b.account } : rest;
  copyLive(p, o.backupDir);
  overwriteJsonInPlace(p.creds, JSON.stringify(nextCreds));
  try {
    overwriteJsonInPlace(p.json, JSON.stringify(nextJson, null, 2));
  } catch (e) {
    if (credsText !== null) overwriteJsonInPlace(p.creds, credsText); else unlinkSync(p.creds);
    throw e;
  }
}

/** A file cut off mid-write: not JSON, or a login block that lost its refresh token. A signed-out file (no login block) is whole. */
const tornCreds = (t: string) => {
  try { const j: unknown = JSON.parse(t); if (!isRec(j)) return true; const o = j.claudeAiOauth; return o !== undefined && !(isRec(o) && typeof o.refreshToken === "string"); } catch { return true; }
};
const tornJson = (t: string) => { try { return !isRec(JSON.parse(t)); } catch { return true; } };

/**
 * Puts a live file back from the copy `writeLive` made when it is torn. Claude
 * Code's own write in progress looks the same for a moment, so a file is only
 * restored if it is still torn after `settleMs`. A missing file, a healthy one,
 * no copy or a torn copy are all left alone. Returns the files restored.
 */
export async function recoverLive(p: ClaudePaths, dir: string, settleMs = 150): Promise<string[]> {
  const out: string[] = [];
  for (const k of KEYS) {
    const torn = k === "creds" ? tornCreds : tornJson;
    const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
    const first = read(p[k]);
    if (first === null || !torn(first)) continue;
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    const now = read(p[k]);
    const copy = read(join(dir, COPY[k]));
    if (now === null || !torn(now) || copy === null || torn(copy)) continue;
    overwriteJsonInPlace(p[k], copy);
    out.push(COPY[k]);
  }
  return out;
}

/** Same login: the account uuid when both have one, else the refresh token. */
export function sameLogin(a: Bundle, b: Bundle): boolean {
  const ua = a.account?.accountUuid, ub = b.account?.accountUuid;
  if (typeof ua === "string" && typeof ub === "string") return ua === ub;
  return typeof a.oauth.refreshToken === "string" && a.oauth.refreshToken === b.oauth.refreshToken;
}

export const serialize = (b: Bundle) => JSON.stringify({ v: 1, ...b });
export function parseBundle(text: string): Bundle {
  const j: unknown = JSON.parse(text);
  if (!isRec(j) || j.v !== 1 || !isRec(j.oauth)) throw new Error("stored login is not readable");
  return { oauth: j.oauth, account: isRec(j.account) ? j.account : null };
}
