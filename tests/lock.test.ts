import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { withLock, lockIsStale, timing } from "../src/lock.ts";
import { scratch, cleanup } from "./helpers.ts";

afterAll(cleanup);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("lock", () => {
  test("callers in one process run one at a time, in order", async () => {
    const d = scratch();
    const log: string[] = [];
    await Promise.all([1, 2, 3].map((n) => withLock(d, async () => { log.push(`in${n}`); await sleep(20); log.push(`out${n}`); })));
    expect(log).toEqual(["in1", "out1", "in2", "out2", "in3", "out3"]);
    expect(existsSync(join(d, "lock"))).toBe(false);
  });

  test("a throwing holder still releases", async () => {
    const d = scratch();
    await expect(withLock(d, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withLock(d, () => "ok")).toBe("ok");
  });

  test("two processes never overlap", async () => {
    const d = scratch();
    const counter = join(d, "counter");
    writeFileSync(counter, "0");
    const child = `
      import { withLock } from ${JSON.stringify(join(import.meta.dir, "../src/lock.ts"))};
      import { readFileSync, writeFileSync } from "node:fs";
      for (let i = 0; i < 20; i++) await withLock(${JSON.stringify(d)}, async () => {
        const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
        await new Promise((r) => setTimeout(r, 2));
        writeFileSync(${JSON.stringify(counter)}, String(n + 1));
      });`;
    const f = join(d, "child.ts");
    writeFileSync(f, child);
    const run = () => Bun.spawn(["bun", f], { stdout: "ignore", stderr: "inherit" }).exited;
    expect(await Promise.all([run(), run(), run()])).toEqual([0, 0, 0]);
    expect(readFileSync(counter, "utf8")).toBe("60");
  }, 30_000);

  test("a lock left by a dead pid is taken over", async () => {
    const d = scratch();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(join(d, "lock"), String(dead.pid));
    expect(await withLock(d, () => "got it", 2000)).toBe("got it");
  });

  test("a lock held by another live process is waited for, then refused", async () => {
    const d = scratch();
    const mine = `${process.ppid}:other`; // the parent shell: alive, and not us
    writeFileSync(join(d, "lock"), mine);
    await expect(withLock(d, () => "no", 150)).rejects.toThrow("still running");
    expect(readFileSync(join(d, "lock"), "utf8")).toBe(mine);
  });

  // In a box the plugin is pid 2 every time, so a crashed run leaves a pid the next run also has. Measured: bwrap --unshare-all ... sh -c 'echo $$' prints 2.
  test("a lock with our own pid but not our nonce is a leftover, taken at once", async () => {
    const d = scratch();
    writeFileSync(join(d, "lock"), `${process.pid}:left-by-the-last-run`);
    expect(await withLock(d, () => "got it", 300)).toBe("got it");
  });

  test("a holder keeps its lock fresh, so a long job is never taken over", async () => {
    const d = scratch();
    const was = { ...timing };
    Object.assign(timing, { staleMs: 200, beatMs: 40 });
    try {
      await withLock(d, async () => {
        await sleep(600);
        expect(lockIsStale(join(d, "lock"))).toBe(false);
      });
    } finally { Object.assign(timing, was); }
  });

  test("a lock nobody touches for the stale time is taken even if its pid is alive", async () => {
    const d = scratch();
    const f = join(d, "lock");
    writeFileSync(f, `${process.ppid}:frozen`);
    utimesSync(f, new Date(Date.now() - timing.staleMs - 5000), new Date(Date.now() - timing.staleMs - 5000));
    expect(lockIsStale(f)).toBe(true);
    expect(await withLock(d, () => "got it", 500)).toBe("got it");
  });

  test("release leaves a lock that someone else took after ours was reclaimed", async () => {
    const d = scratch();
    await withLock(d, () => { writeFileSync(join(d, "lock"), `${process.ppid}:theirs`); });
    expect(readFileSync(join(d, "lock"), "utf8")).toBe(`${process.ppid}:theirs`);
  });

  test("the in-process queue waits for the holder instead of racing it for the file", async () => {
    const d = scratch();
    const first = withLock(d, () => sleep(300));
    // Its own time to get the lock starts when its turn does: without the queue 100 ms is not enough and this rejects.
    const second = withLock(d, () => "later", 100);
    expect(await second).toBe("later");
    await first;
  });
});
