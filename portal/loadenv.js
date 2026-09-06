// Load env BEFORE anything reads process.env. .env is committed (and the server
// auto-commits it via /updateserver), so real SECRETS go in .env.local, which is
// gitignored and overrides .env. Import this first in index.js.
import dotenv from "dotenv";
dotenv.config();                                        // .env (committed, non-secret defaults)
dotenv.config({ path: ".env.local", override: true });  // .env.local (gitignored secrets)
