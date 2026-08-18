import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@22.5.0";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";
import { priceIdForPlan } from "../_shared/plans.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  // Deno has no Node http module; Stripe ships a fetch-based client for it.
  httpClient: Stripe.createFetchHttpClient(),
});

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sermon-scribe.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    // Service-role client, but the user is identified from their own JWT — the
    // browser never gets to say who it is.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const jwt = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) return json({ error: "Invalid session" }, 401);

    const { plan } = await req.json();
    const priceId = priceIdForPlan(plan);
    if (!priceId) {
      return json({ error: `Unknown or unconfigured plan: ${plan}` }, 400);
    }

    // One Stripe customer per user, reused for every future checkout so the
    // billing portal shows a single coherent history.
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    let customerId = existing?.stripe_customer_id ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;

      await supabase
        .from("subscriptions")
        .upsert(
          { user_id: user.id, stripe_customer_id: customerId },
          { onConflict: "user_id" },
        );
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: user.id,
      // Honours the "founding member pricing" the waitlist email promised.
      allow_promotion_codes: true,
      // Metadata set at this level lands on the Checkout Session. The webhook
      // reads the *Subscription*, which is a different object and does not
      // inherit it — hence subscription_data below. Dropping that line is what
      // silently leaves paying customers on the free plan.
      metadata: { user_id: user.id, plan },
      subscription_data: { metadata: { user_id: user.id, plan } },
      success_url: `${SITE_URL}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/pricing`,
    });

    return json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session failed:", err);
    return json({ error: (err as Error)?.message ?? "Unexpected error" }, 500);
  }
});
