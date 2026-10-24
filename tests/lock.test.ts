import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../src/lock.ts";
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

  test("a lock held by a live pid is waited for, then refused", async () => {
    const d = scratch();
    writeFileSync(join(d, "lock"), String(process.pid));
    await expect(withLock(d, () => "no", 150)).rejects.toThrow("still running");
    expect(readFileSync(join(d, "lock"), "utf8")).toBe(String(process.pid));
  });
});
