// One-time admin seeder.   Run:  node portal/createAdmin.js
// Reads ADMIN_EMAIL + ADMIN_PASSWORD from .env and creates/updates the
// single admin with a proper bcrypt hash (never store plaintext).
import "dotenv/config";
import { query, pool } from "./db.js";
import { hashPassword } from "./auth.js";

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;

if (!email || !password) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
  process.exit(1);
}

const hash = await hashPassword(password);
await query(
  `insert into users (email, password_hash, name, role)
   values ($1,$2,'Owner','admin')
   on conflict (email) do update
     set password_hash = excluded.password_hash, role = 'admin'`,
  [email, hash]
);
console.log(`Admin ready: ${email}`);
await pool.end();
process.exit(0);
