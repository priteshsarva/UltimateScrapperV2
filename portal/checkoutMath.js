// Checkout money math for storefront orders: given a subtotal, the chosen payment
// method, and the vendor's checkout config, return the final total and the
// online-vs-COD split. SINGLE SOURCE OF TRUTH — the order route uses this, and the
// self-check at the bottom guards the arithmetic. Run: node portal/checkoutMath.js
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const CHECKOUT_METHODS = ["prepaid", "cod", "semicod"];

// cfg = site_settings.checkout:
//   { methods:{prepaid,cod,semicod}, default, cod_fee, prepaid_discount,
//     advance_type:'percent'|'fixed', advance_value }
export function enabledMethods(cfg = {}) {
  const m = (cfg && cfg.methods) || {};
  const on = CHECKOUT_METHODS.filter((k) => m[k]);
  // A store that never configured this keeps today's behaviour: prepaid only.
  return on.length ? on : ["prepaid"];
}

export function resolveMethod(requested, cfg = {}) {
  const on = enabledMethods(cfg);
  if (requested && on.includes(requested)) return requested;
  if (cfg && cfg.default && on.includes(cfg.default)) return cfg.default;
  return on[0];
}

export function computeCheckout(subtotal, method, cfg = {}) {
  subtotal = round2(subtotal);
  method = CHECKOUT_METHODS.includes(method) ? method : "prepaid";
  const codFee = Math.max(0, round2(cfg.cod_fee));
  const prepaidDisc = Math.max(0, round2(cfg.prepaid_discount));

  let cod_fee = 0, prepaid_discount = 0;
  if (method === "prepaid") prepaid_discount = Math.min(prepaidDisc, subtotal);
  else cod_fee = codFee;                       // cod AND semicod carry the COD fee
  const total = round2(subtotal + cod_fee - prepaid_discount);

  let online_amount, cod_due;
  if (method === "prepaid") { online_amount = total; cod_due = 0; }
  else if (method === "cod") { online_amount = 0; cod_due = total; }
  else {                                        // semicod: advance online, rest as COD
    const type = cfg.advance_type === "fixed" ? "fixed" : "percent";
    const val = Math.max(0, Number(cfg.advance_value) || 0);
    let adv = type === "fixed" ? val : (total * val) / 100;
    adv = round2(Math.min(Math.max(adv, 0), total));   // never below 0 or above total
    online_amount = adv; cod_due = round2(total - adv);
  }
  return { method, subtotal, total, cod_fee, prepaid_discount, online_amount, cod_due };
}

// ---- self-check ----
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("portal/checkoutMath.js")) {
  const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  let r = computeCheckout(1000, "prepaid", { prepaid_discount: 50 });
  ok(r.total === 950 && r.online_amount === 950 && r.cod_due === 0, "prepaid discount");
  r = computeCheckout(1000, "cod", { cod_fee: 30 });
  ok(r.total === 1030 && r.online_amount === 0 && r.cod_due === 1030, "cod fee");
  r = computeCheckout(1000, "semicod", { cod_fee: 30, advance_type: "percent", advance_value: 20 });
  ok(r.total === 1030 && r.online_amount === 206 && r.cod_due === 824, "semicod percent");
  r = computeCheckout(1000, "semicod", { advance_type: "fixed", advance_value: 100 });
  ok(r.total === 1000 && r.online_amount === 100 && r.cod_due === 900, "semicod fixed");
  r = computeCheckout(1000, "semicod", { advance_type: "fixed", advance_value: 5000 });
  ok(r.online_amount === 1000 && r.cod_due === 0, "semicod advance capped at total");
  r = computeCheckout(1000, "cod", {});   // unconfigured → prepaid-only fallback still prices cod cleanly
  ok(r.total === 1000 && r.cod_due === 1000, "cod no fee");
  console.log("checkoutMath OK");
}
