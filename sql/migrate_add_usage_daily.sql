-- Per-student daily usage tracking, used to enforce a daily spend cap
-- (see src/lib/usage.ts). Additive-only, matches the existing migration
-- pattern in this directory.

create table usage_daily (
  user_id uuid not null references users(id) on delete cascade,
  usage_date date not null,
  cost_usd numeric(10, 6) not null default 0,
  primary key (user_id, usage_date)
);

-- Atomic upsert-increment — a plain select-then-update from the app would
-- race under concurrent requests from the same student (e.g. a chat turn
-- plus its visual-decision follow-up call landing at nearly the same time).
create or replace function increment_usage(p_user_id uuid, p_usage_date date, p_cost_usd numeric)
returns void as $$
begin
  insert into usage_daily (user_id, usage_date, cost_usd)
  values (p_user_id, p_usage_date, p_cost_usd)
  on conflict (user_id, usage_date)
  do update set cost_usd = usage_daily.cost_usd + excluded.cost_usd;
end;
$$ language plpgsql;
