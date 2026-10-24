import { describe, expect, test, afterAll } from "bun:test";
import { windowsOf } from "../src/accounts.ts";
import { coreProblem } from "./helpers.ts";
import { fakeServer, REAL_SHAPE } from "./fakeServer.ts";
import { makeHome, setLive, cleanup } from "./helpers.ts";
import { Accounts } from "../src/accounts.ts";
import { SecretStore } from "../src/store.ts";

afterAll(cleanup);
const w = (label: string, minutes: number, usedPercent: number, resetsAt: string | null) => ({ label, minutes, usedPercent, resetsAt });
const bucket = (utilization: unknown, resets_at: unknown = "2026-10-30T09:00:00Z") => ({ utilization, resets_at });

// Every expectation below is read off omarchy-agent-usage-claude (probe_limits, lines 742-765; normalize_*, 606-644; scoped_limits, 677-708).
describe("usage payload: the shape omarchy-agent-usage-claude reads", () => {
  test("the whole payload: session, the app-scoped weekly bucket, and a model-scoped window from `limits`", () => {
    expect(windowsOf(REAL_SHAPE)).toEqual([
      w("5h", 300, 42, "2026-10-24T18:00:00.123Z"), w("7d", 10080, 9, "2026-10-30T09:00:00.000Z"), w("Orbit Pro Weekly", 10080, 55, "2026-10-30T09:00:00.000Z")]);
  });

  test("weekly is seven_day_oauth_apps; the plain seven_day only when that bucket is absent or empty (line 742)", () => {
    const base = { five_hour: bucket(10), seven_day: bucket(7), seven_day_oauth_apps: bucket(30) };
    expect(windowsOf(base).map((x) => x.usedPercent)).toEqual([10, 30]);
    expect(windowsOf({ ...base, seven_day_oauth_apps: undefined }).map((x) => x.usedPercent)).toEqual([10, 7]);
    expect(windowsOf({ ...base, seven_day_oauth_apps: {} }).map((x) => x.usedPercent)).toEqual([10, 7]);
  });

  test("an older payload in fractions is read as fractions; one value >= 1 anywhere makes the whole payload percent (lines 613-623, 750)", () => {
    expect(windowsOf({ five_hour: bucket(0.37), seven_day: bucket(0.05) }).map((x) => x.usedPercent)).toEqual([37, 5]);
    expect(windowsOf({ five_hour: bucket(1.0), seven_day: bucket(0.5) }).map((x) => x.usedPercent)).toEqual([1, 1]); // 1.0 is 1 percent, not 100
    expect(windowsOf({ five_hour: bucket(0.2), limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Orbit Pro" } }, percent: 40 }] }).map((x) => x.usedPercent)).toEqual([0, 40]);
  });

  test("a number written as text with a percent sign, and a reset given as epoch seconds or milliseconds (lines 606-610, 626-644)", () => {
    const out = windowsOf({ five_hour: bucket(" 37.5% ", "1793000000"), seven_day: bucket("12", 1793000000000) });
    expect(out.map((x) => [x.usedPercent, x.resetsAt])).toEqual([[38, "2026-10-26T07:33:20.000Z"], [12, "2026-10-26T07:33:20.000Z"]]);
    expect(windowsOf({ five_hour: bucket("n/a"), seven_day: bucket(-3) })).toEqual([]);
    expect(windowsOf({ five_hour: bucket(5, "soon"), seven_day: bucket(5, "") }).map((x) => x.resetsAt)).toEqual([null, null]);
  });

  test("model-scoped windows: title from the display name or the id, window from the kind, repeats and unknown kinds left out, labels the core accepts (lines 658-708)", () => {
    const e = (kind: string, name: string | null, percent: unknown, id = "m1") => ({ kind, scope: { model: name === null ? { id } : { id, display_name: name } }, percent, resets_at: "2026-10-30T09:00:00Z" });
    const out = windowsOf({ five_hour: bucket(10), limits: [
      e("weekly_scoped", "Orbit Pro", 55), e("weekly_scoped", "Orbit Pro", 56), e("five_hour_scoped", "Orbit Pro", 20), e("monthly_scoped", null, 5, "orbit-mini"),
      e("mystery", "Orbit Lite", 5), e("weekly_scoped", "Orbit <Max> a@b.co", 5), e("weekly_scoped", "Orbit Pro 5 (1M context)", 61), e("weekly_scoped", "Orbitron Extended Edition", 60), { kind: "weekly_scoped", scope: null, percent: 5 }, e("weekly_scoped", "Orbit Neg", -1)] });
    // a long name is cut to leave room for the window word (labels are 16 characters at most) and a label that repeats after the cut is dropped; a name with anything but plain characters is left out
    expect(out.map((x) => [x.label, x.minutes, x.usedPercent])).toEqual([["5h", 300, 10], ["Orbit Pro Weekly", 10080, 55], ["Orbit Pr Session", 300, 20], ["orbit-mi Monthly", 43200, 5], ["Orbitron Weekly", 10080, 60]]);
    expect(coreProblem({ provider: "anthropic", accounts: [{ id: "work", label: "work", plan: "", colour: "blue", active: false, storage: "file", reading: { at: 1, windows: out } }] })).toBeNull();
  });

  test("at most six windows, so the core never refuses the whole list over a seventh", () => {
    const limits = Array.from({ length: 9 }, (_, i) => ({ kind: "weekly_scoped", scope: { model: { display_name: `Orbit ${i}` } }, percent: 5 + i }));
    const out = windowsOf({ five_hour: bucket(10), seven_day: bucket(10), limits });
    expect(out).toHaveLength(6);
    expect(coreProblem({ provider: "anthropic", accounts: [{ id: "work", label: "work", plan: "", colour: "blue", active: false, storage: "file", reading: { windows: out } }] })).toBeNull();
  });
});

describe("usage request", () => {
  test("Bearer token, anthropic-beta oauth-2025-04-20 and Accept: application/json, as the reader sends them (lines 712-718)", async () => {
    const fake = fakeServer();
    try {
      const h = makeHome({ access: "fixture-a", refresh: "fixture-ra", uuid: "uuid-a" });
      const store = await SecretStore.open(h.data, { keyring: null });
      const acc = new Accounts({ ...h.env, ...fake.env }, { store });
      await acc.saveCurrent("work");
      setLive(h, { access: "fixture-b", refresh: "fixture-rb", uuid: "uuid-b" });
      await acc.saveCurrent("home");
      await acc.probeAll();
      expect(fake.hits.filter((x) => x.path === "/usage").map((x) => [x.auth, x.beta, x.accept])).toEqual([["Bearer fixture-a", "oauth-2025-04-20", "application/json"]]);
    } finally { fake.stop(); }
  });
});
