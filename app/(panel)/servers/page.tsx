import type { Metadata } from "next";
import { ServersPage } from "@/components/panel/servers-page";

export const metadata: Metadata = { title: "All servers — Blocky" };

export default function Page() {
  return <ServersPage />;
}
