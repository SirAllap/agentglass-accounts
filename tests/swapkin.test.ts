import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { swapkinPresent, parseMirror, mirror } from "../src/swapkin.ts";
import { Accounts } from "../src/accounts.ts";
import { SecretStore } from "../src/store.ts";
import { makeHome, stub, cleanup, coreProblem, swapkinJson, swapkinAcct } from "./helpers.ts";

afterAll(cleanup);

describe("swapkin detection", () => {
  test("absent in a clean home", () => {
    const h = makeHome();
    expect(swapkinPresent(h.env)).toBe(false);
  });
  test("a swapkin program on PATH", () => {
    const h = makeHome();
    stub(h, "swapkin", "exit 0");
    expect(swapkinPresent(h.env)).toBe(true);
  });
  test("a non-executable file named swapkin is not a program", () => {
    const h = makeHome();
    require("node:fs").writeFileSync(join(h.root, "bin", "swapkin"), "x", { mode: 0o644 });
    expect(swapkinPresent(h.env)).toBe(false);
  });
  test("SWAPKIN_DIR, and the XDG default, by existence only", () => {
    const h = makeHome();
    mkdirSync(join(h.root, "sk"));
    expect(swapkinPresent({ ...h.env, SWAPKIN_DIR: join(h.root, "sk") })).toBe(true);
    expect(swapkinPresent({ ...h.env, SWAPKIN_DIR: join(h.root, "nope") })).toBe(false);
    mkdirSync(join(h.root, "xdg/swapkin"), { recursive: true });
    expect(swapkinPresent(h.env)).toBe(true);
  });
  test("HOME default when XDG_DATA_HOME is unset", () => {
    const h = makeHome();
    const { XDG_DATA_HOME: _x, ...env } = h.env;
    expect(swapkinPresent(env)).toBe(false);
    mkdirSync(join(h.home, ".local/share/swapkin"), { recursive: true });
    expect(swapkinPresent(env)).toBe(true);
  });
});

const GOOD = swapkinJson([
  { ...swapkinAcct("work", "max", true, [{ label: "Session (5-hour)", title: "Session", percent: 0.123, resetsAt: "2026-10-24T15:00:00Z", used: 12, limit: 100, unit: "requests" }, { label: "Weekly", percent: 0.5, resetsAt: "2026-10-30T00:00:00Z" }]), token: "sk-ant-secret" },
  swapkinAcct("home", "pro", false),
]);

describe("swapkin mirror", () => {
  test("reads the claude entry of the real shape: limits as fractions, minutes from the label, nothing else copied", () => {
    const m = parseMirror(GOOD)!;
    expect(m.map((a) => [a.name, a.plan, a.active])).toEqual([["work", "max", true], ["home", "pro", false]]);
    expect(m[0].windows).toEqual([
      { label: "Session (5-hour)", minutes: 300, usedPercent: 12, resetsAt: "2026-10-24T15:00:00.000Z" },
      { label: "Weekly", minutes: 10080, usedPercent: 50, resetsAt: "2026-10-30T00:00:00.000Z" }]);
    expect(m[1].windows).toEqual([]);
    expect(JSON.stringify(m)).not.toMatch(/sk-ant|codex|side|#7fa7d9/);
  });
  test("a limit whose window length the label does not give is left out, a fraction past 1 is capped", () => {
    const j = swapkinJson([swapkinAcct("work", "pro", false, [{ label: "Requests today", percent: 0.1 }, { label: "Weekly", percent: 1.4 }, { label: "Weekly cap", percent: "x" }])]);
    expect(parseMirror(j)![0].windows).toEqual([{ label: "Weekly", minutes: 10080, usedPercent: 100, resetsAt: null }]);
  });
  test("any other shape is null", () => {
    for (const t of ["", "nope", "[]", '{"providers":[]}', '{"providers":[{"id":"claude","accounts":[{"plan":"x"}]}]}', swapkinJson([]).replace('"id":"claude"', '"id":"other"')]) expect(parseMirror(t)).toBeNull();
  });
  test("runs the stub on the given PATH", async () => {
    const h = makeHome();
    stub(h, "swapkin", `[ "$1 $2" = "providers --json" ] && printf '%s' '${GOOD}'`);
    expect((await mirror(h.env))?.length).toBe(2);
  });
  test("a failing or hanging swapkin is null", async () => {
    const h = makeHome();
    stub(h, "swapkin", "echo '{' ; exit 1");
    expect(await mirror(h.env)).toBeNull();
    stub(h, "swapkin", "exec sleep 5");
    expect(await mirror(h.env, 200)).toBeNull();
  });
  test("helper validator rejects a token-shaped label (guards the guard)", () => {
    expect(coreProblem({ provider: "anthropic", accounts: [{ id: "a", label: "x@y.co", plan: "", colour: "blue", active: false, storage: "file" }] })).not.toBeNull();
  });
});

describe("mirrored names", () => {
  // A name of 28 characters plus " 2", twice: the old rename (cut to 28, add the index) gave the same string back for ever and froze the process.
  test("two names that collide after the rename still end", async () => {
    const h = makeHome();
    const n = "abcdefghij abcdefghij abcdef 2";
    stub(h, "swapkin", `echo '${swapkinJson([swapkinAcct(n, "max", false), swapkinAcct(n.toUpperCase(), "max", false), swapkinAcct("other", "max", false)])}'`);
    const acc = new Accounts(h.env, { store: await SecretStore.open(h.data, { keyring: null }) });
    const b = await acc.body();
    expect(b.accounts.length).toBe(3);
    expect(new Set(b.accounts.map((a) => a.label.toLowerCase())).size).toBe(3);
    expect(b.accounts.every((a) => a.label.length <= 32)).toBe(true);
    expect(coreProblem(b)).toBeNull();
  }, 3000);
});
