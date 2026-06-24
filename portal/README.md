# Portal backend — auth + enrollment-key spine

Drop-in files for your existing Express server (ES modules). This slice gives you:
client signup/login (JWT), the single admin, per-site enrollments that issue a key,
admin approve/activate, and `requireEnrollmentKey` — the middleware that **replaces
`x-client-id`** for the plugin.

## 1. Install deps
```bash
npm install pg jsonwebtoken bcryptjs
```

## 2. Env
Copy the vars from `.env.example` into your server's `.env`.
- `DATABASE_URL` — Supabase **Connection Pooling (Session)** string. Dashboard →
  Project Settings → Database → Connection string → **Session pooler**. (SSL is
  handled in `db.js`, so you don't need `?sslmode=` on the URL.)
- `JWT_SECRET` — any long random string.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — your one admin login.

## 3. Put these files in `portal/` inside your server
(They only import each other + the deps above.)

## 4. Wire into `index.js`
```js
import express from "express";
import authRoutes from "./portal/authRoutes.js";
import enrollmentRoutes from "./portal/enrollmentRoutes.js";
import adminRoutes from "./portal/adminRoutes.js";

app.use(express.json());            // if you aren't already parsing JSON

app.use("/auth", authRoutes);       // /auth/signup, /auth/login, /auth/me
app.use("/portal/admin", adminRoutes);  // mount admin BEFORE the client router
app.use("/portal", enrollmentRoutes);   // /portal/enrollments ...
```
Make sure CORS allows your portal's origin (you already use the `cors` package).

## 5. Seed the admin (once)
```bash
node portal/createAdmin.js
```

## 6. You need at least one source row to enroll against
`enrollments.source_id` is a FK to `sources`. Insert one to test (use a real id
from your sites registry):
```sql
insert into sources (id, name, category, method, base_url, search_key, status)
values ('shoemartt','Shoe Martt','shoes','METHOD_A','https://shoemartt.example/','shoemartt','active')
on conflict (id) do nothing;
```
(Bulk-importing your full SITES_REGISTRY into `sources` is a later step.)

## 7. Test the whole flow with curl
```bash
# signup a client
curl -s localhost:3002/auth/signup -H "Content-Type: application/json" \
  -d '{"email":"a@b.com","password":"pass1234","name":"Test"}'
# -> { token, user }   (save the token)

TOKEN=<paste client token>

# enroll a site (issues a key, status 'pending')
curl -s localhost:3002/portal/enrollments -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"domain":"shop.test.com","source_id":"shoemartt"}'
# -> { enrollment: { enrollment_key: "spp_live_...", status:"pending" } }

# login as admin
curl -s localhost:3002/auth/login -H "Content-Type: application/json" \
  -d '{"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}'
ADMIN=<paste admin token>

# see the queue, then approve + activate (use the enrollment id)
curl -s "localhost:3002/portal/admin/enrollments?status=pending" -H "Authorization: Bearer $ADMIN"
curl -s -X POST localhost:3002/portal/admin/enrollments/<ID>/approve  -H "Authorization: Bearer $ADMIN"
curl -s -X POST localhost:3002/portal/admin/enrollments/<ID>/activate -H "Authorization: Bearer $ADMIN"
# -> { ok:true, expiry_date: <one month out> }
```
After activate, the `enrollment_key` is live and will pass `requireEnrollmentKey`.

## What's next (not in this slice)
- Put `requireEnrollmentKey` on `sync-feed` and filter by `req.enrollment`
  (sourceCategory → live DB, categories → allow-list, live DBs only).
- Switch the **plugin** to send `x-enrollment-key` instead of `x-client-id`.
- Universal search endpoint (live + archive). Scrape-requests → sources. Pay0.
