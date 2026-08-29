-- Remember which homepage preset the vendor applied, so the portal can show it
-- as selected after a reload (sections alone can't tell you the preset once edited).
alter table site_settings add column if not exists preset text;
