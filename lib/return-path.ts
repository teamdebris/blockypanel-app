/** Returns `value` only when it is a same-origin relative path; `//evil.example` and `/\evil.example` fall back to "/". */
export function safeReturnPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  let url: URL;
  try { url = new URL(value, "https://blocky.local"); } catch { return "/"; }
  if (url.origin !== "https://blocky.local" || url.pathname === "/login") return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
