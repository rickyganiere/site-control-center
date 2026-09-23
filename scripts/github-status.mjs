// Site Control Center GitHub status monitor v1.1\nimport fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config', 'sites.json');
const outputPath = path.join(root, 'data', 'deployments.json');
const TIMEOUT_MS = 15000;

async function fetchRuns(repo) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'site-control-center',
  };
  if (process.env.GITHUB_MONITOR_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_MONITOR_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=30`, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const sites = JSON.parse(await fs.readFile(configPath, 'utf8'));
let previous = { history: [] };
try { previous = JSON.parse(await fs.readFile(outputPath, 'utf8')); } catch {}

const results = [];
for (const def of sites.filter(s => s.githubRepo)) {
  if (def.repoPrivate && !process.env.GITHUB_MONITOR_TOKEN) {
    results.push({
      id: def.id,
      repo: def.githubRepo,
      workflow: def.githubWorkflow || null,
      kind: def.githubKind || 'CI',
      available: false,
      private: true,
      note: 'Private repository status requires optional GITHUB_MONITOR_TOKEN secret.'
    });
    continue;
  }
  try {
    const payload = await fetchRuns(def.githubRepo);
    const run = (payload.workflow_runs || []).find(r => !def.githubWorkflow || r.name === def.githubWorkflow) || (payload.workflow_runs || [])[0];
    results.push({
      id: def.id,
      repo: def.githubRepo,
      workflow: def.githubWorkflow || run?.name || null,
      kind: def.githubKind || 'CI',
      available: !!run,
      private: !!def.repoPrivate,
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
      } : null
    });
  } catch (error) {
    results.push({
      id: def.id,
      repo: def.githubRepo,
      workflow: def.githubWorkflow || null,
      kind: def.githubKind || 'CI',
      available: false,
      private: !!def.repoPrivate,
      error: error?.message || String(error)
    });
  }
}

const summary = {
  tracked: results.length,
  visible: results.filter(x => x.available).length,
  successful: results.filter(x => x.latest?.conclusion === 'success').length,
  failing: results.filter(x => x.latest?.conclusion === 'failure').length,
  running: results.filter(x => ['queued','in_progress','waiting','pending','requested'].includes(x.latest?.status)).length,
};

const historyPoint = {
  at: new Date().toISOString(),
  successful: summary.successful,
  failing: summary.failing,
  running: summary.running,
};
const payload = {
  generatedAt: new Date().toISOString(),
  summary,
  sites: results,
  history: [...(previous.history || []), historyPoint].slice(-30),
};
await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Done. ${summary.visible}/${summary.tracked} GitHub statuses visible.`);
