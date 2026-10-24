import { readFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./fsutil.ts";

export type Storage = "keyring" | "file";
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SERVICE = "agentglass-accounts";

/** The keyring did not answer, so nothing can be said about what it holds. Not the same as "no such account". */
export class StoreUnavailable extends Error {}

export interface Keyring {
  set(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<boolean>;
}

/** The OS keyring through Bun (Secret Service, Keychain, Credential Manager). Throws where there is none. */
export const bunKeyring: Keyring = {
  set: (name, value) => Bun.secrets.set({ service: SERVICE, name, value }),
  get: (name) => Bun.secrets.get({ service: SERVICE, name }),
  delete: (name) => Bun.secrets.delete({ service: SERVICE, name }),
};

const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("keyring did not answer")), ms))]);

/** A set/get/delete round trip that answers in time. A keyring that hangs (no session bus, a locked prompt) must not hang a switch. */
export async function probeKeyring(k: Keyring, ms = 3000): Promise<boolean> {
  const name = `probe/${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await timeout((async () => {
      await k.set(name, "ok");
      if ((await k.get(name)) !== "ok") throw new Error("keyring returned a different value");
      await k.delete(name);
    })(), ms);
    return true;
  } catch {
    void k.delete(name).catch(() => {});
    return false;
  }
}

/**
 * Where an account's credentials rest: the keyring when it answered the probe,
 * else one 0600 file per account. Which one holds an account is asked of the
 * store, never assumed, so the chip's "stored in a file" is true per account.
 * The secret is an opaque string; nothing here parses or logs it.
 */
export class SecretStore {
  private constructor(private dir: string, private keyring: Keyring | null) {}

  static async open(dataDir: string, opts: { keyring?: Keyring | null; probeMs?: number } = {}): Promise<SecretStore> {
    const dir = join(dataDir, "accounts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const k = opts.keyring === undefined ? bunKeyring : opts.keyring;
    return new SecretStore(dir, k && (await probeKeyring(k, opts.probeMs)) ? k : null);
  }

  get backend(): Storage { return this.keyring ? "keyring" : "file"; }
  private file(id: string) {
    if (!ID_RE.test(id)) throw new Error("bad account id");
    return join(this.dir, `${id}.json`);
  }
  private key = (id: string) => `anthropic/${id}`;

  async set(id: string, secret: string): Promise<Storage> {
    const f = this.file(id);
    if (this.keyring) {
      try {
        await timeout(this.keyring.set(this.key(id), secret), 3000);
        if (existsSync(f)) unlinkSync(f);
        return "keyring";
      } catch { /* the keyring went away after the probe: the file is the truth now */ }
    }
    atomicWrite(f, secret);
    return "file";
  }

  async get(id: string): Promise<string | null> {
    const f = this.file(id);
    if (existsSync(f)) return readFileSync(f, "utf8");
    if (!this.keyring) return null;
    try { return await timeout(this.keyring.get(this.key(id)), 3000); } catch { throw new StoreUnavailable("The keyring did not answer, so nothing was changed. Try again in a moment."); }
  }

  async kindOf(id: string): Promise<Storage | null> {
    if (existsSync(this.file(id))) return "file";
    return (await this.get(id)) !== null ? "keyring" : null;
  }

  async delete(id: string): Promise<void> {
    const f = this.file(id);
    if (existsSync(f)) unlinkSync(f);
    if (this.keyring) await timeout(this.keyring.delete(this.key(id)), 3000).catch(() => {});
  }
}
