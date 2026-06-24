import fetch from "node-fetch";
import "dotenv/config";
import { DB } from "../connect.js";

const WP_URL = process.env.WP_URL;
const WP_CONSUMER_KEY = process.env.WP_CONSUMER_KEY;
const WP_CONSUMER_SECRET = process.env.WP_CONSUMER_SECRET;

function getAuthHeader() {
  const auth = Buffer.from(`${WP_CONSUMER_KEY}:${WP_CONSUMER_SECRET}`).toString("base64");
  return `Basic ${auth}`;
}

// ---------------- CATEGORY HELPERS ----------------
async function getCategoryByName(name) {
  if (!name) return null;
  try {
    const res = await fetch(`${WP_URL}/wp-json/wc/v3/products/categories?search=${encodeURIComponent(name)}`, {
      headers: { Authorization: getAuthHeader() },
    });
    const data = await res.json();
    return data.length > 0 ? data[0] : null;
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
      console.log(`✅ Category created: ${name} (ID: ${data.id})`);
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

// ---------------- PRODUCT HELPERS ----------------
async function getProductBySKU(sku) {
  try {
    const res = await fetch(`${WP_URL}/wp-json/wc/v3/products?sku=${sku}`, {
      headers: { Authorization: getAuthHeader() },
    });
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (err) {
    console.error("❌ Error checking product by SKU:", err);
    return null;
  }
}

// =================================================
// ========== INSERT PRODUCT TO WORDPRESS ==========
// =================================================
export async function insertProductToWP(product) {
  console.log("from insertProductToWP");
  
  try {
    const sku = product.productId?.toString();
    if (!sku) {
      console.warn(`⚠️ Skipping WP insert — missing productId: ${product.productName}`);
      return;
    }

    const existing = await getProductBySKU(sku);
    if (existing) {
      console.log(`ℹ️ Product with SKU ${sku} already exists in WP, skipping insert.`);
      return;
    }

    const categoryId = await getOrCreateCategory(product.catName);

    // handle image parsing safely
    let images = [];
    try {
      const imgs = Array.isArray(product.imageUrl)
        ? product.imageUrl
        : JSON.parse(product.imageUrl || "[]");
      if (imgs?.length) images = imgs.map((src) => ({ src }));
    } catch {
      if (product.featuredimg) images.push({ src: product.featuredimg });
    }

    const inStock = product.availability && product.availability !== "0" && product.availability !== false;
    const stockStatus = inStock ? "instock" : "outofstock";

    const regularPrice = ((parseFloat(product.productOriginalPrice) || 0) + 1200).toString();

    const payload = {
      name: product.productName,
      type: "simple",
      regular_price: regularPrice,
      sku,
      description: product.productDescription || "",
      short_description: product.productShortDescription || "",
      categories: categoryId ? [{ id: categoryId }] : [],
      stock_status: stockStatus,
      images,
      meta_data: [
        { key: "productFetchedFrom", value: product.productFetchedFrom },
        { key: "videoUrl", value: product.videoUrl || "" },
        { key: "availability", value: stockStatus },
        { key: "productOriginalPrice", value: product.productOriginalPrice },
        { key: "featuredimg", value: product.featuredimg },
        { key: "imageUrl", value: product.imageUrl },
        { key: "productBrand", value: product.productBrand },
        { key: "productShortDescription", value: product.productShortDescription },
        { key: "productDescription", value: product.productDescription },
      ],
    };

    const res = await fetch(`${WP_URL}/wp-json/wc/v3/products`, {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (res.ok) {
      console.log(`✅ Created WP product: ${data.name} (ID: ${data.id})`);
    } else {
      console.error("❌ WooCommerce Insert Error:", data);
    }
  } catch (err) {
    console.error("❌ Unexpected error in insertProductToWP:", err);
  }
}

// =================================================
// ========== UPDATE PRODUCT TO WORDPRESS ==========
// =================================================
export async function updateProductToWP(product) {
  console.log("from updateProductToWP");
  
  try {
    const sku = product.productId?.toString();
    if (!sku) {
      console.warn(`⚠️ Skipping WP update — missing productId: ${product.productName}`);
      return;
    }

    const existing = await getProductBySKU(sku);
    if (!existing) {
      console.log(`⚠️ Product not found in WP, inserting new one...`);
      return await insertProductToWP(product);
    }

    const categoryId = await getOrCreateCategory(product.catName);

    const inStock = product.availability && product.availability !== "0" && product.availability !== false;
    const stockStatus = inStock ? "instock" : "outofstock";
    const regularPrice = ((parseFloat(product.productOriginalPrice) || 0) + 1200).toString();

    const payload = {
      // name: product.productName,
      // regular_price: regularPrice,
      stock_status: stockStatus,
      // categories: categoryId ? [{ id: categoryId }] : [],
      meta_data: [
        { key: "productFetchedFrom", value: product.productFetchedFrom },
        { key: "videoUrl", value: product.videoUrl || "" },
        { key: "availability", value: stockStatus },
        { key: "productOriginalPrice", value: product.productOriginalPrice },
        { key: "featuredimg", value: product.featuredimg },
        { key: "imageUrl", value: product.imageUrl },
        { key: "productBrand", value: product.productBrand },
        { key: "productShortDescription", value: product.productShortDescription },
        { key: "productDescription", value: product.productDescription },
      ],
    };

    const res = await fetch(`${WP_URL}/wp-json/wc/v3/products/${existing.id}`, {
      method: "PUT",
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (res.ok) {
      console.log(`✅ Updated WP product: ${data.name} (ID: ${data.id})`);
    } else {
      console.error("❌ WooCommerce Update Error:", data);
    }
  } catch (err) {
    console.error("❌ Unexpected error in updateProductToWP:", err);
  }
}
