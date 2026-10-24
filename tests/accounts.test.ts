import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Accounts, Refused, type Hooks } from "../src/accounts.ts";
import { SecretStore } from "../src/store.ts";
import { parseBundle } from "../src/claude.ts";
import { makeHome, setLive, readJson, cleanup, treeHash, stub, coreProblem, type Home, type Login } from "./helpers.ts";
import { fakeServer } from "./fakeServer.ts";

afterAll(cleanup);
const A: Login = { access: "fixture-a", refresh: "fixture-ra", uuid: "uuid-a" };
const B: Login = { access: "fixture-b", refresh: "fixture-rb", uuid: "uuid-b", plan: "pro" };

async function open(h: Home, extra: Record<string, string> = {}, o: { hooks?: Hooks; now?: () => number } = {}) {
  const env = { ...h.env, ...extra };
  const store = await SecretStore.open(h.data, { keyring: null });
  return { acc: new Accounts(env, { store, ...o }), store, env };
}
/** work = A and home = B saved, live = B. */
async function twoSaved(extra: Record<string, string> = {}, o: { hooks?: Hooks; now?: () => number } = {}) {
  const h = makeHome(A);
  const ctx = await open(h, extra, o);
  await ctx.acc.saveCurrent("work");
  setLive(h, B);
  await ctx.acc.saveCurrent("home");
  return { h, ...ctx };
}
const slot = async (store: SecretStore, id: string) => parseBundle((await store.get(id))!);
const live = (h: Home) => readJson(h.credsFile).claudeAiOauth.refreshToken as string;
/** What Claude Code writes when it refreshes the login it is running: same account, rotated tokens. */
const rotate = (h: Home, l: Login, n: number) => setLive(h, { ...l, access: `${l.access}-r${n}`, refresh: `${l.refresh}-r${n}` });

describe("use: the outgoing login goes to its own slot", () => {
  test("swaps the live login, keeps other keys, records the timeline", async () => {
    const { h, acc, store } = await twoSaved();
    rotate(h, B, 1); // Claude Code refreshed home's token since it was saved
    await acc.use("work");
    expect(live(h)).toBe("fixture-ra");
    expect(readJson(h.claudeJson).oauthAccount.accountUuid).toBe("uuid-a");
    expect(readJson(h.credsFile).mcpOAuth).toEqual({ keep: "me" });
    expect(readJson(h.claudeJson).numStartups).toBe(7);
    expect((await slot(store, "home")).oauth.refreshToken).toBe("fixture-rb-r1");
    expect((await slot(store, "work")).oauth.refreshToken).toBe("fixture-ra");
    const body = await acc.body();
    expect(body.accounts.map((a) => [a.id, a.active])).toEqual([["work", true], ["home", false]]);
    expect(JSON.parse(readFileSync(join(h.data, "accounts.json"), "utf8")).timeline.at(-1)).toMatchObject({ from: "home", to: "work" });
  });

  test("switching to the account already in use only refreshes its slot", async () => {
    const { h, acc, store } = await twoSaved();
    rotate(h, B, 1);
    await acc.use("home");
    expect((await slot(store, "home")).oauth.refreshToken).toBe("fixture-rb-r1");
    expect(live(h)).toBe("fixture-rb-r1");
  });

  test("a live login that is not saved is never discarded: refused, files untouched", async () => {
    const { h, acc } = await twoSaved();
    setLive(h, { access: "fixture-c", refresh: "fixture-rc", uuid: "uuid-c" });
    const before = treeHash(h.home, h.data);
    await expect(acc.use("work")).rejects.toThrow("not one of your saved accounts");
    expect(treeHash(h.home, h.data)).toBe(before);
  });

  test("unknown id is refused", async () => {
    const { acc } = await twoSaved();
    await expect(acc.use("nope")).rejects.toBeInstanceOf(Refused);
  });

  test("signed out: the incoming login is written, nothing to save", async () => {
    const { h, acc } = await twoSaved();
    require("node:fs").rmSync(h.credsFile);
    await acc.use("work");
    expect(live(h)).toBe("fixture-ra");
  });

  test("two switches at once are serialised and neither loses a token", async () => {
    const { h, acc, store } = await twoSaved();
    await Promise.all([acc.use("work"), acc.use("home"), acc.use("work")]);
    expect(live(h)).toBe("fixture-ra");
    expect((await slot(store, "home")).oauth.refreshToken).toBe("fixture-rb");
  });
});

describe("use: RACE, a refresh lands while the switch runs", () => {
  test("one rotation during the switch: the newest token lands in the OUTGOING slot only", async () => {
    let n = 0;
    const ctx = await twoSaved();
    const { h, store } = ctx;
    const acc = new Accounts(ctx.env, { store, hooks: { afterSave: () => { if (++n === 1) rotate(h, B, 9); } } });
    await acc.use("work");
    expect((await slot(store, "home")).oauth.refreshToken).toBe("fixture-rb-r9");
    expect((await slot(store, "work")).oauth.refreshToken).toBe("fixture-ra");
    expect(live(h)).toBe("fixture-ra");
    expect(readJson(h.claudeJson).oauthAccount.accountUuid).toBe("uuid-a");
  });

  test("a chain of rotations: the last one wins", async () => {
    const ctx = await twoSaved();
    const { h, store } = ctx;
    const acc = new Accounts(ctx.env, { store, hooks: { afterSave: (round) => { if (round <= 3) rotate(h, B, round); } } });
    await acc.use("work");
    expect((await slot(store, "home")).oauth.refreshToken).toBe("fixture-rb-r3");
    expect(live(h)).toBe("fixture-ra");
  });

  test("25 round trips with a rotation each time: no token ever crosses slots", async () => {
    const ctx = await twoSaved();
    const { h, store } = ctx;
    const seen: string[] = [];
    let k = 0;
    const acc = new Accounts(ctx.env, { store, hooks: { afterSave: (round) => {
      if (round !== 1) return;
      const cur = readJson(h.credsFile).claudeAiOauth.refreshToken as string;
      const l = cur.startsWith("fixture-rb") ? B : A;
      rotate(h, l, ++k); seen.push(`${l.uuid}:${k}`);
    } } });
    let into = "work";
    for (let i = 0; i < 25; i++) { await acc.use(into); into = into === "work" ? "home" : "work"; }
    const w = (await slot(store, "work")).oauth.refreshToken as string, hm = (await slot(store, "home")).oauth.refreshToken as string;
    expect(w.startsWith("fixture-ra")).toBe(true);
    expect(hm.startsWith("fixture-rb")).toBe(true);
    expect(seen.length).toBe(25);
    // 25 switches from live=home alternate work, home, ... work: the last went to work
    expect(live(h).startsWith("fixture-ra")).toBe(true);
    expect(readJson(h.claudeJson).oauthAccount.accountUuid).toBe("uuid-a");
  });

  test("the login changes to someone else mid-switch: nothing is overwritten", async () => {
    const ctx = await twoSaved();
    const { h, store } = ctx;
    const acc = new Accounts(ctx.env, { store, hooks: { afterSave: () => setLive(h, { access: "fixture-c", refresh: "fixture-rc", uuid: "uuid-c" }) } });
    await expect(acc.use("work")).rejects.toThrow("changed while switching");
    expect(live(h)).toBe("fixture-rc");
  });

  test("a writer that never stops is refused after a few rounds, not looped forever", async () => {
    const ctx = await twoSaved();
    const { h, store } = ctx;
    let k = 0;
    const acc = new Accounts(ctx.env, { store, hooks: { afterSave: () => rotate(h, B, ++k) } });
    await expect(acc.use("work")).rejects.toThrow("kept changing");
    expect(live(h).startsWith("fixture-rb")).toBe(true);
  });
});

describe("add, remove, edit", () => {
  test("save the current login: slot, metadata without secrets, active", async () => {
    const h = makeHome(A);
    const { acc, store } = await open(h);
    expect(await acc.saveCurrent("Work")).toEqual({ id: "work" });
    expect(await store.kindOf("work")).toBe("file");
    const meta = readFileSync(join(h.data, "accounts.json"), "utf8");
    for (const secret of ["fixture-a", "fixture-ra", "uuid-a", "Fixture"]) expect(meta).not.toContain(secret);
    const b = await acc.body();
    expect(b.accounts[0]).toMatchObject({ id: "work", label: "Work", plan: "Max", active: true, storage: "file" });
    expect(statSync(join(h.data, "accounts/work.json")).mode & 0o777).toBe(0o600);
  });

  test("names that look like an email or a key, duplicates and a ninth account are refused", async () => {
    const h = makeHome(A);
    const { acc } = await open(h);
    for (const bad of ["me@acme.test", "sk-ant-abc", "x".repeat(33), "", "  ", "a<b", "abcdefghijklmnopqrstuvwxyz0123"]) await expect(acc.saveCurrent(bad)).rejects.toBeInstanceOf(Refused);
    await acc.saveCurrent("Work");
    setLive(h, B);
    await expect(acc.saveCurrent("work")).rejects.toThrow("already has that name");
    await acc.saveCurrent("Home");
    for (let i = 3; i <= 8; i++) { setLive(h, { access: `a${i}`, refresh: `r${i}`, uuid: `u${i}` }); await acc.saveCurrent(`Acct ${i}`); }
    setLive(h, { access: "a9", refresh: "r9", uuid: "u9" });
    await expect(acc.saveCurrent("Ninth")).rejects.toThrow("At most 8");
  });

  test("saving a login that is already saved, or none at all, is refused", async () => {
    const h = makeHome(A);
    const { acc } = await open(h);
    await acc.saveCurrent("Work");
    rotate(h, A, 1);
    await expect(acc.saveCurrent("Again")).rejects.toThrow('already saved as "Work"');
    require("node:fs").rmSync(h.credsFile);
    await expect(acc.saveCurrent("Nobody")).rejects.toThrow("not signed in");
  });

  test("throwaway add: live files never touched, folder 0700 under pending/, removed after import", async () => {
    const h = makeHome(A);
    const { acc, store } = await open(h);
    await acc.saveCurrent("Work");
    const liveBefore = treeHash(h.home);
    const { pendingId, command } = await acc.startAdd("Home");
    const dir = join(h.data, "pending", pendingId);
    expect(command).toBe(`CLAUDE_CONFIG_DIR='${dir}' claude auth login`);
    expect(acc.addCommand(pendingId)).toBe(command);
    expect(() => acc.addCommand("../x")).toThrow(Refused);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(await acc.finishAdd(pendingId)).toEqual({ done: false });
    const t = makeHome(B); // a login made elsewhere, written where `claude` would have put it
    writeFileSync(join(dir, ".credentials.json"), readFileSync(t.credsFile));
    writeFileSync(join(dir, ".claude.json"), readFileSync(t.claudeJson));
    expect(await acc.finishAdd(pendingId)).toEqual({ done: true, id: "home" });
    expect(existsSync(dir)).toBe(false);
    expect((await slot(store, "home")).oauth.refreshToken).toBe("fixture-rb");
    expect(treeHash(h.home)).toBe(liveBefore);
    expect(acc.pendingList()).toEqual([]);
  });

  test("an add that sat too long is cancelled; a pending id that climbs out is refused", async () => {
    const h = makeHome(A);
    let t = 1_000_000;
    const { acc } = await open(h, {}, { now: () => t });
    const { pendingId } = await acc.startAdd("Home");
    t += 31 * 60_000;
    await expect(acc.finishAdd(pendingId)).rejects.toThrow("too long");
    expect(existsSync(join(h.data, "pending", pendingId))).toBe(false);
    for (const bad of ["../..", "../../home", "a/b", ""]) await expect(acc.cancelAdd(bad)).rejects.toThrow("Unknown add");
    expect(existsSync(h.home)).toBe(true);
  });

  test("adding the login that is already saved drops the throwaway folder", async () => {
    const h = makeHome(A);
    const { acc } = await open(h);
    await acc.saveCurrent("Work");
    const { pendingId } = await acc.startAdd("Dup");
    const dir = join(h.data, "pending", pendingId);
    writeFileSync(join(dir, ".credentials.json"), readFileSync(h.credsFile));
    writeFileSync(join(dir, ".claude.json"), readFileSync(h.claudeJson));
    await expect(acc.finishAdd(pendingId)).rejects.toThrow("already saved");
    expect(existsSync(dir)).toBe(false);
  });

  test("remove: the account in use is refused unless forced; the live login is never touched", async () => {
    const { h, acc, store } = await twoSaved();
    const before = treeHash(h.home);
    await expect(acc.remove("home")).rejects.toThrow("account Claude Code is using now");
    await acc.remove("work");
    expect(await store.get("work")).toBeNull();
    expect((await acc.body()).accounts.map((a) => a.id)).toEqual(["home"]);
    await acc.remove("home", { force: true });
    expect((await acc.body()).accounts).toEqual([]);
    expect(treeHash(h.home)).toBe(before);
    await expect(acc.remove("home")).rejects.toThrow("not saved here");
  });

  test("rename and colour", async () => {
    const { acc } = await twoSaved();
    await acc.edit("work", { label: "Work 2", colour: "rose" });
    expect((await acc.body()).accounts[0]).toMatchObject({ id: "work", label: "Work 2", colour: "rose" });
    await expect(acc.edit("work", { label: "HOME" })).rejects.toThrow("already has that name");
    await expect(acc.edit("work", { colour: "#ff0000" })).rejects.toThrow("Unknown colour");
    await acc.edit("work", { label: "WORK" }); // its own name in another case is not a clash
  });
});

describe("the list passes the core's rules", () => {
  test("eight accounts with readings, and no secret anywhere in the body or the metadata file", async () => {
    const h = makeHome(A);
    const fake = fakeServer();
    try {
      const { acc, env } = await open(h, fake.env);
      await acc.saveCurrent("Work");
      for (let i = 2; i <= 8; i++) { setLive(h, { access: `fixture-a${i}`, refresh: `fixture-r${i}`, uuid: `uuid-${i}` }); await acc.saveCurrent(`Acct ${i}`); }
      await acc.probeAll();
      const body = await acc.body();
      expect(coreProblem(body)).toBeNull();
      expect(body.accounts.length).toBe(8);
      expect(body.accounts.filter((a) => a.reading).length).toBe(7);
      const text = JSON.stringify(body) + readFileSync(join(h.data, "accounts.json"), "utf8");
      for (const s of ["fixture-", "uuid-", "Fixture"]) expect(text).not.toContain(s);
      expect(env.ACCOUNTS_USAGE_URL).toContain("127.0.0.1");
    } finally { fake.stop(); }
  });

  test("a metadata file edited by hand to hold an email or a key still yields a list the core accepts", async () => {
    const { h, acc } = await twoSaved();
    const f = join(h.data, "accounts.json");
    const m = JSON.parse(readFileSync(f, "utf8"));
    m.accounts[0].label = "me@acme.test"; m.accounts[0].plan = "sk-ant-" + "a".repeat(40); m.accounts[1].colour = "#fff";
    writeFileSync(f, JSON.stringify(m));
    const body = await acc.body();
    expect(coreProblem(body)).toBeNull();
    expect(body.accounts.map((a) => a.label)).toEqual(["Account 1", "home"].map((x, i) => (i ? "home" : x)));
    expect(body.accounts[1].colour).toBe("neutral");
  });
});

describe("probe", () => {
  test("only inactive accounts, usage mapped to two windows, the active login never asked for", async () => {
    const fake = fakeServer();
    try {
      const { h, acc } = await twoSaved(fake.env);
      const before = treeHash(h.home);
      expect(await acc.probeAll()).toEqual(["work"]);
      expect(fake.hits.map((x) => x.auth)).toEqual(["Bearer fixture-a"]);
      expect(fake.hits.some((x) => x.auth?.includes("fixture-b"))).toBe(false);
      const b = await acc.body();
      expect(b.accounts.find((a) => a.id === "work")!.reading).toEqual({ windows: [
        { label: "5h", minutes: 300, usedPercent: 42, resetsAt: "2026-10-24T18:00:00.000Z" },
        { label: "7d", minutes: 10080, usedPercent: 7, resetsAt: null }] });
      expect(b.accounts.find((a) => a.id === "home")!.reading).toBeUndefined();
      expect(treeHash(h.home)).toBe(before);
    } finally { fake.stop(); }
  });

  test("an expired token is renewed and the rotated pair is stored BEFORE the usage call", async () => {
    let storedAtUsage = "";
    let dataDir = "";
    const fake = fakeServer({ onUsage: () => { storedAtUsage = readFileSync(join(dataDir, "accounts/work.json"), "utf8"); } });
    try {
      const h = makeHome({ ...A, expiresAt: Date.now() - 1000 });
      dataDir = h.data;
      const { acc, store } = await open(h, fake.env);
      await acc.saveCurrent("Work");
      setLive(h, B);
      await acc.saveCurrent("Home");
      expect(await acc.probeAll()).toEqual(["work"]);
      expect(JSON.parse(fake.hits[0].body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "fixture-ra" });
      expect(fake.hits[1].auth).toBe("Bearer fixture-rot-access-1");
      expect(storedAtUsage).toContain("fixture-rot-refresh-1");
      expect((await slot(store, "work")).oauth.refreshToken).toBe("fixture-rot-refresh-1");
      expect((await slot(store, "work")).account).toEqual({ accountUuid: "uuid-a", displayName: "Fixture" });
    } finally { fake.stop(); }
  });

  test("a refused renewal and a 429 back off, keep the last reading, and honour Retry-After", async () => {
    const fake = fakeServer();
    try {
      let t = 5_000_000;
      const { acc, h } = await twoSaved(fake.env, { now: () => t });
      expect(await acc.probeAll()).toEqual(["work"]);
      const n1 = fake.hits.length;
      fake.state.usageStatus = 429; fake.state.retryAfter = "600";
      t += 61 * 60_000;
      expect(await acc.probeAll()).toEqual([]);
      expect(fake.hits.length).toBe(n1 + 1);
      expect((await acc.body()).accounts[0].reading?.windows.length).toBe(2); // last reading kept
      t += 9 * 60_000;
      await acc.probeAll();
      expect(fake.hits.length).toBe(n1 + 1); // inside the 10 minutes it asked for
      t += 2 * 60_000;
      fake.state.usageStatus = 200;
      expect(await acc.probeAll()).toEqual(["work"]);
      // an expired token whose renewal is refused is retried later, not hammered
      const m = JSON.parse(readFileSync(join(h.data, "accounts.json"), "utf8"));
      expect(m.accounts[0].failures).toBe(0);
    } finally { fake.stop(); }
  });

  test("a renewal the server refuses leaves the stored token as it was", async () => {
    const fake = fakeServer();
    try {
      const h = makeHome({ ...A, expiresAt: 1 });
      const { acc, store } = await open(h, fake.env);
      await acc.saveCurrent("Work");
      setLive(h, B);
      await acc.saveCurrent("Home");
      fake.state.tokenStatus = 400;
      expect(await acc.probeAll()).toEqual([]);
      expect((await slot(store, "work")).oauth.refreshToken).toBe("fixture-ra");
      expect(fake.hits.length).toBe(1);
      await acc.probeAll();
      expect(fake.hits.length).toBe(1); // backed off
    } finally { fake.stop(); }
  });
});

describe("Swapkin: detect and defer", () => {
  const ops = (acc: Accounts) => ({
    use: () => acc.use("work"), save: () => acc.saveCurrent("New"), start: () => acc.startAdd("New"), finish: () => acc.finishAdd("abcdefgh12"),
    cancel: () => acc.cancelAdd("abcdefgh12"), remove: () => acc.remove("work"), removeForce: () => acc.remove("home", { force: true }), edit: () => acc.edit("work", { label: "Other" }),
  });
  for (const how of ["swapkin on PATH", "SWAPKIN_DIR exists"]) {
    test(`${how}: every writer is refused and nothing on disk or at the servers changes`, async () => {
      const fake = fakeServer();
      try {
        const { h, acc } = await twoSaved(fake.env);
        stub(h, "claude", `touch "${h.root}/claude-ran"`);
        if (how === "swapkin on PATH") stub(h, "swapkin", "exit 1"); else mkdirSync(join(h.root, "sk"));
        (acc as any).env.SWAPKIN_DIR = how === "SWAPKIN_DIR exists" ? join(h.root, "sk") : undefined;
        const before = treeHash(h.home, h.data);
        for (const [name, op] of Object.entries(ops(acc))) await expect(op(), name).rejects.toThrow("Swapkin manages your Claude logins");
        expect(await acc.probeAll()).toEqual([]);
        expect(treeHash(h.home, h.data)).toBe(before);
        expect(fake.hits.length).toBe(0);
        expect(existsSync(join(h.root, "claude-ran"))).toBe(false);
      } finally { fake.stop(); }
    });
  }

  test("the app says Swapkin is there while this process cannot see it (a box has no PATH entry for it): writers refuse, files stay", async () => {
    const fake = fakeServer();
    try {
      const { h, acc } = await twoSaved(fake.env);
      const before = treeHash(h.home, h.data);
      acc.hostSaysDeferred = true;
      expect(acc.deferred()).toBe(true);
      for (const [name, op] of Object.entries(ops(acc))) await expect(op(), name).rejects.toThrow("Swapkin manages your Claude logins");
      expect(await acc.probeAll()).toEqual([]);
      expect((await acc.body()).deferTo).toBe("swapkin");
      expect(treeHash(h.home, h.data)).toBe(before);
      expect(fake.hits.length).toBe(0);
      acc.hostSaysDeferred = false;
      await acc.use("work"); // and it lets go again when the app stops saying so
    } finally { fake.stop(); }
  });

  test("Swapkin appears in the middle of a switch: the next write is blocked and the live login stays", async () => {
    const ctx = await twoSaved();
    const { h, store } = ctx;
    const acc = new Accounts(ctx.env, { store, hooks: { afterSave: () => stub(h, "swapkin", "exit 1") } });
    const liveBefore = treeHash(h.home);
    await expect(acc.use("work")).rejects.toThrow("Swapkin manages");
    expect(treeHash(h.home)).toBe(liveBefore);
  });

  test("Swapkin appears while the outgoing token is being re-saved: that store write is blocked", async () => {
    const ctx = await twoSaved();
    const { h, store } = ctx;
    const acc = new Accounts(ctx.env, { store, hooks: { afterSave: () => { rotate(h, B, 1); stub(h, "swapkin", "exit 1"); } } });
    await expect(acc.use("work")).rejects.toThrow("Swapkin manages");
    expect((await slot(store, "home")).oauth.refreshToken).toBe("fixture-rb"); // the second save never happened
    expect(live(h)).toBe("fixture-rb-r1");
  });

  test("Swapkin appears between the slot save and the credentials write", async () => {
    const ctx = await twoSaved();
    const { h, store } = ctx;
    const acc = new Accounts(ctx.env, { store, hooks: { beforeWrite: () => stub(h, "swapkin", "exit 1") } });
    const liveBefore = treeHash(h.home);
    await expect(acc.use("work")).rejects.toThrow("Swapkin manages");
    expect(treeHash(h.home)).toBe(liveBefore);
  });

  test("read-only list: Swapkin's public fields, deferTo set, the core accepts it, no secret field copied", async () => {
    const { h, acc } = await twoSaved();
    const out = JSON.stringify({ providers: [{ provider: "anthropic", accounts: [
      { name: "Work", plan: "Max", active: true, windows: [], token: "sk-ant-xyz", email: "me@acme.test" },
      { name: "Home", plan: "Pro", active: false, windows: [{ label: "5h", minutes: 300, usedPercent: 20, resetsAt: null }] }] }] });
    stub(h, "swapkin", `printf '%s' '${out}'`);
    const before = treeHash(h.home, h.data);
    const body = await acc.body();
    expect(body.deferTo).toBe("swapkin");
    expect(coreProblem(body)).toBeNull();
    expect(body.accounts.map((a) => [a.label, a.active])).toEqual([["Work", true], ["Home", false]]);
    expect(body.accounts[1].reading?.windows[0].usedPercent).toBe(20);
    expect(JSON.stringify(body)).not.toMatch(/sk-ant|acme/);
    expect(treeHash(h.home, h.data)).toBe(before);
  });

  test("if the mirror fails, our own accounts are posted without readings (never an empty list)", async () => {
    const fake = fakeServer();
    try {
      const { h, acc } = await twoSaved(fake.env);
      await acc.probeAll();
      stub(h, "swapkin", "echo not json");
      const body = await acc.body();
      expect(body.deferTo).toBe("swapkin");
      expect(body.accounts.map((a) => a.id)).toEqual(["work", "home"]);
      expect(body.accounts.every((a) => !a.reading)).toBe(true);
      expect(coreProblem(body)).toBeNull();
    } finally { fake.stop(); }
  });
});
