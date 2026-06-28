-- Phase 2: usage-context signals.
-- These are DISPLAY-ONLY context (adoption / install-base proxies). They are
-- deliberately NOT fed into the stability score: per-version download data is
-- absent for source-only releases and whole projects, so dividing risk by it
-- would add bias rather than remove it (see score.ts exposure normalization).
ALTER TABLE projects ADD COLUMN stargazers_count INTEGER;
ALTER TABLE projects ADD COLUMN usage_updated_at TEXT;

-- Sum of uploaded-asset download counts for a release. NULL means "no signal"
-- (source-only release / auto tarball+zipball, which GitHub does not count),
-- which is distinct from 0 ("had assets, nobody downloaded them yet").
ALTER TABLE versions ADD COLUMN download_count INTEGER;
