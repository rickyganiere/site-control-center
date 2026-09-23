import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config', 'sites.json');
const outputPath = path.join(root, 'data', 'performance.json');
const PSI_TIMEOUT_MS = 45000;
const LIGHTHOUSE_TIMEOUT_MS = 180000;
const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PSI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const pct = (score) => Number.isFinite(score) ? Math.round(score * 100) : null;
const auditNum = (a) => Number.isFinite(a?.numericValue) ? Math.round(a.numericValue) : null;
const auditRaw = (a) => Number.isFinite(a?.numericValue) ? Math.round(a.numericValue * 1000) / 1000 : null;

function fieldData(json) {
  const exp = json.loadingExperience?.metrics || json.originLoadingExperience?.metrics || null;
  if (!exp) return { available: false };
  const metric = (name) => {
    const m = exp[name];
    return m ? { percentile: m.percentile ?? null, category: m.category ?? null } : null;
  };
  return {
    available: true,
    lcp: metric('LARGEST_CONTENTFUL_PAINT_MS'),
    cls: metric('CUMULATIVE_LAYOUT_SHIFT_SCORE'),
    inp: metric('INTERACTION_TO_NEXT_PAINT'),
    fcp: metric('FIRST_CONTENTFUL_PAINT_MS'),
  };
}

function performanceRecommendations(audits = {}) {
  const ids = [
    'render-blocking-resources',
    'unused-javascript',
    'unused-css-rules',
    'uses-text-compression',
    'modern-image-formats',
    'uses-optimized-images',
    'uses-responsive-images',
    'offscreen-images',
    'unminified-javascript',
    'unminified-css',
    'server-response-time',
    'dom-size'
  ];
  return ids
    .map(id => ({ id, audit: audits[id] }))
    .filter(x => x.audit && x.audit.score !== null && x.audit.score < 1)
    .map(x => ({
      id: x.id,
      title: x.audit.title || x.id,
      displayValue: x.audit.displayValue || null,
      score: Number.isFinite(x.audit.score) ? Math.round(x.audit.score * 100) : null,
      savingsMs: Number.isFinite(x.audit.details?.overallSavingsMs) ? Math.round(x.audit.details.overallSavingsMs) : null,
      savingsBytes: Number.isFinite(x.audit.details?.overallSavingsBytes) ? Math.round(x.audit.details.overallSavingsBytes) : null
    }))
    .sort((a,b) => (b.savingsMs || 0) - (a.savingsMs || 0))
    .slice(0, 4);
}

function parseLighthouse(lr, strategy, source, field = { available: false }, extra = {}) {
  const c = lr.categories || {};
  const a = lr.audits || {};
  return {
    strategy,
    source,
    fetchedAt: new Date().toISOString(),
    finalUrl: lr.finalDisplayedUrl || lr.finalUrl || lr.requestedUrl || null,
    scores: {
      performance: pct(c.performance?.score),
      accessibility: pct(c.accessibility?.score),
      bestPractices: pct(c['best-practices']?.score),
      seo: pct(c.seo?.score),
    },
    lab: {
      fcpMs: auditNum(a['first-contentful-paint']),
      lcpMs: auditNum(a['largest-contentful-paint']),
      tbtMs: auditNum(a['total-blocking-time']),
      cls: auditRaw(a['cumulative-layout-shift']),
      speedIndexMs: auditNum(a['speed-index']),
      interactiveMs: auditNum(a.interactive),
    },
    field,
    recommendations: performanceRecommendations(a),
    ...extra,
  };
}

async function runPsi(def, strategy) {
  const q = new URLSearchParams();
  q.set('url', def.url);
  q.set('strategy', strategy);
  for (const cat of ['performance', 'accessibility', 'best-practices', 'seo']) q.append('category', cat);
  if (process.env.PAGESPEED_API_KEY) q.set('key', process.env.PAGESPEED_API_KEY);
  const json = await fetchJson(`${API}?${q.toString()}`);
  if (!json.lighthouseResult) throw new Error('No Lighthouse result returned');
  return parseLighthouse(json.lighthouseResult, strategy, 'pagespeed-api', fieldData(json));
}

async function runLighthouse(def, strategy, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-control-lh-'));
  const out = path.join(dir, `${def.id}-${strategy}.json`);
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = [
    '--yes',
    'lighthouse@latest',
    def.url,
    '--quiet',
    '--output=json',
    `--output-path=${out}`,
    '--only-categories=performance,accessibility,best-practices,seo',
    '--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage'
  ];
  if (strategy === 'desktop') args.push('--preset=desktop');

  const proc = spawnSync(npx, args, {
    encoding: 'utf8',
    timeout: LIGHTHOUSE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });

  try {
    if (proc.error) throw proc.error;
    if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || `Lighthouse exited ${proc.status}`).trim().slice(0, 500));
    const json = JSON.parse(await fs.readFile(out, 'utf8'));
    return parseLighthouse(json, strategy, 'lighthouse-cli', { available: false }, extra);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function run(def, strategy) {
  if (!process.env.PAGESPEED_API_KEY) {
    try {
      return await runLighthouse(def, strategy, { psiSkipped: true });
    } catch (error) {
      return {
        strategy,
        fetchedAt: new Date().toISOString(),
        error: error?.message || String(error),
        psiSkipped: true,
      };
    }
  }

  try {
    return await runPsi(def, strategy);
  } catch (error) {
    const psiError = error?.message || String(error);
    console.warn(`PageSpeed API ${strategy} failed for ${def.name}: ${psiError}. Falling back to Lighthouse CLI.`);
    try {
      return await runLighthouse(def, strategy, { psiError });
    } catch (fallbackError) {
      return {
        strategy,
        fetchedAt: new Date().toISOString(),
        error: fallbackError?.message || String(fallbackError),
        psiError,
      };
    }
  }
}

const sites = JSON.parse(await fs.readFile(configPath, 'utf8'));
let previous = { history: [] };
try { previous = JSON.parse(await fs.readFile(outputPath, 'utf8')); } catch {}

const results = [];
for (const def of sites.filter(s => s.performance && s.monitorMode !== 'protected')) {
  console.log(`Performance: ${def.name}`);
  const mobile = await run(def, 'mobile');
  const desktop = await run(def, 'desktop');
  results.push({ id: def.id, name: def.name, url: def.url, mobile, desktop });
}

const mobileScores = results.map(x => x.mobile?.scores?.performance).filter(Number.isFinite);
const desktopScores = results.map(x => x.desktop?.scores?.performance).filter(Number.isFinite);
const summary = {
  monitoredSites: results.length,
  mobileAvg: mobileScores.length ? Math.round(mobileScores.reduce((a,b)=>a+b,0)/mobileScores.length) : null,
  desktopAvg: desktopScores.length ? Math.round(desktopScores.reduce((a,b)=>a+b,0)/desktopScores.length) : null,
  errors: results.reduce((n,x)=>n + (x.mobile?.error?1:0) + (x.desktop?.error?1:0), 0),
  lighthouseRuns: results.reduce((n,x)=>n + (x.mobile?.source==='lighthouse-cli'?1:0) + (x.desktop?.source==='lighthouse-cli'?1:0), 0),
  fieldDataAvailable: results.reduce((n,x)=>n + (x.mobile?.field?.available?1:0) + (x.desktop?.field?.available?1:0), 0),
};
const historyPoint = { at: new Date().toISOString(), mobileAvg: summary.mobileAvg, desktopAvg: summary.desktopAvg };
const payload = {
  generatedAt: new Date().toISOString(),
  summary,
  sites: results,
  history: [...(previous.history || []), historyPoint].slice(-30),
};
await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Done. Mobile avg: ${summary.mobileAvg ?? 'n/a'}, desktop avg: ${summary.desktopAvg ?? 'n/a'}, errors: ${summary.errors}.`);
