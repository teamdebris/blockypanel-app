import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { accounts, type Viewer, viewerForToken } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { clientKey } from "@/lib/rate-limit";
import { type Role, roleAtLeast } from "@/lib/roles";
import { COOKIE_NAME, recoveryKey, sessionCookieOptions } from "@/lib/session";

/** The signed-in person for this request, or undefined. The proxy has already enforced access. */
export async function currentViewer(): Promise<Viewer | undefined> {
  try { return await viewerForToken((await cookies()).get(COOKIE_NAME)?.value); }
  catch { return undefined; } // Outside a request (scheduler).
}

export async function requireViewer(minimum: Role = "viewer") {
  const viewer = await currentViewer();
  if (!viewer) throw new HttpError(401, "Your session ended. Sign in again.");
  if (!roleAtLeast(viewer.role, minimum)) throw new HttpError(403, "Your role doesn't allow that.");
  return viewer;
}

/** Browser and address to show in the sessions list. The address is only known behind a trusted proxy. */
function requestDetails(request: Request) {
  const client = clientKey(request.headers);
  return { userAgent: request.headers.get("user-agent") || "", ip: client === "direct" || client === "unknown" ? "" : client };
}

/**
 * Whether the browser reached the panel over HTTPS, directly or through a trusted reverse proxy.
 * Session cookies are marked Secure then even without BLOCKY_COOKIE_SECURE.
 */
function overHttps(request: Request) {
  if (new URL(request.url).protocol === "https:") return true;
  return process.env.BLOCKY_TRUST_PROXY === "true" && request.headers.get("x-forwarded-proto")?.split(",").at(-1)?.trim() === "https";
}

/** Starts a session and sets its cookie on `response`. */
export async function signIn(response: NextResponse, request: Request, options: { userId: string | null; recovery?: boolean; persistent: boolean }) {
  const { token, maxAgeSeconds } = (await accounts()).createSession({ ...options, recoveryKey: options.recovery ? recoveryKey() : undefined, ...requestDetails(request) });
  response.cookies.set(COOKIE_NAME, token, { ...sessionCookieOptions(options.persistent && !options.recovery ? maxAgeSeconds : undefined), ...(overHttps(request) ? { secure: true } : {}) });
  return response;
}
