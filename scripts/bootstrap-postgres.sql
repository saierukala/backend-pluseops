-- PulseOps local PostgreSQL bootstrap.
--
-- Creates the application role and database that DATABASE_URL points at. Run it once
-- as a superuser after installing PostgreSQL. It is idempotent, so re-running is safe.
--
--   psql -U postgres -h localhost -p 5432 -v pw="<app-password>" -f scripts/bootstrap-postgres.sql
--
-- The password is passed in with -v so it never lives in version control. Use the same
-- value as the password in DATABASE_URL (URL-encode reserved characters there: # is %23).

\set ON_ERROR_STOP on

-- Application role: least privilege. Not a superuser, cannot create other roles.
SELECT format('CREATE ROLE pulseops WITH LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulseops')
\gexec

-- Keep the password in sync when the script is re-run with a new value.
SELECT format('ALTER ROLE pulseops WITH LOGIN PASSWORD %L', :'pw')
\gexec

SELECT 'CREATE DATABASE pulseops OWNER pulseops'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'pulseops')
\gexec

-- PostgreSQL 15+ no longer grants CREATE on the public schema to PUBLIC, so Prisma
-- migrations need the application role to own it.
\connect pulseops

ALTER SCHEMA public OWNER TO pulseops;
GRANT ALL ON SCHEMA public TO pulseops;

\echo ''
\echo 'Bootstrap complete: role "pulseops" and database "pulseops" are ready.'
