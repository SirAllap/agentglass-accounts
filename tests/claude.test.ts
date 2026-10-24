import { describe, expect, test, afterAll } from "bun:test";
import { statSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { claudePaths, readLive, writeLive, recoverLive, LiveMoved, sameLogin, serialize, parseBundle } from "../src/claude.ts";
import { atomicWrite, overwriteJsonInPlace, io } from "../src/fsutil.ts";
import { makeHome, setLive, readJson, cleanup, scratch, treeHash } from "./helpers.ts";

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
    writeLive(p, b, { backupDir: scratch() });
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

  // Only the two files are bind-mounted into the box, never their folder: a rename (which needs the folder) is refused there, and so is a temp file next to them.
  test("both live files are written where they stand: same inodes, a symlink stays a link, no temp file", () => {
    const h = makeHome(A);
    const target = join(h.root, "dotfiles.json");
    require("node:fs").renameSync(h.claudeJson, target);
    symlinkSync(target, h.claudeJson);
    const ino = [statSync(h.credsFile).ino, statSync(target).ino];
    const b = { oauth: readLive(claudePaths(makeHome(B).env))!.oauth, account: { accountUuid: "uuid-b" } };
    writeLive(claudePaths(h.env), b, { backupDir: scratch() });
    expect([statSync(h.credsFile).ino, statSync(target).ino]).toEqual(ino);
    expect(lstatSync(h.claudeJson).isSymbolicLink()).toBe(true);
    expect(readJson(target).oauthAccount).toEqual({ accountUuid: "uuid-b" });
    expect(readdirSync(h.claudeDir)).toEqual([".credentials.json"]);
  });

  test("a second file that cannot be written puts the first back", () => {
    const h = makeHome(A);
    const p = { ...claudePaths(h.env), json: join(h.home, "no-such-dir-is-a-file", "x") };
    writeFileSync(join(h.home, "no-such-dir-is-a-file"), "x"); // a file where a folder is needed: mkdir fails
    const before = Buffer.from(require("node:fs").readFileSync(h.credsFile));
    expect(() => writeLive(p, { oauth: { refreshToken: "r", accessToken: "t" }, account: null }, { backupDir: scratch() })).toThrow();
    expect(Buffer.from(require("node:fs").readFileSync(h.credsFile)).equals(before)).toBe(true);
  });

  test("a file Claude Code is half way through writing is never overwritten", () => {
    const h = makeHome(A);
    writeFileSync(h.claudeJson, '{"oauthAcc');
    expect(() => writeLive(claudePaths(h.env), { oauth: { refreshToken: "r" }, account: null }, { backupDir: scratch() })).toThrow();
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

const bundleB = () => ({ oauth: readLive(claudePaths(makeHome(B).env))!.oauth, account: { accountUuid: "uuid-b" } });

describe("a copy to restore from, and a check before the write", () => {
  test("the live content is copied to the backup folder (0600) before it is replaced", () => {
    const h = makeHome(A);
    const bk = join(scratch(), "bk");
    const before = [readFileSync(h.credsFile, "utf8"), readFileSync(h.claudeJson, "utf8")];
    writeLive(claudePaths(h.env), bundleB(), { backupDir: bk });
    expect(readFileSync(join(bk, "credentials.json"), "utf8")).toBe(before[0]);
    expect(readFileSync(join(bk, "claude.json"), "utf8")).toBe(before[1]);
    expect(statSync(join(bk, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(bk).mode & 0o777).toBe(0o700);
  });

  // Measured as the gap the README admits: Claude Code refreshes between our last look and our write, and its rotated token was overwritten without a word.
  test("a login that moved since the caller looked is not overwritten", () => {
    const h = makeHome(A);
    const bk = join(scratch(), "bk");
    const seen = readLive(claudePaths(h.env))!.oauth;
    setLive(h, { ...A, access: "fixture-a-r1", refresh: "fixture-ra-r1" });
    const before = treeHash(h.home);
    expect(() => writeLive(claudePaths(h.env), bundleB(), { backupDir: bk, expect: seen })).toThrow(LiveMoved);
    expect(treeHash(h.home)).toBe(before);
  });

  test("a half-written credentials file is put back from the copy; a half-written .claude.json too", async () => {
    const h = makeHome(A);
    const bk = join(scratch(), "bk");
    const p = claudePaths(h.env);
    const good = [readFileSync(h.credsFile, "utf8"), readFileSync(h.claudeJson, "utf8")];
    writeLive(p, bundleB(), { backupDir: bk });
    writeFileSync(h.credsFile, '{"claudeAiOauth":{"accessTok');
    writeFileSync(h.claudeJson, '{"oauthAcc');
    expect((await recoverLive(p, bk, 0)).sort()).toEqual(["claude.json", "credentials.json"]);
    expect([readFileSync(h.credsFile, "utf8"), readFileSync(h.claudeJson, "utf8")]).toEqual(good);
  });

  test("valid JSON whose login lost its refresh token counts as torn; signed out does not", async () => {
    const h = makeHome(A);
    const bk = join(scratch(), "bk");
    const p = claudePaths(h.env);
    writeLive(p, bundleB(), { backupDir: bk });
    writeFileSync(h.credsFile, '{"claudeAiOauth":{"accessToken":"x"}}');
    expect(await recoverLive(p, bk, 0)).toEqual(["credentials.json"]);
    writeFileSync(h.credsFile, '{"mcpOAuth":{}}'); // Claude Code signed out: a whole file, not ours to touch
    expect(await recoverLive(p, bk, 0)).toEqual([]);
    expect(readFileSync(h.credsFile, "utf8")).toBe('{"mcpOAuth":{}}');
  });

  test("a healthy pair, no copy, a missing file and a torn copy are all left alone", async () => {
    const h = makeHome(A);
    const bk = join(scratch(), "bk");
    const p = claudePaths(h.env);
    const before = treeHash(h.home);
    expect(await recoverLive(p, bk, 0)).toEqual([]); // healthy, no copy yet
    expect(treeHash(h.home)).toBe(before);
    writeFileSync(h.credsFile, '{"claudeAi'); // torn, and there is no copy to restore from
    expect(await recoverLive(p, bk, 0)).toEqual([]);
    expect(readFileSync(h.credsFile, "utf8")).toBe('{"claudeAi');
    setLive(h, A);
    writeLive(p, bundleB(), { backupDir: bk });
    writeFileSync(join(bk, "credentials.json"), '{"torn copy');
    writeFileSync(h.credsFile, '{"claudeAi');
    expect(await recoverLive(p, bk, 0)).toEqual([]);
    expect(readFileSync(h.credsFile, "utf8")).toBe('{"claudeAi');
  });

  // Claude Code's own write in progress looks the same for a moment; only a file still torn after the settle time is restored.
  test("a file that is whole again after the settle time is not restored", async () => {
    const h = makeHome(A);
    const bk = join(scratch(), "bk");
    const p = claudePaths(h.env);
    writeLive(p, bundleB(), { backupDir: bk });
    const whole = readFileSync(h.credsFile, "utf8");
    writeFileSync(h.credsFile, '{"claudeAi');
    setTimeout(() => writeFileSync(h.credsFile, whole.replace("fixture-rb", "fixture-rb-claude")), 30);
    expect(await recoverLive(p, bk, 120)).toEqual([]);
    expect(readJson(h.credsFile).claudeAiOauth.refreshToken).toBe("fixture-rb-claude");
  });
});

describe("atomic write", () => {
  test("temp in the same folder, fsynced before the rename, nothing left behind", () => {
    const d = scratch();
    const f = join(d, "slot.json");
    const order: string[] = [];
    const { rename, fsync } = io;
    io.rename = (a, b) => { order.push("rename"); rename(a, b); };
    io.fsync = (fd) => { order.push("fsync"); fsync(fd); };
    try { atomicWrite(f, "new"); } finally { Object.assign(io, { rename, fsync }); }
    expect(order).toEqual(["fsync", "rename"]);
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(["slot.json"]);
  });
  test("a rename that fails leaves the old file and no temp", () => {
    const d = scratch();
    const f = join(d, "slot.json");
    writeFileSync(f, "old");
    const { rename } = io;
    io.rename = () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
    try { expect(() => atomicWrite(f, "new")).toThrow(); } finally { io.rename = rename; }
    expect(readFileSync(f, "utf8")).toBe("old");
    expect(readdirSync(d)).toEqual(["slot.json"]);
  });
});

describe("overwrite in place", () => {
  const doc = (n: number) => JSON.stringify({ k: "x".repeat(n) });
  test("same inode and mode, new content (longer, then shorter), no file next to it", () => {
    const d = scratch();
    const f = join(d, "mounted.json");
    writeFileSync(f, doc(10), { mode: 0o640 });
    const ino = statSync(f).ino;
    overwriteJsonInPlace(f, doc(50));
    expect(readFileSync(f, "utf8")).toBe(doc(50));
    overwriteJsonInPlace(f, doc(5));
    expect(readFileSync(f, "utf8")).toBe(doc(5));
    expect(statSync(f).ino).toBe(ino);
    expect(statSync(f).mode & 0o777).toBe(0o640);
    expect(readdirSync(d)).toEqual(["mounted.json"]);
  });
  // A reader that caught the file empty (O_TRUNC, then a slow write) could take it for corrupt and reset it.
  test("a shorter text is a whole document at every moment, including just before the cut", () => {
    const d = scratch();
    const f = join(d, "live.json");
    writeFileSync(f, doc(400));
    const { truncate } = io;
    const seen: unknown[] = [];
    io.truncate = (fd, len) => { seen.push(JSON.parse(readFileSync(f, "utf8"))); truncate(fd, len); };
    try { overwriteJsonInPlace(f, doc(3)); } finally { io.truncate = truncate; }
    expect(seen).toEqual([{ k: "xxx" }]);
    expect(readFileSync(f, "utf8")).toBe(doc(3));
  });
  test("a file that is not there yet is created 0600", () => {
    const d = scratch();
    const old = process.umask(0);
    try { overwriteJsonInPlace(join(d, "new.json"), "{}"); } finally { process.umask(old); }
    expect(statSync(join(d, "new.json")).mode & 0o777).toBe(0o600);
  });
  test("a symlinked file stays a symlink and its target changes", () => {
    const d = scratch();
    mkdirSync(join(d, "dotfiles"));
    writeFileSync(join(d, "dotfiles", "claude.json"), doc(8));
    symlinkSync(join(d, "dotfiles", "claude.json"), join(d, "link.json"));
    overwriteJsonInPlace(join(d, "link.json"), doc(2));
    expect(lstatSync(join(d, "link.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(d, "dotfiles", "claude.json"), "utf8")).toBe(doc(2));
  });
  test("is fsynced", () => {
    const d = scratch();
    let n = 0;
    const { fsync } = io;
    io.fsync = (fd) => { n++; fsync(fd); };
    try { overwriteJsonInPlace(join(d, "a.json"), "{}"); } finally { io.fsync = fsync; }
    expect(n).toBe(1);
  });
});
