#!/usr/bin/env bash
# ============================================================================
# Server Products — API smoke test
# Fill in the CONFIG block, then run:  bash smoke-test.sh
# Read-only except the domain-verify check (harmless). Does not approve/charge.
# ============================================================================

# ----------------------------- CONFIG ---------------------------------------
SERVER="${SERVER:-http://localhost:3002}"
CLIENT_EMAIL="${CLIENT_EMAIL:-a@b.com}"
CLIENT_PASS="${CLIENT_PASS:-}"            # <-- set client password
ADMIN_EMAIL="${ADMIN_EMAIL:-}"           # <-- set admin email
ADMIN_PASS="${ADMIN_PASS:-}"             # <-- set admin password
KEY="${KEY:-spp_live_ec3fc3017e705a0f56f6ed1a}"   # an enrollment key
# ----------------------------------------------------------------------------

PASS=0; FAIL=0; WARN=0
ok(){   echo "  ✅ $1"; PASS=$((PASS+1)); }
no(){   echo "  ❌ $1${2:+  → $2}"; FAIL=$((FAIL+1)); }
warn(){ echo "  ⚠️  $1"; WARN=$((WARN+1)); }
hr(){   echo; echo "──── $1 ────"; }
field(){ grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed "s/\"$1\":\"//;s/\"$//"; }
httpcode(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }

hr "0. Server reachable"
if [ "$(httpcode "$SERVER/")" != "000" ]; then ok "server responds at $SERVER"; else no "server unreachable at $SERVER"; echo "Aborting."; exit 1; fi

# ---- auth ----
hr "1. Auth"
CT=""
if [ -n "$CLIENT_PASS" ]; then
  CT=$(curl -s -X POST "$SERVER/auth/login" -H "Content-Type: application/json" \
        -d "{\"email\":\"$CLIENT_EMAIL\",\"password\":\"$CLIENT_PASS\"}" | field token)
  [ -n "$CT" ] && ok "client login ($CLIENT_EMAIL)" || no "client login failed"
else warn "CLIENT_PASS not set — skipping client-authed checks"; fi

AT=""
if [ -n "$ADMIN_PASS" ] && [ -n "$ADMIN_EMAIL" ]; then
  AT=$(curl -s -X POST "$SERVER/auth/login" -H "Content-Type: application/json" \
        -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | field token)
  [ -n "$AT" ] && ok "admin login ($ADMIN_EMAIL)" || no "admin login failed"
else warn "ADMIN creds not set — skipping admin checks"; fi

# ---- sources registry ----
hr "2. Sources registry (cross-category)"
if [ -n "$CT" ]; then
  R=$(curl -s "$SERVER/portal/sources" -H "Authorization: Bearer $CT")
  echo "$R" | grep -q '"category"' && ok "GET /portal/sources returns sources" || no "sources empty" "$R"
  echo "$R" | grep -q '"watches"' && ok "watch sources present" || no "no watch sources"
  echo "$R" | grep -q '"shoes"'   && ok "shoe sources present (cross-category ready)" || warn "no shoe sources in registry"
fi

# ---- key status + domain ----
hr "3. Enrollment status (keyed)"
S=$(curl -s "$SERVER/product/status" -H "x-enrollment-key: $KEY")
echo "$S" | grep -q '"status"' && ok "GET /product/status works" || no "status failed" "$S"
DOMAIN=$(echo "$S" | field domain)
[ -n "$DOMAIN" ] && ok "registered domain: $DOMAIN" || warn "no domain on status"
echo "$S" | grep -q '"sources"' && ok "status lists enrolled sources" || no "no sources in status"

# ---- sync-feed: multi-source + cross-category ----
hr "4. sync-feed"
F=$(curl -s "$SERVER/product/sync-feed?by=id&after=0&limit=3" -H "x-enrollment-key: $KEY" -H "x-site-domain: $DOMAIN")
echo "$F" | grep -q '"productId"' && ok "sync-feed (no category, backward-compat) returns products" || no "sync-feed default empty" "$F"

W=$(curl -s "$SERVER/product/sync-feed?by=id&after=0&limit=3&category=watches" -H "x-enrollment-key: $KEY" -H "x-site-domain: $DOMAIN")
echo "$W" | grep -q '"productId"' && ok "sync-feed?category=watches returns products" || warn "no watch products (check attached sources)"

H=$(curl -s "$SERVER/product/sync-feed?by=id&after=0&limit=3&category=shoes" -H "x-enrollment-key: $KEY" -H "x-site-domain: $DOMAIN")
echo "$H" | grep -q '"productId"' && ok "sync-feed?category=shoes returns products" || warn "no shoe products (attach a shoe source to test cross-category)"

# ---- domain lock ----
hr "5. Domain lock"
C=$(httpcode "$SERVER/product/sync-feed?by=id&after=0&limit=1&category=watches" -H "x-enrollment-key: $KEY" -H "x-site-domain: not-your-domain.example.com")
[ "$C" = "403" ] && ok "wrong domain rejected (HTTP 403)" || no "domain lock NOT enforced" "got HTTP $C"

BAD=$(httpcode "$SERVER/product/status" -H "x-enrollment-key: spp_live_deadbeefdeadbeefdeadbeef")
[ "$BAD" = "401" ] && ok "invalid key rejected (HTTP 401)" || warn "invalid key returned HTTP $BAD"

# ---- admin overview + verification fields ----
hr "6. Admin enrollment overview"
if [ -n "$AT" ]; then
  O=$(curl -s "$SERVER/portal/admin/enrollment-overview" -H "Authorization: Bearer $AT")
  echo "$O" | grep -q '"enrollments"' && ok "admin overview works" || no "admin overview failed" "$O"
  echo "$O" | grep -q '"days_left"' && ok "overview shows days_left" || warn "no days_left field"
  echo "$O" | grep -q 'domain_verified' && ok "overview exposes verification state" || warn "no domain_verified field (run domain_verification.sql?)"
  echo "$O" | grep -q 'last_seen_domain' && ok "overview exposes domain usage tracking" || warn "no last_seen_domain (run domain_usage_tracking.sql?)"
fi

# ---- plans ----
hr "7. Plans"
if [ -n "$CT" ]; then
  P=$(curl -s "$SERVER/portal/plans" -H "Authorization: Bearer $CT")
  echo "$P" | grep -q '"plans"' && ok "GET /portal/plans works" || no "plans endpoint failed" "$P"
  echo "$P" | grep -q '1000' && ok "₹1000 plan present" || warn "no 1000 plan — create it before billing tests"
fi

# ---- billing (engine deployed; UI pending) ----
hr "8. Billing endpoints"
if [ -n "$CT" ]; then
  I=$(curl -s "$SERVER/portal/invoices" -H "Authorization: Bearer $CT")
  echo "$I" | grep -q '"invoices"' && ok "GET /portal/invoices works" || no "invoices endpoint failed" "$I"
fi

# ---- summary ----
hr "RESULT"
echo "  PASS: $PASS   FAIL: $FAIL   WARN: $WARN"
[ "$FAIL" = "0" ] && echo "  🎉 all hard checks passed" || echo "  ⛔ $FAIL check(s) failed — see above"
