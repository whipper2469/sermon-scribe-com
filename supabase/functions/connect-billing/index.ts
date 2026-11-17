// deno-lint-ignore-file no-unversioned-import

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { signedInUser } from "../_shared/auth.ts";
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
    const { user, admin } = await signedInUser(req);
    const { data: account, error } = await admin.from("stripe_connect_accounts")
      .select("account_id").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (!account) {
      return json({ error: "Create a connected account first" }, 409);
    }
    const body = await req.json().catch(() => ({}));
    const stripe = stripeClient();
    const base = requiredEnv(
      "SITE_URL",
      "Set SITE_URL to the public HTTPS URL used for Checkout return links.",
    );
    if (body.action === "portal") {
      const session = await stripe.billingPortal.sessions.create({
        customer_account: account.account_id,
        return_url: `${base}/dashboard.html`,
      });
      return json({ url: session.url });
    }
    const price = requiredEnv(
      "CONNECT_PLATFORM_PRICE_ID",
      "Create a recurring platform Price and set CONNECT_PLATFORM_PRICE_ID=price_... in Supabase secrets.",
    );
    const session = await stripe.checkout.sessions.create({
      customer_account: account.account_id,
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      success_url: `${base}/dashboard.html?connect_subscription=success`,
      cancel_url: `${base}/dashboard.html?connect_subscription=cancelled`,
    });
    return json({ url: session.url });
  } catch (err) {
    const rawMessage = (err as Error)?.message ?? "Unexpected error";
    console.error("connect-billing failed:", rawMessage);
    return json(
      { error: clientErrorMessage(err) },
      rawMessage.includes("session") || rawMessage.includes("Authorization")
        ? 401
        : 500,
    );
  }
});
