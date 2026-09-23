# Site Control Center

A zero-database, zero-paid-dependency control center for website and application monitoring.

## What it monitors

### Fast health scan — every 6 hours
- HTTP availability and response time
- HTTPS and TLS certificate expiry
- Website SEO fundamentals: title, meta description, H1, canonical, robots.txt, sitemap
- Security signals: HSTS and CSP
- Dedicated scoring modes for public websites, web apps and protected/private apps
- 60-scan health history

### Performance scan — daily
- Google PageSpeed Insights
- Mobile and desktop Lighthouse performance
- Accessibility, Best Practices and SEO scores
- Lab LCP, CLS, FCP, TBT, Speed Index and Time to Interactive
- Chrome UX Report field Core Web Vitals when Google has enough real-user data
- Optional `PAGESPEED_API_KEY` secret; when Google rate-limits anonymous API calls, the workflow automatically falls back to local Lighthouse CLI

### Broken-link scan — daily
- Bounded internal-link crawl on public websites
- Checks up to 30 same-origin links per site
- Stores broken-link count and the affected URLs
- Protected/private apps are intentionally skipped

### GitHub status — every 6 hours
- Latest selected GitHub Actions workflow
- Success / failure / running state
- Public repositories work without an extra token
- Private repositories can optionally use a `GITHUB_MONITOR_TOKEN` secret

## Monitoring modes

Each entry in `config/sites.json` can use:

- `website` — full availability + technical SEO scoring
- `app` — availability, TLS, responsive metadata and security headers
- `protected` — availability, expected auth status, TLS and security headers; SEO login-page checks are intentionally skipped

This prevents private applications and Cloudflare Access pages from being incorrectly flagged as SEO failures.

## Architecture

```text
config/sites.json
      |
      +--> site-scan.yml --------> data/status.json
      +--> performance-scan.yml -> data/performance.json
      +--> github-status.yml ----> data/deployments.json
                                      |
                                      v
                                GitHub Pages dashboard
```

No database, VPS, Datadog or paid monitoring SaaS is required.

## Cost guardrails

- Static dashboard on GitHub Pages
- Scheduled scans on GitHub Actions
- Performance scan only once per day
- No persistent database
- No paid API required for baseline operation

## Add a site

Edit `config/sites.json`, classify its `monitorMode`, and enable `performance` only where a Lighthouse/PageSpeed test is useful.
