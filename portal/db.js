// Postgres connection pool (Supabase).
// DATABASE_URL comes from .env — use the Supabase "Connection Pooling"
// string (Session mode), see portal/README.md.
import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase requires SSL
  max: 10,
});

export const query = (text, params) => pool.query(text, params);

pool.on("error", (err) => console.error("Postgres pool error:", err));
