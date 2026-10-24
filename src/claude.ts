import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { overwriteJsonInPlace } from "./fsutil.ts";
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

/**
 * Makes `b` the live login. Only `claudeAiOauth` and `oauthAccount` change;
 * every other key in both files is kept as it was read. If the second file
 * fails the first is put back, so the pair never ends up from two logins.
 */
export function writeLive(p: ClaudePaths, b: Bundle) {
  const credsText = existsSync(p.creds) ? readFileSync(p.creds, "utf8") : null;
  const creds = readObj(p.creds) ?? {};
  const json = readObj(p.json) ?? {};
  const nextCreds = { ...creds, claudeAiOauth: b.oauth };
  const { oauthAccount: _old, ...rest } = json;
  const nextJson = b.account ? { ...rest, oauthAccount: b.account } : rest;
  overwriteJsonInPlace(p.creds, JSON.stringify(nextCreds));
  try {
    overwriteJsonInPlace(p.json, JSON.stringify(nextJson, null, 2));
  } catch (e) {
    if (credsText !== null) overwriteJsonInPlace(p.creds, credsText); else unlinkSync(p.creds);
    throw e;
  }
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
