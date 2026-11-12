-- ========================================================
-- bodo ERP: Migration 0001_init
-- Database Migration for Single Company Tenant Database
-- Executed by role: erp_migrator (Owner of schema and tables)
-- ========================================================

-- 1. Trusted Extensions (PostgreSQL 16+)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- 2. Enumerated Types
CREATE TYPE "UserType" AS ENUM ('INTERNAL', 'PORTAL');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED', 'LOCKED');
CREATE TYPE "RuleScope" AS ENUM ('OWN', 'TEAM', 'ALL', 'CUSTOM');
CREATE TYPE "EventSource" AS ENUM ('UI', 'API', 'IMPORT', 'SYSTEM');
CREATE TYPE "LostAppliesTo" AS ENUM ('LEAD', 'QUOTATION', 'BOTH');

-- 3. Core Tables

-- Currencies: Multi-currency support (no exchange rates stored)
CREATE TABLE "currencies" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "check_currencies_decimals" CHECK ("decimals" >= 0)
);

-- Company Profile: Single record per tenant database (id = 1 enforced)
CREATE TABLE "company_profile" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL DEFAULT '',
    "legal_name" TEXT,
    "national_id" TEXT,
    "registration_no" TEXT,
    "economic_code" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "address" TEXT,
    "postal_code" TEXT,
    "logo_file_id" UUID,
    "default_currency_code" TEXT NOT NULL DEFAULT 'IRR',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_company_profile_id" CHECK ("id" = 1),
    CONSTRAINT "company_profile_default_currency_code_fkey" FOREIGN KEY ("default_currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- System Settings: Key-value database-level configuration
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- Users: Internal staff and external portal accounts
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "type" "UserType" NOT NULL DEFAULT 'INTERNAL',
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "mobile" TEXT,
    "email" TEXT,
    "avatar_file_id" UUID,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "password_changed_at" TIMESTAMPTZ(3),
    "portal_contact_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_users_username_lower" CHECK ("username" = lower("username")),
    CONSTRAINT "check_users_failed_login_count" CHECK ("failed_login_count" >= 0)
);

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "users_mobile_key" ON "users"("mobile");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_type_status_idx" ON "users"("type", "status");

-- Sessions: Refresh tokens with family revocation tracking
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- Groups & Permissions (RBAC)
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "groups_name_key" ON "groups"("name");

CREATE TABLE "group_members" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id", "user_id"),
    CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "group_permissions" (
    "group_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,

    CONSTRAINT "group_permissions_pkey" PRIMARY KEY ("group_id", "permission_code"),
    CONSTRAINT "group_permissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Teams: User operational grouping
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "leader_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "teams_name_key" ON "teams"("name");

CREATE TABLE "team_members" (
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id", "user_id"),
    CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Record Rules: Row-Level Security Rules evaluated in application layer
CREATE TABLE "record_rules" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "can_read" BOOLEAN NOT NULL DEFAULT true,
    "can_write" BOOLEAN NOT NULL DEFAULT true,
    "can_create" BOOLEAN NOT NULL DEFAULT true,
    "can_delete" BOOLEAN NOT NULL DEFAULT false,
    "scope" "RuleScope" NOT NULL DEFAULT 'OWN',
    "owner_field" TEXT NOT NULL DEFAULT 'ownerId',
    "custom_filter" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "record_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "record_rules_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "record_rules_group_id_resource_key" ON "record_rules"("group_id", "resource");

-- Outbox Events: Transactional outbox for guaranteed event publishing
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_events_processed_at_created_at_idx" ON "outbox_events"("processed_at", "created_at");

-- Sequences: Pattern-based numbering sequences (quotation, sale_order, etc.)
CREATE TABLE "sequences" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "pattern" TEXT NOT NULL DEFAULT '{prefix}{yyyy}-{seq:5}',
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "reset_policy" TEXT NOT NULL DEFAULT 'YEARLY',
    "last_reset_key" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sequences_code_key" ON "sequences"("code");

-- Lost Reasons: Lead and Quotation loss categorization
CREATE TABLE "lost_reasons" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "applies_to" "LostAppliesTo" NOT NULL DEFAULT 'BOTH',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "lost_reasons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lost_reasons_name_key" ON "lost_reasons"("name");

-- 4. Partitioned Tables (RANGE by occurred_at)

-- Audit Logs: Append-only system audit trail
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "source" "EventSource" NOT NULL DEFAULT 'UI',
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "changes" JSONB,
    "meta" JSONB,
    "request_id" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");

CREATE INDEX "audit_logs_entity_type_entity_id_occurred_at_idx" ON "audit_logs"("entity_type", "entity_id", "occurred_at" DESC);
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at" DESC);

-- Timeline Events: Customer and Document event history
CREATE TABLE "timeline_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "actor_id" UUID,
    "source" "EventSource" NOT NULL DEFAULT 'SYSTEM',
    "ref_type" TEXT,
    "ref_id" UUID,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "role" TEXT,
    "meta" JSONB,
    "source_event_id" UUID,

    CONSTRAINT "timeline_events_pkey" PRIMARY KEY ("id", "occurred_at"),
    CONSTRAINT "timeline_events_source_event_id_subject_type_subject_id_occ_key" UNIQUE ("source_event_id", "subject_type", "subject_id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");

CREATE INDEX "timeline_events_subject_type_subject_id_occurred_at_idx" ON "timeline_events"("subject_type", "subject_id", "occurred_at" DESC);
CREATE INDEX "timeline_events_ref_type_ref_id_idx" ON "timeline_events"("ref_type", "ref_id");

-- 5. Initial Monthly Partitions and DEFAULT Catch-all
-- Partition naming convention: <table_name>_p<YYYYMM> and <table_name>_default

CREATE TABLE "audit_logs_default" PARTITION OF "audit_logs" DEFAULT;
CREATE TABLE "audit_logs_p202611" PARTITION OF "audit_logs" FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE "audit_logs_p202612" PARTITION OF "audit_logs" FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE "audit_logs_p202701" PARTITION OF "audit_logs" FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE "audit_logs_p202702" PARTITION OF "audit_logs" FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');

CREATE TABLE "timeline_events_default" PARTITION OF "timeline_events" DEFAULT;
CREATE TABLE "timeline_events_p202611" PARTITION OF "timeline_events" FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE "timeline_events_p202612" PARTITION OF "timeline_events" FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE "timeline_events_p202701" PARTITION OF "timeline_events" FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE "timeline_events_p202702" PARTITION OF "timeline_events" FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');

-- 6. Partition Management Function
-- SECURITY DEFINER function owned by erp_migrator to allow erp_app to pre-create upcoming partitions safely
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(target_table text, months_ahead int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    m int;
    start_date timestamptz;
    end_date timestamptz;
    part_name text;
BEGIN
    -- Strict whitelist guard: only permitted partitioned tables
    IF target_table NOT IN ('audit_logs', 'timeline_events') THEN
        RAISE EXCEPTION 'Table "%" is not a permitted partitioned table', target_table;
    END IF;

    IF months_ahead < 0 OR months_ahead > 24 THEN
        RAISE EXCEPTION 'months_ahead must be between 0 and 24';
    END IF;

    FOR m IN 0..months_ahead LOOP
        start_date := date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + (m || ' month')::interval);
        end_date := date_trunc('month', start_date + interval '1 month');
        part_name := target_table || '_p' || to_char(start_date, 'YYYYMM');

        BEGIN
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L);',
                part_name, target_table, start_date, end_date
            );
        EXCEPTION
            WHEN duplicate_table THEN
                -- Partition already exists; continue idempotently
                NULL;
        END;
    END LOOP;
END;
$$;

-- 7. Role Privileges & Isolation (PostgreSQL 16)

-- Revoke all public schema permissions from default PUBLIC
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO erp_app;

-- Grant standard DML to erp_app on all existing tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app;

-- Ensure future tables created by migrations inherit standard DML for erp_app
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app;

-- Strict Append-Only enforcement for audit_logs: erp_app cannot UPDATE or DELETE audit records
REVOKE UPDATE, DELETE ON "audit_logs" FROM erp_app;
REVOKE UPDATE, DELETE ON "audit_logs_default" FROM erp_app;
REVOKE UPDATE, DELETE ON "audit_logs_p202611" FROM erp_app;
REVOKE UPDATE, DELETE ON "audit_logs_p202612" FROM erp_app;
REVOKE UPDATE, DELETE ON "audit_logs_p202701" FROM erp_app;
REVOKE UPDATE, DELETE ON "audit_logs_p202702" FROM erp_app;

-- Permit erp_app to execute the secure partition creation helper
GRANT EXECUTE ON FUNCTION ensure_monthly_partitions(text, int) TO erp_app;
