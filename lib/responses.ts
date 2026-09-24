import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError } from "@/lib/errors";

export function apiError(error: unknown) {
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
  if (error instanceof HttpError) return NextResponse.json({ error: error.message, field: "field" in error ? error.field : undefined }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  // Unexpected failures are usually Docker or restic errors. Everyone who can reach this is a
  // signed-in panel user, so the message is still useful to show; the stack stays in the server log.
  console.error("Blocky request failed", error);
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return NextResponse.json({ error: message }, { status: 500 });
}
