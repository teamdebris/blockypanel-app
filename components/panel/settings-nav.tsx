"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PageHeading } from "./common";
import { usePanel } from "./panel-context";

/** The heading and tabs shared by the Settings pages. */
export function SettingsNav() {
  const pathname = usePathname();
  const { can } = usePanel();
  const items = [
    { href: "/settings", label: "Your account", show: true },
    { href: "/settings/users", label: "Users", show: can.users },
    { href: "/settings/cloud", label: "Blocky Cloud", show: can.cloud },
  ].filter((item) => item.show);
  return <div>
    <PageHeading title="Settings" description="Your account, who can sign in, and Blocky Cloud." />
    {items.length > 1 && <nav aria-label="Settings sections" className="scrollbar-none -mt-2 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
      {items.map((item) => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}
        className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground">{item.label}</Link>)}
    </nav>}
  </div>;
}
