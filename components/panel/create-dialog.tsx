"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ApiError, api, errorMessage, initialForm, nextFreePort, serverHref, toPayload } from "./lib";
import { usePanel } from "./panel-context";
import { AdvancedFields, BasicFields, type FieldErrors, validateForm } from "./server-form";
import type { MinecraftServer, ServerForm } from "./types";

const fieldIds: Partial<Record<keyof ServerForm, string>> = { maxPlayers: "players", customProperties: "properties", cpuLimit: "cpu" };

function focusFirstError(prefix: string, keys: string[], map: (key: string) => string = (key) => key) {
  if (!keys.length) return;
  document.querySelectorAll<HTMLDetailsElement>(`#${prefix}-form details`).forEach((details) => { if (details.querySelector(`[aria-invalid="true"]`)) details.open = true; });
  window.setTimeout(() => {
    const target = document.getElementById(`${prefix}-${map(keys[0])}`);
    target?.closest("details")?.setAttribute("open", "");
    target?.focus();
  }, 0);
}

function useCreated() {
  const { setCreateOpen, refresh, announceServer } = usePanel();
  const router = useRouter();
  return (created: MinecraftServer, note: string) => {
    announceServer(created);
    toast.success(`${created.name} is being set up`, { description: note });
    setCreateOpen(false);
    void refresh();
    router.push(serverHref(created.id, "console"));
  };
}

function MinecraftForm() {
  const { setCreateOpen, servers } = usePanel();
  const created = useCreated();
  // Suggest the next free port so a second server doesn't collide with the first.
  const [form, setForm] = useState<ServerForm>(() => ({ ...initialForm, port: String(nextFreePort(servers)) }));
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = { ...(submitted ? validateForm(form, servers) : {}), ...serverErrors };
  function update(next: ServerForm) { setForm(next); setServerErrors({}); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    const problems = Object.keys(validateForm(form, servers));
    if (problems.length) return focusFirstError("create", problems, (key) => fieldIds[key as keyof ServerForm] || key);
    setBusy(true);
    try { created(await api<MinecraftServer>("/api/servers", { method: "POST", body: JSON.stringify(toPayload(form)) }), "The first start downloads Minecraft and can take a few minutes. Follow along in the console."); }
    catch (error) {
      if (error instanceof ApiError && error.field) setServerErrors({ [error.field]: error.message });
      else toast.error(errorMessage(error, "Server creation failed."));
    } finally { setBusy(false); }
  }
  return <form id="create-form" onSubmit={submit} className="flex min-h-0 flex-1 flex-col" noValidate>
    <DialogHeader className="border-b border-border px-5 py-4 text-left sm:px-6">
      <DialogTitle className="font-display text-xl">New Minecraft server</DialogTitle>
      <DialogDescription>Pick the basics. Everything else has sensible defaults and can be changed later.</DialogDescription>
    </DialogHeader>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <BasicFields form={form} setForm={update} errors={errors} idPrefix="create" servers={servers} creating />
        <AdvancedFields form={form} setForm={update} errors={errors} idPrefix="create" servers={servers} creating />
      </div>
      <div className="mt-5 flex items-start gap-3 rounded-xl border border-border bg-muted/50 p-4">
        <Checkbox id="create-eula" checked={form.eula} onCheckedChange={(value) => setForm({ ...form, eula: value === true })} aria-describedby="create-eula-hint" />
        <div><Label htmlFor="create-eula" className="font-normal leading-5">I accept the Minecraft End User License Agreement.</Label>
          <p id="create-eula-hint" className="field-hint mt-1">Required by Mojang to run a server. <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Read the EULA</a></p></div>
      </div>
    </div>
    <DialogFooter className="pb-safe border-t border-border bg-popover px-5 py-3 sm:px-6">
      <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
      <Button type="submit" disabled={!form.eula || busy}>{busy && <LoaderCircle className="animate-spin" />}{form.eula ? "Create server" : "Accept the EULA to continue"}</Button>
    </DialogFooter>
  </form>;
}

export function CreateServerDialog() {
  const { createOpen, setCreateOpen } = usePanel();
  return <Dialog open={createOpen} onOpenChange={setCreateOpen}>
    <DialogContent className="dialog-sheet-mobile flex max-h-[92vh] flex-col gap-0 overflow-hidden border-border bg-popover p-0 text-foreground sm:max-w-2xl">
      {/* Mounted only while open, so every opening starts with a fresh form. */}
      {createOpen && <MinecraftForm />}
    </DialogContent>
  </Dialog>;
}
