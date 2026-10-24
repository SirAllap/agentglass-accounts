import type { Body } from "./accounts.ts";

export interface Notice { text: string; tone: "success" | "warning" | "danger" | "muted" }
export interface View {
  accounts: Body["accounts"];
  deferred: boolean;
  pending: { id: string; label: string; command: string }[];
  notice: Notice | null;
}

const act = (id: string, payload?: Record<string, unknown>) => ({ id, ...(payload ? { payload } : {}) });
const field = (label: string) => [{ key: "label", type: "string", label, placeholder: "e.g. work" }];

/**
 * The manage page as the app draws it: its own parts only, no HTML. It is the
 * smallest page that lists accounts, saves the login Claude Code has now,
 * starts an add and removes one. Renaming and colours are in the engine
 * (`edit`) and not on the page yet.
 */
export function manageTree(v: View) {
  const kids: unknown[] = [{ type: "heading", text: "Claude accounts", level: 2 }];
  if (v.notice) kids.push({ type: "text", text: v.notice.text, tone: v.notice.tone });
  if (v.deferred) kids.push({ type: "text", text: "Swapkin manages your Claude logins on this machine, so this plugin only shows them. Use Swapkin to switch, add or remove accounts.", tone: "muted" });
  if (!v.accounts.length) kids.push({ type: "empty", title: v.deferred ? "Swapkin reported no accounts" : "No accounts saved yet", body: v.deferred ? undefined : "Sign in with Claude Code, then save that login below." });
  for (const a of v.accounts) {
    kids.push({ type: "row", align: "between", wrap: true, children: [
      { type: "text", text: [a.label, a.plan, a.storage === "keyring" ? "keyring" : "stored in a file"].filter(Boolean).join(" · ") },
      ...(a.active ? [{ type: "badge", text: "In use", tone: "success" }] : []),
      ...(v.deferred ? [] : [
        ...(a.active ? [] : [{ type: "button", label: "Switch", action: act("use", { id: a.id }) }]),
        { type: "button", label: "Remove", tone: "danger", disabled: a.active, confirm: `Remove ${a.label}? Its saved login is deleted here. Claude Code keeps the login it has now.`, action: act("remove", { id: a.id }) },
      ]),
    ] });
  }
  if (!v.deferred) {
    kids.push({ type: "section", title: "Save the login Claude Code has now", children: [
      { type: "form", id: "save", fields: field("Name"), submit: { label: "Save current login", action: act("save") } }] });
    kids.push({ type: "section", title: "Add another account", subtitle: "Signs in to a throwaway folder; the login Claude Code is using is not touched.", children: [
      ...v.pending.flatMap((p) => [
        { type: "text", text: `Waiting for ${p.label}. Run this in a terminal, type /login at the prompt and sign in:` },
        { type: "code", text: p.command },
        { type: "row", children: [
          { type: "button", label: "I signed in, check", tone: "primary", action: act("check", { id: p.id }) },
          { type: "button", label: "Cancel", action: act("cancel", { id: p.id }) }] },
      ]),
      { type: "form", id: "add", fields: field("Name for the new account"), submit: { label: "Start", action: act("add") } }] });
  }
  return { type: "stack", gap: "md", children: kids };
}
