import type { Metadata } from "next";
import { AccountPage } from "@/components/panel/account-page";

export const metadata: Metadata = { title: "Settings — Blocky" };

export default function Page() {
  return <AccountPage />;
}
