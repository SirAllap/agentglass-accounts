# accounts

Holds your Claude logins side by side and lets you switch between them from the
usage popover. It fills the `accounts` contribution of agentglass for the
`anthropic` provider.

**This plugin touches Claude Code's login.** To switch, it saves the live
credentials into the outgoing account's own slot and then replaces the live
credentials file and the account keys of `~/.claude.json` with the incoming
account's. Read the grants below before enabling it.

## It ships together with an agentglass change

The plugin is meant to be released with the agentglass commit that adds
`deferTo` to the accounts body (branch `feat/accounts-plugin-core`, commit
`e54399c5e`). Without it the app drops `deferTo`, never says "managed by
Swapkin" for a plugin that is not named `swapkin`, and a boxed copy of this
plugin (which cannot see Swapkin by itself) would go on switching while Swapkin
owns the logins. Unboxed, it still looks for Swapkin itself and refuses; boxed
on an app without the change, nothing can tell it, so do not enable it there.

## What it asks for, and why

| Grant | Why |
| --- | --- |
| `scope: read` | `/plugin/self/*` (post the account list, hear a chip press) is open at any scope. It reads and answers nothing else. |
| `network: internet` | Checks the usage of accounts you are not using, and renews their tokens, against Anthropic. |
| `read`/`write` `~/.claude/.credentials.json` | The live tokens. A switch rewrites the `claudeAiOauth` key and keeps the rest of the file. The grant is this one file, not `~/.claude`: that folder holds `settings.json` (its `hooks` run commands outside the box), `commands/` and `CLAUDE.md`, and a plugin that could write them could run code unboxed. |
| `read`/`write` `~/.claude.json` | Holds `oauthAccount`, the other half of "who is logged in". Only that key is replaced; the rest of the file is kept. |
| `programs: bun` | The plugin runs on `bun`. In the box, a `bun` that lives under your home folder (`~/.bun`, a version manager) is only visible through this grant; one under `/usr` needs none. `claude` is not granted: the plugin never runs it, it only prints the command for you to run. |

No grant covers the whole home folder, `~/.config/agentglass`, or the keyring
folders: the sandbox refuses those for every plugin.

The validator flags the credentials file as a login in red; that is the plugin
touching Claude Code's login, said out loud.

A file grant is a bind mount of that file alone. The box cannot create a temp
file next to it or rename over it (the rename is refused), so both files are
written **in place**, and that is **not atomic**. See "How a switch stays safe"
and "Ceilings". Both files must exist: the box cannot create a file it was not
given, so on a machine where Claude Code never signed in, there is nothing to
switch.

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
five minutes. Only an explicit "nobody manages it" lets a write through: a list
the app refused, a read-back that failed, or an app that lists nothing for this
plugin counts as no answer and the press is refused with a sentence. Between
two read-backs, Swapkin installed a moment ago is not known to either side: the
press still reaches the plugin, which asks again and refuses. The mirror of Swapkin's own accounts (`swapkin providers --json`)
only works unboxed; in the box the plugin shows its own list, read only.

## How a switch stays safe

A refresh token is single use: Claude Code rotates it every time it refreshes,
and the old one dies. So a switch (all under one lock, in this process and
across processes):

1. finds which saved account the live login is, in memory only (account uuid,
   else refresh token);
2. saves that live login into **its own** slot, reads the live file again, and
   saves again if it moved meanwhile (a refresh that lands during the switch);
3. reads `.credentials.json` once more and, if its login is not the one it just
   saved (a refresh landed), refuses and writes nothing;
4. copies both live files to the plugin's data folder (`0600`), notes the switch
   as under way, replaces `claudeAiOauth` in `.credentials.json` and the 13
   account keys in `~/.claude.json` (next section) **where they stand** (one write at offset
   0, padded with spaces when shorter, which JSON ignores, then a cut to the
   real length and fsync, so a reader never meets an empty file), copies the
   new pair again and clears the note.

**Which keys of `~/.claude.json` move with a login.** The same 13 Swapkin
carries (verified from source: `omarchy-swapkin` `bin/providers/claude.sh:49`
`ACCOUNT_KEYS`, and `:45-48` for why): `oauthAccount`, `userID`,
`modelAccessCache`, `orgModelDefaultCache`, `passesEligibilityCache`,
`additionalModelCostsCache`, `additionalModelOptionsCache`,
`additionalModelOptionsAnsweredAt`, `cachedExtraUsageDisabledReason`,
`cachedUsageUtilization`, `groveConfigCache`, `penguinModeOrgEnabled`,
`opusProMigrationComplete`. They carry the plan (models allowed, org defaults,
extra-usage state), so a Pro login would otherwise keep a Max login's answers
until Claude Code asks again. On a switch the outgoing account's 13 keys (as
they are in the file at that moment) go into its own slot, and the incoming
account's replace them in the file. A key the incoming account has not got is
**removed** from the file, not left: one account's org fields are never beside
another's (Swapkin merges and would leave it; this is stricter). Every other
key is left alone: same values, same order, same place. A key already in the
file keeps its position; a key it did not have is added at the end. The file is
written back with the indent it had (spaces, tabs or none) and a trailing
newline only if it had one. What a JSON round trip cannot keep: number
spellings (`1.0` becomes `1`), `\u` escapes (written as the character),
a repeated key (the last wins), keys that are whole numbers (listed first by
JavaScript), CRLF line ends, and integers beyond 2^53. Swapkin also drops six
per-user experiment keys on a switch (`VOLATILE_KEYS`, `:52`); this plugin does
not: it touches nothing outside the 13. A slot saved by an earlier version holds
`oauthAccount` only, so switching to it clears the other 12 until Claude Code
asks again. A slot is a file on disk and is not trusted to name keys: only the
13 are ever written from it.

Who the live login is: the **refresh token first**. A token that equals a saved
slot's is that account, and if the account key beside it names someone else
(a crash between the two writes, or Claude Code rewriting `~/.claude.json` from
memory) the switch, save and remove are refused ("different logins") and
nothing is filed. A rotated token is matched by the account uuid and, when both
sides say one, the organisation (a personal plan and a team seat share the
uuid). Each slot keeps the login it replaced, one step back; the engine can put
it back (`restorePrevious`), the page has no button for it yet.

If agentglass or the machine dies mid-write, the next start (and the next
switch) finds a file that is not JSON, or a login with no refresh token, waits
150 ms in case Claude Code is the one writing, and restores it from the copy. A
switch that died between its two writes is finished or dropped by the note it
left. A file that cannot be read is never overwritten, and a probe skips every
account while it cannot tell which one is in use.

A live login that is none of the saved accounts is never overwritten: the switch
is refused and you are told to save it first. Probing (usage of the accounts you
are not using) renews an expired token under the same lock and stores the new
pair before it asks for usage, and keeps it even if Swapkin shows up while the
request is in flight (the old token is dead by then). Add flows nobody finished
are swept after 30 minutes, at start and on every probe pass.

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

- **In-place writes are not atomic.** The box binds the two files and not their
  folder, so there is no temp file and no rename (measured: a rename over a bound
  file is refused with EBUSY, and a temp file next to it lands on the box's
  scratch folder, not in `~/.claude`). Granting the folder would make the
  write atomic and would also let the plugin write `settings.json` (hooks), so
  it is not granted. A crash or power cut between
  the write and the end of it can leave a file torn; the copy in the data
  folder is what restores it. That copy is the pair as of the last switch (or
  the state just before one that died), not Claude Code's latest refresh: a
  restore can bring back a token Claude Code has since rotated, and the account
  would have to sign in again. The write also races Claude Code, which rewrites
  `~/.claude.json` from memory: a write of its own between our read and our
  write is lost. Close Claude Code sessions you are not using.
- **A session still running as the old account.** If Claude Code, still open as
  account A after a switch to B, refreshes, it writes A's rotated pair into the
  credentials file while `~/.claude.json` says B. Offline that is
  indistinguishable from B's own refresh (the token is new to every slot), so
  the next switch files A's token into B's slot. Checking which account an
  access token belongs to needs the profile endpoint, which was not verified
  against the real service and is not called. The slot keeps the previous
  login (`restorePrevious`) for exactly this.
- **A login with no account key** (neither side has an account uuid) matches by
  refresh token only, so one rotation later it is "not saved": remove that
  account and save the login again. The sentence says so.
- **Both files must exist** (see the grants).
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
- **Unverified against the real service:** the token refresh endpoint, the
  client id and the request body are written from memory of Claude Code and
  were only ever answered by a fake server on localhost. Swapkin's source does
  not say either: its Claude adapter never refreshes a token itself and hands
  the usage read to another program (`omarchy-swapkin` `bin/providers/claude.sh`
  lines 191-192), which was not read. The usage endpoint and its response shape
  come from the app's own reader. Until someone checks the refresh against the
  real service, a probe of an account you are not using may fail (it backs off
  and keeps the last reading); `ACCOUNTS_TOKEN_URL` overrides the URL.
- **Verified from Swapkin's source** (`omarchy-swapkin`, not run): the add flow
  starts plain `claude` with `CLAUDE_CONFIG_DIR` on a throwaway folder and the
  person types `/login` (`bin/providers/claude.sh` lines 145-160); a finished
  sign-in is `.credentials.json` holding `claudeAiOauth.refreshToken` in that
  folder (line 164), with the account keys in `<folder>/.claude.json` (lines 24
  and 166). Swapkin waits one second after the file appears so the account keys
  are written too (line 165); here "I signed in, check" is pressed by the
  person; a check pressed before the keys are there answers "not yet" and
  imports nothing.
- The entrypoint starts `bun` from `/tmp`, not from the install folder: in the
  box `bun` must open the parents of its working directory and cannot
  (`CouldntReadCurrentDirectory`).
- Swapkin's `providers --json` shape is **verified from source** (`bin/swapkin`
  lines 363-402 and 406-417, `docs/providers.md` lines 126-145), not by running
  it: `{demo, providers:[{id:"claude", ..., accounts:[{name, active, plan,
  limits:[{label, percent, resetsAt}], ...}]}]}`, `percent` a fraction used
  (0..1), no tokens in it. It gives no window length, so the plugin takes it
  from the label (5 hour, week, month) and leaves out a limit whose label says
  none of them. Any other shape falls back to the plugin's own list, read only.
- A keyring entry that cannot be deleted when you remove an account stays in the
  keyring.

## Develop

`bun test` (needs `dbus-run-session` and `gnome-keyring-daemon` for the keyring
tests, which run against a private bus and skip without them) and
`tsc -p .` with `bun-types` resolvable from `node_modules`.
