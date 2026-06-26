-- One enrollment (site/key) can now hold MULTIPLE sources, each with its own
-- picked categories. Run in the Supabase SQL editor.

create table if not exists enrollment_sources (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references enrollments(id) on delete cascade,
  source_id     text not null references sources(id),
  categories    text[] not null default '{}',   -- empty = all of this source's categories
  created_at    timestamptz not null default now(),
  unique (enrollment_id, source_id)
);
create index if not exists idx_enrsrc_enr on enrollment_sources(enrollment_id);

-- migrate every existing single-source enrollment into the child table
insert into enrollment_sources (enrollment_id, source_id, categories)
select id, source_id, coalesce(categories, '{}')
  from enrollments
 where source_id is not null
on conflict (enrollment_id, source_id) do nothing;
