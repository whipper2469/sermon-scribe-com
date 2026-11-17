import Stripe from "npm:stripe@23.1.0";
import { requiredEnv } from "./http.ts";

// Construct lazily so a missing secret produces an actionable function error.
// Every Stripe API request in the integration goes through this Client.
export function stripeClient(): Stripe {
  return new Stripe(
    requiredEnv(
      "STRIPE_SECRET_KEY",
      "Set it with `supabase secrets set STRIPE_SECRET_KEY=sk_...`.",
    ),
    {
      httpClient: Stripe.createFetchHttpClient(),
    },
  );
}
