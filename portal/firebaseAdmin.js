// Firebase Admin — verifies phone-auth ID tokens minted by the client SDK.
// Lazy init: only touches firebase-admin when a service account is configured,
// so the server (and the dev OTP fallback) run fine without Firebase.
//
// Configure in .env.local (NOT .env — that file is git-committed by the server):
//   FIREBASE_SERVICE_ACCOUNT=/absolute/path/to/serviceAccountKey.json
import fs from "fs";

let app = null;
let tried = false;

async function ensureApp() {
  if (app) return app;
  if (tried) return null;      // already failed once — don't spam
  tried = true;
  const p = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!p || !fs.existsSync(p)) { console.warn("[firebase] FIREBASE_SERVICE_ACCOUNT not set/found — Firebase auth disabled"); return null; }
  try {
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const cred = JSON.parse(fs.readFileSync(p, "utf8"));
    app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(cred) });
    return app;
  } catch (e) { console.error("[firebase] init failed:", e.message); return null; }
}

export async function verifyFirebaseIdToken(idToken) {
  const a = await ensureApp();
  if (!a) throw new Error("Firebase not configured");
  const { getAuth } = await import("firebase-admin/auth");
  return getAuth(a).verifyIdToken(idToken);   // { phone_number, uid, ... }
}
