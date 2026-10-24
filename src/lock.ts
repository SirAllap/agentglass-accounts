import { writeFileSync, linkSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

/** A lock held longer than this is taken to be left by a crashed holder whose pid was reused. */
const STALE_MS = 120_000;
const queues = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function stale(file: string): boolean {
  try {
    const pid = Number(readFileSync(file, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return true;
    return Date.now() - statSync(file).mtimeMs > STALE_MS;
  } catch { return false; } // gone already: the next create decides
}

async function acquire(file: string, timeoutMs: number): Promise<() => void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    // Written whole under a temp name, then linked in: link() fails with EEXIST like O_EXCL, and a reader never sees a lock file with no pid yet (it read that as stale and took a live lock).
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, String(process.pid), { mode: 0o600 });
    try {
      linkSync(tmp, file);
      return () => { try { unlinkSync(file); } catch { /* already reclaimed */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally { unlinkSync(tmp); }
    // shortcut: two processes can both judge one dead holder stale and the slower unlink removes the faster one's new lock; the window is one syscall pair, and add/use/remove are person-paced.
    if (stale(file)) { try { unlinkSync(file); } catch { /* someone else did */ } continue; }
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
