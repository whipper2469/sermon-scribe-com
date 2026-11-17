// deno-lint-ignore-file no-unversioned-import

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@23.1.0";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requiredEnv } from "../_shared/http.ts";
import { stripeClient } from "../_shared/stripe.ts";

const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "payment_method.attached",
  "payment_method.detached",
  "customer.updated",
  "customer.tax_id.created",
  "customer.tax_id.updated",
  "customer.tax_id.deleted",
  "billing_portal.configuration.created",
  "billing_portal.configuration.updated",
  "billing_portal.session.created",
]);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature", { status: 400 });
  }
  let event: Stripe.Event;
  try {
    const stripe = stripeClient();
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      requiredEnv(
        "STRIPE_CONNECT_WEBHOOK_SECRET",
        "Set the signing secret for the Connect snapshot-event destination.",
      ),
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.error(
      "Stripe Connect snapshot signature verification failed:",
      (err as Error)?.message,
    );
    return new Response("Invalid signature", { status: 400 });
  }
  if (!HANDLED.has(event.type)) {
    return new Response("Unsupported event", { status: 400 });
  }
  try {
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
    const object = event.data.object as unknown as Record<string, unknown>;
    const customerAccount = typeof object.customer_account === "string"
      ? object.customer_account
      : null;
    const { error: claimError } = await db.from("stripe_connect_events").insert(
      {
        id: event.id,
        type: event.type,
        account_id: customerAccount,
      },
    );
    if (claimError?.code === "23505") {
      return Response.json({ received: true, duplicate: true });
    }
    if (claimError) throw claimError;

    if (event.type.startsWith("customer.subscription.")) {
      const sub = object as unknown as Stripe.Subscription & {
        customer_account?: string;
      };
      const item = sub.items?.data?.[0];
      const subscriptionAccountId = sub.customer_account ?? customerAccount;
      if (!subscriptionAccountId) {
        console.warn(
          `Subscription ${sub.id} was not a customer_account subscription; snapshot still recorded.`,
        );
        return Response.json({ received: true });
      }
      const { error } = await db.from("stripe_connect_subscriptions").upsert({
        stripe_subscription_id: sub.id,
        account_id: subscriptionAccountId,
        status: sub.status,
        price_id: item?.price?.id ?? null,
        cancel_at_period_end: sub.cancel_at_period_end ?? false,
        updated_at: new Date().toISOString(),
      }, { onConflict: "stripe_subscription_id" });
      if (error) throw error;
    }
    if (event.type === "checkout.session.completed") {
      // Subscription snapshots provide the authoritative state; this event is
      // retained for audit/reconciliation and is not used as proof of payment.
      console.log("Connect Checkout completed", event.id);
    }
    // Payment method, customer, tax-ID, and portal snapshots are safely recorded
    // above. Add product-specific side effects here when the app persists them.
    return Response.json({ received: true });
  } catch (err) {
    console.error(
      `Stripe Connect event ${event.id} failed:`,
      (err as Error)?.message,
    );
    // Remove the idempotency claim on failure so Stripe's retry can process it.
    try {
      const db = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await db.from("stripe_connect_events").delete().eq("id", event.id);
    } catch { /* Stripe will retry; the original error is logged above. */ }
    return new Response("Handler failed", { status: 500 });
  }
});
