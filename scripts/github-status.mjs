import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config', 'sites.json');
const outputPath = path.join(root, 'data', 'deployments.json');
const TIMEOUT_MS = 15000;
const SELF_REPO = 'rickyganiere/site-control-center';

async function fetchRuns(repo, token = '') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'site-control-center',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=50`, {
      signal: ctrl.signal,
      headers,
    });
    if (!res.ok) {
      const retry = res.headers.get('retry-after');
      const remaining = res.headers.get('x-ratelimit-remaining');
      const suffix = retry ? ` retry-after=${retry}` : remaining === '0' ? ' rate-limit-exhausted' : '';
      throw new Error(`GitHub API HTTP ${res.status}${suffix}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function pickRun(runs, def) {
  const named = runs.filter(r => !def.githubWorkflow || r.name === def.githubWorkflow);
  return named.find(r => r.head_branch === 'main') || named[0] || runs.find(r => r.head_branch === 'main') || runs[0] || null;
}

const sites = JSON.parse(await fs.readFile(configPath, 'utf8'));
let previous = { history: [], sites: [] };
try {
  previous = JSON.parse(await fs.readFile(outputPath, 'utf8'));
} catch {}

const previousById = new Map((previous.sites || []).map(x => [x.id, x]));
const results = [];

for (const def of sites.filter(s => s.githubRepo)) {
  const old = previousById.get(def.id);

  if (def.repoPrivate && !process.env.GITHUB_MONITOR_TOKEN) {
    results.push({
      id: def.id,
      repo: def.githubRepo,
      workflow: def.githubWorkflow || null,
      kind: def.githubKind || 'CI',
      available: false,
      private: true,
      note: 'Live app monitoring is active. Private GitHub workflow status needs the optional GITHUB_MONITOR_TOKEN secret.',
      latest: old?.latest || null,
      stale: !!old?.latest,
    });
    continue;
  }

  const token = def.repoPrivate
    ? (process.env.GITHUB_MONITOR_TOKEN || '')
    : (def.githubRepo === SELF_REPO ? (process.env.GITHUB_PUBLIC_TOKEN || '') : '');

  try {
    const payload = await fetchRuns(def.githubRepo, token);
    const run = pickRun(payload.workflow_runs || [], def);
    results.push({
      id: def.id,
      repo: def.githubRepo,
      workflow: def.githubWorkflow || run?.name || null,
      kind: def.githubKind || 'CI',
      available: !!run,
      private: !!def.repoPrivate,
      stale: false,
      latest: run ? {
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        event: run.event,
        branch: run.head_branch,
        sha: run.head_sha,
        title: run.display_title,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        url: run.html_url,
      } : null,
    });
  } catch (error) {
    results.push({
      id: def.id,
      repo: def.githubRepo,
      workflow: def.githubWorkflow || old?.workflow || null,
      kind: def.githubKind || 'CI',
      available: !!old?.latest,
      private: !!def.repoPrivate,
      stale: !!old?.latest,
      latest: old?.latest || null,
      error: error?.message || String(error),
    });
  }
}

const effective = results.filter(x => x.latest);
const summary = {
  tracked: results.length,
  visible: effective.length,
  successful: effective.filter(x => x.latest?.conclusion === 'success').length,
  failing: effective.filter(x => x.latest?.conclusion === 'failure').length,
  running: effective.filter(x => ['queued','in_progress','waiting','pending','requested'].includes(x.latest?.status)).length,
  stale: results.filter(x => x.stale).length,
};

const now = new Date().toISOString();
const payload = {
  generatedAt: now,
  summary,
  sites: results,
  history: [...(previous.history || []), {
    at: now,
    successful: summary.successful,
    failing: summary.failing,
    running: summary.running,
  }].slice(-30),
};

await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Done. ${summary.visible}/${summary.tracked} GitHub statuses available; ${summary.stale} stale.`);
