import { NextRequest, NextResponse } from "next/server";
import { accounts, viewerForToken } from "@/lib/auth";
import { guardApiRequest } from "@/lib/request-guard";
import { pageAccess, roleAtLeast } from "@/lib/roles";
import { clearedCookie, COOKIE_NAME } from "@/lib/session";

function redirectTo(request: NextRequest, pathname: string, next?: string) {
  const url = new URL(pathname, request.url);
  url.search = "";
  if (next && next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

/**
 * Every request is checked against the permission table in lib/roles.ts: API routes and methods
 * that aren't listed are refused, and each listed one needs a session with at least its role.
 * Uploads (/api/uploads/) skip this file, because the proxy buffers at most 10 MB of a request
 * body; those routes run the same API checks themselves (lib/request-guard.ts).
 */
export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/api/")) return (await guardApiRequest(request)) ?? NextResponse.next();

  const access = pageAccess(pathname);
  let needsSetup = false;
  try { needsSetup = !(await accounts()).hasActiveAdmin(); }
  catch (error) {
    console.error("Blocky couldn't open its account database", error);
    return new NextResponse("The panel's account database is unavailable. Check the server log.", { status: 503 });
  }
  // A fresh install goes to first-run setup; once set up, the setup page isn't reachable.
  if (needsSetup && pathname !== "/setup") return redirectTo(request, "/setup");
  if (!needsSetup && pathname === "/setup") return redirectTo(request, "/login");

  if (access === "public") return NextResponse.next();

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const viewer = await viewerForToken(token);
  if (!viewer) {
    const response = redirectTo(request, "/login", pathname);
    if (token) response.cookies.set(COOKIE_NAME, "", clearedCookie);
    return response;
  }
  if (!roleAtLeast(viewer.role, access)) return redirectTo(request, "/");
  return NextResponse.next();
}

// api/uploads/ is left out on purpose: see above. Keep it in step with STREAMED_PREFIX in lib/request-guard.ts.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.svg|screenshots/|api/uploads/).*)"] };
