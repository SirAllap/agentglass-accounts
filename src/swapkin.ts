import { existsSync, statSync, accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";

export type Env = Record<string, string | undefined>;

/** Where Swapkin keeps its accounts. Existence is all that is ever asked of it; its files are never opened. */
export function swapkinDir(env: Env): string {
  return env.SWAPKIN_DIR || join(env.XDG_DATA_HOME || join(env.HOME ?? "", ".local/share"), "swapkin");
}

// Own PATH scan on the env given: Bun.which uses the PATH the process started with, so a test stub would be invisible.
function onPath(cmd: string, path: string): boolean {
  for (const d of path.split(delimiter)) {
    if (!d) continue;
    const f = join(d, cmd);
    try { if (statSync(f).isFile()) { accessSync(f, constants.X_OK); return true; } } catch { /* not here */ }
  }
  return false;
}

/** Swapkin owns the logins when its program or its folder is there. Asked again before every write: it can be installed while we run. */
export function swapkinPresent(env: Env): boolean {
  return onPath("swapkin", env.PATH ?? "") || existsSync(swapkinDir(env));
}

export interface MirrorWindow { label: string; minutes: number; usedPercent: number; resetsAt: string | null }
export interface MirrorAccount { name: string; plan: string; active: boolean; windows: MirrorWindow[] }

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function windowOf(w: unknown): MirrorWindow | null {
  if (!isRec(w)) return null;
  const label = str(w.label, 16), minutes = w.minutes, used = w.usedPercent;
  if (!label || typeof minutes !== "number" || typeof used !== "number") return null;
  const r = w.resetsAt;
  return { label, minutes: Math.round(minutes), usedPercent: used, resetsAt: typeof r === "string" ? r : null };
}

/**
 * Parses `swapkin providers --json` keeping only the public fields: name, plan,
 * active and the windows. Expected shape (the real output was not available to
 * measure against, so a mismatch returns null and the caller shows the plugin's
 * own list instead): `{providers:[{provider:"anthropic",accounts:[{name,plan,active,windows:[...]}]}]}`.
 */
export function parseMirror(text: string): MirrorAccount[] | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  const provs = isRec(j) && Array.isArray(j.providers) ? j.providers : null;
  const prov = provs?.find((p) => isRec(p) && (p.provider === "anthropic" || p.provider === "claude"));
  if (!isRec(prov) || !Array.isArray(prov.accounts)) return null;
  const out: MirrorAccount[] = [];
  for (const a of prov.accounts) {
    if (!isRec(a)) return null;
    const name = str(a.name, 32);
    if (!name) return null;
    const windows = Array.isArray(a.windows) ? a.windows.map(windowOf).filter((w): w is MirrorWindow => !!w) : [];
    out.push({ name, plan: str(a.plan, 24), active: a.active === true, windows });
  }
  return out;
}

/** Runs the one read-only Swapkin command we use. Any failure, hang or odd output is null. */
export async function mirror(env: Env, timeoutMs = 5000): Promise<MirrorAccount[] | null> {
  try {
    const p = Bun.spawn(["swapkin", "providers", "--json"], { env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" }, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const text = await new Response(p.stdout).text();
    clearTimeout(timer);
    return (await p.exited) === 0 ? parseMirror(text) : null;
  } catch { return null; }
}
