import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isWrongCredential } from "@/lib/account-store";
import { accounts, type Viewer, viewerForToken } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { beginPasswordCheck, clientKey, passwordRetryAfter, withCheckSlot } from "@/lib/rate-limit";
import { busy, tooManyAttempts } from "@/lib/responses";
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

/**
 * Runs a check of the signed-in user's own password (changing it, two-factor changes) like a login:
 * through the shared limit on password hashing, and against a per-account budget for wrong
 * passwords so a stolen session can't keep guessing. Returns the 429/503 to send when refused.
 */
export async function withPasswordCheck(userId: string, work: () => Promise<unknown>): Promise<NextResponse | undefined> {
  const wait = passwordRetryAfter(userId);
  if (wait) return tooManyAttempts(Math.ceil(wait / 1000));
  const attempt = beginPasswordCheck(userId);
  let done: true | undefined;
  try { done = await withCheckSlot(async () => { await work(); return true as const; }); }
  catch (error) {
    if (isWrongCredential(error)) await new Promise((resolve) => setTimeout(resolve, 750));
    else attempt.cancel();
    throw error;
  }
  if (!done) { attempt.cancel(); return busy(); }
  attempt.succeed();
  return undefined;
}

/** " from 203.0.113.9" for activity log entries, when a trusted proxy supplies the address. */
export function fromAddress(request: Request) {
  const { ip } = requestDetails(request);
  return ip ? ` from ${ip}` : "";
}
