"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { blockArt, SERVER_ICON_LABELS, SERVER_ICONS, serverIcon, type ServerIcon } from "@/lib/server-icons";
import { cn } from "@/lib/utils";
import { api, errorMessage } from "./lib";
import { usePanel } from "./panel-context";
import type { MinecraftServer } from "./types";

/** Block art: a server's icon, or a chest standing for backups. Decorative; the text next to it says what it is. */
export function BlockArt({ name, className }: { name: Parameters<typeof blockArt>[0]; className?: string }) {
  // The near-black ones get a faint rim on the dark theme, or they vanish into it.
  const dim = name === "enderman" || name === "chest-ender" || name === "obsidian";
  // eslint-disable-next-line @next/next/no-img-element -- a tiny static SVG; next/image adds nothing here
  return <img src={blockArt(name)} alt="" aria-hidden draggable={false} className={cn("shrink-0 select-none", dim && "dark:drop-shadow-[0_0_1.5px_rgba(255,255,255,0.45)]", className)} />;
}

export function ServerIconImage({ server, className }: { server: Pick<MinecraftServer, "id" | "icon">; className?: string }) {
  return <BlockArt name={serverIcon(server)} className={className} />;
}

/** The server's icon; admins can click it to pick another. */
export function ServerIconButton({ server, className }: { server: MinecraftServer; className?: string }) {
  const { can } = usePanel();
  const [open, setOpen] = useState(false);
  if (!can.manage) return <ServerIconImage server={server} className={className} />;
  return <>
    <button type="button" onClick={() => setOpen(true)} title="Change icon" aria-label={`Change ${server.name}'s icon`}
      className="group relative shrink-0 rounded-lg outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring">
      <ServerIconImage server={server} className={className} />
    </button>
    <ServerIconPicker server={server} open={open} onOpenChange={setOpen} />
  </>;
}

/**
 * Every icon to pick from, saved the moment one is clicked (it never restarts anything). The dialog
 * shows labels under each; the settings page shows a compact grid of 8 across.
 */
export function ServerIconGrid({ server, compact, onPicked }: { server: MinecraftServer; compact?: boolean; onPicked?: () => void }) {
  const { track, isPending, can } = usePanel();
  const current = serverIcon(server);
  const pick = (icon: ServerIcon) => icon !== current && void track(`${server.id}:icon`, async () => {
    try {
      await api(`/api/servers/${server.id}/icon`, { method: "PUT", body: JSON.stringify({ icon }) });
      if (compact) toast.success(`Icon changed to ${SERVER_ICON_LABELS[icon].toLowerCase()}.`);
      onPicked?.();
    } catch (error) { toast.error(errorMessage(error, "Couldn't change the icon.")); }
  });
  const group = (title: string, icons: readonly ServerIcon[]) => <div>
    <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
    <div role="radiogroup" aria-label={title} className={cn("grid gap-2", compact ? "grid-cols-4 sm:grid-cols-8" : "grid-cols-4")}>
      {icons.map((icon) => <button key={icon} type="button" role="radio" aria-checked={icon === current} aria-label={SERVER_ICON_LABELS[icon]} title={SERVER_ICON_LABELS[icon]} disabled={!can.manage || isPending(`${server.id}:icon`)} onClick={() => pick(icon)}
        className={cn("flex flex-col items-center gap-1 rounded-xl border p-2 text-xs transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
          icon === current ? "border-primary bg-primary/10 font-medium" : "border-border")}>
        <BlockArt name={icon} className={compact ? "size-10" : "size-12"} />{!compact && SERVER_ICON_LABELS[icon]}
      </button>)}
    </div>
  </div>;
  return <div className="space-y-4">{group("Blocks", SERVER_ICONS.slice(0, 8))}{group("Mobs", SERVER_ICONS.slice(8))}</div>;
}

function ServerIconPicker({ server, open, onOpenChange }: { server: MinecraftServer; open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>Icon for {server.name}</DialogTitle><DialogDescription>Shown wherever the server is listed. Changing it doesn&apos;t restart anything.</DialogDescription></DialogHeader>
      <ServerIconGrid server={server} onPicked={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>;
}
