import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { ServerPage } from "@/components/panel/server-page";
import { SERVER_TABS, type ServerTab } from "@/components/panel/types";

// Every tab except the overview, which lives at /servers/[id]. Derived from the list, so a new tab can't be left out.
const tabs = new Set<ServerTab>(SERVER_TABS.filter((tab) => tab !== "overview"));

export default async function Page({ params }: { params: Promise<{ id: string; section: string }> }) {
  const { id, section } = await params;
  if (section === "backup") redirect(`/servers/${id}/backups`);
  if (!tabs.has(section as ServerTab)) notFound();
  // The Files tab reads the folder from the URL (?path=), which needs a Suspense boundary.
  return <Suspense><ServerPage serverId={id} tab={section as ServerTab} /></Suspense>;
}
