-- This branch's demo migration must never be applied to a production database.
DO $$ BEGIN
  IF current_database() NOT LIKE 'clubops_demo_%' THEN
    RAISE EXCEPTION 'Standalone demo migrations require a dedicated clubops_demo_* database';
  END IF;
END $$;

-- Bound inserts per visitor/table even through ordinary server actions/imports.
-- A tenant advisory lock serializes the count and insert across app instances.
CREATE FUNCTION demo_tenant_row_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_count BIGINT;
BEGIN
  IF NEW."companyId" IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."companyId", 17));
  EXECUTE format('SELECT count(*) FROM %I WHERE "companyId" = $1', TG_TABLE_NAME)
    INTO row_count USING NEW."companyId";
  IF row_count >= 1000 THEN RAISE EXCEPTION 'DEMO_TENANT_ROW_LIMIT'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE table_row RECORD; BEGIN
  FOR table_row IN SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'companyId'
  LOOP
    EXECUTE format('CREATE TRIGGER demo_row_limit BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION demo_tenant_row_limit()', table_row.table_name);
  END LOOP;
END $$;
