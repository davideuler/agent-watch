ALTER TABLE issue_analyses ADD COLUMN severity TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE issue_analyses ADD COLUMN impact_scope TEXT NOT NULL DEFAULT 'moderate';
ALTER TABLE issue_analyses ADD COLUMN functionality TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE issue_analyses ADD COLUMN affected_user_share TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE issue_analyses ADD COLUMN duplicate_cluster_size INTEGER NOT NULL DEFAULT 1;
ALTER TABLE issue_analyses ADD COLUMN workaround_status TEXT NOT NULL DEFAULT 'unknown';
