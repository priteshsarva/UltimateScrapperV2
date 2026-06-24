// Enrollment-key generation + small date helpers.
import crypto from "crypto";

export const generateEnrollmentKey = () =>
  "spp_live_" + crypto.randomBytes(12).toString("hex");

export const todayISO = () => new Date().toISOString().slice(0, 10);

// add one calendar month to a date (Date | ISO string) -> 'YYYY-MM-DD'
export function addMonth(base) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// normalize a pg DATE (returned as Date) -> 'YYYY-MM-DD'
export const dateISO = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
