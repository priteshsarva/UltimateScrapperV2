// Sample renders of every transactional email, for the admin Email-settings
// preview. Uses the same build*() functions the real senders use, so the preview
// is exactly what customers/vendors receive.
import { buildCustomerOrderEmail, buildVendorOrderEmail, buildPayoutEmail } from "./orderEmails.js";

const BRAND = "Server Products";
const SAMPLE_ORDER = {
  order_no: "ORD-000123", total: 3298, subtotal: 3298, payment_status: "verified",
  buyer_name: "Deepak Nandu", buyer_phone: "+91 98205 24003", buyer_email: "buyer@example.com",
  address: { name: "Deepak Nandu", line1: "Meghraj Apt", line2: "Saraswati Baug Rd", city: "Mumbai", state: "Maharashtra", pincode: "400060", phone: "+91 98205 24003" },
};
const SAMPLE_ITEMS = [
  { product_name: "Seiko 5 Sports GMT Automatic", size: "", qty: 1, unit_price: 2350, line_total: 2350 },
  { product_name: "Air Jordan Retro 1", size: "9", qty: 1, unit_price: 948, line_total: 948 },
];

// [value, label] — value is what the API takes, label is what the admin sees.
export const EMAIL_TYPES = [
  ["placed", "Order received (customer)"],
  ["processing", "Order processing (customer)"],
  ["completed", "Order completed (customer)"],
  ["on-hold", "Order on hold (customer)"],
  ["cancelled", "Order cancelled (customer)"],
  ["refunded", "Order refunded (customer)"],
  ["new_order", "New order (vendor/admin)"],
  ["payout_processing", "Payout processing (vendor)"],
  ["payout_paid", "Payout sent (vendor)"],
  ["payout_cancelled", "Payout cancelled (vendor)"],
];

const SAMPLE_CONTACT = { name: "AB Store", email: "hello@abstore.example", phone: "+91 90000 00303", whatsapp: "+91 90000 00303", address: { line1: "Shop 4, Vesu Main Rd", city: "Surat", state: "Gujarat", pincode: "394010" } };

export function renderSampleEmail(type) {
  if (type === "new_order") return buildVendorOrderEmail({ brand: "AB Store", order: SAMPLE_ORDER, items: SAMPLE_ITEMS, storeName: "AB Store", contact: SAMPLE_CONTACT });
  if (type?.startsWith("payout_")) {
    const kind = type.replace("payout_", "");
    return buildPayoutEmail(kind, { brand: BRAND, amount: 5400, utr: "AXIS123456789", note: "Bank details mismatch" });
  }
  const order = type === "placed" ? { ...SAMPLE_ORDER, payment_status: "unpaid" } : SAMPLE_ORDER;
  return buildCustomerOrderEmail(type, { brand: "AB Store", order, items: SAMPLE_ITEMS, contact: SAMPLE_CONTACT });
}
