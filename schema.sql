-- ============================================================================
-- AgencyArk — Dispatch portal tables
-- Run in Supabase → SQL Editor. Idempotent.
-- ============================================================================

-- Saved settings: one row per sub-account destination.
create table if not exists dispatch_destinations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,                 -- sub-account name; must match the contact tag
  match_key    text not null,                 -- normalised name, used for tag matching
  webhook_url  text not null,                 -- the GHL/n8n workflow that creates the contact
  active       boolean not null default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create unique index if not exists idx_dispatch_dest_key on dispatch_destinations(match_key);

-- Every dispatch attempt, for auditing "where did this contact go".
create table if not exists dispatch_log (
  id            bigint primary key generated always as identity,
  run_id        uuid not null,
  destination   text,                          -- null = unrouted
  webhook_url   text,
  contact_count integer not null default 0,
  status        text not null,                 -- sent | failed | unrouted
  detail        text,                          -- error message or tag list
  created_at    timestamptz default now()
);

create index if not exists idx_dispatch_log_run  on dispatch_log(run_id);
create index if not exists idx_dispatch_log_time on dispatch_log(created_at desc);
