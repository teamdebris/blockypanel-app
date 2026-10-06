import { SettingsNav } from "@/components/panel/settings-nav";

/** Settings: your account, users, and Blocky Cloud, under one heading with tabs. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">
    <SettingsNav />
    {children}
  </div>;
}
