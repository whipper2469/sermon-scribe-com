// Default to the production origin; set ALLOWED_ORIGIN explicitly for local
// development or a different deployment host.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ??
  "https://sermon-scribe.com";

export const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function requiredEnv(name: string, hint: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}. ${hint}`);
  return value;
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]!));
}

// Show actionable configuration/auth errors, but keep Stripe/API internals in
// server logs instead of returning them to a browser.
export function clientErrorMessage(err: unknown): string {
  const message = (err as Error)?.message ?? "";
  if (
    message.startsWith("Missing ") || message === "Invalid session" ||
    message.startsWith("Missing or invalid Authorization")
  ) return message;
  return "The Stripe request could not be completed. Check the server logs and Stripe configuration.";
}
