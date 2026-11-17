// deno-lint-ignore-file no-unversioned-import

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@23.1.0";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requiredEnv } from "../_shared/http.ts";
import { stripeClient } from "../_shared/stripe.ts";

const EVENT_TYPES = new Set([
  "v2.core.account[requirements].updated",
  "v2.core.account[configuration.merchant].capability_status_updated",
  "v2.core.account[configuration.customer].capability_status_updated",
  "v2.core.account[.recipient].capability_status_updated",
]);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature", { status: 400 });
  }
  let stripe: Stripe;
  let notification: Stripe.V2.Core.EventNotification;
  try {
    stripe = stripeClient();
    notification = await stripe.parseEventNotificationAsync(
      await req.text(),
      signature,
      requiredEnv(
        "STRIPE_CONNECT_THIN_WEBHOOK_SECRET",
        "Set the signing secret for the V2 thin-event destination.",
      ),
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.error(
      "Stripe Connect thin webhook signature/configuration failed:",
      (err as Error)?.message,
    );
    return new Response("Invalid signature", { status: 400 });
  }
  // Thin notifications contain identifiers only. fetchEvent retrieves the
  // full event using the connected-account Stripe context from the signature.
  try {
    const event = await notification.fetchEvent();
    if (!EVENT_TYPES.has(event.type)) {
      return new Response("Unsupported event", { status: 400 });
    }
    const relatedObject =
      (notification as unknown as { related_object?: { id?: string } | null })
        .related_object;
    const accountId = relatedObject?.id ?? null;
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
    const { error } = await db.from("stripe_connect_events").insert({
      id: notification.id,
      type: event.type,
      account_id: accountId,
    });
    if (error?.code === "23505") {
      return Response.json({ received: true, duplicate: true });
    }
    if (error) throw error;
    if (accountId) {
      try {
        const contextualStripe = notification.context
          ? stripe.withStripeContext(notification.context)
          : stripe;
        const account = await contextualStripe.v2.core.accounts.retrieve(
          accountId,
          { include: ["configuration.merchant", "requirements"] },
        );
        const { error: updateError } = await db.from("stripe_connect_accounts")
          .update({
            card_payments_status:
              account.configuration?.merchant?.capabilities?.card_payments
                ?.status ?? null,
            requirements_status:
              account.requirements?.summary?.minimum_deadline?.status ?? null,
            updated_at: new Date().toISOString(),
          }).eq("account_id", accountId);
        if (updateError) throw updateError;
      } catch (err) {
        await db.from("stripe_connect_events").delete().eq(
          "id",
          notification.id,
        );
        throw err;
      }
    }
    return Response.json({ received: true });
  } catch (err) {
    console.error(
      "Stripe Connect thin event processing failed:",
      (err as Error)?.message,
    );
    return new Response("Webhook handler failed", { status: 500 });
  }
});
