-- Sequential, human-readable invoice numbers (INV-1000, INV-1001, ...).
create sequence if not exists invoice_no_seq start 1000;

-- So the daily reminder job never sends the same invoice twice in one day.
alter table invoices add column if not exists last_reminder_at timestamptz;
