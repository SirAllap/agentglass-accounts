import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { Accounts } from "../src/accounts.ts";
import { SecretStore } from "../src/store.ts";
import { parseBundle } from "../src/claude.ts";
import { run } from "../src/runtime.ts";
import { makeHome, setLive, readJson, cleanup, treeHash, stub, type Home, type Login } from "./helpers.ts";
import { fakeHost, until, nodes } from "./fakeHost.ts";
import { fakeServer } from "./fakeServer.ts";

afterAll(cleanup);
const A: Login = { access: "fixture-a", refresh: "fixture-ra", uuid: "uuid-a" };
const B: Login = { access: "fixture-b", refresh: "fixture-rb", uuid: "uuid-b", plan: "pro" };
const live = (h: Home) => readJson(h.credsFile).claudeAiOauth.refreshToken as string;
const texts = (t: any) => nodes(t).flatMap((n) => [n.text, n.title, n.label, n.body].filter((x) => typeof x === "string")).join("\n");

/** work = A, home = B saved; live = B. The loop runs against a fake host until stop(). */
async function boot(o: { extra?: Record<string, string>; run?: Record<string, unknown>; saved?: boolean } = {}) {
  const h = makeHome(A);
  const host = fakeHost();
  const env = { ...h.env, AGENTGLASS_URL: host.url, AGENTGLASS_READ_TOKEN: host.token } as Record<string, string>;
  const store = await SecretStore.open(h.data, { keyring: null });
  const acc = new Accounts(env, { store });
  if (o.saved !== false) { await acc.saveCurrent("work"); setLive(h, B); await acc.saveCurrent("home"); }
  Object.assign(env, o.extra); // after seeding: a seeded account needs Swapkin absent
  const ac = new AbortController();
  const done = run(env, { acc, signal: ac.signal, waitMs: 30, retryMs: 10, firstProbeMs: 1e9, probeMs: 1e9, ...o.run });
  const stop = async () => { ac.abort(); await done; host.stop(); };
  return { h, host, acc, store, done, stop, env };
}
const slot = async (store: SecretStore, id: string) => parseBundle((await store.get(id))!);

describe("start", () => {
  test("posts the whole list and draws the panel, once", async () => {
    const t = await boot();
    await until(() => t.host.accounts.length > 0 && t.host.panels.length > 0, 4000, "first post");
    expect(t.host.accounts[0].accounts.map((a: any) => [a.id, a.active])).toEqual([["work", false], ["home", true]]);
    expect(t.host.panels[0].id).toBe("accounts");
    await Bun.sleep(120);
    expect(t.host.accounts.length).toBe(1); // idle polls repost nothing
    await t.stop();
  });

  test("no token, no secret and no email reaches the host in any post", async () => {
    const t = await boot();
    await until(() => t.host.panels.length > 0);
    t.host.push({ type: "account.manage", provider: "anthropic" });
    await Bun.sleep(100);
    const all = JSON.stringify([t.host.accounts, t.host.panels]);
    for (const s of ["fixture-a", "fixture-b", "fixture-ra", "fixture-rb", "uuid-a", "uuid-b", "Fixture"]) expect(all).not.toContain(s);
    await t.stop();
  });
});

describe("account.switch", () => {
  test("switches, saves the outgoing token in its own slot, and the repost is the only ack", async () => {
    const t = await boot();
    await until(() => t.host.accounts.length > 0);
    setLive(t.h, { ...B, access: "fixture-b-r1", refresh: "fixture-rb-r1" }); // Claude Code rotated home's token
    const n = t.host.accounts.length;
    t.host.push({ type: "account.switch", provider: "anthropic", id: "work" });
    await until(() => t.host.accounts.length > n, 4000, "repost after switch");
    expect(live(t.h)).toBe("fixture-ra");
    expect((await slot(t.store, "home")).oauth.refreshToken).toBe("fixture-rb-r1");
    expect(t.host.last().accounts.map((a: any) => [a.id, a.active])).toEqual([["work", true], ["home", false]]);
    await t.stop();
  });

  test("a refusal is a sentence on the panel and the files stay put", async () => {
    const t = await boot();
    await until(() => t.host.panels.length > 0);
    setLive(t.h, { access: "fixture-c", refresh: "fixture-rc", uuid: "uuid-c" }); // a login nobody saved
    const before = treeHash(t.h.home, t.h.data);
    t.host.push({ type: "account.switch", provider: "anthropic", id: "work" });
    await until(() => texts(t.host.lastPanel()).includes("not one of your saved accounts"), 4000, "refusal on the panel");
    expect(treeHash(t.h.home, t.h.data)).toBe(before);
    await t.stop();
  });

  test("other providers and unknown event types are ignored", async () => {
    const t = await boot();
    await until(() => t.host.accounts.length > 0);
    const before = treeHash(t.h.home, t.h.data);
    t.host.push({ type: "account.switch", provider: "codex", id: "work" });
    t.host.push({ type: "settings", settings: {} });
    t.host.push({ type: "something-new" });
    await Bun.sleep(150);
    expect(treeHash(t.h.home, t.h.data)).toBe(before);
    await t.stop();
  });
});

describe("the loop stays up", () => {
  test("a login changed outside the plugin is posted without any event", async () => {
    const t = await boot();
    await until(() => t.host.accounts.length > 0);
    setLive(t.h, A); // the person ran `claude login` as the other account
    await until(() => t.host.accounts.length > 1, 4000, "repost on change");
    expect(t.host.last().accounts.find((a: any) => a.active).id).toBe("work");
    await t.stop();
  });

  test("a failing poll is retried and the next event still lands", async () => {
    const t = await boot();
    await until(() => t.host.accounts.length > 0);
    t.host.state.eventFailures = 3;
    await Bun.sleep(30);
    t.host.push({ type: "account.switch", provider: "anthropic", id: "work" });
    await until(() => live(t.h) === "fixture-ra", 4000, "switch after failures");
    await t.stop();
  });

  test("a list the host refuses is not lost: it is posted again once the host takes it", async () => {
    const t = await boot();
    await until(() => t.host.accounts.length > 0);
    t.host.state.refuseAccounts = true;
    setLive(t.h, A);
    await Bun.sleep(150);
    expect(t.host.accounts.length).toBe(1);
    t.host.state.refuseAccounts = false;
    await until(() => t.host.accounts.length > 1, 4000, "repost after the host recovers");
    expect(t.host.last().accounts.find((a: any) => a.active).id).toBe("work");
    await t.stop();
  });

  test.each([401, 403])("a %i from the host ends the run", async (code) => {
    const t = await boot();
    await until(() => t.host.accounts.length > 0);
    t.host.state.status = code;
    t.host.push({ type: "account.manage", provider: "anthropic" });
    await Promise.race([t.done, Bun.sleep(3000).then(() => { throw new Error("run did not end"); })]);
    t.host.stop();
  });
});

describe("the manage page", () => {
  const buttons = (t: any, id: string) => nodes(t).filter((n) => n.type === "button" && n.action?.id === id);
  const forms = (t: any, id: string) => nodes(t).filter((n) => n.type === "form" && n.submit?.action?.id === id);

  test("lists accounts with switch and remove, and the in-use one cannot be removed", async () => {
    const t = await boot();
    await until(() => t.host.panels.length > 0);
    const tree = t.host.lastPanel();
    expect(buttons(tree, "use").map((b) => b.action.payload.id)).toEqual(["work"]);
    const rm = buttons(tree, "remove");
    expect(rm.map((b) => [b.action.payload.id, !!b.disabled])).toEqual([["work", false], ["home", true]]);
    expect(rm[0].confirm).toBeTruthy();
    await t.stop();
  });

  test("save the current login: a form value becomes a new account", async () => {
    const t = await boot({ saved: false });
    await until(() => t.host.panels.length > 0);
    expect(forms(t.host.lastPanel(), "save").length).toBe(1);
    t.host.push({ type: "action", action: { id: "save" }, values: { label: "orbit" } });
    await until(() => t.host.last()?.accounts.some((a: any) => a.id === "orbit"), 4000, "saved account");
    expect(t.host.last().accounts.find((a: any) => a.id === "orbit").active).toBe(true);
    await t.stop();
  });

  test("start add shows the exact command, check says not yet, cancel clears it", async () => {
    const t = await boot();
    await until(() => t.host.panels.length > 0);
    t.host.push({ type: "action", action: { id: "add" }, values: { label: "acme" } });
    await until(() => texts(t.host.lastPanel()).includes("claude auth login"), 4000, "command on the panel");
    const pending = t.acc.pendingList()[0]!;
    expect(texts(t.host.lastPanel())).toContain(`CLAUDE_CONFIG_DIR='${t.h.data}/pending/${pending.id}' claude auth login`);
    t.host.push({ type: "action", action: { id: "check", payload: { id: pending.id } } });
    await until(() => texts(t.host.lastPanel()).toLowerCase().includes("not signed in yet"), 4000, "not yet");
    t.host.push({ type: "action", action: { id: "cancel", payload: { id: pending.id } } });
    await until(() => !texts(t.host.lastPanel()).includes("claude auth login"), 4000, "cleared");
    expect(existsSync(`${t.h.data}/pending/${pending.id}`)).toBe(false);
    await t.stop();
  });

  test("a finished throwaway login is imported by check", async () => {
    const t = await boot();
    await until(() => t.host.panels.length > 0);
    t.host.push({ type: "action", action: { id: "add" }, values: { label: "acme" } });
    await until(() => t.acc.pendingList().length === 1);
    const p = t.acc.pendingList()[0]!;
    const dir = `${t.h.data}/pending/${p.id}`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dir}/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-d", refreshToken: "fixture-rd", expiresAt: Date.now() + 3_600_000 } }));
    writeFileSync(`${dir}/.claude.json`, JSON.stringify({ oauthAccount: { accountUuid: "uuid-d" } }));
    t.host.push({ type: "action", action: { id: "check", payload: { id: p.id } } });
    await until(() => t.host.last()?.accounts.some((a: any) => a.id === "acme"), 4000, "imported");
    await t.stop();
  });

  test("remove deletes the slot and reposts; removing the one in use is refused with a sentence", async () => {
    const t = await boot();
    await until(() => t.host.panels.length > 0);
    t.host.push({ type: "action", action: { id: "remove", payload: { id: "home" } } });
    await until(() => texts(t.host.lastPanel()).includes("Switch to another one first"), 4000, "refusal");
    expect(await t.store.get("home")).not.toBeNull();
    t.host.push({ type: "action", action: { id: "remove", payload: { id: "work" } } });
    await until(() => t.host.last().accounts.length === 1, 4000, "repost after remove");
    expect(await t.store.get("work")).toBeNull();
    await t.stop();
  });

  test("a malformed action or value is a sentence, not a crash", async () => {
    const t = await boot();
    await until(() => t.host.panels.length > 0);
    t.host.push({ type: "action", action: { id: "remove", payload: 7 } });
    t.host.push({ type: "action", action: { id: "save" }, values: { label: 5 } });
    t.host.push({ type: "action", action: { id: "nope" } });
    t.host.push({ type: "action" });
    t.host.push({ type: "account.switch", provider: "anthropic", id: 12 });
    await Bun.sleep(200);
    t.host.push({ type: "account.switch", provider: "anthropic", id: "work" });
    await until(() => live(t.h) === "fixture-ra", 4000, "still alive");
    await t.stop();
  });
});

describe("Swapkin", () => {
  test("present at start: deferTo is posted, nothing is written, the page has no controls", async () => {
    const h = makeHome(A);
    mkdirSync(`${h.root}/swapkin`);
    const host = fakeHost();
    const env = { ...h.env, SWAPKIN_DIR: `${h.root}/swapkin`, AGENTGLASS_URL: host.url, AGENTGLASS_READ_TOKEN: host.token };
    const acc = await Accounts.open(env, { store: await SecretStore.open(h.data, { keyring: null }) });
    const before = treeHash(h.home, h.data);
    const ac = new AbortController();
    const done = run(env, { acc, signal: ac.signal, waitMs: 30, retryMs: 10, firstProbeMs: 30, probeMs: 1e9 });
    await until(() => host.accounts.length > 0 && host.panels.length > 0);
    expect(host.accounts[0].deferTo).toBe("swapkin");
    const kinds = nodes(host.lastPanel()).map((n) => n.type);
    expect(kinds).not.toContain("button");
    expect(kinds).not.toContain("form");
    expect(texts(host.lastPanel())).toContain("Swapkin");
    host.push({ type: "account.switch", provider: "anthropic", id: "work" });
    host.push({ type: "action", action: { id: "save" }, values: { label: "orbit" } });
    await Bun.sleep(200);
    expect(treeHash(h.home, h.data)).toBe(before);
    ac.abort(); await done; host.stop();
  });

  test("appearing mid-run: the next switch is refused, files untouched, and the list is reposted as deferred", async () => {
    const t = await boot();
    await until(() => t.host.accounts.length > 0);
    mkdirSync(`${t.h.root}/swapkin-late`);
    (t.env as Record<string, string>).SWAPKIN_DIR = `${t.h.root}/swapkin-late`;
    const before = treeHash(t.h.home);
    t.host.push({ type: "account.switch", provider: "anthropic", id: "work" });
    await until(() => t.host.accounts.at(-1)?.deferTo === "swapkin", 4000, "deferred repost");
    expect(treeHash(t.h.home)).toBe(before);
    await t.stop();
  });
});

describe("probe timer", () => {
  test("reads the saved account that is not in use and posts its windows; never the active one", async () => {
    const used: string[] = [];
    const fake = fakeServer({ onUsage: (tok) => used.push(tok) });
    const t = await boot({ extra: fake.env, run: { firstProbeMs: 20, probeMs: 1e9 } });
    await until(() => t.host.accounts.some((b) => b.accounts.find((a: any) => a.id === "work")?.reading), 4000, "reading posted");
    const body = t.host.last();
    expect(body.accounts.find((a: any) => a.id === "work").reading.windows.map((w: any) => w.label)).toEqual(["5h", "7d"]);
    expect(body.accounts.find((a: any) => a.id === "home").reading).toBeUndefined();
    expect(used).toEqual(["fixture-a"]);
    await t.stop(); fake.stop();
  });

  test("a deferred run never reaches the usage endpoint", async () => {
    const fake = fakeServer();
    const t = await boot({ extra: { ...fake.env, SWAPKIN_DIR: "/" }, run: { firstProbeMs: 20, probeMs: 20 } });
    await Bun.sleep(250);
    expect(fake.hits.length).toBe(0);
    await t.stop(); fake.stop();
  });
});

describe("main", () => {
  test("exits 2 with a sentence when the host gave no URL or token", async () => {
    const p = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/main.ts`], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    const err = await new Response(p.stderr).text();
    expect(await p.exited).toBe(2);
    expect(err).toContain("AGENTGLASS_URL");
  });
});
