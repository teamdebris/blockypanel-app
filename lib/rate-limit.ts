const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED = 10_000;

/** Failures in a sliding-ish window per key; `limit` failures block the key until the window ends. */
class Limiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs = WINDOW_MS) { this.limit = limit; this.windowMs = windowMs; }

  retryAfterMs(key: string, now = Date.now()) {
    const bucket = this.buckets.get(key);
    return bucket && bucket.resetAt > now && bucket.count >= this.limit ? bucket.resetAt - now : 0;
  }

  add(key: string, now = Date.now()) {
    if (this.buckets.size > MAX_TRACKED) {
      for (const [candidate, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(candidate);
      // Still too many live entries (a flood of distinct keys): drop the oldest.
      while (this.buckets.size > MAX_TRACKED) this.buckets.delete(this.buckets.keys().next().value!);
    }
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt > now) bucket.count += 1;
    else this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  remove(key: string) {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.count > 0) bucket.count -= 1;
  }

  clear(key: string) { this.buckets.delete(key); }
  reset() { this.buckets.clear(); }
}

// Per address (only when a trusted proxy supplies one), per username, and a high overall cap
// against spraying guesses across many usernames.
const perClient = new Limiter(8);
const perUsername = new Limiter(10);
const overall = new Limiter(300);
const OVERALL = "*";
// Wrong two-factor codes, per account and per address. Kept apart from the password limits: a
// correct password must not buy fresh guesses at the code, so only a correct code clears these.
const codesPerUser = new Limiter(10);
const codesPerClient = new Limiter(20);
// Wrong current passwords from a signed-in session (changing the password, two-factor changes).
const passwordChecks = new Limiter(5, 15 * 60 * 1000);

/**
 * The client's address, or "direct" when it isn't known. X-Forwarded-For is only trusted when
 * BLOCKY_TRUST_PROXY=true, and then only its last entry: Caddy and nginx append the address they
 * saw, so earlier entries are whatever the client sent.
 */
export function clientKey(headers: Headers) {
  if (process.env.BLOCKY_TRUST_PROXY !== "true") return "direct";
  const forwarded = headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean);
  return forwarded?.at(-1) || headers.get("x-real-ip")?.trim() || "unknown";
}

/** Milliseconds until a login for this client and username is allowed again (0 when it is). */
export function loginRetryAfter(client: string, username: string) {
  const user = username.toLowerCase();
  return Math.max(client === "direct" ? 0 : perClient.retryAfterMs(client), perUsername.retryAfterMs(user), overall.retryAfterMs(OVERALL));
}

/**
 * Counts a login attempt as a failure before the (slow) password check, so parallel requests can't
 * all pass the limit before any of them is recorded. A success takes the count back.
 *
 * Without a trusted proxy every client shares the key "direct", so it isn't limited per client:
 * that would let anyone lock everyone out. Usernames and the overall cap still apply.
 */
export function beginLoginAttempt(client: string, username: string) {
  const user = username.toLowerCase();
  if (client !== "direct") perClient.add(client);
  perUsername.add(user);
  overall.add(OVERALL);
  return {
    fail() { /* already counted */ },
    /** The check never ran (the server was busy), so it doesn't count. */
    cancel() {
      if (client !== "direct") perClient.remove(client);
      perUsername.remove(user);
      overall.remove(OVERALL);
    },
    succeed() {
      if (client !== "direct") perClient.clear(client);
      perUsername.clear(user);
      overall.remove(OVERALL);
    },
  };
}

/** Forgives earlier failed logins once the whole sign-in (password and code) has succeeded. */
export function forgiveLogin(client: string, username: string) {
  if (client !== "direct") perClient.clear(client);
  perUsername.clear(username.toLowerCase());
}

/** Milliseconds until this account may try another two-factor code from this client (0 when it may). */
export function codeRetryAfter(client: string, userId: string) {
  return Math.max(client === "direct" ? 0 : codesPerClient.retryAfterMs(client), codesPerUser.retryAfterMs(userId));
}

/** Counts a two-factor code as wrong before it's checked; a correct one takes that back. */
export function beginCodeAttempt(client: string, userId: string) {
  if (client !== "direct") codesPerClient.add(client);
  codesPerUser.add(userId);
  return {
    /** The challenge was gone, so no code was really tried. */
    cancel() { if (client !== "direct") codesPerClient.remove(client); codesPerUser.remove(userId); },
    succeed() { if (client !== "direct") codesPerClient.remove(client); codesPerUser.clear(userId); },
  };
}

/** Milliseconds until this account may try its current password again (0 when it may). */
export function passwordRetryAfter(userId: string) {
  return passwordChecks.retryAfterMs(userId);
}

/** Counts a current-password check as wrong before it runs; `cancel` when it wasn't wrong (or didn't run). */
export function beginPasswordCheck(userId: string) {
  passwordChecks.add(userId);
  return { cancel() { passwordChecks.remove(userId); }, succeed() { passwordChecks.clear(userId); } };
}

const failureNotes = new Map<string, { count: number; writtenAt: number }>();
const NOTE_INTERVAL = 60 * 1000;

/**
 * Keeps repeated failures from flooding the activity log: returns how many failures for `key` to
 * record now (including earlier ones held back), at most once a minute, and 0 in between.
 */
export function failuresToRecord(key: string, now = Date.now()) {
  if (failureNotes.size > MAX_TRACKED) failureNotes.delete(failureNotes.keys().next().value!);
  const note = failureNotes.get(key) || { count: 0, writtenAt: -Infinity };
  note.count += 1;
  failureNotes.set(key, note);
  if (now - note.writtenAt < NOTE_INTERVAL) return 0;
  const count = note.count;
  failureNotes.set(key, { count: 0, writtenAt: now });
  return count;
}

// Password checks and hashes (scrypt, ~32 MB each) run on Node's small shared thread pool, which
// file I/O also uses; a flood of logins or password changes mustn't be able to stall the whole panel.
const MAX_CONCURRENT_CHECKS = 4;
let checksInFlight = 0;

/** Runs a password check or hash if a slot is free; returns undefined (caller answers "busy") otherwise. */
export async function withCheckSlot<T>(work: () => Promise<T>): Promise<T | undefined> {
  if (checksInFlight >= MAX_CONCURRENT_CHECKS) return undefined;
  checksInFlight += 1;
  try { return await work(); } finally { checksInFlight -= 1; }
}

const queues = new Map<string, { tail: Promise<unknown>; waiting: number }>();

/**
 * Runs `work` for `name` one at a time. Used for the recovery and setup passwords: they have no
 * lockout (so nobody can lock the owner out of recovery), and running checks one after another,
 * each failure followed by a delay, keeps guessing to about one attempt a second.
 */
export function serialized<T>(name: string, work: () => Promise<T>, maxWaiting = 20): Promise<T> {
  const queue = queues.get(name) || { tail: Promise.resolve(), waiting: 0 };
  queues.set(name, queue);
  if (queue.waiting >= maxWaiting) return Promise.reject(new Error("Too many attempts at once. Try again in a moment."));
  queue.waiting += 1;
  const run = queue.tail.catch(() => undefined).then(work).finally(() => { queue.waiting -= 1; });
  queue.tail = run.catch(() => undefined);
  return run;
}

export function resetLoginLimits() {
  perClient.reset();
  perUsername.reset();
  overall.reset();
  codesPerUser.reset();
  codesPerClient.reset();
  passwordChecks.reset();
  failureNotes.clear();
  checksInFlight = 0;
  queues.clear();
}
