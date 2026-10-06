import type { Metadata } from "next";
import { BackupsPage } from "@/components/panel/backups-page";

export const metadata: Metadata = { title: "Backups — Blocky" };

export default function Page() {
  return <BackupsPage />;
}
