import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { clientErrorMessage, corsHeaders, json, requiredEnv } from "../_shared/http.ts";
import { stripeClient } from "../_shared/stripe.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sermon-scribe.com";

// Stripe's hosted billing portal handles plan changes, card updates, invoice
// history and cancellation. Building those screens yourself is weeks of work
// and a PCI question you don't want to answer.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripe = stripeClient();
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabase = createClient(
      requiredEnv("SUPABASE_URL", "Set the Supabase project URL for Edge Functions."),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY", "Set the Supabase service-role secret for Edge Functions."),
    );

    const jwt = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) return json({ error: "Invalid session" }, 401);

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return json({ error: "No billing account yet" }, 404);
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${SITE_URL}/account`,
    });

    return json({ url: session.url });
  } catch (err) {
    console.error("customer-portal failed:", err);
    return json({ error: clientErrorMessage(err) }, 500);
  }
});
