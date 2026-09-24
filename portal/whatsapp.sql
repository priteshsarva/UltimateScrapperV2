-- whatsapp.sql — WhatsApp support bot (no AI): FAQ answers learned from the owner.
-- Apply by hand in the Supabase SQL editor. Additive only.

-- One answer, three language versions (any may be empty; the bot falls back).
create table if not exists wa_faqs (
  id              serial primary key,
  answer_en       text not null default '',
  answer_hinglish text not null default '',
  answer_hi       text not null default '',
  hits            int  not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Phrasings that should hit a FAQ. Stored RAW; normalized at match time
-- (portal/waMatch.js), so improving the normalizer re-scores everything.
create table if not exists wa_faq_phrases (
  id      serial primary key,
  faq_id  int  not null references wa_faqs(id) on delete cascade,
  phrase  text not null
);
create index if not exists idx_wa_faq_phrases_faq on wa_faq_phrases(faq_id);

-- Questions the bot couldn't answer -> sent to the owner. id is the "#12" the owner replies to.
create table if not exists wa_questions (
  id           serial primary key,
  phone        text not null,              -- digits, e.g. 919876543210
  jid          text not null,              -- WhatsApp chat id to reply to
  user_id      uuid references users(id) on delete set null,
  name         text,
  text         text not null,
  lang         text not null default 'hinglish',
  status       text not null default 'pending' check (status in ('pending','answered','skipped')),
  owner_msg_id text,                       -- id of the escalation message (owner can quote-reply it)
  faq_id       int references wa_faqs(id) on delete set null,
  answer       text,
  created_at   timestamptz not null default now(),
  answered_at  timestamptz
);
create index if not exists idx_wa_questions_status on wa_questions(status, created_at desc);
create index if not exists idx_wa_questions_owner_msg on wa_questions(owner_msg_id);

-- Per-number preference (language). Menu position lives in the bot's memory.
create table if not exists wa_contacts (
  phone      text primary key,
  lang       text not null check (lang in ('en','hinglish','hi')),
  updated_at timestamptz not null default now()
);

-- Chats the bot is allowed to take part in. Only chats that START after the bot's
-- GO_LIVE date become 'active'; chats found in the history sync at link time are
-- 'legacy' and the bot never replies or follows up there. 'off' = owner muted it.
create table if not exists wa_chats (
  jid         text primary key,
  phone       text not null default '',
  status      text not null default 'active' check (status in ('active','legacy','off')),
  started_by  text not null default 'client' check (started_by in ('client','owner')),
  started_at  timestamptz not null default now(),
  last_in_at  timestamptz,
  last_out_at timestamptz,
  followups   int not null default 0,     -- follow-ups sent since the client last wrote
  opted_out   boolean not null default false
);
create index if not exists idx_wa_chats_phone on wa_chats(phone);

-- Who produced the answer: 'owner' (you typed it) or 'ai' (Gemini answered on its own).
alter table wa_questions add column if not exists source text not null default 'owner';

-- Short conversation memory so the assistant can hold a real conversation
-- (last ~12 turns per chat are sent to the model; older rows are only history).
create table if not exists wa_messages (
  id         bigserial primary key,
  jid        text not null,
  role       text not null check (role in ('client','us')),
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_messages_jid on wa_messages(jid, id desc);

-- Owner answers are drafted into a proper client message first, shown to the owner,
-- and only sent once they confirm. draft_msg_id = the preview message they can quote-reply.
alter table wa_questions add column if not exists draft        text;
alter table wa_questions add column if not exists draft_msg_id text;

-- What we learn about a person while talking to them: filled in by the assistant
-- from the conversation itself (never an interrogation), one row per number.
create table if not exists wa_leads (
  phone         text primary key,
  jid           text,
  name          text,
  business      text,
  city          text,
  sells         text,          -- what they sell
  shops         text,          -- how many shops / scale
  online_already text,         -- already selling online? where?
  email         text,
  socials       text,          -- instagram / facebook / website
  suppliers     text,          -- suppliers they named
  budget_hint   text,
  intent        text,          -- what they want / where the talk got to
  score         text not null default 'cold' check (score in ('hot','warm','cold')),
  score_reason  text,
  notes         text,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists idx_wa_leads_score on wa_leads(score, updated_at desc);

-- Where a saved answer came from: 'owner' (you typed it) or 'ai' (learned from a
-- conversation the assistant handled well). Learned ones are the offline safety net:
-- when Gemini is down, the keyword matcher answers from these.
alter table wa_faqs add column if not exists source text not null default 'owner';

-- draft_at: when the owner was last shown a draft — a bare "ok" confirms the most
-- recently shown one, not whichever pending question has the highest id.
-- reengaged_at: when a pick-up line was last made for this question, so an undelivered
-- line isn't regenerated (another AI call) on every 5-minute tick.
alter table wa_questions add column if not exists draft_at     timestamptz;
alter table wa_questions add column if not exists reengaged_at timestamptz;

-- score_at: when the lead's score was last set. A score set in the last 72 hours is never
-- lowered (the model only sees today's few messages). updated_at moves on every message,
-- so it can't be used for this. Existing rows start from their last update.
alter table wa_leads add column if not exists score_at timestamptz;
update wa_leads set score_at = updated_at where score_at is null;
