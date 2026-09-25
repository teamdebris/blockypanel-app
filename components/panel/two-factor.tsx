"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import qrcode from "qrcode-generator";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Field } from "./common";
import { api, ApiError, errorMessage } from "./lib";

type Status = { enabled: boolean; recoveryCodesLeft: number };

/** The otpauth link as a QR code, drawn as SVG squares. */
function QrCode({ text }: { text: string }) {
  const cells = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(text);
    code.make();
    const size = code.getModuleCount();
    const dark: [number, number][] = [];
    for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) if (code.isDark(row, col)) dark.push([col, row]);
    return { size, dark };
  }, [text]);
  const quiet = 4;
  const view = cells.size + quiet * 2;
  return <svg viewBox={`0 0 ${view} ${view}`} className="size-44 rounded-lg bg-white" role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
    <path fill="#000" d={cells.dark.map(([x, y]) => `M${x + quiet} ${y + quiet}h1v1h-1z`).join("")} />
  </svg>;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `Blocky Panel recovery codes (each works once)\n\n${codes.join("\n")}\n`;
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { toast.error("Couldn't copy. Select the codes and copy them manually."); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: "blocky-recovery-codes.txt" });
    link.click();
    URL.revokeObjectURL(url);
  }
  return <div className="space-y-3">
    <p className="text-sm">Save these recovery codes somewhere safe, like a password manager. <span className="font-medium">Each one signs you in once if you lose your phone.</span> They won&apos;t be shown again.</p>
    <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-border bg-muted/50 p-3 font-mono text-sm">{codes.map((code) => <li key={code}>{code}</li>)}</ul>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
      <Button type="button" variant="outline" size="sm" onClick={download}><Download />Download</Button>
      <Button type="button" size="sm" onClick={onDone}>I&apos;ve saved them</Button>
    </div>
  </div>;
}

function Setup({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => {
    let active = true;
    api<{ secret: string; uri: string }>("/api/auth/two-factor", { method: "POST", body: JSON.stringify({ action: "start" }) })
      .then((result) => { if (active) setSetup(result); })
      .catch((reason) => { toast.error(errorMessage(reason, "Couldn't start setup.")); onDone(); });
    return () => { active = false; };
  }, [onDone]);
  async function confirm(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { setCodes((await api<{ recoveryCodes: string[] }>("/api/auth/two-factor", { method: "POST", body: JSON.stringify({ action: "confirm", code }) })).recoveryCodes); }
    catch (reason) { setError(errorMessage(reason, "That code didn't work.")); }
    finally { setBusy(false); }
  }
  if (codes) return <RecoveryCodes codes={codes} onDone={() => { toast.success("Two-factor sign-in is on."); onDone(); }} />;
  if (!setup) return <Skeleton className="h-44" />;
  return <form onSubmit={(event) => void confirm(event)} className="space-y-4">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <QrCode text={setup.uri} />
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <p><span className="font-medium">1.</span> In your authenticator app, add an account and scan this code.</p>
        <p className="text-xs text-muted-foreground">Can&apos;t scan? Enter this key instead:</p>
        <p className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">{setup.secret.match(/.{1,4}/g)?.join(" ")}</p>
        <p><span className="font-medium">2.</span> Enter the 6-digit code it shows.</p>
      </div>
    </div>
    <Field label="Code" id="two-factor-code" error={error}>{(props) => <Input {...props} value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} className="w-36 font-mono tracking-widest" autoFocus />}</Field>
    <div className="flex gap-2"><Button type="submit" disabled={busy || code.replace(/\s/g, "").length < 6}>Turn on</Button><Button type="button" variant="ghost" onClick={onDone}>Cancel</Button></div>
  </form>;
}

function PasswordDialog({ title, description, confirmLabel, open, onOpenChange, onConfirm }: { title: string; description: string; confirmLabel: string; open: boolean; onOpenChange: (open: boolean) => void; onConfirm: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await onConfirm(password); setPassword(""); onOpenChange(false); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : errorMessage(reason, "That didn't work.")); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={(next) => { if (!next) { setPassword(""); setError(""); } onOpenChange(next); }}>
    <DialogContent>
      <form onSubmit={(event) => void submit(event)} className="grid gap-4">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <Field label="Your password" id="two-factor-password" error={error}>{(props) => <Input {...props} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus />}</Field>
        <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !password}>{confirmLabel}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function TwoFactorSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [dialog, setDialog] = useState<"off" | "codes" | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const load = useCallback(async () => {
    try { setStatus(await api<Status>("/api/auth/two-factor")); } catch { setStatus({ enabled: false, recoveryCodesLeft: 0 }); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const finishSetup = useCallback(() => { setSettingUp(false); void load(); }, [load]);
  if (!status) return <Skeleton className="h-20" />;
  if (codes) return <RecoveryCodes codes={codes} onDone={() => { setCodes(null); void load(); }} />;
  if (!status.enabled) return settingUp ? <Setup onDone={finishSetup} /> : <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Off. Turn it on to ask for a code from an authenticator app (like Google Authenticator, 1Password, or Authy) after your password. Someone who learns your password still can&apos;t sign in.</p>
    <Button onClick={() => setSettingUp(true)}><ShieldCheck />Turn on two-factor sign-in</Button>
  </div>;
  return <div className="space-y-3">
    <p className="flex items-center gap-1.5 text-sm"><ShieldCheck className="size-4 text-success" /><span className="font-medium">On.</span><span className="text-muted-foreground">{status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? "" : "s"} left.</span></p>
    {status.recoveryCodesLeft <= 3 && <p className="text-xs text-warning">You&apos;re running low on recovery codes. Make new ones so you can still get in if you lose your phone.</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => setDialog("codes")}><KeyRound />New recovery codes</Button>
      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}><ShieldOff />Turn off</Button>
    </div>
    <PasswordDialog open={dialog === "codes"} onOpenChange={(open) => !open && setDialog(null)} title="Make new recovery codes?" description="Your current recovery codes stop working." confirmLabel="Make new codes"
      onConfirm={async (password) => { setCodes((await api<{ recoveryCodes: string[] }>("/api/auth/two-factor", { method: "POST", body: JSON.stringify({ action: "recovery-codes", password }) })).recoveryCodes); }} />
    <PasswordDialog open={dialog === "off"} onOpenChange={(open) => !open && setDialog(null)} title="Turn off two-factor sign-in?" description="Signing in will only need your password again. Your recovery codes stop working." confirmLabel="Turn off"
      onConfirm={async (password) => { await api("/api/auth/two-factor", { method: "DELETE", body: JSON.stringify({ password }) }); toast.success("Two-factor sign-in is off."); await load(); }} />
  </div>;
}
