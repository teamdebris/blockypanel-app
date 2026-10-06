import { PanelProvider } from "@/components/panel/panel-context";
import { PanelShell } from "@/components/panel/shell";

// One provider for every panel page, so server data, polling, and history survive navigation between
// pages and tabs (tabs are real links, so Back, middle-click, and deep links all work).
export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return <PanelProvider><PanelShell>{children}</PanelShell></PanelProvider>;
}
