-- bodo ERP: Database Roles Initialization
-- Created once when the PostgreSQL cluster is initialized

DO
$do$
BEGIN
   -- 1. erp_provisioner: Role with CREATEDB privilege for Database Manager
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'erp_provisioner') THEN
      CREATE ROLE erp_provisioner WITH LOGIN CREATEDB PASSWORD 'provisioner_secret_change_in_prod';
   END IF;

   -- 2. erp_migrator: Role that owns table schemas and runs migrations
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'erp_migrator') THEN
      CREATE ROLE erp_migrator WITH LOGIN PASSWORD 'migrator_secret_change_in_prod';
   END IF;

   -- 3. erp_app: Regular application role with DML permissions only
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'erp_app') THEN
      CREATE ROLE erp_app WITH LOGIN PASSWORD 'app_secret_change_in_prod';
   END IF;
END
$do$;
