import { writeFileSync, linkSync, readFileSync, unlinkSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

/**
 * A holder touches its lock every `beatMs`; a lock nobody touched for `staleMs` was left by a run that died.
 * Not the pid alone: the box gives every run of the plugin the same pid (2), so a crashed run's pid is always "alive".
 */
export const timing = { staleMs: 15_000, beatMs: 5_000 };
const queues = new Map<string, Promise<unknown>>();
/** Nonces this process holds right now: a lock with our pid and another nonce is a leftover, not ours. */
const held = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

const parse = (text: string) => { const [pid, nonce = ""] = text.trim().split(":"); return { pid: Number(pid), nonce }; };

export function lockIsStale(file: string): boolean {
  try {
    const { pid, nonce } = parse(readFileSync(file, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return true;
    if (pid === process.pid && !held.has(nonce)) return true;
    return Date.now() - statSync(file).mtimeMs > timing.staleMs;
  } catch { return false; } // gone already: the next create decides
}

async function acquire(file: string, timeoutMs: number): Promise<() => void> {
  const until = Date.now() + timeoutMs;
  const nonce = Math.random().toString(36).slice(2);
  for (;;) {
    // Written whole under a temp name, then linked in: link() fails with EEXIST like O_EXCL, and a reader never sees a lock file with no pid yet (it read that as stale and took a live lock).
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, `${process.pid}:${nonce}`, { mode: 0o600 });
    try {
      linkSync(tmp, file);
      held.add(nonce);
      const beat = setInterval(() => { try { const t = new Date(); utimesSync(file, t, t); } catch { /* reclaimed */ } }, timing.beatMs);
      beat.unref();
      return () => {
        clearInterval(beat);
        held.delete(nonce);
        // Only our own lock: after a takeover the file is somebody else's.
        try { if (parse(readFileSync(file, "utf8")).nonce === nonce) unlinkSync(file); } catch { /* already reclaimed */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally { unlinkSync(tmp); }
    // shortcut: two processes can both judge one stale holder gone and the slower unlink removes the faster one's new lock; the window is one syscall pair, and add/use/remove are person-paced.
    if (lockIsStale(file)) { try { unlinkSync(file); } catch { /* someone else did */ } continue; }
    if (Date.now() > until) throw new Error("another add, switch or remove is still running; try again in a moment");
    await sleep(25);
  }
}

/**
 * One writer at a time across processes (an exclusive-create lock file, no flock(1) needed) and
 * within this process (a queue, so two callers never poll each other).
 */
export function withLock<T>(dir: string, fn: () => Promise<T> | T, timeoutMs = 30_000): Promise<T> {
  const file = join(dir, "lock");
  const run = (queues.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const release = await acquire(file, timeoutMs);
    try { return await fn(); } finally { release(); }
  });
  queues.set(file, run);
  return run;
}
