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
- Free local Lighthouse baseline for mobile and desktop
- Performance, Accessibility, Best Practices and SEO scores
- Lab LCP, CLS, FCP, TBT, Speed Index and Time to Interactive
- Top Lighthouse performance recommendations
- Optional Google PageSpeed API integration for field Core Web Vitals when a free `PAGESPEED_API_KEY` secret is configured
- Without an API key, the workflow does not make anonymous PageSpeed calls, avoiding unnecessary rate-limit errors

### Broken-link scan — daily
- Bounded internal-link crawl on public websites
- Checks up to 30 same-origin links per site
- Stores broken-link count and affected URLs
- Protected/private apps are intentionally skipped

### GitHub status — every 6 hours
- Latest selected GitHub Actions workflow for public repositories
- Success / failure / running state
- Private repository names and workflow metadata are intentionally not published
- Private applications still receive live HTTP/TLS/security monitoring

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
      +--> link-scan.yml --------> data/links.json
      +--> github-status.yml ----> data/deployments.json
                                      |
                                      v
                                GitHub Pages dashboard
```

Snapshot writers rebase onto the newest `main` state and retry branch races, so parallel monitoring jobs do not overwrite unrelated updates.

No database, VPS, Datadog or paid monitoring SaaS is required.

## Cost guardrails

- Static dashboard on GitHub Pages
- Scheduled scans on GitHub Actions
- Performance scan only once per day
- No persistent database
- No paid API required for baseline operation
- Optional PageSpeed API key remains free and is only needed for field-data enrichment

## Add a site

Edit `config/sites.json`, classify its `monitorMode`, and enable `performance` only where a Lighthouse test is useful.

## Current dashboard behavior

The dashboard surfaces:
- overall online/healthy/critical counts
- average health and mobile performance
- broken-link count
- per-site health, TLS, security and SEO/app checks
- Lighthouse lab performance
- top performance fixes
- public GitHub workflow status
- a **Needs attention** section that promotes actionable warnings first
