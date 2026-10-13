-- Requests use immutable tenant pools. Only startup and trusted workers use '*'.
-- Existing unowned data is quarantined in the demo organization.
DO $tenant$
DECLARE t record; f record; child_cols text; parent_cols text; idx text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_sqlx_migrations' LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN organization_id text NOT NULL DEFAULT %L', t.tablename, 'org_demo');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN organization_id SET DEFAULT NULLIF(current_setting(%L, true), %L)', t.tablename, 'mf.organization_id', '*');
    EXECUTE format('ALTER TABLE %I ADD CHECK (organization_id <> %L AND organization_id <> %L)', t.tablename, '*', '');
    EXECUTE format('CREATE INDEX ON %I (organization_id)', t.tablename);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('CREATE POLICY organization_isolation ON %I USING (organization_id = current_setting(%L,true) OR current_setting(%L,true) = %L) WITH CHECK (organization_id = current_setting(%L,true) OR current_setting(%L,true) = %L)', t.tablename, 'mf.organization_id', 'mf.organization_id', '*', 'mf.organization_id', 'mf.organization_id', '*');
  END LOOP;
  -- PostgreSQL foreign-key checks bypass row policies. Composite keys also
  -- require children to belong to the parent's organization.
  FOR f IN SELECT c.oid, c.conname, c.conrelid, c.confrelid, c.conkey, c.confkey,
                  c.conrelid::regclass AS child, c.confrelid::regclass AS parent
           FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord) INTO child_cols
      FROM unnest(f.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.num;
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord) INTO parent_cols
      FROM unnest(f.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.num;
    idx := 'tenant_ref_' || f.oid;
    EXECUTE format('CREATE UNIQUE INDEX %I ON %s (organization_id, %s)', idx, f.parent, parent_cols);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (organization_id, %s) REFERENCES %s (organization_id, %s) DEFERRABLE INITIALLY DEFERRED', f.child, 'tenant_' || f.conname, child_cols, f.parent, parent_cols);
  END LOOP;
END $tenant$;
ALTER TABLE markings DROP CONSTRAINT markings_name_key;
ALTER TABLE markings ADD UNIQUE (organization_id, name);
ALTER TABLE curriculum_progress DROP CONSTRAINT curriculum_progress_actor_key_step_id_key;
ALTER TABLE curriculum_progress ADD UNIQUE (organization_id, actor_key, step_id);
