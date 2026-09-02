// Shopper (buyer) auth for hosted storefronts — deliberately separate from the
// portal's auth.js. A customer JWT is signed with its own secret and carries
// enrollmentId, so it can never pass requireAuth on vendor/admin routes, and a
// vendor A customer token can never be accepted on vendor B's store.
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import "dotenv/config";

const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || "change-me-customer-secret";
const CUSTOMER_JWT_EXPIRES = "30d";

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const comparePassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signCustomerToken(customer) {
  return jwt.sign(
    { sub: customer.id, enrollmentId: customer.enrollment_id, email: customer.email },
    CUSTOMER_JWT_SECRET,
    { expiresIn: CUSTOMER_JWT_EXPIRES }
  );
}

// Preview unlock token — proves the holder entered the store's preview password,
// so a not-yet-live store can be viewed. Scoped to one enrollment.
export function signPreviewToken(enrollmentId) {
  return jwt.sign({ preview: true, enrollmentId }, CUSTOMER_JWT_SECRET, { expiresIn: "7d" });
}
export function verifyPreviewToken(token, enrollmentId) {
  try {
    const p = jwt.verify(String(token || ""), CUSTOMER_JWT_SECRET);
    return p.preview === true && p.enrollmentId === enrollmentId;
  } catch { return false; }
}

// Attaches req.customer if a valid token for THIS store is present; never blocks
// (guest checkout is allowed). Must run after resolveStore. Routes that require
// login chain requireCustomer after this.
export function identifyCustomer(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, CUSTOMER_JWT_SECRET);
      if (payload.enrollmentId === req.storeEnrollment.id) req.customer = payload;
    } catch { /* bad/expired token -> treat as guest */ }
  }
  next();
}

export function requireCustomer(req, res, next) {
  if (!req.customer) return res.status(401).json({ error: "Please log in" });
  next();
}
