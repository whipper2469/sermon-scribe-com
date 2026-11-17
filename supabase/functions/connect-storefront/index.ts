// deno-lint-ignore-file no-unversioned-import

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@23.1.0";
import { corsHeaders, escapeHtml, html, requiredEnv } from "../_shared/http.ts";
import { stripeClient } from "../_shared/stripe.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const slug = new URL(req.url).searchParams.get("slug") ?? "";
    if (!/^[a-f0-9]{20}$/.test(slug)) {
      return html("<!doctype html><h1>Store not found</h1>", 404);
    }
    const supabase = createClient(
      requiredEnv(
        "SUPABASE_URL",
        "Set the Supabase project URL for Edge Functions.",
      ),
      requiredEnv(
        "SUPABASE_SERVICE_ROLE_KEY",
        "Set the Supabase service-role secret for Edge Functions.",
      ),
    );
    const { data: account, error } = await supabase.from(
      "stripe_connect_accounts",
    )
      .select("account_id,store_name").eq("public_slug", slug).maybeSingle();
    if (error) throw error;
    if (!account) return html("<!doctype html><h1>Store not found</h1>", 404);
    const stripe = stripeClient();
    const result = await stripe.products.list({
      active: true,
      limit: 100,
      expand: ["data.default_price"],
    }, { stripeAccount: account.account_id });
    const products = result.data.filter((p) =>
      typeof p.default_price === "object" && p.default_price !== null &&
      p.default_price.active
    ).map((p) => {
      const price = p.default_price as Stripe.Price;
      const amount = new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency: price.currency.toUpperCase(),
      }).format((price.unit_amount ?? 0) / 100);
      return `<article><h2>${escapeHtml(p.name)}</h2><p>${
        escapeHtml(p.description)
      }</p><strong>${amount}</strong><button data-price="${
        escapeHtml(price.id)
      }">Buy securely</button></article>`;
    }).join("");
    const checkoutUrl = `${
      requiredEnv(
        "SUPABASE_URL",
        "Set the Supabase project URL for Edge Functions.",
      )
    }/functions/v1/connect-checkout`;
    return html(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${
        escapeHtml(account.store_name || "Sermon Scribe Store")
      }</title><style>body{font:16px system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#182335}h1{color:#142b4a}article{border:1px solid #dce3ec;border-radius:14px;padding:20px;margin:16px 0}button{display:block;margin-top:16px;padding:11px 16px;border:0;border-radius:8px;background:#2459d3;color:#fff;font-weight:600;cursor:pointer}p{color:#657386}</style><h1>${
        escapeHtml(account.store_name || "Sermon Scribe Store")
      }</h1>${
        products || "<p>No products are available yet.</p>"
      }<script>document.querySelectorAll("button[data-price]").forEach(b=>b.onclick=async()=>{b.disabled=true;try{const r=await fetch(${
        JSON.stringify(checkoutUrl)
      },{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({slug:${
        JSON.stringify(slug)
      },priceId:b.dataset.price})});const d=await r.json();if(!r.ok)throw Error(d.error||"Checkout unavailable");location.href=d.url}catch(e){alert(e.message);b.disabled=false}})</script></html>`,
    );
  } catch (err) {
    console.error("connect-storefront failed:", (err as Error)?.message);
    return html("<!doctype html><h1>Store temporarily unavailable</h1>", 500);
  }
});
