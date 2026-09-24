"use client";

import { useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, LoaderCircle, PauseCircle, Square } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { usePanel } from "./panel-context";
import { readableStatus, serverAddress } from "./lib";
import type { MinecraftServer } from "./types";

const statusStyles = {
  running: { icon: CheckCircle2, className: "border-success/30 bg-success-soft text-success" },
  starting: { icon: LoaderCircle, className: "border-warning/30 bg-warning-soft text-warning" },
  stopped: { icon: Square, className: "border-border bg-muted text-muted-foreground" },
  failed: { icon: AlertTriangle, className: "border-destructive/30 bg-danger-soft text-destructive" },
} as const;

/** Status as text plus an icon, so it never relies on color alone. */
export function StatusPill({ server, className }: { server: MinecraftServer; className?: string }) {
  const busy = Boolean(server.operation);
  const state = busy ? statusStyles.starting : statusStyles[server.health === "unhealthy" ? "failed" : server.status];
  const Icon = server.health === "paused" ? PauseCircle : state.icon;
  return <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", state.className, className)}>
    <Icon className={cn("size-3.5 shrink-0", (busy || server.status === "starting") && "animate-spin")} aria-hidden />
    <span className="truncate">{readableStatus(server)}</span>
  </span>;
}

export function CopyAddress({ port, compact = false, className, minecraft = true }: { port: number; compact?: boolean; className?: string; minecraft?: boolean }) {
  const { system } = usePanel();
  const [copied, setCopied] = useState(false);
  const address = serverAddress(port, system?.publicHost, minecraft);
  async function copy(event: React.MouseEvent) {
    event.preventDefault(); event.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true); toast.success("Address copied", { description: address });
      window.setTimeout(() => setCopied(false), 1500);
    } catch { toast.error("Couldn't copy. Select the address and copy it manually."); }
  }
  return <button type="button" onClick={copy} className={cn("group inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 font-mono text-xs text-foreground hover:bg-accent", className)} aria-label={`Copy server address ${address}`}>
    <span className="truncate">{address}</span>
    {copied ? <Check className="size-3.5 shrink-0 text-success" /> : <Copy className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />}
    {!compact && <span className="sr-only">Copy</span>}
  </button>;
}

/** Label + control + hint/error, wired together for screen readers. */
export function Field({ label, id, children, wide = false, hint, error }: { label: React.ReactNode; id: string; children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => React.ReactNode; wide?: boolean; hint?: React.ReactNode; error?: string }) {
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return <div className={cn("field", wide && "sm:col-span-2")}>
    <Label htmlFor={id}>{label}</Label>
    {children({ id, "aria-describedby": described, "aria-invalid": error ? true : undefined })}
    {error ? <p id={`${id}-error`} className="field-error" role="alert">{error}</p> : null}
    {hint ? <p id={`${id}-hint`} className="field-hint">{hint}</p> : null}
  </div>;
}

export function Sparkline({ values, max, className, label }: { values: number[]; max?: number; className?: string; label: string }) {
  if (values.length < 2) return <div className={cn("h-8", className)} aria-hidden />;
  const top = Math.max(max ?? 0, ...values, 1);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${30 - (value / top) * 28}`).join(" ");
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-8 w-full text-foreground/60", className)} role="img" aria-label={label}>
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
  </svg>;
}

export function UsageBar({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
    <div className={cn("h-full rounded-full", percent > 90 ? "bg-destructive" : percent > 75 ? "bg-warning" : "bg-foreground/70")} style={{ width: `${percent}%` }} />
  </div>;
}

type ConfirmProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
  /** When set, the user must type this text to enable the confirm button. */
  typeToConfirm?: string;
};

export function ConfirmDialog({ open, onOpenChange, title, children, confirmLabel, onConfirm, destructive = false, typeToConfirm }: ConfirmProps) {
  const [typed, setTyped] = useState("");
  const blocked = Boolean(typeToConfirm) && typed.trim() !== typeToConfirm;
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next) setTyped(""); onOpenChange(next); }}>
    <AlertDialogContent className="border-border bg-popover text-foreground">
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild><div className="space-y-2 text-sm text-muted-foreground">{children}</div></AlertDialogDescription>
      </AlertDialogHeader>
      {typeToConfirm && <div className="field"><Label htmlFor="type-to-confirm">Type <span className="font-mono text-foreground">{typeToConfirm}</span> to confirm</Label><Input id="type-to-confirm" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} /></div>}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction className={cn(destructive && "bg-destructive text-white hover:bg-destructive/90")} disabled={blocked} onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export function PageHeading({ eyebrow, title, description, actions, id = "page-title" }: { eyebrow?: string; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; id?: string }) {
  return <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
    <div className="min-w-0">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1 id={id} tabIndex={-1} className="font-display mt-1 text-2xl font-bold tracking-[-.035em] outline-none sm:text-3xl">{title}</h1>
      {description && <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>;
}

export function Section({ title, description, actions, children, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-xl border border-border bg-card", className)}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
      <div className="min-w-0"><h2 className="text-sm font-semibold">{title}</h2>{description && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    <div className="p-4 sm:p-5">{children}</div>
  </section>;
}
