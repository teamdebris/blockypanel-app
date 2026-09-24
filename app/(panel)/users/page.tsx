import type { Metadata } from "next";
import { UsersPage } from "@/components/panel/users-page";

export const metadata: Metadata = { title: "Users — Blocky" };

export default function Page() {
  return <UsersPage />;
}
