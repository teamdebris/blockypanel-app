import { NextRequest, NextResponse } from "next/server";
import { accounts, viewerForToken } from "@/lib/auth";
import { guardApiRequest } from "@/lib/request-guard";
import { pageAccess, roleAtLeast } from "@/lib/roles";
import { clearedCookie, COOKIE_NAME } from "@/lib/session";
import { newNonce, pagePolicy } from "@/lib/csp";

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

  // Pages get a Content Security Policy with a fresh nonce; Next.js reads it from the request
  // headers and puts it on its scripts (lib/csp.ts).
  const nonce = newNonce();
  const policy = pagePolicy(nonce);
  const pageHeaders = new Headers(request.headers);
  pageHeaders.set("x-nonce", nonce);
  pageHeaders.set("Content-Security-Policy", policy);
  const render = () => {
    const response = NextResponse.next({ request: { headers: pageHeaders } });
    response.headers.set("Content-Security-Policy", policy);
    return response;
  };

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

  if (access === "public") return render();

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const viewer = await viewerForToken(token);
  if (!viewer) {
    const response = redirectTo(request, "/login", pathname);
    if (token) response.cookies.set(COOKIE_NAME, "", clearedCookie);
    return response;
  }
  if (!roleAtLeast(viewer.role, access)) return redirectTo(request, "/");
  return render();
}

// api/uploads/ is left out on purpose: see above. Keep it in step with STREAMED_PREFIX in lib/request-guard.ts.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.svg|apple-touch-icon.png|brand/|screenshots/|api/uploads/).*)"] };
