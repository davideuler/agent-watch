-- Agent Watch — schema v1
-- All timestamps stored as ISO-8601 TEXT (sqlite-friendly, comparable lexicographically).

CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    github_repo  TEXT NOT NULL,
    github_url   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tag_name      TEXT NOT NULL,
    name          TEXT,
    body          TEXT,
    html_url      TEXT,
    download_url  TEXT,
    published_at  TEXT NOT NULL,
    is_prerelease INTEGER NOT NULL DEFAULT 0,
    raw_json      TEXT,
    UNIQUE (project_id, tag_name)
);
CREATE INDEX IF NOT EXISTS idx_versions_project_pub ON versions(project_id, published_at DESC);

CREATE TABLE IF NOT EXISTS issues (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    github_id    INTEGER NOT NULL,
    number       INTEGER NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT,
    state        TEXT NOT NULL,
    html_url     TEXT NOT NULL,
    user_login   TEXT,
    comment_count INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    closed_at    TEXT,
    UNIQUE (project_id, github_id)
);
CREATE INDEX IF NOT EXISTS idx_issues_project_created ON issues(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_issues_project_updated ON issues(project_id, updated_at);

CREATE TABLE IF NOT EXISTS issue_comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id    INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    github_id   INTEGER NOT NULL,
    body        TEXT,
    user_login  TEXT,
    created_at  TEXT NOT NULL,
    UNIQUE (issue_id, github_id)
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON issue_comments(issue_id, created_at);

CREATE TABLE IF NOT EXISTS issue_analyses (
    issue_id        INTEGER PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    sentiment       TEXT NOT NULL,                      -- positive | negative | neutral
    target_version  TEXT,                               -- tag_name guess, nullable
    confidence      REAL NOT NULL DEFAULT 0,            -- 0..1
    summary         TEXT,
    raw_response    TEXT,
    analyzed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider      TEXT NOT NULL,                        -- github | google
    provider_id   TEXT NOT NULL,
    email         TEXT,
    name          TEXT,
    login         TEXT,
    avatar_url    TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (provider, provider_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS user_ratings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version_id  INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
    comment     TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (user_id, version_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_version ON user_ratings(version_id);

CREATE TABLE IF NOT EXISTS poll_state (
    project_id            INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    last_issue_updated_at TEXT,
    last_polled_at        TEXT
);
