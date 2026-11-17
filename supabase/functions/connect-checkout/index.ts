// deno-lint-ignore-file no-unversioned-import

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  clientErrorMessage,
  corsHeaders,
  json,
  requiredEnv,
} from "../_shared/http.ts";
import { stripeClient } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    if (req.method !== "POST") return json({ error: "POST required" }, 405);
    const { slug, priceId } = await req.json();
    if (
      typeof slug !== "string" || !/^[a-f0-9]{20}$/.test(slug) ||
      typeof priceId !== "string" || !/^price_[A-Za-z0-9]+$/.test(priceId)
    ) {
      return json({ error: "Invalid store or price" }, 400);
    }
    const db = createClient(
      requiredEnv(
        "SUPABASE_URL",
        "Set the Supabase project URL for Edge Functions.",
      ),
      requiredEnv(
        "SUPABASE_SERVICE_ROLE_KEY",
        "Set the Supabase service-role secret for Edge Functions.",
      ),
    );
    const { data: seller, error } = await db.from("stripe_connect_accounts")
      .select("account_id").eq("public_slug", slug).maybeSingle();
    if (error) throw error;
    if (!seller) return json({ error: "Store not found" }, 404);

    const stripe = stripeClient();
    // Read the price within the seller's Stripe account, then use the returned
    // canonical ID and amount. Never accept a client-provided amount or fee.
    const price = await stripe.prices.retrieve(priceId, {}, {
      stripeAccount: seller.account_id,
    });
    if (!price.active || !price.unit_amount || !price.product) {
      return json({ error: "Price is unavailable" }, 400);
    }
    const pct = Number(Deno.env.get("CONNECT_APPLICATION_FEE_PERCENT") ?? "10");
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error(
        "CONNECT_APPLICATION_FEE_PERCENT must be between 0 and 100.",
      );
    }
    const base = requiredEnv(
      "SITE_URL",
      "Set SITE_URL to the public HTTPS URL used for Checkout return links.",
    );
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: price.id, quantity: 1 }],
      payment_intent_data: {
        application_fee_amount: Math.round(price.unit_amount * pct / 100),
      },
      success_url:
        `${base}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/functions/v1/connect-storefront?slug=${
        encodeURIComponent(slug)
      }`,
    }, { stripeAccount: seller.account_id });
    return json({ url: session.url });
  } catch (err) {
    const message = (err as Error)?.message ?? "Unexpected error";
    console.error("connect-checkout failed:", message);
    return json({ error: clientErrorMessage(err) }, 500);
  }
});
