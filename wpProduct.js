// wpProduct.js
import fetch from "node-fetch";
import "dotenv/config";

const WP_URL = process.env.WP_URL;
const WP_CONSUMER_KEY = process.env.WP_CONSUMER_KEY;
const WP_CONSUMER_SECRET = process.env.WP_CONSUMER_SECRET;

function getAuthHeader() {
  const auth = Buffer.from(`${WP_CONSUMER_KEY}:${WP_CONSUMER_SECRET}`).toString("base64");
  return `Basic ${auth}`;
}

// ----------------- CATEGORY HELPERS -----------------
async function getCategoryByName(name) {
  try {
    const res = await fetch(
      `${WP_URL}/wp-json/wc/v3/products/categories?search=${encodeURIComponent(name)}`,
      { headers: { Authorization: getAuthHeader() } }
    );
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (err) {
    console.error("❌ Error fetching category:", err);
    return null;
  }
}

async function createCategory(name) {
  try {
    const res = await fetch(`${WP_URL}/wp-json/wc/v3/products/categories`, {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`✅ Created category: ${name} (ID: ${data.id})`);
      return data;
    } else {
      console.error("❌ Error creating category:", data);
      return null;
    }
  } catch (err) {
    console.error("❌ Unexpected error creating category:", err);
    return null;
  }
}

async function getOrCreateCategory(name) {
  let category = await getCategoryByName(name);
  if (!category) category = await createCategory(name);
  return category?.id || null;
}

// ----------------- PRODUCT HELPERS -----------------
async function getProductBySKU(sku) {
  try {
    const res = await fetch(`${WP_URL}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}`, {
      headers: { Authorization: getAuthHeader() },
    });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) return data[0];
    return null;
  } catch (err) {
    console.error("❌ Error checking product by SKU:", err);
    return null;
  }
}

// ----------------- MAIN UPSERT FUNCTION -----------------
export async function upsertProduct(product) {
  try {
    if (!product.productId) {
      console.log("⚠️ Skipping product — missing productId:", product.productName);
      return;
    }

    const sku = product.productId.toString();

    const existing = await getProductBySKU(sku);

    let method = "POST";
    let endpoint = `${WP_URL}/wp-json/wc/v3/products`;

    if (existing) {
      endpoint = `${WP_URL}/wp-json/wc/v3/products/${existing.id}`;
      method = "PUT";
      console.log(`🔄 Updating existing product: ${product.productName} (ID: ${existing.id})`);
    } else {
      console.log(`🆕 Creating new product: ${product.productName}`);
    }

    const categoryId = await getOrCreateCategory(product.catName);

    let images = [];
    try {
      const imgs = JSON.parse(product.imageUrl);
      images = imgs.map((src) => ({ src }));
    } catch {
      if (product.featuredimg) images.push({ src: product.featuredimg });
    }

    const regularPrice = ((product.productOriginalPrice || 0) + 1200).toString();

    const payload = {
      name: product.productName,
      type: "simple",
      regular_price: regularPrice,
      sku,
      description: product.productDescription || "",
      short_description: product.productShortDescription || "",
      categories: categoryId ? [{ id: categoryId }] : [],
      images,
      meta_data: [
        { key: "productFetchedFrom", value: product.productFetchedFrom },
        { key: "productUrl", value: product.productUrl },
        { key: "videoUrl", value: product.videoUrl || "" },
        { key: "availability", value: product.availability ? "instock" : "outofstock" },
        { key: "productOriginalPrice", value: product.productOriginalPrice },
      ],
    };

    const res = await fetch(endpoint, {
      method,
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (res.ok) {
      console.log(`✅ Product ${existing ? "updated" : "created"} successfully: ID ${data.id}`);
    } else {
      console.error("❌ WooCommerce API error:", data);
    }
  } catch (err) {
    console.error("❌ Unexpected error in upsertProduct:", err);
  }
}

// ----------------- TEST -----------------
const testProducts = [
  {
    productId: 30122,
    productName: "CASIO METAL",
    productOriginalPrice: 499,
    productFetchedFrom: "https://famwatch.cartpe.in/",
    productUrl: "https://famwatch.cartpe.in/casio-metal-famwatch8944.html?color=",
    featuredimg: "https://cdn.cartpe.in/images/gallery_sm/68e29b55ecf1c.jpeg",
    imageUrl: "[\"https://cdn.cartpe.in/images/gallery_md/68e29b55ecf1c.jpeg\"]",
    catName: "Mens Watch",
    availability: 1,
  },
];

// if (process.argv[1].includes("wpProduct.js")) {
//   (async () => {
//     console.log("🚀 Running test product sync...");
//     for (const p of testProducts) await upsertProduct(p);
//   })();
// }
