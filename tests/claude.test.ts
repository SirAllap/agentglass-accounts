import { describe, expect, test, afterAll } from "bun:test";
import { statSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { claudePaths, readLive, writeLive, sameLogin, serialize, parseBundle } from "../src/claude.ts";
import { atomicWrite, io } from "../src/fsutil.ts";
import { makeHome, setLive, readJson, cleanup, scratch } from "./helpers.ts";

afterAll(cleanup);
const A = { access: "fixture-a", refresh: "fixture-ra", uuid: "uuid-a" };
const B = { access: "fixture-b", refresh: "fixture-rb", uuid: "uuid-b", plan: "pro" };

describe("claude adapter", () => {
  test("paths: test override, CLAUDE_CONFIG_DIR, then HOME", () => {
    expect(claudePaths({ HOME: "/h" })).toEqual({ creds: "/h/.claude/.credentials.json", json: "/h/.claude.json" });
    expect(claudePaths({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" })).toEqual({ creds: "/c/.credentials.json", json: "/c/.claude.json" });
    expect(claudePaths({ HOME: "/h", ACCOUNTS_CLAUDE_DIR: "/d", ACCOUNTS_CLAUDE_JSON: "/j.json" })).toEqual({ creds: "/d/.credentials.json", json: "/j.json" });
  });

  test("read the live login; signed out is null", () => {
    const h = makeHome();
    const p = claudePaths(h.env);
    expect(readLive(p)).toBeNull();
    setLive(h, A);
    const live = readLive(p)!;
    expect(live.oauth.refreshToken).toBe("fixture-ra");
    expect(live.account?.accountUuid).toBe("uuid-a");
  });

  test("write replaces only the login: other keys in both files survive, modes stay 0600, no temp left", () => {
    const h = makeHome(A);
    const p = claudePaths(h.env);
    const b = { oauth: readLive(claudePaths(makeHome(B).env))!.oauth, account: { accountUuid: "uuid-b" } };
    writeLive(p, b);
    const c = readJson(h.credsFile), j = readJson(h.claudeJson);
    expect(c.claudeAiOauth.refreshToken).toBe("fixture-rb");
    expect(c.mcpOAuth).toEqual({ keep: "me" });
    expect(j.oauthAccount).toEqual({ accountUuid: "uuid-b" });
    expect(j.numStartups).toBe(7);
    expect(j.projects).toEqual({ "/orbit": {} });
    expect(statSync(h.credsFile).mode & 0o777).toBe(0o600);
    expect(statSync(h.claudeJson).mode & 0o777).toBe(0o600);
    expect(readdirSync(h.claudeDir)).toEqual([".credentials.json"]);
    expect(readdirSync(h.home).sort()).toEqual([".claude", ".claude.json"]);
  });

  test("a second file that cannot be written puts the first back", () => {
    const h = makeHome(A);
    const p = { ...claudePaths(h.env), json: join(h.home, "no-such-dir-is-a-file", "x") };
    writeFileSync(join(h.home, "no-such-dir-is-a-file"), "x"); // a file where a folder is needed: mkdir fails
    const before = Buffer.from(require("node:fs").readFileSync(h.credsFile));
    expect(() => writeLive(p, { oauth: { refreshToken: "r", accessToken: "t" }, account: null })).toThrow();
    expect(Buffer.from(require("node:fs").readFileSync(h.credsFile)).equals(before)).toBe(true);
  });

  test("a file Claude Code is half way through writing is never overwritten", () => {
    const h = makeHome(A);
    writeFileSync(h.claudeJson, '{"oauthAcc');
    expect(() => writeLive(claudePaths(h.env), { oauth: { refreshToken: "r" }, account: null })).toThrow();
    expect(require("node:fs").readFileSync(h.claudeJson, "utf8")).toBe('{"oauthAcc');
  });

  test("same login: uuid wins, refresh token when there is no uuid", () => {
    const a = { oauth: { refreshToken: "r1" }, account: { accountUuid: "u" } };
    expect(sameLogin(a, { oauth: { refreshToken: "rotated" }, account: { accountUuid: "u" } })).toBe(true);
    expect(sameLogin(a, { oauth: { refreshToken: "r1" }, account: { accountUuid: "other" } })).toBe(false);
    expect(sameLogin({ oauth: { refreshToken: "r1" }, account: null }, { oauth: { refreshToken: "r1" }, account: null })).toBe(true);
    expect(sameLogin({ oauth: { refreshToken: "r1" }, account: null }, { oauth: { refreshToken: "r2" }, account: null })).toBe(false);
  });

  test("a stored bundle round-trips and an alien string is refused", () => {
    const b = { oauth: { refreshToken: "r" }, account: { accountUuid: "u" } };
    expect(parseBundle(serialize(b))).toEqual(b);
    expect(() => parseBundle('{"oauth":{}}')).toThrow();
  });
});

describe("atomic write", () => {
  test("when rename is refused (a bind-mounted file in a box) it overwrites in place", () => {
    const d = scratch();
    const f = join(d, "mounted.json");
    writeFileSync(f, "old");
    // A directory cannot be renamed over by a file: EISDIR is not on the fallback list, so use a path that is a directory to prove it still throws...
    mkdirSync(join(d, "isdir"));
    expect(() => atomicWrite(join(d, "isdir"), "x")).toThrow();
    expect(readdirSync(d).sort()).toEqual(["isdir", "mounted.json"]);
    // ...and the in-place branch, with the rename made to fail the way a bind mount fails.
    const fs = require("node:fs");
    const orig = io.rename;
    io.rename = () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
    try { atomicWrite(f, "new"); } finally { io.rename = orig; }
    expect(fs.readFileSync(f, "utf8")).toBe("new");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(d).sort()).toEqual(["isdir", "mounted.json"]);
  });
});
