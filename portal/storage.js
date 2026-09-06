// Object storage on Cloudflare R2 (S3-compatible). Product images are converted
// to WebP and capped in size; shipment parcel photos are kept as JPEG (evidence)
// and can be purged later. Everything is gated on env — if R2 isn't configured,
// isConfigured() is false and callers fall back to URL-paste, so nothing breaks
// before the keys are set.
//
// .env:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import crypto from "crypto";

const {
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  R2_BUCKET, R2_PUBLIC_URL,
} = process.env;

export const isConfigured = () => !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_URL);

let _client = null;
function client() {
  if (!_client) {
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
  }
  return _client;
}

const publicUrl = (key) => `${String(R2_PUBLIC_URL).replace(/\/+$/, "")}/${key}`;
const rand = () => crypto.randomBytes(8).toString("hex");

// Store a product image: resize to <=1200px, convert to WebP (~small + fast).
export async function putProductImage(buffer, prefix = "products") {
  if (!isConfigured()) throw new Error("Image storage is not configured yet.");
  const out = await sharp(buffer).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  const key = `${prefix}/${Date.now()}-${rand()}.webp`;
  await client().send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: out, ContentType: "image/webp" }));
  return { url: publicUrl(key), key };
}

// Store a shipment/parcel photo: keep as JPEG (evidence), capped at 1600px.
export async function putShipmentPhoto(buffer, prefix = "shipments") {
  if (!isConfigured()) throw new Error("Image storage is not configured yet.");
  const out = await sharp(buffer).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const key = `${prefix}/${Date.now()}-${rand()}.jpg`;
  await client().send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: out, ContentType: "image/jpeg" }));
  return { url: publicUrl(key), key };
}

export async function deleteObject(key) {
  if (!isConfigured() || !key) return;
  try { await client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); }
  catch (e) { console.error("[storage] delete failed", key, e.message); }
}
