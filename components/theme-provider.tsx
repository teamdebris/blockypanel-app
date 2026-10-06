"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** `nonce` is this response's CSP nonce, so the inline script that applies the theme before paint may run. */
export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange nonce={nonce}>{children}</NextThemesProvider>;
}
