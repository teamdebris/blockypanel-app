import "server-only";

// Optional failure alerts. BLOCKY_WEBHOOK_URL accepts a Discord webhook or any endpoint that takes
// a JSON body with `content` (Discord) and `text` (Slack-compatible) fields.
const WEBHOOK_URL = process.env.BLOCKY_WEBHOOK_URL || "";

export async function notify(message: string) {
  if (!WEBHOOK_URL) return;
  const content = `[Blocky] ${message}`.slice(0, 1900);
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, text: content }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`Blocky webhook responded with ${response.status}.`);
  } catch (error) {
    console.error("Blocky webhook delivery failed", error);
  }
}
