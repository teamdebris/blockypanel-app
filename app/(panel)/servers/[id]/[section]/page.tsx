import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { ServerPage } from "@/components/panel/server-page";
import type { ServerTab } from "@/components/panel/types";

const tabs = new Set<ServerTab>(["console", "plugins", "backups", "files", "settings", "activity"]);

export default async function Page({ params }: { params: Promise<{ id: string; section: string }> }) {
  const { id, section } = await params;
  if (section === "backup") redirect(`/servers/${id}/backups`);
  if (!tabs.has(section as ServerTab)) notFound();
  // The Files tab reads the folder from the URL (?path=), which needs a Suspense boundary.
  return <Suspense><ServerPage serverId={id} tab={section as ServerTab} /></Suspense>;
}
