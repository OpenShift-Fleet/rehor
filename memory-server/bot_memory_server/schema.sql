CREATE EXTENSION IF NOT EXISTS vector;

-- Outcome repository extraction is shared by live SQL rollups and report writes.
-- No extensions beyond the schema's existing vector dependency are required.
CREATE OR REPLACE FUNCTION outcome_url_decode(value TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    bytes BYTEA := ''::bytea;
    result TEXT := '';
    i INTEGER := 1;
    start_at INTEGER;
    first_byte INTEGER;
    next_byte INTEGER;
    width INTEGER;
    consumed INTEGER;
BEGIN
    WHILE i <= char_length(value) LOOP
        IF substr(value, i, 3) ~ '^%[0-9A-Fa-f]{2}$' THEN
            bytes := bytes || decode(substr(value, i + 1, 2), 'hex');
            i := i + 3;
        ELSE
            bytes := bytes || convert_to(substr(value, i, 1), 'UTF8');
            i := i + 1;
        END IF;
    END LOOP;
    -- Decode UTF-8 with replacement, like urllib.parse.unquote(errors='replace').
    i := 0;
    WHILE i < octet_length(bytes) LOOP
        start_at := i;
        first_byte := get_byte(bytes, i);
        width := CASE WHEN first_byte < 128 THEN 1
                      WHEN first_byte BETWEEN 194 AND 223 THEN 2
                      WHEN first_byte BETWEEN 224 AND 239 THEN 3
                      WHEN first_byte BETWEEN 240 AND 244 THEN 4 ELSE 0 END;
        consumed := 1;
        WHILE consumed < width AND i + consumed < octet_length(bytes) LOOP
            next_byte := get_byte(bytes, i + consumed);
            EXIT WHEN next_byte NOT BETWEEN 128 AND 191;
            EXIT WHEN consumed = 1 AND (
                (first_byte = 224 AND next_byte < 160) OR
                (first_byte = 237 AND next_byte > 159) OR
                (first_byte = 240 AND next_byte < 144) OR
                (first_byte = 244 AND next_byte > 143));
            consumed := consumed + 1;
        END LOOP;
        IF width > 0 AND consumed = width AND first_byte <> 0 THEN
            result := result || convert_from(substr(bytes, start_at + 1, consumed), 'UTF8');
        ELSE
            -- PostgreSQL text cannot hold NUL; treat it as invalid repository text.
            result := result || chr(65533);
        END IF;
        i := i + consumed;
    END LOOP;
    RETURN result;
END $$;

CREATE OR REPLACE FUNCTION outcome_strip(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
    -- Exactly Python str.strip() whitespace, independent of database locale.
    SELECT btrim(value, E' \t\n\r\f\013' || chr(28) || chr(29) || chr(30) || chr(31) ||
        chr(133) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) ||
        chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) ||
        chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288))
$$;

CREATE OR REPLACE FUNCTION outcome_normalize_repository(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT nullif(outcome_strip(btrim(outcome_strip(regexp_replace(
        outcome_strip(btrim(outcome_strip(split_part(split_part(value, '?', 1), '#', 1)), '/')),
        '\.git$', '')), '/')), '')
$$;

CREATE OR REPLACE FUNCTION outcome_repository_from_url(value TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    path TEXT;
    marker TEXT[];
    segments TEXT[];
BEGIN
    path := split_part(split_part(outcome_strip(value), '?', 1), '#', 1);
    path := regexp_replace(path, '^[A-Za-z][A-Za-z0-9+.-]*://[^/]*', '');
    path := btrim(outcome_url_decode(path), '/');
    marker := regexp_match(path, '^(.*?)(/-/merge_requests/|/merge_requests/)');
    IF marker IS NOT NULL THEN
        RETURN outcome_normalize_repository(marker[1]);
    END IF;
    segments := string_to_array(path, '/');
    IF cardinality(segments) >= 4 AND segments[3] IN ('pull', 'pulls') THEN
        RETURN outcome_normalize_repository(segments[1] || '/' || segments[2]);
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION outcome_canonical_repositories(task_repo TEXT, artifacts JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
    WITH extracted AS (
        SELECT item.position,
            CASE
                WHEN jsonb_typeof(item.value->'url') = 'string'
                    AND outcome_strip(item.value->>'url') <> ''
                    THEN jsonb_build_array('url', outcome_strip(item.value->>'url'))
                WHEN jsonb_typeof(item.value->'type') = 'string'
                    AND outcome_strip(item.value->>'type') <> ''
                    AND jsonb_typeof(item.value->'id') = 'string'
                    AND outcome_strip(item.value->>'id') <> ''
                    THEN jsonb_build_array('id', outcome_strip(item.value->>'type'), outcome_strip(item.value->>'id'))
                ELSE jsonb_build_array('position', item.position)
            END AS identity,
            (SELECT outcome_normalize_repository(item.value->>keys.key)
             FROM unnest(ARRAY['baseRepo', 'base_repo', 'targetProject', 'target_project',
                 'targetRepo', 'target_repo', 'canonicalRepo', 'canonical_repo'])
                 WITH ORDINALITY AS keys(key, position)
             WHERE jsonb_typeof(item.value->keys.key) = 'string'
                 AND outcome_normalize_repository(item.value->>keys.key) IS NOT NULL
             ORDER BY keys.position LIMIT 1) AS explicit_repo,
            CASE WHEN jsonb_typeof(item.value->'url') = 'string'
                  THEN outcome_repository_from_url(item.value->>'url') END AS url_repo,
            CASE WHEN jsonb_typeof(item.value->'repo') = 'string' AND NOT EXISTS (
                SELECT 1 FROM unnest(ARRAY['headRepo', 'head_repo', 'headProject', 'head_project',
                    'sourceRepo', 'source_repo', 'sourceProject', 'source_project', 'forkRepo', 'fork_repo']) AS keys(key)
                WHERE item.value->keys.key IS NOT NULL
                    AND item.value->keys.key NOT IN ('null'::jsonb, 'false'::jsonb,
                        '0'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)
            ) THEN outcome_normalize_repository(item.value->>'repo') END AS legacy_repo
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(artifacts) = 'array'
            THEN artifacts ELSE '[]'::jsonb END) WITH ORDINALITY AS item(value, position)
        WHERE jsonb_typeof(item.value) = 'object'
    ), candidates AS (
        SELECT identity, position, COALESCE(explicit_repo, url_repo, legacy_repo) AS repo,
            CASE WHEN explicit_repo IS NOT NULL THEN 0 WHEN url_repo IS NOT NULL THEN 1 ELSE 2 END AS rank
        FROM extracted
    ), ranked AS (
        SELECT repo, row_number() OVER (PARTITION BY identity ORDER BY rank, position DESC) AS priority
        FROM candidates WHERE repo IS NOT NULL
    ), repositories AS (SELECT DISTINCT repo COLLATE "C" AS repo FROM ranked WHERE priority = 1)
    SELECT COALESCE(jsonb_agg(repo ORDER BY repo),
        CASE WHEN outcome_normalize_repository(task_repo) IS NULL THEN '[]'::jsonb
             ELSE jsonb_build_array(outcome_normalize_repository(task_repo)) END)
    FROM repositories
$$;

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

CREATE OR REPLACE FUNCTION outcome_report_repositories() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    -- Snapshot raw legacy PR metadata too: build_artifacts intentionally retains
    -- only display/identity fields, and must not become a metadata migration.
    SELECT outcome_canonical_repositories(
        t.repo, COALESCE(t.artifacts, '[]'::jsonb) ||
        CASE WHEN jsonb_typeof(t.metadata->'prs') = 'array'
             THEN t.metadata->'prs' ELSE '[]'::jsonb END || NEW.artifacts
    ) INTO NEW.canonical_repositories
    FROM tasks t WHERE t.id = NEW.task_id;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS task_outcome_report_repositories ON task_outcome_reports;
CREATE TRIGGER task_outcome_report_repositories
    BEFORE INSERT ON task_outcome_reports
    FOR EACH ROW EXECUTE FUNCTION outcome_report_repositories();

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
