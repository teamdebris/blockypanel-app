import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blocky Panel",
  description: "A self-hosted control panel for Minecraft servers on Docker.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#ffffff" }, { media: "(prefers-color-scheme: dark)", color: "#151b21" }],
};

// Reading the request's nonce (set by proxy.ts for the Content Security Policy) renders every page
// per request, which nonces need.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // next-themes sets the theme class before hydration, so the attribute differs from the server render.
    <html lang="en" suppressHydrationWarning>
      <body><ThemeProvider nonce={(await headers()).get("x-nonce") ?? undefined}>{children}</ThemeProvider></body>
    </html>
  );
}
