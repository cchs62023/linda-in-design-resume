# AI Portal Screenshot Library

Weekly screenshots of the major AI / LLM chat portals (ChatGPT, Claude, Gemini,
Perplexity, Copilot, Le Chat, Grok…), each with a short design analysis, plus a
Slack notification after every run.

- **Gallery page:** [`../screenshots/index.html`](../screenshots/index.html)
  (served at `…/linda-in-design-resume/screenshots/` on GitHub Pages)
- **Data:** [`../screenshots/manifest.json`](../screenshots/manifest.json)
- **Images:** `../screenshots/shots/*.png`
- **Automation:** [`../.github/workflows/weekly-screenshots.yml`](../.github/workflows/weekly-screenshots.yml)

## How it works

Every Monday (or on manual dispatch) the GitHub Action:

1. opens each portal from [`portals.json`](portals.json) in headless Chromium
   and takes a **full-page screenshot**;
2. extracts a small **dominant-colour palette** from each image;
3. writes a **brief design analysis** — via Claude vision if `ANTHROPIC_API_KEY`
   is set, otherwise a heuristic note from the palette + page metadata;
4. updates `screenshots/manifest.json` (newest first);
5. commits the new images + manifest back to the repo, which redeploys the
   Pages gallery;
6. posts a **Slack notification** with a thumbnail and the analysis of each
   portal.

## One-time setup

1. **Slack incoming webhook** — create one at
   <https://api.slack.com/messaging/webhooks>, then add it to the repo:
   `Settings → Secrets and variables → Actions → New repository secret`
   - `SLACK_WEBHOOK_URL` = `https://hooks.slack.com/services/…`
2. **(Optional) Claude-written analysis** — add secret
   - `ANTHROPIC_API_KEY` = your Anthropic API key
   Without it, the script falls back to a heuristic design note.
3. **(Optional) Site URL for links** — add an Actions *variable* (not secret)
   - `SITE_BASE_URL` = `https://<user>.github.io/<repo>/screenshots/`
   Defaults to `https://cchs62023.github.io/linda-in-design-resume/screenshots/`.
4. **Enable GitHub Pages** for the repo (Deploy from branch → root) so the
   gallery and Slack image thumbnails are publicly reachable.

## Run it manually

From the **Actions** tab → *Weekly AI portal screenshots* → *Run workflow*.
Optionally pass a comma-separated list of slugs to capture just those.

Locally:

```bash
cd scripts
npm install
npx playwright install chromium      # first time only
export SLACK_WEBHOOK_URL=...          # optional
export ANTHROPIC_API_KEY=...          # optional
node capture.mjs                      # all portals, this week
node capture.mjs --only claude,chatgpt
node capture.mjs --no-slack           # capture without notifying
node capture.mjs --week 2026-07-13    # override the week label
```

## Adding / removing portals

Edit [`portals.json`](portals.json). Each entry:

```json
{
  "slug": "claude",           // filename + id (unique, no spaces)
  "name": "Claude",           // display name
  "company": "Anthropic",     // shown under the name
  "url": "https://claude.ai/",
  "brand": "#d97757",         // badge colour
  "waitFor": 4000,            // ms to let the page settle before the shot
  "fullPage": true            // capture the whole scroll height
}
```

## Notes

- Most portals show a **login / landing** screen to logged-out visitors — that
  is what gets captured, which is exactly the public "front door" design we want
  to track over time.
- The gallery ships with three clearly-labelled **SAMPLE** mockups so it renders
  before the first automated run. The first real run adds real captures
  alongside them; delete the `sample-*.svg` entries from `manifest.json` once you
  have real data if you'd like.
- Slack incoming webhooks render an image by URL, so thumbnails resolve once
  GitHub Pages has published the committed screenshot (usually within a minute).
