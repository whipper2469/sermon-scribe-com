// Price ids live in env vars, not in code, so the same functions run against
// Stripe test mode and live mode without an edit.
//
//   STRIPE_PRICE_PRO       price_... ($19/mo)
//   STRIPE_PRICE_MINISTRY  price_... ($49/mo)

export type Plan = "free" | "pro" | "ministry";

const PRICE_BY_PLAN: Record<Exclude<Plan, "free">, string | undefined> = {
  pro: Deno.env.get("STRIPE_PRICE_PRO"),
  ministry: Deno.env.get("STRIPE_PRICE_MINISTRY"),
};

export function priceIdForPlan(plan: unknown): string | null {
  if (plan !== "pro" && plan !== "ministry") return null;
  return PRICE_BY_PLAN[plan] ?? null;
}

// Reverse lookup for the webhook: a plan change made in the Stripe dashboard
// arrives as a price id with no metadata attached to it.
export function planForPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  for (const [plan, id] of Object.entries(PRICE_BY_PLAN)) {
    if (id && id === priceId) return plan as Plan;
  }
  return null;
}
