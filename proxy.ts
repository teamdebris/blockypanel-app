import { NextRequest, NextResponse } from "next/server";
import { accounts, viewerForToken } from "@/lib/auth";
import { CSRF_HEADER } from "@/lib/csrf";
import { type Access, apiAccess, pageAccess, roleAtLeast } from "@/lib/roles";
import { clearedCookie, COOKIE_NAME } from "@/lib/session";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function requestHost(request: NextRequest) {
  if (process.env.BLOCKY_TRUST_PROXY === "true") return request.headers.get("x-forwarded-host") || request.headers.get("host");
  return request.headers.get("host");
}

/**
 * SameSite cookies still flow between "same-site" origins, and every port on the same host is the
 * same site, so a web map plugin or another app on this machine could otherwise submit requests.
 * State-changing API calls must come from this exact origin and carry a custom header, which a
 * cross-origin page can't add without a CORS preflight that this app never approves.
 */
function crossOriginRejection(request: NextRequest) {
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

function redirectTo(request: NextRequest, pathname: string, next?: string) {
  const url = new URL(pathname, request.url);
  url.search = "";
  if (next && next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

/**
 * Every request is checked against the permission table in lib/roles.ts: API routes and methods
 * that aren't listed are refused, and each listed one needs a session with at least its role.
 */
export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const api = pathname.startsWith("/api/");
  if (api) {
    const rejection = crossOriginRejection(request);
    if (rejection) return NextResponse.json({ error: rejection }, { status: 403 });
  }

  const access: Access | undefined = api ? apiAccess(pathname, request.method) : pageAccess(pathname);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let needsSetup = false;
  try { needsSetup = !(await accounts()).hasActiveAdmin(); }
  catch (error) {
    console.error("Blocky couldn't open its account database", error);
    return api ? NextResponse.json({ error: "The panel's account database is unavailable. Check the server log." }, { status: 503 }) : new NextResponse("The panel's account database is unavailable. Check the server log.", { status: 503 });
  }
  // A fresh install goes to first-run setup; once set up, the setup page isn't reachable.
  if (!api && needsSetup && pathname !== "/setup") return redirectTo(request, "/setup");
  if (!api && !needsSetup && pathname === "/setup") return redirectTo(request, "/login");

  if (access === "public") return NextResponse.next();

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const viewer = await viewerForToken(token);
  if (!viewer) {
    const response = api ? NextResponse.json({ error: "Sign in to continue." }, { status: 401 }) : redirectTo(request, "/login", pathname);
    if (token) response.cookies.set(COOKIE_NAME, "", clearedCookie);
    return response;
  }
  if (!roleAtLeast(viewer.role, access)) {
    return api ? NextResponse.json({ error: "Your role doesn't allow that." }, { status: 403 }) : redirectTo(request, "/");
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.svg|screenshots/).*)"] };
