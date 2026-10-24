import { run } from "./runtime.ts";

const ac = new AbortController();
for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => ac.abort());
try {
  await run(process.env, { signal: ac.signal });
} catch (e) {
  // The class and the first sentence only: nothing here may echo a file's content.
  console.error(`accounts: ${(e as Error).name}: ${String((e as Error).message).split("\n")[0]!.slice(0, 200)}`);
  process.exit(2);
}
