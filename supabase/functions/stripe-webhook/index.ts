import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@22.5.0";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { planForPriceId } from "../_shared/plans.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});

// Deno verifies signatures through Web Crypto, which is async — this pairs with
// constructEventAsync below. The synchronous constructEvent throws here.
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

// Statuses where the customer keeps what they paid for. Anything else falls
// back to free until Stripe tells us otherwise.
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing stripe-signature", { status: 400 });

  // The raw body is what was signed. Parsing it first (req.json()) reserialises
  // it and the signature will never match.
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    console.error("Signature verification failed:", (err as Error).message);
    return new Response("Invalid signature", { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Claim the event before doing any work. Stripe retries on non-2xx and can
  // redeliver an event it already delivered successfully, so this is what stops
  // the same upgrade being applied twice.
  const { error: claimError } = await supabase
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });

  if (claimError) {
    if (claimError.code === "23505") {
      console.log(`Skipping already-processed event ${event.id}`);
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }
    console.error("Could not record event:", claimError);
    // 500 so Stripe retries — better a retry than a silently dropped upgrade.
    return new Response("Could not record event", { status: 500 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // The subscription.created event covers this too, but delivery order
        // isn't guaranteed, so apply whichever lands first. Both are idempotent.
        if (typeof session.subscription === "string") {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await applySubscription(supabase, sub);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await applySubscription(supabase, event.data.object as Stripe.Subscription);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
        if (customerId) {
          // Don't revoke access here. Stripe retries failed payments for days,
          // and customer.subscription.deleted is what ends the relationship.
          await supabase
            .from("subscriptions")
            .update({ status: "past_due" })
            .eq("stripe_customer_id", customerId);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (err) {
    console.error(`Handling ${event.type} (${event.id}) failed:`, err);
    // Release the claim so Stripe's retry can have another go.
    await supabase.from("stripe_events").delete().eq("id", event.id);
    return new Response("Handler failed", { status: 500 });
  }
});

async function applySubscription(supabase: SupabaseClient, sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) {
    console.error(`Subscription ${sub.id} has no customer`);
    return;
  }

  const item = sub.items?.data?.[0];
  const cancelled = sub.status === "canceled" || sub.status === "incomplete_expired";

  // Prefer the price id: it stays correct when someone switches plans in the
  // billing portal, where the original checkout metadata is never updated.
  const plan = cancelled
    ? "free"
    : planForPriceId(item?.price?.id) ??
      (sub.metadata?.plan as string | undefined) ??
      "pro";

  // current_period_end moved onto subscription items in the 2025-03-31 API
  // version; read both so this works whichever version the account is pinned to.
  const periodEnd = (item as { current_period_end?: number } | undefined)?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;

  const update = {
    plan: ENTITLED_STATUSES.has(sub.status) ? plan : "free",
    status: sub.status,
    // Marks the row as Stripe-owned. Rows paid by Interac are never matched
    // here — they carry no stripe_customer_id — so the two paths can't fight
    // over the same subscription.
    source: "stripe",
    stripe_subscription_id: cancelled ? null : sub.id,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
  };

  // Match on the customer first — it's the one id that survives plan changes.
  const { data: matched, error } = await supabase
    .from("subscriptions")
    .update(update)
    .eq("stripe_customer_id", customerId)
    .select("user_id");

  if (error) throw error;
  if (matched && matched.length > 0) return;

  // No row carried this customer id yet (checkout raced the customer write, or
  // the customer was made in the Stripe dashboard). Fall back to the user id
  // stamped into metadata at checkout.
  const userId = sub.metadata?.user_id;
  if (!userId) {
    console.error(`No subscription row for customer ${customerId} and no user_id metadata`);
    return;
  }

  const { error: upsertError } = await supabase
    .from("subscriptions")
    .upsert({ user_id: userId, stripe_customer_id: customerId, ...update }, { onConflict: "user_id" });

  if (upsertError) throw upsertError;
}
