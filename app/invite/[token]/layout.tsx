import type { Metadata } from "next";

export const metadata: Metadata = { title: "Join — Blocky", referrer: "no-referrer" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
