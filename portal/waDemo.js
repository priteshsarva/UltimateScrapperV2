// Free 7-day demo storefronts, built from a WhatsApp chat.
//
// The assistant collects a store name and what they sell, and this creates a REAL
// hosted store on the platform, live immediately, in the prospect's own name. It runs
// for DEMO_DAYS and then pauses itself unless they verify their mobile and buy a plan.
//
// Two deliberate choices, both to stay clear of the billing/scheduler machinery:
//   * plan_id stays NULL  -> portal/scheduler.js never invoices it (billingTick filters
//     on `plan_id is not null`).
//   * expiry_date stays NULL -> hostedExpiryTick, which does NOT filter on plan_id, never
//     sees it, so no "renew your store" emails or 5-day auto-pause. The 7 days are ours
//     to enforce, in expireDemos() below.
// The account is pre-created against their mobile the same way the OTP login does it, so
// when they later sign in with an OTP the row matches on the last 10 digits and the store
// is already theirs — no claiming step to build.
import crypto from "crypto";
import { query } from "./db.js";
import { generateEnrollmentKey } from "./keys.js";
import { PRESETS } from "./storefrontPresets.js";
import { sanitizeCategory } from "./sources.js";

const PLATFORM_HOST = (process.env.PLATFORM_HOST || "thekartify.com").toLowerCase().replace(/^\.+|\.+$/g, "");
export const DEMO_DAYS = Number(process.env.WA_DEMO_DAYS || 7);

const digits = (p) => String(p || "").replace(/\D/g, "");
// same shape the OTP login stores, so a later login finds this row: 10 digits -> 91XXXXXXXXXX
const canonMobile = (m) => { const d = digits(m); return d.length === 10 ? "91" + d : d; };

const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "").slice(0, 40) || "store";

async function uniqueSlug(base) {
  let slug = base, n = 1;
  while ((await query(`select 1 from enrollments where slug=$1`, [slug])).rowCount) slug = `${base}-${++n}`;
  return slug;
}

export const demoUrl = (slug) => `https://${slug}.${PLATFORM_HOST}`;

// Their account, by mobile. If they already have one (email signup or an earlier OTP
// login) we reuse it — never a second row for the same person.
async function userForPhone(phone, name) {
  const last10 = digits(phone).slice(-10);
  if (last10.length < 10) throw Object.assign(new Error("a 10-digit mobile is needed"), { status: 400 });
  const found = (await query(
    `select id from users where regexp_replace(coalesce(mobile,''), '[^0-9]', '', 'g') like $1
      order by created_at limit 1`, ["%" + last10])).rows[0];
  if (found) return found.id;
  // mobile_verified stays FALSE: they haven't proved this number yet. That is exactly what
  // they must do (OTP login) to keep the store past the demo window.
  return (await query(
    `insert into users (email, password_hash, name, role, mobile, status, mobile_verified, profile_complete)
     values (null, '', $1, 'client', $2, 'active', false, false) returning id`,
    [String(name || "").slice(0, 80) || null, canonMobile(phone)])).rows[0].id;
}

// Which suppliers a demo store carries. categories '{}' means "all of this source's categories".
//
// First choice is always the wholesaler THEY named. Their own supplier's goods on their own
// store is the whole hook, so the assistant asks for that link (knowledge/15-demo.md, detail 6)
// and it is kept in wa_leads.supplier_links. We can only attach a site we already crawl —
// one we've never seen has to be added and scraped first, so it comes back as `missing` and
// becomes a source request for the owner rather than a promise nobody actioned.
//
// No supplier named (or we don't have theirs): PER_CATEGORY at random from every category.
// Not all of them — a store carrying every supplier we have looks like a scrape, not a shop —
// and random so two demos built the same afternoon don't look like the same shop.
// ponytail: every category gets a share. If the catalogue grows past a handful of niches,
// narrow this to the categories their `sells` mentions.
const PER_CATEGORY = Number(process.env.WA_DEMO_SOURCES_PER_CATEGORY || 4);

const hostOf = (s) => String(s || "").trim().toLowerCase()
  .replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0];
// treat shop.x.com and x.com as the same wholesaler
const sameHost = (a, b) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

// `fill` is off when the store already exists: a supplier link that arrives two messages after
// the build still gets attached, but the random ones must NOT be added a second time.
async function attachSources(enrollmentId, { supplierLinks, userId, sells, fill = true }) {
  const wanted = [...new Set(String(supplierLinks || "").split(/[\s,;|]+/)
    .map(hostOf).filter((h) => /\.[a-z]{2,}$/.test(h)))];

  const theirs = wanted.length
    ? (await query(`select id, name, base_url from sources where status='active'`)).rows
        .filter((s) => wanted.some((w) => sameHost(hostOf(s.base_url), w)))
    : [];
  const missing = wanted.filter((w) => !theirs.some((s) => sameHost(hostOf(s.base_url), w)));

  const chosen = theirs.length ? theirs : !fill ? [] : (await query(
    `select id from (
       select id, row_number() over (partition by category order by random()) as rn
         from sources where status='active') s
      where rn <= $1`, [PER_CATEGORY])).rows;

  for (const s of chosen) {
    await query(
      `insert into enrollment_sources (enrollment_id, source_id, categories) values ($1,$2,'{}')
       on conflict (enrollment_id, source_id) do nothing`, [enrollmentId, s.id]);
  }
  // A wholesaler we don't crawl yet goes into the owner's existing source-approval queue.
  // "Site ka link bhej do, add kar dete hain" is a promise the platform can keep — but only
  // if it gets queued instead of sitting in a chat nobody re-reads. on conflict: the same
  // link mentioned twice in one conversation must not become two requests.
  for (const site of missing) {
    await query(
      `insert into scrape_requests (user_id, site_url, category)
       select $1,$2,$3 where not exists (
         select 1 from scrape_requests where user_id=$1 and site_url=$2 and status='pending')`,
      [userId, `https://${site}`, sanitizeCategory(sells) || "other"]
    ).catch((e) => console.error("[wa-demo] source request", site, e.message));
  }
  return { attached: chosen.length, theirs: theirs.map((s) => s.name), missing };
}

// -> { url, slug, expires_at, enrollment_id, user_id, sources, their_suppliers, pending_suppliers, reused }
export async function createDemoStore({ phone, name, store_name, sells, whatsapp, city, logo_url, supplier_links }) {
  const storeName = String(store_name || name || "").trim().slice(0, 60);
  if (!storeName) throw Object.assign(new Error("store_name required"), { status: 400 });

  // One live demo per number: a second "bana do" returns the same link instead of a new store.
  const existing = (await query(
    `select l.demo_slug, l.demo_expires_at, l.demo_enrollment_id, l.demo_user_id, e.status
       from wa_leads l join enrollments e on e.id = l.demo_enrollment_id
      where right(l.phone,10) = $1 and l.demo_expires_at > now() and e.status = 'active'`,
    [digits(phone).slice(-10)])).rows[0];
  if (existing) {
    // The demo is usually built as soon as the store name and what they sell are known, so
    // their wholesaler often arrives afterwards. Attach it now (or queue it) rather than drop
    // it on the floor just because the store is already live.
    const late = supplier_links
      ? await attachSources(existing.demo_enrollment_id,
          { supplierLinks: supplier_links, userId: existing.demo_user_id, sells, fill: false })
      : {};
    return {
      url: demoUrl(existing.demo_slug), slug: existing.demo_slug, reused: true,
      expires_at: existing.demo_expires_at, enrollment_id: existing.demo_enrollment_id,
      their_suppliers: late.theirs || [], pending_suppliers: late.missing || [],
    };
  }

  const userId = await userForPhone(phone, name);
  const slug = await uniqueSlug(slugify(storeName));
  // status 'active' is the ONLY value the storefront serves publicly (resolveStore).
  const enr = (await query(
    `insert into enrollments (user_id, domain, type, slug, enrollment_key, status, categories)
     values ($1,$2,'hosted',$3,$4,'active','{}') returning id`,
    [userId, `${slug}.hosted`, slug, generateEnrollmentKey()])).rows[0];

  const expiresAt = new Date(Date.now() + DEMO_DAYS * 864e5);
  await query(
    `insert into site_settings (enrollment_id, store_name, preview_password, whatsapp, logo_url, address, announcement, sections, preset)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'commerce')`,
    [enr.id, storeName, crypto.randomBytes(3).toString("hex"),
     digits(whatsapp || phone) || null, String(logo_url || "").trim() || null,
     JSON.stringify(city ? { city: String(city).slice(0, 60) } : {}),
     `Demo store — ${DEMO_DAYS} din ke liye. Apna banane ke liye account verify karke plan lijiye.`,
     JSON.stringify(PRESETS.commerce?.sections || [])]);

  const { attached, theirs, missing } = await attachSources(enr.id, { supplierLinks: supplier_links, userId, sells });

  await query(
    `update wa_leads set demo_enrollment_id=$2, demo_slug=$3, demo_expires_at=$4, demo_user_id=$5,
            stage = case when stage in ('ready','details') then stage else 'details' end, updated_at=now()
      where right(phone,10) = $1`,
    [digits(phone).slice(-10), enr.id, slug, expiresAt, userId]);

  return { url: demoUrl(slug), slug, expires_at: expiresAt, enrollment_id: enr.id, user_id: userId,
           sources: attached, their_suppliers: theirs, pending_suppliers: missing, reused: false };
}

// Past its 7 days and still nobody has bought a plan -> pause it. Paused stores are
// preview-locked, so the link stops working for shoppers but nothing is deleted: assign a
// plan and it comes back. Runs from the bot's tick; safe to call as often as you like.
export async function expireDemos() {
  const { rows } = await query(
    `update enrollments e set status='paused'
       from wa_leads l
      where l.demo_enrollment_id = e.id
        and l.demo_expires_at < now()
        and e.status = 'active' and e.plan_id is null and e.type = 'hosted'
      returning e.id, e.slug, l.phone`);
  if (rows.length) console.log(`[wa-demo] paused ${rows.length} expired demo store(s)`);
  return rows;
}

// For the owner's report: demos still running, and how long each has left.
export async function liveDemos() {
  return (await query(
    `select l.phone, l.name, l.demo_slug, l.demo_expires_at, e.status, e.plan_id is not null as has_plan,
            u.mobile_verified
       from wa_leads l join enrollments e on e.id = l.demo_enrollment_id
       left join users u on u.id = l.demo_user_id
      where l.demo_enrollment_id is not null
      order by l.demo_expires_at desc limit 25`)).rows;
}

// Which supplier a demo store gets built from is the whole hook, and it turns on host
// matching — run `node portal/waDemo.js` after touching hostOf/sameHost.
if (import.meta.url === (await import("url")).pathToFileURL(process.argv[1] || "").href) {
  const assert = (await import("assert")).strict;
  assert.equal(hostOf("https://www.Shoemartt.in/collections/nike?page=2"), "shoemartt.in");
  assert.equal(hostOf("shoemartt.in"), "shoemartt.in");
  assert.equal(hostOf("http://srtrendyhub.cartpe.in:443/"), "srtrendyhub.cartpe.in");
  assert.equal(sameHost("shoemartt.in", "shoemartt.in"), true);
  assert.equal(sameHost("shop.shoemartt.in", "shoemartt.in"), true);   // their subdomain, our site
  assert.equal(sameHost("shoemartt.in", "shoemartt.com"), false);      // different TLD, different shop
  assert.equal(sameHost("myshoemartt.in", "shoemartt.in"), false);     // not a subdomain, just a suffix
  assert.equal(sameHost("", "shoemartt.in"), false);
  console.log("waDemo ok");
}
