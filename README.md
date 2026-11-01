# ADCommerce status

The public status page of the ADCommerce platform: **https://status.adcommerce.mn**

- `scripts/check.mjs` checks each part every 5 minutes from GitHub Actions (`.github/workflows/check.yml`), triggered by
  cron-job.org; GitHub's schedule is the fallback.
- `data/` is the page's data: current state, 90 days of daily roll-ups, incidents. It changes only when a state does,
  plus once a day.
- The page (`index.html`, `assets/`) is served by GitHub Pages and reads `data/`.
- Incidents post to the team's Slack, with updates in a thread.

What is checked, and how: sign-in (Auth's deep health check and OpenID discovery), Admin (the app and the API's deep
health check), checkout, the AD agent, media (the CDN), a few online store home pages per run (with a non-browser user
agent, so never counted as a visit), and the email provider's and Cloudflare's own public status. A part is marked
degraded after 2 failed runs in a row and as an outage after 3.

Test an alert (writes nothing public): Actions → check → Run workflow with `simulate` = a part id (e.g. `admin`) and
`test_label` = `TEST`; run it twice for "degraded", then once without `simulate` for the recovery.
