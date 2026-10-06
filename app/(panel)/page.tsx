import type { Metadata } from "next";
import { OverviewPage } from "@/components/panel/overview-page";

export const metadata: Metadata = { title: "Overview — Blocky" };

export default function HomePage() {
  return <OverviewPage />;
}
