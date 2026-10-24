import { describe, expect, test, afterAll } from "bun:test";
import { statSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecretStore, StoreUnavailable, probeKeyring, type Keyring } from "../src/store.ts";
import { scratch, cleanup } from "./helpers.ts";

afterAll(cleanup);

/** An in-memory keyring with switches, so each failure the real one has can be asked for. */
function fake(mode: "ok" | "hang" | "throw" | "dies-later" | "get-dies" = "ok"): Keyring & { m: Map<string, string>; calls: number; gets: number } {
  const k = { m: new Map<string, string>(), calls: 0, gets: 0,
    async set(n: string, v: string) { k.calls++; if (mode === "hang") return new Promise<void>(() => {}); if (mode === "throw" || (mode === "dies-later" && k.calls > 1)) throw new Error("no bus"); k.m.set(n, v); },
    async get(n: string) { if (mode === "get-dies" && ++k.gets > 1) throw new Error("no bus"); if (mode === "hang") return new Promise<string>(() => {}); return k.m.get(n) ?? null; },
    async delete(n: string) { return k.m.delete(n); } };
  return k;
}
const mode = (f: string) => statSync(f).mode & 0o777;

describe("file store", () => {
  test("0600 file in a 0700 dir, even under a loose umask, no temp left over", async () => {
    const d = scratch();
    const old = process.umask(0);
    try {
      const s = await SecretStore.open(d, { keyring: null });
      expect(await s.set("work", "secret-1")).toBe("file");
      expect(mode(join(d, "accounts"))).toBe(0o700);
      expect(mode(join(d, "accounts/work.json"))).toBe(0o600);
      expect(readdirSync(join(d, "accounts"))).toEqual(["work.json"]);
    } finally { process.umask(old); }
  });
  test("round trip, overwrite, delete", async () => {
    const s = await SecretStore.open(scratch(), { keyring: null });
    await s.set("work", "a"); await s.set("work", "b");
    expect(await s.get("work")).toBe("b");
    expect(await s.kindOf("work")).toBe("file");
    await s.delete("work");
    expect(await s.get("work")).toBeNull();
    expect(await s.kindOf("work")).toBeNull();
  });
  test("an id that could leave the folder is refused", async () => {
    const s = await SecretStore.open(scratch(), { keyring: null });
    for (const id of ["../x", "a/b", "", "A", ".hidden"]) await expect(s.set(id, "v")).rejects.toThrow("bad account id");
  });
});

describe("keyring choice", () => {
  test("a keyring that answers is used, and reported", async () => {
    const d = scratch(), k = fake();
    const s = await SecretStore.open(d, { keyring: k });
    expect(s.backend).toBe("keyring");
    expect(await s.set("work", "tok")).toBe("keyring");
    expect(k.m.get("anthropic/work")).toBe("tok");
    expect(readdirSync(join(d, "accounts"))).toEqual([]);
    expect(await s.kindOf("work")).toBe("keyring");
    await s.delete("work");
    expect(k.m.has("anthropic/work")).toBe(false);
  });
  // "The keyring did not answer" and "there is nothing under that name" were both null, so a login already saved looked unsaved and was saved a second time.
  test("a keyring that stops answering is an error, not an absent account", async () => {
    const k = fake("get-dies");
    const s = await SecretStore.open(scratch(), { keyring: k, probeMs: 500 });
    expect(s.backend).toBe("keyring");
    await s.set("work", "secret-1");
    await expect(s.get("work")).rejects.toBeInstanceOf(StoreUnavailable);
    expect(await fake("ok").get("never-saved")).toBeNull(); // a keyring that answers "nothing" is still null
  });
  test("a keyring that hangs falls back to the file within the probe time", async () => {
    const t = Date.now();
    const s = await SecretStore.open(scratch(), { keyring: fake("hang"), probeMs: 150 });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(s.backend).toBe("file");
  });
  test("a keyring that throws falls back to the file", async () => {
    const s = await SecretStore.open(scratch(), { keyring: fake("throw") });
    expect(await s.set("home", "t")).toBe("file");
  });
  test("a keyring that dies after the probe: the write lands in a file and says so", async () => {
    const d = scratch();
    const s = await SecretStore.open(d, { keyring: fake("dies-later") });
    expect(s.backend).toBe("keyring");
    expect(await s.set("home", "t")).toBe("file");
    expect(existsSync(join(d, "accounts/home.json"))).toBe(true);
    expect(await s.get("home")).toBe("t");
  });
  test("moving an account from a file to the keyring removes the file copy", async () => {
    const d = scratch();
    await (await SecretStore.open(d, { keyring: null })).set("work", "old");
    const s = await SecretStore.open(d, { keyring: fake() });
    expect(await s.set("work", "new")).toBe("keyring");
    expect(existsSync(join(d, "accounts/work.json"))).toBe(false);
  });
  test("probe returns false for a keyring that returns another value", async () => {
    const k = fake(); k.get = async () => "other";
    expect(await probeKeyring(k, 200)).toBe(false);
  });
});

/*
 * The real thing: Bun.secrets against a gnome-keyring-daemon on a private
 * D-Bus session inside a scratch HOME. The owner's keyring is never reachable:
 * the child gets only the variables below, and dbus-run-session makes its own bus.
 */
const have = (c: string) => Bun.which(c) !== null;
const real = have("dbus-run-session") && have("gnome-keyring-daemon") ? describe : describe.skip;
real("Bun.secrets on a private session bus", () => {
  const script = (d: string, withBus: boolean) => `
    import { SecretStore } from ${JSON.stringify(join(import.meta.dir, "../src/store.ts"))};
    const s = await SecretStore.open(${JSON.stringify(d)}, { probeMs: 3000 });
    const kind = await s.set("work", "fixture-secret");
    const back = await s.get("work");
    const where = await s.kindOf("work");
    await s.delete("work");
    console.log(JSON.stringify({ backend: s.backend, kind, back, where, gone: await s.get("work") }));`;
  function run(withBus: boolean) {
    const root = scratch(), data = join(root, "data");
    const f = join(root, "k.ts"); writeFileSync(f, script(data, withBus));
    const env = { PATH: process.env.PATH!, HOME: join(root, "h"), XDG_DATA_HOME: join(root, "h/d"), XDG_CONFIG_HOME: join(root, "h/c"), XDG_CACHE_HOME: join(root, "h/x"), XDG_RUNTIME_DIR: join(root, "run") };
    const sh = join(root, "go.sh");
    writeFileSync(sh, `mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"\n` +
      (withBus ? `printf pw | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1\n` : "") + `exec bun ${f}\n`);
    const argv = withBus ? ["dbus-run-session", "--", "bash", sh] : ["bash", sh];
    const p = Bun.spawnSync(argv, { env, timeout: 60_000 });
    return JSON.parse(p.stdout.toString().trim().split("\n").pop()!);
  }
  test("keyring path: the secret rests in the keyring, not in a file", () => {
    expect(run(true)).toEqual({ backend: "keyring", kind: "keyring", back: "fixture-secret", where: "keyring", gone: null });
  }, 70_000);
  test("no session bus: falls back to the file, truthfully", () => {
    expect(run(false)).toEqual({ backend: "file", kind: "file", back: "fixture-secret", where: "file", gone: null });
  }, 70_000);
});
