// Browser-side billing calls for Sermon Scribe.
//
// Only the publishable anon key ever reaches the browser. The Stripe secret key
// stays in Supabase secrets — if it's ever in this file, rotate it immediately.

const SUPABASE_URL = "https://pythmzvpbtlkhootkqlt.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dGhtenZwYnRsa2hvb3RrcWx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5OTkzODAsImV4cCI6MjEwMjU3NTM4MH0.Cz9j-ECVhSMAVW4DSP43qMDAl9GERzHwrqnSOcTItOY";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function callFunction(name, body = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    // Send them to sign in first — checkout needs a user to attach the plan to.
    window.location.href = "/signin";
    return null;
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error ?? "Request failed");
  return payload;
}

// Wire to the Pro / Ministry buttons on the pricing section.
export async function startCheckout(plan) {
  const { url } = await callFunction("create-checkout-session", { plan });
  window.location.href = url;
}

// Wire to a "Manage billing" link in the account area.
export async function openBillingPortal() {
  const { url } = await callFunction("customer-portal");
  window.location.href = url;
}

// Entitlement check. Reads the row the webhook writes — never trust a value the
// browser could have set.
export async function getPlan() {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .maybeSingle();

  if (error || !data) return { plan: "free", status: "active" };
  return data;
}
