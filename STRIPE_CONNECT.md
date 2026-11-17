# Stripe Connect V2 sample

This sample extends the existing Sermon Scribe stack: static HTML, Supabase Auth,
Supabase Edge Functions on Deno, and Supabase Postgres. All Stripe server calls
use Stripe's Node SDK `stripe@23.1.0` through the shared `Stripe` Client in
`supabase/functions/_shared/stripe.ts`. It never accepts an account ID from an
authenticated seller's browser; the account is looked up from that user's row.

## Included flows

- `connect-account`: create an Accounts v2 connected account, make a fresh
  hosted onboarding link, and retrieve current requirements and card-payment
  capability status from Stripe.
- `connect-products`: create a product and default one-time price on the
  authenticated user's connected account.
- `connect-storefront`: public, slug-based HTML storefront backed by products
  read from that connected Stripe account.
- `connect-checkout`: public hosted Checkout for direct charges. It retrieves
  the selected price in the seller's account and calculates the application fee
  server-side; the browser cannot set an amount or fee.
- `connect-billing`: platform-level subscription Checkout for the connected
  account as a V2 customer, plus its hosted billing portal.
- `stripe-connect-thin-webhook`: signature-checks thin V2 account requirement
  and capability events, retrieves the full event/resource in its Stripe
  context, then refreshes the cached status columns.
- `stripe-connect-webhook`: signature-checks snapshot events for Checkout,
  subscriptions, payment methods, customers, tax IDs, and billing portal; it
  records event IDs idempotently and mirrors connected-account subscription state.

## Set up

The target Supabase project and database migration are still subject to the
existing cutover plan in `BILLING.md`. Do not deploy these functions against the
old authentication project: the live pages currently authenticate against a
different Supabase project. First complete the documented user/data migration
and repoint the app auth configuration.

1. Apply `supabase/migrations/20261116120000_stripe_connect.sql` to the target
   Supabase project.
2. In Stripe test mode, create a recurring platform Price for connected-account
   subscriptions.
3. Add these Supabase secrets (the first two must be platform secret keys; do
   not put them in HTML):

   ```sh
   supabase secrets set STRIPE_SECRET_KEY=sk_test_...
   supabase secrets set STRIPE_CONNECT_THIN_WEBHOOK_SECRET=whsec_...
   supabase secrets set STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
   supabase secrets set CONNECT_PLATFORM_PRICE_ID=price_...
   supabase secrets set SITE_URL=https://sermon-scribe.com
   supabase secrets set CONNECT_APPLICATION_FEE_PERCENT=10
   supabase secrets set CONNECT_COUNTRY=CA
   supabase secrets set ALLOWED_ORIGIN=https://sermon-scribe.com
   ```

   `CONNECT_APPLICATION_FEE_PERCENT` is a sample default (10%). Set a value
   consistent with the platform's commercial terms. `SITE_URL` must be a public
   HTTPS origin with deployed `dashboard.html` and `checkout-success.html` return
   pages. Create that success page before enabling live payments.
4. Configure two separate Stripe webhook destinations on the platform account:

   - **Thin payload / connected accounts:**
     `v2.core.account[requirements].updated`,
     `v2.core.account[configuration.merchant].capability_status_updated`,
     `v2.core.account[configuration.customer].capability_status_updated`, and
     `v2.core.account[.recipient].capability_status_updated` (only if recipient
     configuration is used). Endpoint:
     `https://<project-ref>.supabase.co/functions/v1/stripe-connect-thin-webhook`.
   - **Snapshot payload / platform account:**
     `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`,
     `payment_method.attached`, `payment_method.detached`, `customer.updated`,
     `customer.tax_id.created`, `customer.tax_id.updated`,
     `customer.tax_id.deleted`, `billing_portal.configuration.created`,
     `billing_portal.configuration.updated`, and
     `billing_portal.session.created`. Endpoint:
     `https://<project-ref>.supabase.co/functions/v1/stripe-connect-webhook`.

   Put each destination's own `whsec_...` value in its matching secret above.
   The existing Sermon Scribe subscription webhook retains its separate
   `STRIPE_WEBHOOK_SECRET` and endpoint.
5. Deploy the Connect functions and the updated existing Stripe functions:

   ```sh
   supabase functions deploy connect-account
   supabase functions deploy connect-products
   supabase functions deploy connect-storefront
   supabase functions deploy connect-checkout
   supabase functions deploy connect-billing
   supabase functions deploy stripe-connect-thin-webhook
   supabase functions deploy stripe-connect-webhook
   supabase functions deploy create-checkout-session
   supabase functions deploy customer-portal
   supabase functions deploy stripe-webhook
   ```

6. Publish `cersom-latest/connect.html` alongside the site's other HTML pages.
   After the Supabase auth cutover, open **Seller setup** from the dashboard,
   connect an account, finish hosted onboarding, create a product, and use its
   generated storefront URL.

## Persistence and remaining product work

- Account ownership, an unguessable public storefront slug, onboarding status,
  subscription state, and webhook event IDs are stored in Postgres. Product
  catalog and authoritative account onboarding details remain in Stripe.
- Event IDs for customer, payment-method, tax-ID, and portal changes are
  recorded in `stripe_connect_events` without retaining billing PII;
  application-specific handling such as
  email notifications or billing-profile synchronization is marked in the
  webhook handler for implementation when those product features exist.
- Public slugs are generated automatically. A user-editable storefront domain,
  persisted seller product catalog, taxes/shipping, order fulfillment/refunds,
  and a branded post-purchase success page remain product TODOs.
- The sample's seller subscription status is mirrored into
  `stripe_connect_subscriptions`; entitlements or paid seller features still
  need to be connected to that state if the product introduces them.

## Local webhook development

Use two Stripe CLI listeners with test credentials and configure Supabase
function secrets for the corresponding CLI `whsec_` values. Verify the exact
thin-event filter names available to the platform in Stripe Workbench before
using them in production. For platform subscription billing, use a test recurring
price and verify status changes from the signed snapshot webhook, not the
Checkout return URL.

Official references: [Stripe Accounts v2](https://docs.stripe.com/connect/accounts-v2),
[V2 event destinations](https://docs.stripe.com/event-destinations),
[Checkout](https://docs.stripe.com/checkout), and
[billing portal](https://docs.stripe.com/customer-management).
