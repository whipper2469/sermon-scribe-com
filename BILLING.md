# Sermon Scribe — billing and project migration

Subscription billing for sermon-scribe.com: **Free $0 / Pro $19 / Ministry $49, CAD**.
Card payments via Stripe, with the existing Interac e-Transfer path kept alongside.

```
Browser ──► create-checkout-session ──► Stripe Checkout ──► card entry
                                                              │
Browser ◄── subscriptions table ◄── stripe-webhook ◄──────────┘
```

The browser never writes entitlement. It reads the `subscriptions` row the
webhook writes; RLS grants read-only access to a user's own row.

## Two projects, mid-move

The live app authenticates against **`japlrtlpopefvgkecpif` (Snapfix)** — that is
where its 29 auth users and 19 sermons live today. Billing is being built against
the new project **`pythmzvpbtlkhootkqlt`**, which is currently empty.

Nothing on this branch may be deployed until the data moves, or signed-in users
hit a project that has never heard of them.

Who actually belongs to Sermon Scribe, measured rather than assumed:

| Cohort | Users |
|---|---|
| Wrote sermons | 3 |
| Uses both products | 1 |
| No activity, May email signups (likely Sermon Scribe) | 3 |
| SnapFix only (incl. every Apple sign-in — iOS) | 22 |

So the move is **4 users, 7 at the outside**, all email/password. No OAuth
provider config to replicate.

## Order of operations

1. `supabase login` with the account that owns `pythmzvpbtlkhootkqlt`
2. `supabase link --project-ref pythmzvpbtlkhootkqlt`
3. `supabase db push` — creates sermons, sermon_templates, subscriptions,
   stripe_events, interac_claims
4. Move the users (see below) and copy their sermons
5. Repoint `login.html`, `app.html`, `dashboard.html` — they still hardcode the
   Snapfix ref. `upgrade.html` and `web/billing.js` already point at the new one
6. `supabase secrets set --env-file .env`
7. `supabase functions deploy create-checkout-session customer-portal stripe-webhook`
8. Create the Stripe webhook endpoint, put its `whsec_` in `.env`, repeat 6 and 7
9. Merge this branch and deploy the site

## Moving the users

Chosen approach: **create the accounts fresh by email and let Supabase send a
password-reset link.** Four people set a new password once, and no bcrypt hashes
are written to disk in a git repo. Their sermons are copied by `user_id`, so
nothing is lost.

The alternative — dumping `auth.users` and `auth.identities` — preserves
passwords but puts hashes in a file that only has to be committed once to be
permanent.

## Files

| Path | What it does |
|---|---|
| `supabase/migrations/…_shared_helpers.sql` | `touch_updated_at()`, used by later migrations |
| `supabase/migrations/…_sermon_app_schema.sql` | `sermons`, `sermon_templates` + RLS |
| `supabase/migrations/…_sermon_scribe_billing.sql` | `subscriptions`, `stripe_events`, `interac_claims`, `grant_interac_plan()` |
| `supabase/functions/create-checkout-session/` | Signed-in user → Stripe Checkout URL |
| `supabase/functions/stripe-webhook/` | Stripe → entitlement. Signature-verified, idempotent |
| `supabase/functions/customer-portal/` | Signed-in user → Stripe billing portal |
| `cersom-latest/upgrade.html` | Card / Interac tabs; card path calls the function |
| `web/billing.js` | `startCheckout`, `openBillingPortal`, `getPlan` for other pages |

## Stripe

Test-mode products already created (2026-08-17, CAD monthly):

```
Pro       price_1U5avLJJuJdO8a9khXUTEfL3   $19.00 CAD/month
Ministry  price_1U5avLJJuJdO8a9kEkJ2LvxT   $49.00 CAD/month
```

Webhook endpoint, once the functions are deployed:

```
https://pythmzvpbtlkhootkqlt.supabase.co/functions/v1/stripe-webhook
```

Events: `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_failed`.

`config.toml` sets `verify_jwt = false` for the webhook — Stripe has no Supabase
JWT to send, and the signature check is what authenticates it.

Testing:

```bash
brew install stripe/stripe-cli/stripe
stripe login
stripe listen --forward-to https://pythmzvpbtlkhootkqlt.supabase.co/functions/v1/stripe-webhook
```

Card `4242 4242 4242 4242`, any future expiry. Then confirm the row flipped:

```sql
select user_id, plan, status, source, current_period_end from subscriptions;
```

## Interac, kept

`upgrade.html` used to show a success banner and print a receipt **entirely in
the browser** — a customer could send money, click confirm, and nothing would
reach you but the bank email. Confirmations now insert into `interac_claims`.

Nothing in that table grants access. After the money lands:

```sql
select id, sender_email, plan, amount_cad, sent_on from interac_claims where status = 'pending';
select public.grant_interac_plan('<claim id>', 1);
```

That sets `source = 'interac'` and an explicit `current_period_end`, so an
unpaid month lapses instead of running free forever. Stripe never touches those
rows — it matches on `stripe_customer_id`, which they don't have.

## Before going live

- [ ] Roll the Stripe secret key that was pasted into chat
- [ ] Activate the Stripe account (business details, bank account)
- [ ] Recreate both products in **live** mode — test price ids do not work live
- [ ] Separate live webhook endpoint; its `whsec_` differs from test
- [ ] `ALLOWED_ORIGIN` set to `https://sermon-scribe.com`
- [ ] Serve sermon-scribe.com — it currently returns 403
- [ ] Reset the database password that was pasted into chat
- [ ] Refund policy on the pricing page; check Stripe tax settings for CAD/GST

## Three deliberate choices

**Metadata is set twice at checkout.** `metadata` lands on the Checkout Session;
the webhook reads the Subscription, a different object that doesn't inherit it.
Only `subscription_data.metadata` reaches the subscription. The earlier FastAPI
draft set the first and read the second — every paying customer would have stayed
on free, silently.

**The webhook claims each event id before working.** Stripe retries on non-2xx
and can redeliver a delivered event. Without `stripe_events`, a retry re-applies.

**Plan comes from the price id, not metadata.** Switching plans in the billing
portal never updates the original checkout metadata; the price id stays current.
