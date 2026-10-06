import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError } from "@/lib/errors";

/**
 * `publicRoute` is for routes anyone can call (sign-in, invite links, setup): an unexpected error's
 * own message could describe the server to a stranger, so they get a generic one instead.
 */
export function apiError(error: unknown, options: { publicRoute?: boolean } = {}) {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    // `field` lets forms highlight the input that failed instead of only showing a toast.
    return NextResponse.json({ error: issue?.message || "Invalid request.", field: issue?.path.join(".") || undefined }, { status: 400 });
  }
  // Matched by name: the account store is shared with tests through relative imports, so the
  // bundle can hold two copies of the class and `instanceof` isn't reliable.
  if (error instanceof Error && error.name === "AccountError") {
    const { status, field } = error as Error & { status: number; field?: string };
    return NextResponse.json({ error: error.message, field }, { status });
  }
  // By name too: lib/json-body.ts imports errors.ts relatively (it's used by tests).
  if (error instanceof Error && error.name === "HttpError") return NextResponse.json({ error: error.message, field: "field" in error ? error.field : undefined }, { status: (error as HttpError).status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  // Unexpected failures are usually Docker or restic errors. On signed-in routes the message is
  // still useful to show; the stack stays in the server log.
  console.error("Blocky request failed", error);
  const message = options.publicRoute ? "Something went wrong. Try again." : error instanceof Error ? error.message : "Unexpected server error.";
  return NextResponse.json({ error: message }, { status: 500 });
}

/** 429 with Retry-After (seconds), for login and other attempt limits. */
export function tooManyAttempts(retryAfter: number) {
  return NextResponse.json({ error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute${retryAfter > 60 ? "s" : ""}.`, retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
}

/** 503 when every password-check slot is taken (withCheckSlot in lib/rate-limit.ts). */
export function busy(message = "The panel is busy checking other passwords. Try again in a few seconds.") {
  return NextResponse.json({ error: message }, { status: 503, headers: { "Retry-After": "5" } });
}
