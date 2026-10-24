import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { swapkinPresent, parseMirror, mirror } from "../src/swapkin.ts";
import { makeHome, stub, cleanup, coreProblem } from "./helpers.ts";

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

const GOOD = JSON.stringify({ providers: [{ provider: "anthropic", accounts: [
  { name: "work", plan: "Max", active: true, windows: [{ label: "5h", minutes: 300, usedPercent: 12, resetsAt: null }], token: "sk-ant-secret" },
  { name: "home", plan: "Pro", active: false },
] }] });

describe("swapkin mirror", () => {
  test("keeps the public fields only", () => {
    const m = parseMirror(GOOD)!;
    expect(m.map((a) => a.name)).toEqual(["work", "home"]);
    expect(m[0].windows[0].usedPercent).toBe(12);
    expect(JSON.stringify(m)).not.toContain("sk-ant");
  });
  test("any other shape is null", () => {
    for (const t of ["", "nope", "[]", '{"providers":[]}', '{"providers":[{"provider":"anthropic","accounts":[{"plan":"x"}]}]}']) expect(parseMirror(t)).toBeNull();
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
