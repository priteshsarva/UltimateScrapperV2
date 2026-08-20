// Preset layouts for the hosted storefront. Mirrors site/src/components/sections/presets.js
// so both surfaces (the storefront's fallback + the portal's "apply preset"
// endpoint) share one source of truth for the shipped presets.
// ponytail: two shipped presets, no editor UI. Add more presets by adding an
// entry here + the matching sections array; that's the extension point.

const COMMERCE = [
  { type: "banner", props: { height: "md", overlay: 35, text_color: "light" } },
  { type: "categories", title: "Shop by Category", wrap: { padding: "lg" } },
  { type: "products", title: "Best Sellers", wrap: { padding: "md" }, props: { style: "rail", limit: 8 } },
  { type: "features", wrap: { padding: "md", bg_color: "#F7F8FB" }, props: {
    items: [
      { icon: "Truck", title: "Fast Shipping", text: "Delivered across India in 3–5 days" },
      { icon: "ShieldCheck", title: "Secure Checkout", text: "Every order handled personally on WhatsApp" },
      { icon: "RotateCcw", title: "Easy Returns", text: "7-day return window, no questions asked" },
      { icon: "Headphones", title: "Real Support", text: "Talk to a human, not a bot" },
    ],
    columns: 4,
  } },
  { type: "testimonials", title: "Loved by our customers", wrap: { padding: "lg" }, props: {
    items: [
      { quote: "Genuinely felt like a boutique experience. Quick replies, quick delivery.", author: "Priya S.", role: "Bengaluru", stars: 5 },
      { quote: "The order came exactly as shown. Packaging was thoughtful too.", author: "Rahul M.", role: "Mumbai", stars: 5 },
      { quote: "Best price I found anywhere, and the WhatsApp support made checkout easy.", author: "Anita K.", role: "Delhi", stars: 5 },
    ],
  } },
  { type: "cta", wrap: { padding: "md" }, props: {
    title: "Not sure what to pick?",
    subtitle: "Chat with us on WhatsApp — we'll help you find the right piece.",
    cta_text: "Talk to us", cta_link: "/",
  } },
];

const SHOWCASE = [
  { type: "banner", props: { height: "lg", overlay: 40, text_color: "light" } },
  { type: "text", wrap: { padding: "lg" }, props: {
    text: "A curated selection of pieces we personally love — no filler, no clutter.",
    align: "center",
  } },
  { type: "products", title: "This Month's Picks", wrap: { padding: "md" }, props: { style: "grid", limit: 8 } },
  { type: "banner_grid", wrap: { padding: "md" }, props: {
    tiles: [
      { title: "New Arrivals", subtitle: "Fresh in", cta_text: "Shop new", cta_link: "/" },
      { title: "Best Sellers", subtitle: "Customer favourites", cta_text: "Explore", cta_link: "/" },
    ],
  } },
  { type: "features", wrap: { padding: "md", bg_color: "#F7F8FB" }, props: {
    items: [
      { icon: "Truck", title: "Free shipping", text: "On orders above ₹2000" },
      { icon: "Headphones", title: "WhatsApp support", text: "Real people, quick replies" },
      { icon: "RotateCcw", title: "Easy returns", text: "7 days, no questions" },
    ],
    columns: 3,
  } },
];

export const PRESETS = {
  commerce: { name: "Commerce classic", description: "Hero + categories + best sellers + trust strip + testimonials + CTA. The everything-you-need home for most stores.", sections: COMMERCE },
  showcase: { name: "Showcase",        description: "Big hero, curated grid, promo pair. Better for a single-focus, gallery-style store.", sections: SHOWCASE },
};
