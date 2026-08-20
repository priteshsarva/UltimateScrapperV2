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

function bandFor(price, bands) {
  return bands.find((b) => price > b.min && price <= b.max) || bands[bands.length - 1];
}

// -> { price, mrp, savings_pct }. price = what the buyer pays. mrp = the
// struck-through reference price shown next to it (cosmetic, same as before).
export function priceProduct(originalPrice, pricingConfig) {
  const base = Number(originalPrice) || 0;
  if (base <= 0) return { price: 0, mrp: 0, savings_pct: 0 };

  const bands = pricingConfig && Array.isArray(pricingConfig.bands) && pricingConfig.bands.length
    ? pricingConfig.bands
    : DEFAULT_BANDS;
  const band = bandFor(base, bands);

  const price = round2(base + band.add);
  const mrp = round2(base * 1.5 + band.add);
  const savings_pct = mrp > 0 ? Math.round(((mrp - price) / mrp) * 100) : 0;
  return { price, mrp, savings_pct };
}
