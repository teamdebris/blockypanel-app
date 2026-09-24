import type { Metadata } from "next";
import { OffsitePage } from "@/components/panel/offsite-page";

export const metadata: Metadata = { title: "Offsite backups — Blocky" };

export default function Page() {
  return <OffsitePage />;
}
