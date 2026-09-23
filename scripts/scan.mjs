import fs from 'node:fs/promises';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config', 'sites.json');
const outputPath = path.join(root, 'data', 'status.json');
const HISTORY_LIMIT = 60;
const TIMEOUT_MS = 12000;
const UA = 'SiteControlCenter/2.0 (+https://rickyganiere.github.io/site-control-center/)';

const text = (html, re) => (html.match(re)?.[1] || '').replace(/\s+/g, ' ').trim();
const has = (html, re) => re.test(html);

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*', ...(opts.headers || {}) },
      ...opts,
    });
    const ms = Math.round(performance.now() - started);
    const body = opts.method === 'HEAD' ? '' : await res.text();
    return { ok: true, res, body, ms };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

function getCertificate(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: TIMEOUT_MS, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return resolve({ ok: false, error: 'No certificate returned' });
      const expiresAt = new Date(cert.valid_to);
      resolve({
        ok: true,
        expiresAt: expiresAt.toISOString(),
        daysRemaining: Math.floor((expiresAt.getTime() - Date.now()) / 86400000),
        issuer: cert.issuer?.O || cert.issuer?.CN || '',
        subject: cert.subject?.CN || '',
      });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'TLS timeout' }); });
    socket.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

function expectedHttp(def, status) {
  if ((def.expectedStatuses || []).includes(status)) return true;
  if (def.monitorMode === 'protected') return status >= 200 && status < 500;
  return status >= 200 && status < 400;
}

function scoreSite(site, def) {
  const mode = def.monitorMode || 'website';
  const online = site.availability?.ok === true;
  const https = site.url.startsWith('https://');
  const sslOk = site.ssl?.ok === true;

  let checks;
  if (mode === 'protected') {
    checks = [
      ['Availability', online, 50, 'critical', 'Protected application endpoint is not reachable as expected.'],
      ['HTTPS', https, 20, 'critical', 'Application is not configured with HTTPS.'],
      ['TLS certificate', sslOk, 10, 'high', 'TLS certificate could not be verified.'],
      ['HSTS', site.headers?.hsts === true, 10, 'low', 'Strict-Transport-Security header not detected.'],
      ['CSP', site.headers?.csp === true, 10, 'low', 'Content-Security-Policy header not detected.'],
    ];
  } else if (mode === 'app') {
    checks = [
      ['Availability', online, 30, 'critical', 'Application is not returning an expected HTTP status.'],
      ['HTTPS', https, 15, 'critical', 'Application is not configured with HTTPS.'],
      ['TLS certificate', sslOk, 10, 'high', 'TLS certificate could not be verified.'],
      ['Title', !!site.seo?.title, 10, 'medium', 'Missing page title.'],
      ['Viewport', site.seo?.viewport === true, 10, 'medium', 'Missing viewport meta tag.'],
      ['HTML lang', !!site.seo?.lang, 5, 'low', 'Missing lang attribute on the HTML element.'],
      ['CSP', site.headers?.csp === true, 10, 'low', 'Content-Security-Policy header not detected.'],
      ['HSTS', site.headers?.hsts === true, 5, 'low', 'Strict-Transport-Security header not detected.'],
      ['Meta description', !!site.seo?.description, 3, 'low', 'Missing meta description.'],
      ['Open Graph', site.seo?.openGraph === true, 2, 'low', 'Basic Open Graph metadata not detected.'],
    ];
  } else {
    checks = [
      ['Availability', online, 20, 'critical', 'Homepage is not returning an expected HTTP status.'],
      ['HTTPS', https, 10, 'critical', 'Site is not configured with HTTPS.'],
      ['Title', !!site.seo?.title, 10, 'high', 'Missing page title.'],
      ['Meta description', !!site.seo?.description, 10, 'high', 'Missing meta description.'],
      ['Single H1', site.seo?.h1Count === 1, 10, 'medium', site.seo?.h1Count === 0 ? 'Missing H1.' : `Expected 1 H1, found ${site.seo?.h1Count ?? 0}.`],
      ['Canonical', !!site.seo?.canonical, 8, 'medium', 'Missing canonical URL.'],
      ['robots.txt', site.robots?.ok === true, 8, 'medium', 'robots.txt is missing or unavailable.'],
      ['Sitemap', site.sitemap?.ok === true, 8, 'medium', 'Sitemap is missing or unavailable.'],
      ['Viewport', site.seo?.viewport === true, 5, 'low', 'Missing viewport meta tag.'],
      ['HTML lang', !!site.seo?.lang, 4, 'low', 'Missing lang attribute on the HTML element.'],
      ['HSTS', site.headers?.hsts === true, 4, 'low', 'Strict-Transport-Security header not detected.'],
      ['Open Graph', site.seo?.openGraph === true, 3, 'low', 'Basic Open Graph metadata not detected.'],
    ];
  }

  let score = 0;
  const issues = [];
  for (const [name, pass, weight, severity, message] of checks) {
    if (pass) score += weight;
    else issues.push({ check: name, severity, message, weight });
  }
  return { score, issues };
}

async function inspectSite(def) {
  const checkedAt = new Date().toISOString();
  let base;
  try { base = new URL(def.url); }
  catch {
    return { ...def, checkedAt, health: 'critical', score: 0, availability: { ok: false }, issues: [{ check: 'URL', severity: 'critical', message: 'Invalid URL' }] };
  }

  const result = {
    id: def.id,
    name: def.name,
    url: def.url,
    monitorMode: def.monitorMode || 'website',
    checkedAt,
  };
  const home = await fetchWithTimeout(base.href);

  if (!home.ok) {
    result.http = { ok: false, error: home.error, responseMs: home.ms };
    result.availability = { ok: false, reason: home.error };
    result.ssl = base.protocol === 'https:' ? await getCertificate(base.hostname) : { ok: false, error: 'Not HTTPS' };
    result.score = 0;
    result.health = 'critical';
    result.issues = [{ check: 'Availability', severity: 'critical', message: `Endpoint could not be reached: ${home.error}` }];
    return result;
  }

  const html = home.body || '';
  const headers = home.res.headers;
  const status = home.res.status;
  result.availability = { ok: expectedHttp(def, status), expectedStatuses: def.expectedStatuses || null };
  result.http = {
    ok: true,
    status,
    responseMs: home.ms,
    finalUrl: home.res.url,
    contentType: headers.get('content-type') || '',
  };
  result.headers = {
    server: headers.get('server') || '',
    cacheControl: headers.get('cache-control') || '',
    xRobotsTag: headers.get('x-robots-tag') || '',
    hsts: !!headers.get('strict-transport-security'),
    csp: !!headers.get('content-security-policy'),
  };
  result.seo = {
    title: text(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: text(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i) || text(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i),
    canonical: text(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i) || text(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i),
    h1: text(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, '').trim(),
    h1Count: (html.match(/<h1\b/gi) || []).length,
    lang: text(html, /<html[^>]+lang=["']([^"']+)["']/i),
    viewport: has(html, /<meta[^>]+name=["']viewport["']/i),
    openGraph: has(html, /<meta[^>]+property=["']og:title["']/i) && has(html, /<meta[^>]+property=["']og:description["']/i),
    noindex: /noindex/i.test(headers.get('x-robots-tag') || '') || /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html),
  };

  result.ssl = base.protocol === 'https:' ? await getCertificate(base.hostname) : { ok: false, error: 'Not HTTPS' };

  if (result.monitorMode === 'website') {
    const robotsUrl = def.robotsPath ? new URL(def.robotsPath, base).href : new URL('/robots.txt', base).href;
    const robots = await fetchWithTimeout(robotsUrl);
    const robotBody = robots.ok ? robots.body : '';
    result.robots = { ok: !!(robots.ok && robots.res.status >= 200 && robots.res.status < 300), status: robots.ok ? robots.res.status : null, url: robotsUrl };

    const defaultSitemap = def.sitemapPath ? new URL(def.sitemapPath, base).href : new URL('/sitemap.xml', base).href;
    const sitemapCandidates = [...new Set([
      ...(robotBody.match(/^\s*Sitemap:\s*(\S+)/gim) || []).map((line) => line.replace(/^\s*Sitemap:\s*/i, '').trim()),
      defaultSitemap,
    ])];
    let sitemapResult = { ok: false, status: null, url: sitemapCandidates[0] };
    for (const candidate of sitemapCandidates.slice(0, 4)) {
      const sm = await fetchWithTimeout(candidate);
      if (sm.ok && sm.res.status >= 200 && sm.res.status < 300 && /<urlset|<sitemapindex/i.test(sm.body)) {
        sitemapResult = { ok: true, status: sm.res.status, url: candidate };
        break;
      }
      sitemapResult = { ok: false, status: sm.ok ? sm.res.status : null, url: candidate };
    }
    result.sitemap = sitemapResult;
  } else {
    result.robots = { skipped: true };
    result.sitemap = { skipped: true };
  }

  const scored = scoreSite(result, def);
  result.score = scored.score;
  result.issues = scored.issues;

  if (result.monitorMode === 'website' && result.seo.noindex) {
    result.issues.unshift({ check: 'Indexability', severity: 'high', message: 'Homepage appears to be marked noindex.' });
  }
  if (result.ssl.ok && result.ssl.daysRemaining < 14) {
    result.issues.unshift({ check: 'SSL expiry', severity: 'high', message: `SSL certificate expires in ${result.ssl.daysRemaining} days.` });
  }

  const hasCritical = result.issues.some((issue) => issue.severity === 'critical');
  result.health = !result.availability.ok || hasCritical || result.score < 60 ? 'critical' : result.score < 85 ? 'warning' : 'healthy';
  return result;
}

const sites = JSON.parse(await fs.readFile(configPath, 'utf8'));
let previous = { history: [] };
try { previous = JSON.parse(await fs.readFile(outputPath, 'utf8')); } catch {}

const results = [];
for (const site of sites) {
  console.log(`Scanning ${site.name} — ${site.url} [${site.monitorMode || 'website'}]`);
  results.push(await inspectSite(site));
}

const summary = {
  totalSites: results.length,
  online: results.filter(s => s.availability?.ok).length,
  healthy: results.filter(s => s.health === 'healthy').length,
  warnings: results.filter(s => s.health === 'warning').length,
  critical: results.filter(s => s.health === 'critical').length,
  avgScore: results.length ? Math.round(results.reduce((a, s) => a + (s.score || 0), 0) / results.length) : 0,
};
const historyPoint = {
  at: new Date().toISOString(),
  totalSites: summary.totalSites,
  online: summary.online,
  avgScore: summary.avgScore,
  critical: summary.critical,
};
const payload = {
  generatedAt: new Date().toISOString(),
  summary,
  sites: results,
  history: [...(previous.history || []), historyPoint].slice(-HISTORY_LIMIT),
};
await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Done. ${summary.online}/${summary.totalSites} online, avg health ${summary.avgScore}/100.`);
