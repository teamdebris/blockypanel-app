import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export const cn = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

/* ---------- Toasts ---------- */
type Toast = { id: number; text: string; tone: "ok" | "error" };
export let pushToast: (text: string, tone?: Toast["tone"]) => void = () => undefined;
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    pushToast = (text, tone = "ok") => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list, { id, text, tone }]);
      setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), 4500);
    };
  }, []);
  return <div className="fixed right-6 top-6 z-50 grid w-80 gap-2" role="status" aria-live="polite">
    {toasts.map((toast) => <div key={toast.id} className={cn("rounded-xl border px-4 py-3 text-sm shadow-card", toast.tone === "error" ? "border-destructive/30 bg-danger-soft text-danger-soft-foreground" : "border-border bg-card")}>{toast.text}</div>)}
  </div>;
}
export const run = async (work: () => Promise<unknown>, success?: string) => {
  try { await work(); if (success) pushToast(success); }
  catch (error) { pushToast(error instanceof Error ? error.message : "Something went wrong.", "error"); }
};

export function Section({ title, description, actions, children, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-xl border border-border bg-card shadow-card", className)}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3.5">
      <div className="min-w-0"><h2 className="text-sm font-semibold">{title}</h2>{description && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    <div className="p-5">{children}</div>
  </section>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid content-start gap-1.5 text-sm font-medium">{label}{children}{hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}</label>;
}
export function Dialog({ title, children, footer, onClose, wide = false }: { title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const modal = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = modal.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={modal} aria-label={title} className="fixed inset-0 m-0 grid h-dvh max-h-none w-dvw max-w-none place-items-center bg-black/50 p-4 text-foreground backdrop:bg-transparent" onCancel={(event) => { event.preventDefault(); onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={cn("max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-2xl border border-border bg-popover p-6 shadow-2xl", wide ? "max-w-5xl" : "max-w-lg")}>
      <div className="mb-4 flex items-start justify-between gap-3"><h2 className="text-lg font-semibold">{title}</h2><button className="btn btn-ghost btn-sm -mr-2 -mt-1" aria-label="Close" onClick={onClose}><X /></button></div>
      {children}
      <div className="mt-6 flex justify-end gap-2">{footer}</div>
    </div>
  </dialog>;
}
