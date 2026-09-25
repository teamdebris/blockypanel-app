"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, LogOut, MoreHorizontal, Plus, ShieldOff, Trash2, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, type Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { ConfirmDialog, PageHeading, Section } from "./common";
import { api, errorMessage, formatRelative } from "./lib";
import { useNow, usePanel } from "./panel-context";
import { RoleBadge } from "./shell";

type UserRow = { id: string; username: string; role: Role; createdAt: number; lastLoginAt: number | null; lastSeenAt: number | null; disabled: boolean; twoFactor: boolean; you: boolean };
type InviteRow = { id: string; kind: "invite" | "reset"; role: Role | null; username?: string; createdBy: string; createdAt: number; expiresAt: number };
type AuditRow = { id: number; at: number; actor: string; message: string };
type UsersData = { users: UserRow[]; invites: InviteRow[]; audit: AuditRow[] };
type CreatedLink = { title: string; description: string; url: string };

/** Shows a just-created invite or reset link once, with a copy button. */
function LinkDialog({ link, onClose }: { link: CreatedLink | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { toast.error("Couldn't copy. Select the link and copy it manually."); }
  }
  return <Dialog open={Boolean(link)} onOpenChange={(open) => { if (!open) { setCopied(false); onClose(); } }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{link?.title}</DialogTitle><DialogDescription>{link?.description}</DialogDescription></DialogHeader>
      <div className="flex gap-2">
        <Input readOnly value={link?.url || ""} aria-label="Link" className="font-mono text-xs" onFocus={(event) => event.target.select()} />
        <Button onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Works once and expires in 24 hours. It isn&apos;t shown again, but you can make a new one any time.</p>
      <DialogFooter><Button variant="outline" onClick={onClose}>Done</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function InviteDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (token: string, role: Role) => void }) {
  const [role, setRole] = useState<Role>("operator");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const { token } = await api<{ token: string }>("/api/users", { method: "POST", body: JSON.stringify({ role }) });
      onOpenChange(false);
      onCreated(token, role);
    } catch (error) { toast.error(errorMessage(error, "Couldn't create the invite.")); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader><DialogTitle>Invite someone</DialogTitle><DialogDescription>Pick what they can do. You&apos;ll get a link to send them; they choose their own username and password.</DialogDescription></DialogHeader>
      <div className="grid gap-2" role="radiogroup" aria-label="Role">
        {ROLES.map((item) => <button key={item} type="button" role="radio" aria-checked={role === item} onClick={() => setRole(item)}
          className={cn("rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", role === item ? "border-foreground/50 bg-accent" : "border-border hover:border-foreground/30")}>
          <span className="block text-sm font-medium">{ROLE_LABELS[item]}</span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{ROLE_DESCRIPTIONS[item]}</span>
        </button>)}
      </div>
      <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => void create()} disabled={busy}>Create invite link</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function UserActions({ user, onChanged, onLink }: { user: UserRow; onChanged: () => void; onLink: (link: CreatedLink) => void }) {
  const { track } = usePanel();
  const [confirm, setConfirm] = useState<"delete" | "disable" | "two-factor" | null>(null);
  const call = (key: string, work: () => Promise<void>) => track(`user:${user.id}:${key}`, async () => { await work(); onChanged(); });
  async function reset() {
    await call("reset", async () => {
      const { token } = await api<{ token: string }>(`/api/users/${user.id}`, { method: "POST", body: JSON.stringify({ action: "reset-link" }) });
      onLink({ title: `Password reset link for ${user.username}`, description: "Send this to them. Opening it lets them choose a new password, and signs them out everywhere.", url: `${window.location.origin}/invite/${token}` });
    });
  }
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${user.username}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => void reset()}><KeyRound />Reset password…</DropdownMenuItem>
        {user.twoFactor && !user.you && <DropdownMenuItem onSelect={() => setConfirm("two-factor")}><ShieldOff />Turn off two-factor…</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => void call("signout", async () => { await api(`/api/users/${user.id}`, { method: "POST", body: JSON.stringify({ action: "sign-out" }) }); toast.success(user.you ? "Signed out your other devices." : `${user.username} was signed out everywhere.`); })}><LogOut />Sign out everywhere</DropdownMenuItem>
        {!user.you && <>
          <DropdownMenuSeparator />
          {user.disabled
            ? <DropdownMenuItem onSelect={() => void call("enable", async () => { await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ disabled: false }) }); toast.success(`${user.username} can sign in again.`); })}><UserCheck />Enable account</DropdownMenuItem>
            : <DropdownMenuItem onSelect={() => setConfirm("disable")}><UserX />Disable account…</DropdownMenuItem>}
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirm("delete")}><Trash2 />Delete account…</DropdownMenuItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
    <ConfirmDialog open={confirm === "disable"} onOpenChange={(open) => !open && setConfirm(null)} title={`Disable ${user.username}?`} confirmLabel="Disable account"
      onConfirm={() => void call("disable", async () => { await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ disabled: true }) }); toast.success(`${user.username} is disabled and was signed out.`); })}>
      <p>They&apos;re signed out right away and can&apos;t sign in until you enable the account again. Their name stays in the activity log.</p>
    </ConfirmDialog>
    <ConfirmDialog open={confirm === "two-factor"} onOpenChange={(open) => !open && setConfirm(null)} title={`Turn off two-factor sign-in for ${user.username}?`} confirmLabel="Turn off"
      onConfirm={() => void call("two-factor", async () => { await api(`/api/users/${user.id}`, { method: "POST", body: JSON.stringify({ action: "disable-two-factor" }) }); toast.success(`${user.username} can sign in with just their password now.`); })}>
      <p>For when they&apos;ve lost their phone and their recovery codes. Make sure it&apos;s really them asking. They can turn it back on from their account page.</p>
    </ConfirmDialog>
    <ConfirmDialog open={confirm === "delete"} onOpenChange={(open) => !open && setConfirm(null)} title={`Delete ${user.username}?`} confirmLabel="Delete account" destructive
      onConfirm={() => void call("delete", async () => { await api(`/api/users/${user.id}`, { method: "DELETE" }); toast.success(`${user.username} was deleted.`); })}>
      <p>They&apos;re signed out and the account is removed. Past activity still shows their name. To let them back in later, send a new invite.</p>
    </ConfirmDialog>
  </>;
}

function RoleSelect({ user, onChanged }: { user: UserRow; onChanged: () => void }) {
  const { track } = usePanel();
  if (user.you) return <RoleBadge role={user.role} />;
  return <Select value={user.role} onValueChange={(role) => void track(`user:${user.id}:role`, async () => {
    await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ role }) });
    toast.success(`${user.username} is now ${role === "viewer" ? "a" : "an"} ${ROLE_LABELS[role as Role]}. They'll need to sign in again.`);
    onChanged();
  })}>
    <SelectTrigger size="sm" className="w-32" aria-label={`Role for ${user.username}`}><SelectValue /></SelectTrigger>
    <SelectContent>{ROLES.map((role) => <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>)}</SelectContent>
  </Select>;
}

export function UsersPage() {
  const { me } = usePanel();
  const now = useNow(30_000);
  const [data, setData] = useState<UsersData | null>(null);
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<CreatedLink | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<UsersData>("/api/users")); setError(""); }
    catch (reason) { setError(errorMessage(reason, "Couldn't load users.")); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function revoke(invite: InviteRow) {
    try { await api(`/api/invites/${invite.id}`, { method: "DELETE" }); toast.success("Link revoked."); void load(); }
    catch (reason) { toast.error(errorMessage(reason, "Couldn't revoke the link.")); }
  }

  return <div className="space-y-6">
    <PageHeading eyebrow="Access" title="Users" description="Everyone who can sign in to this panel, and what they can do."
      actions={<Button onClick={() => setInviting(true)}><Plus />Invite someone</Button>} />
    {me?.recovery && <p role="status" className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">You&apos;re using a recovery sign-in, which lasts one hour. Reset your account&apos;s password or re-enable it here, then sign in normally.</p>}
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-destructive">{error}</p>}

    <Section title="People" description="Changing someone's role or disabling them signs them out right away.">
      {!data ? <Skeleton className="h-32" /> : <ul className="-mx-4 divide-y divide-border sm:-mx-5">
        {data.users.map((user) => <li key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{user.username}{user.you && <span className="text-xs font-normal text-muted-foreground">(you)</span>}{user.disabled && <span className="rounded-full border border-destructive/40 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">Disabled</span>}{user.twoFactor && <span className="rounded-full border border-success/40 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-success" title="Two-factor sign-in is on">2FA</span>}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{user.lastSeenAt ? `Active ${formatRelative(user.lastSeenAt, now)}` : user.lastLoginAt ? `Signed in ${formatRelative(user.lastLoginAt, now)}` : "Never signed in"} · joined {formatRelative(user.createdAt, now)}</p>
          </div>
          <RoleSelect user={user} onChanged={() => void load()} />
          <UserActions user={user} onChanged={() => void load()} onLink={setLink} />
        </li>)}
      </ul>}
    </Section>

    {data && data.invites.length > 0 && <Section title="Pending links" description="Invites and password resets that haven't been used yet.">
      <ul className="-mx-4 divide-y divide-border sm:-mx-5">
        {data.invites.map((invite) => <li key={invite.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="text-sm">{invite.kind === "invite" ? <>Invite as <span className="font-medium">{invite.role ? ROLE_LABELS[invite.role] : ""}</span></> : <>Password reset for <span className="font-medium">{invite.username}</span></>}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Made by {invite.createdBy} {formatRelative(invite.createdAt, now)} · expires {formatRelative(invite.expiresAt, now)}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void revoke(invite)}>Revoke</Button>
        </li>)}
      </ul>
    </Section>}

    {data && data.audit.length > 0 && <Section title="Account activity" description="Sign-ups, role changes, resets, and recovery sign-ins.">
      <ul className="space-y-2 text-sm">
        {data.audit.map((entry) => <li key={entry.id} className="flex gap-3"><span className="w-24 shrink-0 text-xs text-muted-foreground">{formatRelative(entry.at, now)}</span><span><span className="font-medium">{entry.actor}</span> · {entry.message}</span></li>)}
      </ul>
    </Section>}

    <InviteDialog open={inviting} onOpenChange={setInviting} onCreated={(token, role) => { void load(); setLink({ title: `Invite link for a new ${ROLE_LABELS[role]}`, description: "Send this to the person you're inviting. They'll choose their own username and password.", url: `${window.location.origin}/invite/${token}` }); }} />
    <LinkDialog link={link} onClose={() => setLink(null)} />
  </div>;
}
