-- An org could never be deleted once it had used the service once.
--
-- usage_events is append-only, enforced by a BEFORE UPDATE OR DELETE trigger, and that is
-- right: a usage ledger somebody can quietly edit is not a ledger. But usage_events.org_id is
-- ON DELETE CASCADE, and a cascade is a DELETE like any other, so the trigger refused it and
-- `delete from public.orgs where id = ...` failed with "usage_events is append-only" from
-- inside the cascade.
--
-- Nobody had hit it because nothing had ever deleted an org. It would have been found by the
-- first person to close an account, or the first deletion request under GDPR, and it would
-- have been found in the worst way: as a failure on a path with a legal deadline attached.
--
-- The fix distinguishes the two cases precisely rather than weakening the guard. Postgres
-- deletes the parent row before firing the child's cascade, both inside one statement, so by
-- the time this trigger runs for a cascaded row the org it belongs to is already gone from the
-- table's own snapshot. A stray `delete from usage_events where ...` has its org sitting right
-- there. That difference is the whole test:
--
--   the org still exists  -> somebody is deleting ledger rows  -> refuse
--   the org is gone       -> this is the cascade               -> allow
--
-- Updates are refused either way. There is no version of an update to this table that is not
-- somebody editing history.

create or replace function app.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and tg_table_name = 'usage_events'
     and not exists (select 1 from public.orgs o where o.id = old.org_id) then
    -- The org went in the same statement. Let the cascade finish.
    return old;
  end if;

  raise exception '% is append-only', tg_table_name using errcode = '42501';
end
$$;

comment on function app.forbid_mutation() is
  'Append-only guard. Allows exactly one deletion: the cascade from an org that is being '
  'deleted in the same statement, which is detected by its parent row already being gone.';
