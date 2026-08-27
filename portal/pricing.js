// Server-side sell-price calculation for hosted storefronts. Never trust a price
// computed in the browser — the old site/src/data/data.jsx did the markup
// client-side, which meant anyone could read the formula and it couldn't be
// trusted at checkout. Same bands, same math, moved server-side.
// A vendor can override the bands via site_settings.pricing = { bands: [...] }.
const DEFAULT_BANDS = [
  { min: 0,    max: 500,      add: 750 },
  { min: 500,  max: 4500,     add: 1000 },
  { min: 4500, max: 6000,     add: 1250 },
  { min: 6000, max: Infinity, add: 1500 },
];

const round2 = (n) => Math.round(n * 100) / 100;

// Normalise whatever the vendor editor produced into clean, sorted bands.
// A blank/null max means "no upper limit" (Infinity) — the old code left it null,
// and `price <= null` coerces to `price <= 0` which is always false, so a blank
// max on any row but the last silently fell through to the last band's markup.
export function resolveBands(pricingConfig) {
  const raw = pricingConfig && Array.isArray(pricingConfig.bands) && pricingConfig.bands.length
    ? pricingConfig.bands
    : DEFAULT_BANDS;
  return raw
    .map((b) => ({
      min: Number(b.min) || 0,
      max: (b.max == null || b.max === "" || !isFinite(Number(b.max))) ? Infinity : Number(b.max),
      add: Number(b.add) || 0,
    }))
    .sort((a, b) => a.min - b.min);
}

function bandFor(price, bands) {
  return bands.find((b) => price > b.min && price <= b.max) || bands[bands.length - 1];
}

// -> { price, mrp, savings_pct }. price = what the buyer pays. mrp = the
// struck-through reference price shown next to it (cosmetic, same as before).
export function priceProduct(originalPrice, pricingConfig) {
  const base = Number(originalPrice) || 0;
  if (base <= 0) return { price: 0, mrp: 0, savings_pct: 0 };

  const band = bandFor(base, resolveBands(pricingConfig));

  const price = round2(base + band.add);
  const mrp = round2(base * 1.5 + band.add);
  const savings_pct = mrp > 0 ? Math.round(((mrp - price) / mrp) * 100) : 0;
  return { price, mrp, savings_pct };
}

// A SQLite expression for the DISPLAYED (marked-up) price of a row, built from
// the vendor's bands. Lets the products query filter/sort by the price the
// shopper actually sees — not the raw scraped cost — while staying in SQL so
// keyset pagination still works. `col` is the price column (productOriginalPrice).
export function priceSqlExpr(pricingConfig, col = "CAST(productOriginalPrice AS REAL)") {
  const bands = resolveBands(pricingConfig);
  // CASE WHEN base > minA AND base <= maxA THEN base+addA ... ELSE base+lastAdd END
  const whens = bands
    .filter((b) => b.max !== Infinity)
    .map((b) => `WHEN ${col} > ${b.min} AND ${col} <= ${b.max} THEN ${col} + ${b.add}`)
    .join(" ");
  const lastAdd = bands[bands.length - 1].add;
  return `(CASE ${whens} ELSE ${col} + ${lastAdd} END)`;
}
