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

const SITE_URL = () =>
  requiredEnv(
    "SITE_URL",
    "Set SITE_URL to the public HTTPS URL used for Connect return links.",
  );

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const { user, admin } = await signedInUser(req);
    const stripe = stripeClient();
    const { data: saved, error: readError } = await admin.from(
      "stripe_connect_accounts",
    )
      .select("account_id,public_slug").eq("user_id", user.id).maybeSingle();
    if (readError) throw readError;

    if (req.method === "GET") {
      if (!saved?.account_id) return json({ connected: false });
      // V2 account reads return requirement/capability detail only when requested.
      const accountResponse = await stripe.v2.core.accounts.retrieve(
        saved.account_id,
        {
          include: ["configuration.merchant", "requirements"],
        },
      );
      const account = accountResponse;
      const merchantStatus =
        account.configuration?.merchant?.capabilities?.card_payments?.status ??
          "unknown";
      const dueStatus =
        account.requirements?.summary?.minimum_deadline?.status ?? "unknown";
      return json({
        connected: true,
        accountId: saved.account_id,
        storefrontUrl: `${SITE_URL()}/functions/v1/connect-storefront?slug=${
          encodeURIComponent(saved.public_slug)
        }`,
        readyToProcessPayments: merchantStatus === "active",
        merchantCapability: merchantStatus,
        requirementsStatus: dueStatus,
        onboardingComplete: dueStatus !== "currently_due" &&
          dueStatus !== "past_due",
      });
    }
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const body = await req.json().catch(() => ({}));
    let accountId = saved?.account_id;
    let slug = saved?.public_slug;
    if (!accountId) {
      const country = typeof body.country === "string"
        ? body.country.toUpperCase()
        : (Deno.env.get("CONNECT_COUNTRY") ?? "CA");
      if (!/^[A-Z]{2}$/.test(country)) {
        return json(
          { error: "country must be an ISO 3166-1 alpha-2 code" },
          400,
        );
      }
      // V2 accounts use requested configurations and explicit responsibilities;
      // they do not accept the legacy top-level type=express/custom/standard.
      const displayName =
        String(body.displayName ?? "Sermon Scribe seller").trim().slice(
          0,
          100,
        ) || "Sermon Scribe seller";
      const account = await stripe.v2.core.accounts.create({
        display_name: displayName,
        contact_email: user.email,
        identity: { country },
        dashboard: "express",
        defaults: {
          responsibilities: {
            fees_collector: "application",
            losses_collector: "application",
          },
        },
        configuration: {
          customer: {}, // Required to use this connected account as a platform subscriber.
          merchant: { capabilities: { card_payments: { requested: true } } },
        },
      });
      accountId = account.id;
      slug = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
      const { error } = await admin.from("stripe_connect_accounts").insert({
        user_id: user.id,
        account_id: accountId,
        public_slug: slug,
        store_name: displayName,
      });
      if (error) throw error;
    }

    // Create a fresh, single-use hosted onboarding link for every request.
    const base = SITE_URL();
    const linkResponse = await stripe.v2.core.accountLinks.create({
      account: accountId!,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          refresh_url: `${base}/connect.html?connect=refresh`,
          return_url: `${base}/connect.html?connect=return`,
        },
      },
    });
    return json({ url: linkResponse.url, accountId, publicSlug: slug });
  } catch (err) {
    const rawMessage = (err as Error)?.message ?? "Unexpected error";
    const status =
      rawMessage.includes("Authorization") || rawMessage.includes("session")
        ? 401
        : 500;
    console.error("connect-account failed:", rawMessage);
    return json({ error: clientErrorMessage(err) }, status);
  }
});
