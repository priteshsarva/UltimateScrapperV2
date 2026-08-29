// Preset layouts for the hosted storefront. Mirrors site/src/components/sections/presets.js
// so both surfaces (the storefront's fallback + the portal's "apply preset"
// endpoint) share one source of truth for the shipped presets.
// ponytail: two shipped presets, no editor UI. Add more presets by adding an
// entry here + the matching sections array; that's the extension point.

const COMMERCE = [
  { type: "banner", props: { height: "md", overlay: 35, text_color: "light" } },
  { type: "categories", title: "Shop by Category", wrap: { padding: "lg" } },
  { type: "brands", title: "Shop by Brand", wrap: { padding: "lg" } },
  { type: "products", title: "Best Sellers", wrap: { padding: "md" }, props: { style: "rail", limit: 8 } },
  // Claim-free labels only. A preset must never publish a delivery/returns
  // PROMISE on a vendor's behalf — the vendor's real terms live in their
  // policies, and a shopper can hold them to whatever this says.
  { type: "features", wrap: { padding: "md", bg_color: "#F7F8FB" }, props: {
    items: [
      { icon: "Truck", title: "Shipping" },
      { icon: "ShieldCheck", title: "Secure Checkout" },
      { icon: "RotateCcw", title: "Returns" },
      { icon: "Headphones", title: "Support" },
    ],
    columns: 4,
  } },
  // Empty on purpose: Testimonials self-hides until the vendor adds REAL ones.
  // Shipping invented five-star reviews under a vendor's brand is a
  // consumer-protection problem for them and for the platform.
  { type: "testimonials", title: "What our customers say", wrap: { padding: "lg" }, props: { items: [] } },
  { type: "cta", wrap: { padding: "md" }, props: {
    title: "Not sure what to pick?",
    subtitle: "Chat with us on WhatsApp — we'll help you find the right piece.",
    cta_text: "Talk to us", cta_link: "/",
  } },
];

const SHOWCASE = [
  { type: "banner", props: { height: "lg", overlay: 40, text_color: "light" } },
  // no first-person copy here either — the vendor's own "About" text fills this
  // in from site_settings; an empty text block self-hides.
  { type: "text", wrap: { padding: "lg" }, props: { text: "", align: "center" } },
  { type: "products", title: "This Month's Picks", wrap: { padding: "md" }, props: { style: "grid", limit: 8 } },
  { type: "banner_grid", wrap: { padding: "md" }, props: {
    tiles: [
      { title: "New Arrivals", subtitle: "Fresh in", cta_text: "Shop new", cta_link: "/" },
      { title: "Best Sellers", subtitle: "Customer favourites", cta_text: "Explore", cta_link: "/" },
    ],
  } },
  { type: "features", wrap: { padding: "md", bg_color: "#F7F8FB" }, props: {
    items: [
      { icon: "Truck", title: "Shipping" },
      { icon: "Headphones", title: "WhatsApp Support" },
      { icon: "RotateCcw", title: "Returns" },
    ],
    columns: 3,
  } },
];

export const PRESETS = {
  commerce: { name: "Commerce classic", description: "Hero + categories + best sellers + trust strip + testimonials + CTA. The everything-you-need home for most stores.", sections: COMMERCE },
  showcase: { name: "Showcase",        description: "Big hero, curated grid, promo pair. Better for a single-focus, gallery-style store.", sections: SHOWCASE },
};
