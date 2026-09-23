# Site Control Center

Free, zero-database website health and technical SEO dashboard.

## V1 checks
- HTTP status and response time
- HTTPS and TLS certificate expiry
- Title, meta description, H1, canonical
- robots.txt and sitemap.xml
- viewport, HTML lang and Open Graph
- HSTS and CSP signals
- homepage noindex
- health score and issue severity
- scan history

## Monitoring
GitHub Actions scans the configured sites every 6 hours and saves the latest snapshot.

## Add a site
Edit `config/sites.json`.

## Cost
No paid monitoring service, database, or SaaS dependency is required. The dashboard can run on GitHub Pages.
