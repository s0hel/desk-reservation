-- Two roles, per TDD §18.2.
--   deskflow_owner : owns the schema and runs migrations
--   deskflow_app   : the API's runtime role
--
-- deskflow_app must be neither a superuser nor BYPASSRLS. This is the single most
-- important line of database configuration in the product: a superuser bypasses row
-- level security regardless of FORCE, so connecting the API as one silently disables
-- every tenant boundary while leaving all the policies visibly in place.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deskflow_app') THEN
    CREATE ROLE deskflow_app LOGIN PASSWORD 'deskflow' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE deskflow TO deskflow_app;
GRANT USAGE ON SCHEMA public TO deskflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE deskflow_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO deskflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE deskflow_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO deskflow_app;
