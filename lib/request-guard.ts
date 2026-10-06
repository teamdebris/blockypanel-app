import { NextRequest, NextResponse } from "next/server";
import { accounts, viewerForToken } from "@/lib/auth";
import { CSRF_HEADER } from "@/lib/csrf";
import { type Access, apiAccess, roleAtLeast } from "@/lib/roles";
import { clearedCookie, COOKIE_NAME } from "@/lib/session";

/**
 * The checks every API request passes: same-origin with the verification header, listed in the
 * permission table (lib/roles.ts), and a session with the role it needs. proxy.ts runs them for
 * every route. Upload routes skip the proxy, because it would buffer at most 10 MB of their body,
 * so they run these same checks themselves (see STREAMED_PREFIX).
 */

/** API routes under this prefix bypass proxy.ts so large bodies stream; each one calls guardApiRequest. */
export const STREAMED_PREFIX = "/api/uploads/";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function requestHost(request: Request) {
  if (process.env.BLOCKY_TRUST_PROXY === "true") return request.headers.get("x-forwarded-host") || request.headers.get("host");
  return request.headers.get("host");
}

/**
 * SameSite cookies still flow between "same-site" origins, and every port on the same host is the
 * same site, so a web map plugin or another app on this machine could otherwise submit requests.
 * State-changing API calls must come from this exact origin and carry a custom header, which a
 * cross-origin page can't add without a CORS preflight that this app never approves.
 */
export function crossOriginRejection(request: Request) {
  if (SAFE_METHODS.has(request.method)) return null;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return "Cross-origin requests are not allowed.";
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost = "";
    try { originHost = new URL(origin).host; } catch { /* malformed */ }
    if (!originHost || originHost !== requestHost(request)) return "Cross-origin requests are not allowed.";
  }
  if (request.headers.get(CSRF_HEADER) !== "1") return "Missing request verification header.";
  return null;
}

/** The session cookie, from a NextRequest's parsed cookies or a plain Request's Cookie header. */
function sessionCookie(request: Request) {
  const parsed = (request as Partial<NextRequest>).cookies?.get(COOKIE_NAME)?.value;
  if (parsed !== undefined) return parsed;
  const pair = request.headers.get("cookie")?.split(/;\s*/).find((item) => item.startsWith(`${COOKIE_NAME}=`));
  return pair ? decodeURIComponent(pair.slice(COOKIE_NAME.length + 1)) : undefined;
}

/** Runs the API checks. Returns the refusal to send, or null when the request may go ahead. */
export async function guardApiRequest(request: Request): Promise<NextResponse | null> {
  const rejection = crossOriginRejection(request);
  if (rejection) return NextResponse.json({ error: rejection }, { status: 403 });
  const access: Access | undefined = apiAccess((request as Partial<NextRequest>).nextUrl?.pathname ?? new URL(request.url).pathname, request.method);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  try { await accounts(); }
  catch (error) {
    console.error("Blocky couldn't open its account database", error);
    return NextResponse.json({ error: "The panel's account database is unavailable. Check the server log." }, { status: 503 });
  }
  if (access === "public") return null;
  const token = sessionCookie(request);
  const viewer = await viewerForToken(token);
  if (!viewer) {
    const response = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    if (token) response.cookies.set(COOKIE_NAME, "", clearedCookie);
    return response;
  }
  if (!roleAtLeast(viewer.role, access)) return NextResponse.json({ error: "Your role doesn't allow that." }, { status: 403 });
  return null;
}

/**
 * The same checks again, from inside a route handler. Every API route runs this first, so a route
 * stays protected even if proxy.ts didn't run for it (a matcher mistake, a framework change).
 * tests/route-guard.test.ts fails if a handler leaves it out.
 */
export async function guardRoute(request: Request) {
  // Not wrapped in a new NextRequest: the request objects Next.js hands route handlers can't be.
  return guardApiRequest(request);
}
