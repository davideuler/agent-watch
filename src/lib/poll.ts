import type { Env } from './types';
import { getProjects } from './config';
import { fetchIssueComments, fetchIssues, fetchReleases, type GhRelease } from './github';
import { analyzeIssue } from './llm';
import {
  getPollState,
  listVersions,
  setAnalysis,
  setPollState,
  upsertComment,
  upsertIssue,
  upsertProject,
  upsertVersion,
} from './db';

function bestDownloadUrl(rel: GhRelease): string | null {
  if (rel.assets.length > 0) {
    const sorted = [...rel.assets].sort((a, b) => b.size - a.size);
    return sorted[0]!.browser_download_url;
  }
  return rel.tarball_url ?? rel.zipball_url ?? rel.html_url;
}

export async function pollOnce(env: Env): Promise<{ project: string; releases: number; issues: number; analyses: number }[]> {
  const cfg = getProjects(env);
  const results: { project: string; releases: number; issues: number; analyses: number }[] = [];

  for (const p of cfg) {
    const project = await upsertProject(env, p.slug, p.name, p.repo);
    let releaseCount = 0;
    let issueCount = 0;
    let analysisCount = 0;

    try {
      const releases = await fetchReleases(env, p.repo, 30);
      const stable = releases.filter((r) => !/beta/i.test(r.tag_name)).slice(0, 15);
      for (const r of stable) {
        await upsertVersion(env, {
          project_id: project.id,
          tag_name: r.tag_name,
          name: r.name,
          body: r.body,
          html_url: r.html_url,
          download_url: bestDownloadUrl(r),
          published_at: r.published_at,
          is_prerelease: r.prerelease,
          raw_json: JSON.stringify({ id: r.id, assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url })) }),
        });
        releaseCount++;
      }
    } catch (err) {
      console.error(`[poll] ${p.slug} releases failed`, err);
    }

    const versions = await listVersions(env, project.id, 15);
    const tagNames = versions.map((v) => v.tag_name);

    try {
      const state = await getPollState(env, project.id);
      const issues = await fetchIssues(env, p.repo, {
        since: state.last_issue_updated_at ?? undefined,
        pages: 2,
      });
      let maxUpdated = state.last_issue_updated_at;
      for (const issue of issues) {
        try {
          const issueId = await upsertIssue(env, {
            project_id: project.id,
            github_id: issue.id,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            html_url: issue.html_url,
            user_login: issue.user?.login ?? null,
            comment_count: issue.comments,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            closed_at: issue.closed_at,
          });
          issueCount++;
          if (!maxUpdated || issue.updated_at > maxUpdated) maxUpdated = issue.updated_at;

          let comments: Awaited<ReturnType<typeof fetchIssueComments>> = [];
          if (issue.comments > 0) {
            try {
              comments = await fetchIssueComments(env, p.repo, issue.number, 10);
              for (const com of comments) {
                await upsertComment(env, issueId, com.id, com.body, com.user?.login ?? null, com.created_at);
              }
            } catch (err) {
              console.error(`[poll] ${p.slug} issue#${issue.number} comments failed`, err);
            }
          }

          if (env.LLM_API_KEY) {
            try {
              const result = await analyzeIssue(env, issue, comments, tagNames);
              await setAnalysis(env, {
                issue_id: issueId,
                sentiment: result.sentiment,
                target_version: result.targetVersion,
                confidence: result.confidence,
                summary: result.summary,
                raw_response: result.raw.slice(0, 4000),
              });
              analysisCount++;
            } catch (err) {
              console.error(`[poll] ${p.slug} issue#${issue.number} analysis failed`, err);
            }
          }
        } catch (err) {
          console.error(`[poll] ${p.slug} issue#${issue.number} failed`, err);
        }
      }
      await setPollState(env, project.id, maxUpdated);
    } catch (err) {
      console.error(`[poll] ${p.slug} issues failed`, err);
    }

    results.push({ project: p.slug, releases: releaseCount, issues: issueCount, analyses: analysisCount });
  }

  return results;
}
