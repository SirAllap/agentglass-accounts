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
| `programs: claude, bun` | `claude` is used only to tell you the command for adding an account; the plugin runs on `bun`. |

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
  When the file is a bind mount inside the box (rename refused with EBUSY or
  EXDEV) it is overwritten in place instead, which is not atomic.
- **Matching the live login** needs `oauthAccount.accountUuid` (Claude Code
  always writes it) or an unrotated refresh token.
- A probe holds the lock while it renews a token (up to 8 s), so a switch can
  wait that long.
- Only the 5 hour and 7 day windows are read, not per-model limits.
- The refresh endpoint and client id are Claude Code's; they were not checked
  against a live server here (`ACCOUNTS_TOKEN_URL` overrides the URL).
- Swapkin's `providers --json` shape was not measured; a mismatch falls back to
  the plugin's own list, read only.
- A keyring entry that cannot be deleted when you remove an account stays in the
  keyring.

## Develop

`bun test` (needs `dbus-run-session` and `gnome-keyring-daemon` for the keyring
tests, which run against a private bus and skip without them) and
`tsc -p .` with `bun-types` resolvable from `node_modules`.
