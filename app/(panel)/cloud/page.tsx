import type { Metadata } from "next";
import { CloudPage } from "@/components/panel/cloud-page";

export const metadata: Metadata = { title: "Blocky Cloud — Blocky" };

export default function Page() {
  return <CloudPage />;
}
