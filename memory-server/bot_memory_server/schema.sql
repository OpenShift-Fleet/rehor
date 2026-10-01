CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
    CREATE TYPE task_status AS ENUM (
        'in_progress', 'pr_open', 'pr_changes', 'paused', 'done', 'archived'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Add 'archived' to existing enum if it doesn't have it
DO $$ BEGIN
    ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'archived';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tasks (
    id              SERIAL PRIMARY KEY,
    external_key    TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    source_url      TEXT,
    artifacts       JSONB DEFAULT '[]',
    status          task_status NOT NULL DEFAULT 'in_progress',
    repo            TEXT,
    branch          TEXT,
    title           TEXT,
    summary         TEXT,
    outcome_report_id BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_addressed  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at     TIMESTAMPTZ,
    paused_reason   TEXT,
    metadata        JSONB DEFAULT '{}',
    UNIQUE(external_key, source_type)
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS outcome_report_id BIGINT;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
UPDATE tasks
SET archived_at = last_addressed
WHERE status = 'archived'::task_status AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS task_outcome_reports (
    id                      BIGSERIAL PRIMARY KEY,
    task_id                 INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    decision                TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'obsolete', 'inconclusive')),
    confidence              TEXT NOT NULL CHECK (confidence IN ('conclusive', 'inconclusive')),
    reason                  TEXT NOT NULL,
    reported_by             TEXT NOT NULL DEFAULT 'agent',
    reported_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_at             TIMESTAMPTZ,
    artifacts               JSONB NOT NULL DEFAULT '[]',
    evidence                JSONB NOT NULL DEFAULT '[]',
    canonical_repositories  JSONB NOT NULL DEFAULT '[]',
    notes                   TEXT,
    run_id                  TEXT,
    reporting_cycle_id      BIGINT,
    attempt                 INTEGER,
    workflow                TEXT,
    instance_id             TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_outcome_reports_task_latest
    ON task_outcome_reports (task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_task_outcome_reports_reported_at
    ON task_outcome_reports (reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_outcome_reports_repositories
    ON task_outcome_reports USING GIN (canonical_repositories);

DO $$ BEGIN
    ALTER TABLE tasks
        ADD CONSTRAINT tasks_current_outcome_report_fk
        FOREIGN KEY (outcome_report_id) REFERENCES task_outcome_reports(id) ON DELETE RESTRICT;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_outcome_report_id ON tasks (outcome_report_id);
COMMENT ON COLUMN tasks.outcome_report_id IS
    'Outcome report staged for or selected by current archive; history remains in task_outcome_reports.';

CREATE TABLE IF NOT EXISTS memories (
    id              SERIAL PRIMARY KEY,
    category        TEXT NOT NULL,
    repo            TEXT,
    external_key    TEXT,
    source_type     TEXT,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    tags            TEXT[] DEFAULT '{}',
    embedding       vector(384) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB DEFAULT '{}'
);

-- Add title and summary columns if they don't exist (for existing databases)
DO $$ BEGIN
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS summary TEXT;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

-- Add instance_id column for multi-instance isolation
DO $$ BEGIN
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS instance_id TEXT;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

-- Add tags column if it doesn't exist (for existing databases)
DO $$ BEGIN
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bot_status (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    state           TEXT NOT NULL DEFAULT 'idle',
    message         TEXT NOT NULL DEFAULT '',
    external_key    TEXT,
    source_type     TEXT,
    repo            TEXT,
    instance_id     TEXT,
    cycle_start     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO bot_status (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Add instance_id to bot_status for existing databases
DO $$ BEGIN
    ALTER TABLE bot_status ADD COLUMN IF NOT EXISTS instance_id TEXT;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS cycles (
    id              SERIAL PRIMARY KEY,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    label           TEXT NOT NULL,
    session_id      TEXT,
    num_turns       INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    model           TEXT,
    is_error        BOOLEAN NOT NULL DEFAULT FALSE,
    no_work         BOOLEAN NOT NULL DEFAULT FALSE
);

-- Cycle work context (added retroactively — nullable for historical data)
DO $$ BEGIN
    ALTER TABLE cycles ADD COLUMN IF NOT EXISTS external_key TEXT;
    ALTER TABLE cycles ADD COLUMN IF NOT EXISTS source_type TEXT;
    ALTER TABLE cycles ADD COLUMN IF NOT EXISTS repo TEXT;
    ALTER TABLE cycles ADD COLUMN IF NOT EXISTS work_type TEXT;
    ALTER TABLE cycles ADD COLUMN IF NOT EXISTS summary TEXT;
    ALTER TABLE cycles ADD COLUMN IF NOT EXISTS instance_id TEXT;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS slack_notifications (
    id              SERIAL PRIMARY KEY,
    external_key    TEXT NOT NULL,
    source_type     TEXT,
    event_type      TEXT NOT NULL,
    message         TEXT NOT NULL,
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slack_digest_queue (
    id              SERIAL PRIMARY KEY,
    instance_id     TEXT,
    jira_key        TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    pr_url          TEXT,
    pr_number       INTEGER,
    repo            TEXT,
    title           TEXT,
    message         TEXT NOT NULL,
    queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent            BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS org_members (
    id              SERIAL PRIMARY KEY,
    username        TEXT NOT NULL,
    org             TEXT NOT NULL,
    is_member       BOOLEAN NOT NULL,
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(username, org)
);

-- Multi-instance bot status tracking
CREATE TABLE IF NOT EXISTS bot_instances (
    instance_id                 TEXT PRIMARY KEY,
    state                       TEXT NOT NULL DEFAULT 'idle',
    message                     TEXT NOT NULL DEFAULT '',
    external_key                TEXT,
    source_type                 TEXT,
    repo                        TEXT,
    cycle_start                 TIMESTAMPTZ,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idle_consecutive_cycles     INTEGER NOT NULL DEFAULT 0,
    last_idle_reminder_sent_at  TIMESTAMPTZ
);

-- Idempotent column changes for existing databases
ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS idle_consecutive_cycles    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS last_idle_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE bot_instances DROP COLUMN IF EXISTS last_seen;

-- Migrate existing bot_status row into bot_instances (if instance_id is set)
DO $$ BEGIN
    INSERT INTO bot_instances (instance_id, state, message, external_key, source_type, repo, cycle_start, updated_at)
    SELECT instance_id, state, message, external_key, source_type, repo, cycle_start, updated_at
    FROM bot_status
    WHERE id = 1 AND instance_id IS NOT NULL
    ON CONFLICT (instance_id) DO NOTHING;
EXCEPTION
    WHEN undefined_table THEN NULL;
END $$;

-- Cycle runs — progress history + compressed transcripts per bot cycle
CREATE TABLE IF NOT EXISTS cycle_runs (
    id              SERIAL PRIMARY KEY,
    task_id         INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    cycle_type      TEXT NOT NULL DEFAULT 'task_work',
    instance_id     TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    tool_calls      INTEGER,
    tokens_used     INTEGER,
    progress        JSONB,
    transcript      BYTEA,
    input_prompt    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration: add input_prompt to existing cycle_runs tables
ALTER TABLE cycle_runs ADD COLUMN IF NOT EXISTS input_prompt TEXT;
CREATE INDEX IF NOT EXISTS idx_cycle_runs_task_started
    ON cycle_runs (task_id, started_at, id);

-- Only create index if table has enough rows (ivfflat needs data)
-- On first startup with empty table, queries fall back to sequential scan
-- Re-run this after seeding data:
-- CREATE INDEX IF NOT EXISTS idx_memories_embedding
--   ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);
