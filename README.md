# accounts

Holds your Claude logins side by side and lets you switch between them from the
usage popover. It fills the `accounts` contribution of agentglass for the
`anthropic` provider.

**This plugin touches Claude Code's login.** To switch, it saves the live
credentials into the outgoing account's own slot and then replaces the live
credentials file and the account keys of `~/.claude.json` with the incoming
account's. Read the grants below before enabling it.

## What it asks for, and why

| Grant | Why |
| --- | --- |
| `scope: read` | `/plugin/self/*` (post the account list, hear a chip press) is open at any scope. It reads and answers nothing else. |
| `network: internet` | Checks the usage of accounts you are not using, and renews their tokens, against Anthropic. |
| `read`/`write` `~/.claude` | The live `.credentials.json` is there. A switch rewrites it (temp file in the same folder, then rename). |
| `read`/`write` `~/.claude.json` | Holds `oauthAccount`, the other half of "who is logged in". Only that key is replaced; the rest of the file is kept. |
| `programs: bun` | The plugin runs on `bun`. In the box, a `bun` that lives under your home folder (`~/.bun`, a version manager) is only visible through this grant; one under `/usr` needs none. `claude` is not granted: the plugin never runs it, it only prints the command for you to run. |

No grant covers the whole home folder, `~/.config/agentglass`, or the keyring
folders: the sandbox refuses those for every plugin.

## Where the tokens live

The core gives plugins **no keyring**, and a boxed plugin cannot reach the
session bus. So the plugin tries the OS keyring on its own (`Bun.secrets`, a
3 second probe) and, when that does not answer, keeps one `0600` file per
account in its data folder. Each account in the popover says which it is
("stored in a file" or keyring). Inside the box the keyring is not reachable,
so expect "stored in a file" there.

## Swapkin

If `swapkin` is on PATH or its data folder exists, this plugin does nothing that
writes: no switch, add, remove or probe. It shows what Swapkin reports, read
only, and tells the app to show "Managed by Swapkin". Presence is checked at
start and again right before every write.

Inside the box this process cannot see Swapkin (its PATH entry and folder are
not mounted; measured with a stub `swapkin` on the app's PATH, the plugin kept
switching). So every list carries `deferTo: "swapkin"`, which the app drops
unless it finds Swapkin itself, and the app's answer is read back from
`GET /usage/accounts` after each post, before each press that writes, and every
five minutes. Between two of those, Swapkin installed a moment ago is not
known to either side: the press still reaches the plugin, which asks again and
refuses. The mirror of Swapkin's own accounts (`swapkin providers --json`)
only works unboxed; in the box the plugin shows its own list, read only.

## How a switch stays safe

A refresh token is single use: Claude Code rotates it every time it refreshes,
and the old one dies. So a switch (all under one lock, in this process and
across processes):

1. finds which saved account the live login is, in memory only (account uuid,
   else refresh token);
2. saves that live login into **its own** slot, reads the live file again, and
   saves again if it moved meanwhile (a refresh that lands during the switch);
3. only then replaces `claudeAiOauth` in `.credentials.json` and `oauthAccount`
   in `~/.claude.json`, each by temp file in the same folder + fsync + rename.

A live login that is none of the saved accounts is never overwritten: the switch
is refused and you are told to save it first. Probing (usage of the accounts you
are not using) renews an expired token under the same lock and stores the new
pair before it asks for usage.

## The page

Settings → Plugins → Accounts → Open, or "manage" in the usage popover. It
lists the accounts with **Switch** and **Remove** (the one in use cannot be
removed), **Save current login**, and **Add another account**, which prints the
command for a throwaway folder and waits for you to say you signed in. Renaming
and colours exist in the engine and are not on the page yet. Under Swapkin the
page is read only.

## What it posts

`POST /plugin/self/accounts` with id, label, plan, colour, active, storage and,
for accounts you are not using, the last reading (5 hour and 7 day windows).
Never an email, an account id from Anthropic, or a token. Names are cleaned the
way the app's validator checks them, and a name that looks like an email or key
is refused when you type it.

## Environment

Given by the host: `PATH`, `HOME`, `AGENTGLASS_READ_TOKEN`, `AGENTGLASS_URL`,
`AGENTGLASS_PLUGIN_DATA`. Read only for tests: `ACCOUNTS_CLAUDE_DIR`,
`ACCOUNTS_CLAUDE_JSON`, `ACCOUNTS_USAGE_URL`, `ACCOUNTS_TOKEN_URL`, `SWAPKIN_DIR`.

## Ceilings

- **The last millisecond.** The live file is read once more right before the
  rename; a refresh that lands in that window is overwritten, and the account
  would have to sign in again. Close Claude Code sessions you are not using.
- **`~/.claude.json` is read, changed and replaced as a whole.** Claude Code
  writes it too; a write of its own between our read and rename is lost.
  In the box that file is a bind mount, so the rename is refused (EBUSY) and
  it is overwritten **in place** instead (measured: same inode before and
  after), which is not atomic: a crash in the middle can leave it half
  written. `.credentials.json` sits in a granted folder and is renamed
  atomically. The grant is the file, not its folder, because the app refuses
  to mount the folder `~` itself.
- **Secrets are in a file.** In the box there is no keyring (the app gives
  plugins none and the session bus is out of reach), so each account's tokens
  are a `0600` file in the plugin's data folder: anything running as you can
  read it, and a plugin that runs unboxed can too. The popover says "stored in
  a file".
- **Matching the live login** needs `oauthAccount.accountUuid` (Claude Code
  always writes it) or an unrotated refresh token.
- A probe holds the lock while it renews a token (up to 8 s), so a switch can
  wait that long.
- Only the 5 hour and 7 day windows are read, not per-model limits.
- **Unverified against the real service:** the token refresh endpoint and the
  client id are written from memory of Claude Code and were only ever answered
  by a fake server on localhost. The usage endpoint and its response shape come
  from the app's own reader. Until someone checks the refresh against the real
  service (and the `claude auth login` command printed for adding an account is
  also unverified: the real `claude` was off limits), a probe of an account you
  are not using may fail (it backs off and
  keeps the last reading); `ACCOUNTS_TOKEN_URL` overrides the URL.
- The entrypoint starts `bun` from `/tmp`, not from the install folder: in the
  box `bun` must open the parents of its working directory and cannot
  (`CouldntReadCurrentDirectory`).
- Swapkin's `providers --json` shape was not measured; a mismatch falls back to
  the plugin's own list, read only.
- A keyring entry that cannot be deleted when you remove an account stays in the
  keyring.

## Develop

`bun test` (needs `dbus-run-session` and `gnome-keyring-daemon` for the keyring
tests, which run against a private bus and skip without them) and
`tsc -p .` with `bun-types` resolvable from `node_modules`.
