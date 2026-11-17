// deno-lint-ignore-file no-unversioned-import

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { signedInUser } from "../_shared/auth.ts";
import { clientErrorMessage, corsHeaders, json } from "../_shared/http.ts";
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
      return json(
        { error: "Create and onboard a connected account first" },
        409,
      );
    }
    const body = await req.json();
    const name = typeof body.name === "string"
      ? body.name.trim().slice(0, 120)
      : "";
    const amount = Number(body.unitAmount);
    const currency = typeof body.currency === "string"
      ? body.currency.toLowerCase()
      : "cad";
    if (
      !name || !Number.isSafeInteger(amount) || amount < 50 ||
      !/^[a-z]{3}$/.test(currency)
    ) {
      return json({
        error:
          "Provide a product name, an integer unitAmount in minor currency units (minimum 50), and a 3-letter currency.",
      }, 400);
    }
    // The connected account is read from the authenticated user's DB row, never
    // accepted from the browser, preventing cross-account product writes.
    const product = await stripeClient().products.create({
      name,
      description: typeof body.description === "string"
        ? body.description.slice(0, 500)
        : undefined,
      default_price_data: { unit_amount: amount, currency },
    }, { stripeAccount: account.account_id });
    return json({ productId: product.id, priceId: product.default_price });
  } catch (err) {
    const rawMessage = (err as Error)?.message ?? "Unexpected error";
    console.error("connect-products failed:", rawMessage);
    return json(
      { error: clientErrorMessage(err) },
      rawMessage.includes("session") || rawMessage.includes("Authorization")
        ? 401
        : 500,
    );
  }
});
