import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");

// A write grant on the whole ~/.claude makes settings.json hooks, commands/ and CLAUDE.md writable: code that Claude Code runs outside the box.
describe("the grants", () => {
  const FILES = ["~/.claude/.credentials.json", "~/.claude.json"];
  test("read and write name the two login files and nothing wider", () => {
    expect([...manifest.sandbox.read].sort()).toEqual([...FILES].sort());
    expect([...manifest.sandbox.write].sort()).toEqual([...FILES].sort());
  });
  test("no grant is a folder or the home folder", () => {
    for (const g of [...manifest.sandbox.read, ...manifest.sandbox.write]) expect(g).toMatch(/\.json$/);
  });
  test("each grant is justified in the README, and the ceiling of an in-place write is named", () => {
    for (const g of [...FILES, "programs: bun", "network: internet"]) expect(readme).toContain(g.replace("programs: bun", "programs").replace("network: internet", "network"));
    expect(readme).toContain("not atomic");
    expect(readme).toContain("hooks");
  });
  test("the core commit the Swapkin defer depends on is named", () => {
    expect(readme).toContain("deferTo");
    expect(readme).toContain("e54399c5e");
  });
});
