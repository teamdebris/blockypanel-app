/**
 * The Content Security Policy for pages. Scripts need this request's nonce (Next.js adds it to its
 * own scripts, and the theme script gets it from the root layout), so an injected script can't run.
 * Styles allow inline: the UI's components set style attributes, which a nonce can't cover. Images
 * may come from any HTTPS address (plugin icons from Modrinth, player heads from mc-heads.net).
 *
 * No upgrade-insecure-requests: on a plain-HTTP LAN install it would send the panel's own scripts
 * to HTTPS, and the page would break.
 */
export function pagePolicy(nonce: string, dev = process.env.NODE_ENV === "development") {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A fresh, unguessable nonce for one response. */
export function newNonce() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}
