import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config', 'sites.json');
const outputPath = path.join(root, 'data', 'links.json');
const TIMEOUT_MS = 12000;
const MAX_LINKS = 30;
const UA = 'SiteControlCenter-LinkCheck/1.0';

async function checkUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
    });
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      responseMs: Math.round(performance.now() - started),
      finalUrl: (() => { try { const u = new URL(res.url); return u.origin + u.pathname; } catch { return ''; } })(),
    };
  } catch (error) {
    return { ok: false, status: null, responseMs: Math.round(performance.now() - started), error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function extractLinks(html, base) {
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < MAX_LINKS) {
    const raw = m[1].trim();
    if (!raw || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    try {
      const u = new URL(raw, base);
      const b = new URL(base);
      if (!/^https?:$/.test(u.protocol) || u.origin !== b.origin) continue;
      u.hash = '';
      const normalized = u.href;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      links.push(normalized);
    } catch {}
  }
  return links;
}

async function fetchHome(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'text/html' } });
    if (!res.ok) throw new Error(`Homepage HTTP ${res.status}`);
    return { html: await res.text(), finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

const sites = JSON.parse(await fs.readFile(configPath, 'utf8'));
let previous = { history: [] };
try { previous = JSON.parse(await fs.readFile(outputPath, 'utf8')); } catch {}

const results = [];
for (const def of sites.filter(s => (s.monitorMode || 'website') === 'website')) {
  console.log(`Links: ${def.name}`);
  try {
    const home = await fetchHome(def.url);
    const urls = extractLinks(home.html, home.finalUrl);
    const checked = [];
    for (const url of urls) {
      checked.push({ url, ...(await checkUrl(url)) });
    }
    const broken = checked.filter(x => !x.ok);
    results.push({
      id: def.id,
      name: def.name,
      url: def.url,
      checkedAt: new Date().toISOString(),
      checkedCount: checked.length,
      brokenCount: broken.length,
      broken: broken.slice(0, 10),
    });
  } catch (error) {
    results.push({
      id: def.id,
      name: def.name,
      url: def.url,
      checkedAt: new Date().toISOString(),
      checkedCount: 0,
      brokenCount: null,
      error: error?.message || String(error),
      broken: [],
    });
  }
}

const counts = results.filter(x => Number.isFinite(x.brokenCount));
const summary = {
  monitoredSites: results.length,
  checkedLinks: results.reduce((n,x)=>n+(x.checkedCount||0),0),
  brokenLinks: counts.reduce((n,x)=>n+x.brokenCount,0),
  sitesWithBrokenLinks: counts.filter(x=>x.brokenCount>0).length,
};
const point = { at: new Date().toISOString(), brokenLinks: summary.brokenLinks, checkedLinks: summary.checkedLinks };
const payload = {
  generatedAt: new Date().toISOString(),
  summary,
  sites: results,
  history: [...(previous.history || []), point].slice(-30),
};
await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Done. Checked ${summary.checkedLinks} links; broken: ${summary.brokenLinks}.`);
