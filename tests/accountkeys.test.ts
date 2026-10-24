import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { Accounts } from "../src/accounts.ts";
import { SecretStore } from "../src/store.ts";
import { parseBundle, serialize, ACCOUNT_KEYS } from "../src/claude.ts";
import { makeHome, cleanup, creds, type Home, type Login } from "./helpers.ts";

afterAll(cleanup);
const A: Login = { access: "fixture-a", refresh: "fixture-ra", uuid: "uuid-a", org: "org-a" };
const B: Login = { access: "fixture-b", refresh: "fixture-rb", uuid: "uuid-b", plan: "pro" };

/** The 13 keys that belong to the account (the same list Swapkin carries), with values that name whose they are. */
const ownKeys = (who: string, omit: string[] = []) => Object.fromEntries(ACCOUNT_KEYS.filter((k) => !omit.includes(k)).map((k) => [k, k === "oauthAccount" ? { accountUuid: `uuid-${who}`, ...(who === "a" ? { organizationUuid: "org-a" } : {}), displayName: "Fixture" } : `${k}:${who}`]));

/** A live `.claude.json` the way Claude Code lays it out: machine keys and account keys interleaved. */
function writeState(h: Home, who: string, o: { omit?: string[]; indent?: number | string; nl?: boolean; machine?: string } = {}) {
  const own = ownKeys(who, o.omit);
  const o2: Record<string, unknown> = {
    numStartups: 7, ...pick(own, "userID"), projects: { "/orbit": { allowedTools: [] } }, ...pick(own, "oauthAccount"),
    cachedStatsigGates: { gate: who }, ...pick(own, "modelAccessCache", "groveConfigCache"), tipsHistory: { a: 1 }, machineMark: o.machine ?? "m1",
    ...pick(own, "cachedUsageUtilization", "opusProMigrationComplete"), theme: "dark",
    ...own, // whatever is left (Claude Code appends keys it adds later); the ones placed above keep their place
  };
  writeFileSync(h.claudeJson, JSON.stringify(o2, null, o.indent ?? 2) + (o.nl === false ? "" : "\n"), { mode: 0o600 });
  return o2;
}
const pick = (o: Record<string, unknown>, ...ks: string[]) => Object.fromEntries(ks.filter((k) => k in o).map((k) => [k, o[k]]));
const live = (h: Home, who: Login, state: () => void) => { writeFileSync(h.credsFile, JSON.stringify(creds(who)), { mode: 0o600 }); state(); };

async function setup(stateA = {}, stateB: { omit?: string[] } = {}) {
  const h = makeHome(A);
  const store = await SecretStore.open(h.data, { keyring: null });
  const acc = new Accounts(h.env, { store });
  live(h, A, () => writeState(h, "a", stateA));
  await acc.saveCurrent("work");
  live(h, B, () => writeState(h, "b", stateB));
  await acc.saveCurrent("home");
  return { h, store, acc };
}
const text = (h: Home) => readFileSync(h.claudeJson, "utf8");

describe("a switch carries all 13 account keys of .claude.json", () => {
  test("the incoming account's keys go in, everything else stays where it was, byte for byte in the file's own layout", async () => {
    const { h, acc } = await setup();
    // home is live; a cache moved since it was saved
    const ownB = writeState(h, "b", { machine: "m2", omit: ["penguinModeOrgEnabled", "passesEligibilityCache"] });
    await acc.use("work");
    const want = JSON.parse(JSON.stringify(ownB));
    for (const [k, v] of Object.entries(ownKeys("a"))) if (k in want) want[k] = v;
    // home's file lacked two of the 13: work's values for them are appended at the end
    for (const [k, v] of Object.entries(ownKeys("a"))) if (!(k in want)) want[k] = v;
    expect(text(h)).toBe(JSON.stringify(want, null, 2) + "\n");
    expect(Object.keys(JSON.parse(text(h)))).toEqual([...Object.keys(ownB), ...ACCOUNT_KEYS.filter((k) => !(k in ownB))]);
    expect(JSON.parse(text(h)).machineMark).toBe("m2");
    expect(JSON.parse(text(h)).cachedStatsigGates).toEqual({ gate: "b" }); // not ours to drop
  });

  test("the outgoing account's 13 keys land in its own slot, as they are at the moment of the switch", async () => {
    const { h, acc, store } = await setup();
    const ownB = writeState(h, "b");
    const edited = JSON.parse(text(h));
    edited.modelAccessCache = "modelAccessCache:b-newer";
    writeFileSync(h.claudeJson, JSON.stringify(edited, null, 2) + "\n");
    await acc.use("work");
    const home = parseBundle((await store.get("home"))!);
    expect({ ...home.keys, oauthAccount: home.account } as Record<string, unknown>).toEqual({ ...pick(ownB, ...ACCOUNT_KEYS), modelAccessCache: "modelAccessCache:b-newer" });
    const work = parseBundle((await store.get("work"))!);
    expect(Object.keys(work.keys ?? {}).sort()).toEqual(ACCOUNT_KEYS.filter((k) => k !== "oauthAccount").sort());
  });

  test("mixed fields: a key only the outgoing account had is removed, never left next to the incoming account's", async () => {
    const { h, acc } = await setup({}, { omit: ["orgModelDefaultCache", "groveConfigCache", "userID"] });
    await acc.use("work"); // work has all 13, home lacked 3 of them: live was home's
    expect(JSON.parse(text(h)).orgModelDefaultCache).toBe("orgModelDefaultCache:a");
    await acc.use("home"); // and back: live must hold none of work's org fields
    const j = JSON.parse(text(h));
    for (const k of ["orgModelDefaultCache", "groveConfigCache", "userID"]) expect(k in j).toBe(false);
    expect(j.oauthAccount.accountUuid).toBe("uuid-b");
    expect("organizationUuid" in j.oauthAccount).toBe(false);
    for (const k of ACCOUNT_KEYS.filter((k) => k !== "oauthAccount" && k in j)) expect(j[k]).toBe(`${k}:b`);
  });

  test("a slot saved before the keys were kept (account only) switches without leaving the outgoing caches behind", async () => {
    const { h, acc, store } = await setup();
    const old = parseBundle((await store.get("work"))!);
    await store.set("work", serialize({ oauth: old.oauth, account: old.account }));
    await acc.use("work");
    const j = JSON.parse(text(h));
    expect(j.oauthAccount.accountUuid).toBe("uuid-a");
    for (const k of ACCOUNT_KEYS.filter((k) => k !== "oauthAccount")) expect(k in j).toBe(false);
    expect(j.numStartups).toBe(7);
  });

  test("a slot edited by hand to carry other keys cannot write them into the file", async () => {
    const { h, acc, store } = await setup();
    const b = parseBundle((await store.get("work"))!);
    await store.set("work", JSON.stringify({ v: 1, oauth: b.oauth, account: b.account, keys: { ...b.keys, mcpServers: { evil: { command: "x" } }, projects: {} } }));
    await acc.use("work");
    const j = JSON.parse(text(h));
    expect(j.userID).toBe("userID:a"); // the account keys did go in
    expect("mcpServers" in j).toBe(false);
    expect(j.projects).toEqual({ "/orbit": { allowedTools: [] } });
  });

  test("layout: a compact file stays compact, a tab-indented one keeps its tabs, no trailing newline is not added", async () => {
    for (const [indent, nl] of [["", false], ["\t", true], [4, false]] as const) {
      const { h, acc } = await setup();
      const o = writeState(h, "b", { indent, nl });
      await acc.use("work");
      const j = JSON.parse(text(h));
      expect(text(h)).toBe(JSON.stringify(j, null, indent) + (nl ? "\n" : ""));
      expect(j.numStartups).toBe(o.numStartups);
    }
  });

  test("a torn .claude.json is put back from the copy of the last switch, with the account keys of that switch", async () => {
    const { h, store } = await setup();
    const acc = new Accounts(h.env, { store, settleMs: 0 });
    await acc.use("work");
    writeFileSync(h.claudeJson, '{"numStartups": 7, "oauthAcc');
    await acc.use("home");
    const j = JSON.parse(text(h));
    expect(j.oauthAccount.accountUuid).toBe("uuid-b");
    expect(j.modelAccessCache).toBe("modelAccessCache:b");
    expect(j.numStartups).toBe(7);
  });
});
