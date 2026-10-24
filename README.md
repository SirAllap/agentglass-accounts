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
