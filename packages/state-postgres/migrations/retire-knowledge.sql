-- Run explicitly after the old runtime and all of its writers have stopped.
-- One atomic statement: unrelated dependencies or unexpected remaining objects
-- abort the entire operation. No CASCADE may cross the retired schema boundary.
DO $retirement$
DECLARE
  tables_to_drop text;
BEGIN
  IF to_regnamespace('companyos_knowledge') IS NULL THEN
    RETURN;
  END IF;
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO tables_to_drop
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'companyos_knowledge' AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition;
  IF tables_to_drop IS NOT NULL THEN
    EXECUTE 'DROP TABLE ' || tables_to_drop || ' RESTRICT';
  END IF;
  -- Owned indexes, row types and sequences disappear with their tables.
  -- Standalone functions/views/types require review, not an unbounded cascade.
  DROP SCHEMA companyos_knowledge RESTRICT;
END
$retirement$;
