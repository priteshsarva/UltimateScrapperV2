-- Guest checkout auto-creates a customer with no password yet ("unclaimed").
-- The buyer claims it by signing up with the same email, which sets the password.
alter table customers alter column password_hash drop not null;
