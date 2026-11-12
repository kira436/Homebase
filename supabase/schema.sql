-- Homebase sync table. Paste this whole file into Supabase > SQL Editor > New query, and Run.
--
-- How access works: the table itself is locked (row level security on, no policies), so the public key
-- cannot read or write it directly. The app only calls the two functions below, and each call must name
-- a household code. The code is a long random string that lives in the invite link, so only people
-- holding the link can see or change that household.

create table if not exists public.hb_items (
  household  text        not null,
  id         text        not null,
  type       text        not null,
  data       jsonb       not null,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (household, id)
);

create index if not exists hb_items_household_updated on public.hb_items (household, updated_at);

alter table public.hb_items enable row level security;
revoke all on public.hb_items from anon, authenticated;

-- Everything in a household that changed after p_since.
create or replace function public.hb_pull(p_household text, p_since timestamptz)
returns table (id text, type text, data jsonb, deleted boolean, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select i.id, i.type, i.data, i.deleted, i.updated_at
  from public.hb_items i
  where i.household = p_household
    and length(p_household) >= 16
    and i.updated_at > p_since
  order by i.updated_at
  limit 5000;
$$;

-- Insert or update a batch of records. The server stamps the time, so phones with wrong clocks are fine.
create or replace function public.hb_push(p_household text, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(p_household) < 16 then
    raise exception 'invalid household code';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'too many rows in one push';
  end if;

  insert into public.hb_items (household, id, type, data, deleted, updated_at)
  select p_household,
         r->>'id',
         coalesce(r->>'type', 'unknown'),
         coalesce(r->'data', '{}'::jsonb),
         coalesce((r->>'deleted')::boolean, false),
         clock_timestamp()
  from jsonb_array_elements(p_rows) as r
  where r->>'id' is not null
    and length(coalesce(r->>'data', '')) < 100000
  on conflict (household, id) do update
    set type = excluded.type,
        data = excluded.data,
        deleted = excluded.deleted,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.hb_pull(text, timestamptz) from public;
revoke all on function public.hb_push(text, jsonb) from public;
grant execute on function public.hb_pull(text, timestamptz) to anon, authenticated;
grant execute on function public.hb_push(text, jsonb) to anon, authenticated;
