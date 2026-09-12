-- Two roles, per TDD §18.2.
--   deskflow_owner : owns the schema, runs migrations, bypasses nothing at runtime
--   deskflow_app   : the API's role. NOT the table owner, so RLS is never bypassed.
CREATE ROLE deskflow_app LOGIN PASSWORD 'deskflow' NOBYPASSRLS;
GRANT CONNECT ON DATABASE deskflow TO deskflow_app;
GRANT USAGE ON SCHEMA public TO deskflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE deskflow_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO deskflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE deskflow_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO deskflow_app;
