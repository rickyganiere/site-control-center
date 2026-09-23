import fs from 'node:fs/promises';

const [filePath, commitMessage = 'chore: update monitoring snapshot'] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

if (!filePath) throw new Error('Usage: node scripts/publish-snapshot.mjs <path> [commit message]');
if (!repo) throw new Error('GITHUB_REPOSITORY is required');
if (!token) throw new Error('GITHUB_TOKEN is required');

const api = `https://api.github.com/repos/${repo}/contents/${filePath}`;
const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'x-github-api-version': '2022-11-28',
  'user-agent': 'site-control-center',
  'content-type': 'application/json',
};

const localText = await fs.readFile(filePath, 'utf8');
const encoded = Buffer.from(localText, 'utf8').toString('base64');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

for (let attempt = 1; attempt <= 8; attempt++) {
  const currentRes = await fetch(`${api}?ref=main&ts=${Date.now()}`, { headers });
  if (!currentRes.ok) throw new Error(`Could not read remote ${filePath}: HTTP ${currentRes.status}`);
  const current = await currentRes.json();

  const remoteText = Buffer.from(String(current.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  if (remoteText === localText) {
    console.log(`No remote change needed for ${filePath}.`);
    process.exit(0);
  }

  const putRes = await fetch(api, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: commitMessage,
      content: encoded,
      sha: current.sha,
      branch: 'main',
    }),
  });

  if (putRes.ok) {
    const result = await putRes.json();
    console.log(`Published ${filePath} at ${result.commit?.sha || 'new commit'}.`);
    process.exit(0);
  }

  const body = await putRes.text();
  if (putRes.status !== 409 && putRes.status !== 422) {
    throw new Error(`Could not publish ${filePath}: HTTP ${putRes.status} ${body.slice(0, 500)}`);
  }

  console.warn(`Snapshot write conflict for ${filePath} on attempt ${attempt}; retrying.`);
  await wait(attempt * 500);
}

throw new Error(`Could not publish ${filePath} after 8 attempts.`);
