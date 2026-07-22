#!/usr/bin/env node
/**
 * Weekly AI-portal screenshot capture.
 *
 * For every portal in portals.json it:
 *   1. opens the page in headless Chromium and takes a full-page screenshot
 *   2. extracts a small dominant-colour palette from the image
 *   3. writes a brief design analysis (Claude vision if ANTHROPIC_API_KEY is
 *      set, otherwise a heuristic note built from the palette + page metadata)
 *   4. updates screenshots/manifest.json (newest first)
 *   5. posts a Slack notification summarising the batch (unless --no-slack)
 *
 * The heavy lifting (real network access) is meant to run on a GitHub Actions
 * runner via .github/workflows/weekly-screenshots.yml. It also runs locally.
 *
 * Env:
 *   SLACK_WEBHOOK_URL   Slack incoming-webhook URL for notifications
 *   ANTHROPIC_API_KEY   optional: enables Claude-written design analysis
 *   ANALYSIS_MODEL      optional: override the analysis model id
 *   SITE_BASE_URL       optional: public base URL of the gallery (for links)
 *
 * Flags:
 *   --only a,b          capture only these portal slugs
 *   --no-slack          skip the Slack notification
 *   --week YYYY-MM-DD   override the week label (defaults to this Monday)
 */

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SHOTS_DIR = join(ROOT, 'screenshots', 'shots');
const MANIFEST_PATH = join(ROOT, 'screenshots', 'manifest.json');

const VIEWPORT = { width: 1280, height: 900 };
const DEFAULT_SITE_BASE =
  process.env.SITE_BASE_URL ||
  'https://cchs62023.github.io/linda-in-design-resume/screenshots/';
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'claude-sonnet-5';

// ---------------------------------------------------------------- args ----
function parseArgs(argv) {
  const args = { only: null, slack: true, week: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-slack') args.slack = false;
    else if (a === '--only') args.only = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--week') args.week = argv[++i];
  }
  return args;
}

// Monday of the current week, as YYYY-MM-DD (used to group captures).
function isoWeekMonday(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Sun=0 -> 7
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date.toISOString().slice(0, 10);
}

// ----------------------------------------------------- colour palette ----
/**
 * Sample a dominant-colour palette from a PNG by drawing it (downscaled) onto
 * a canvas inside a throwaway page and quantising the pixels. No native deps.
 */
async function extractPalette(browser, pngBuffer, count = 5) {
  const page = await browser.newPage();
  try {
    const dataUrl = 'data:image/png;base64,' + pngBuffer.toString('base64');
    const palette = await page.evaluate(
      async ({ src, count }) => {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = src;
        });
        const w = 80;
        const h = Math.max(1, Math.round((img.height / img.width) * w));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 128) continue;
          // quantise to 4 bits/channel so similar colours merge
          const r = data[i] & 0xf0;
          const g = data[i + 1] & 0xf0;
          const b = data[i + 2] & 0xf0;
          const key = (r << 16) | (g << 8) | b;
          const cur = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
          cur.n++;
          cur.r += data[i];
          cur.g += data[i + 1];
          cur.b += data[i + 2];
          buckets.set(key, cur);
        }
        const sorted = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, count);
        const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
        return sorted.map((c) => `#${hex(c.r / c.n)}${hex(c.g / c.n)}${hex(c.b / c.n)}`);
      },
      { src: dataUrl, count }
    );
    return palette;
  } catch {
    return [];
  } finally {
    await page.close();
  }
}

// ------------------------------------------------------- design analysis ----
function heuristicAnalysis(portal, meta) {
  const { palette = [], width, height, title } = meta;
  const ratio = height / width;
  const density =
    ratio > 3 ? 'a long, content-dense scroll' : ratio > 1.6 ? 'a moderately tall layout' : 'a compact, above-the-fold-first layout';
  const tone =
    palette[0] && isDark(palette[0]) ? 'a dark, focused canvas' : 'a light, airy canvas';
  const accent = palette.find((c) => isVivid(c));
  const accentNote = accent ? ` An accent around ${accent} carries the primary calls-to-action.` : '';
  return `${portal.name} presents ${tone} with ${density}. The dominant palette (${palette
    .slice(0, 3)
    .join(', ')}) keeps chrome minimal so the input/composer stays the focal point.${accentNote}${
    title ? ` Page title: “${title}”.` : ''
  }`.trim();
}

function isDark(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
function isVivid(hex) {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min > 60 && max > 90;
}
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

async function claudeAnalysis(portal, pngBuffer, meta) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const prompt =
    `This is a full-page screenshot of the ${portal.name} portal by ${portal.company}. ` +
    `Give a brief design analysis in 2–3 sentences for a UX designer's reference library. ` +
    `Cover the visual tone, layout/hierarchy, and one notable interaction or UX choice. ` +
    `Be specific and neutral; no preamble, no bullet points.`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        max_tokens: 320,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBuffer.toString('base64') } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`  ! Claude analysis failed (${res.status}); using heuristic.`);
      return null;
    }
    const json = await res.json();
    const text = (json.content || []).map((b) => b.text || '').join(' ').trim();
    return text || null;
  } catch (e) {
    console.warn(`  ! Claude analysis error: ${e.message}; using heuristic.`);
    return null;
  }
}

// -------------------------------------------------------------- capture ----
async function capturePortal(browser, portal, week) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();
  const capturedAt = new Date().toISOString();
  const file = `${portal.slug}-${week}.png`;
  const outPath = join(SHOTS_DIR, file);
  try {
    await page.goto(portal.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(async () => {
      // fall back to a softer wait if networkidle never settles
      await page.goto(portal.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    });
    await page.waitForTimeout(portal.waitFor ?? 3000);
    // dismiss the most common cookie / consent overlays so they don't dominate
    await dismissOverlays(page);
    const title = await page.title().catch(() => '');
    const buffer = await page.screenshot({ fullPage: portal.fullPage !== false, type: 'png' });
    await writeFile(outPath, buffer);
    const dims = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    const palette = await extractPalette(browser, buffer);
    const meta = { palette, width: dims.width || VIEWPORT.width, height: dims.height || VIEWPORT.height, title };
    let analysis = await claudeAnalysis(portal, buffer, meta);
    let analysisBy = 'claude';
    if (!analysis) {
      analysis = heuristicAnalysis(portal, meta);
      analysisBy = 'heuristic';
    }
    console.log(`  ✓ ${portal.name}  (${meta.width}×${meta.height})`);
    return {
      id: `${portal.slug}-${week}`,
      slug: portal.slug,
      portal: portal.name,
      company: portal.company,
      url: portal.url,
      brand: portal.brand || palette[0] || '#888888',
      week,
      capturedAt,
      image: `shots/${file}`,
      width: meta.width,
      height: meta.height,
      palette,
      analysis,
      analysisBy,
      status: 'ok',
    };
  } catch (e) {
    console.warn(`  ✗ ${portal.name}: ${e.message}`);
    return {
      id: `${portal.slug}-${week}`,
      slug: portal.slug,
      portal: portal.name,
      company: portal.company,
      url: portal.url,
      brand: portal.brand || '#888888',
      week,
      capturedAt,
      image: null,
      palette: [],
      analysis: `Capture failed: ${e.message}`,
      analysisBy: 'system',
      status: 'error',
    };
  } finally {
    await context.close();
  }
}

async function dismissOverlays(page) {
  const labels = [
    'Accept all', 'Accept All', 'I agree', 'Agree', 'Got it', 'Allow all',
    'Accept', 'Reject all', 'Close', 'Dismiss', 'No thanks',
  ];
  for (const label of labels) {
    try {
      const btn = page.getByRole('button', { name: label, exact: false }).first();
      if (await btn.isVisible({ timeout: 600 })) {
        await btn.click({ timeout: 1000 }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }
}

// ------------------------------------------------------------- manifest ----
async function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return { generatedAt: null, site: DEFAULT_SITE_BASE, captures: [] };
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    return { generatedAt: null, site: DEFAULT_SITE_BASE, captures: [] };
  }
}

function mergeCaptures(existing, fresh) {
  const byId = new Map();
  for (const c of fresh) byId.set(c.id, c); // fresh wins over same-week duplicates
  for (const c of existing) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].sort(
    (a, b) => (b.week || '').localeCompare(a.week || '') || (a.portal || '').localeCompare(b.portal || '')
  );
}

// ---------------------------------------------------------------- slack ----
async function notifySlack(batch, week, siteBase) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log('  (no SLACK_WEBHOOK_URL set — skipping Slack notification)');
    return;
  }
  const ok = batch.filter((c) => c.status === 'ok');
  const failed = batch.filter((c) => c.status !== 'ok');
  const galleryUrl = `${siteBase.replace(/\/$/, '')}/?week=${week}`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🖼️  AI portal screenshots — week of ${week}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${ok.length}* portal${ok.length === 1 ? '' : 's'} captured${
          failed.length ? ` · *${failed.length}* failed` : ''
        }.  <${galleryUrl}|Open the library →>`,
      },
    },
    { type: 'divider' },
  ];

  for (const c of ok.slice(0, 8)) {
    const shotUrl = `${siteBase.replace(/\/$/, '')}/${c.image}`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${c.url}|${c.portal}>*  ·  _${c.company}_\n${truncate(c.analysis, 320)}`,
      },
      accessory: { type: 'image', image_url: shotUrl, alt_text: `${c.portal} screenshot` },
    });
  }
  if (failed.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `⚠️ Failed: ${failed.map((f) => f.portal).join(', ')}` }],
    });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `AI portal screenshots — week of ${week}: ${ok.length} captured${
        failed.length ? `, ${failed.length} failed` : ''
      }.`,
      blocks,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`  ! Slack notification failed (${res.status}): ${body}`);
  } else {
    console.log('  ✓ Slack notification sent');
  }
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// ----------------------------------------------------------------- main ----
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const week = args.week || isoWeekMonday();
  const cfg = JSON.parse(await readFile(join(__dirname, 'portals.json'), 'utf8'));
  let portals = cfg.portals;
  if (args.only) portals = portals.filter((p) => args.only.includes(p.slug));
  if (!portals.length) {
    console.error('No portals selected.');
    process.exit(1);
  }

  await mkdir(SHOTS_DIR, { recursive: true });
  console.log(`Capturing ${portals.length} portal(s) for week ${week}…`);

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const batch = [];
  try {
    for (const portal of portals) {
      batch.push(await capturePortal(browser, portal, week));
    }
  } finally {
    await browser.close();
  }

  const manifest = await loadManifest();
  manifest.site = DEFAULT_SITE_BASE;
  manifest.generatedAt = new Date().toISOString();
  manifest.captures = mergeCaptures(manifest.captures || [], batch);
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Manifest updated (${manifest.captures.length} total captures).`);

  if (args.slack) await notifySlack(batch, week, DEFAULT_SITE_BASE);

  const failed = batch.filter((c) => c.status !== 'ok');
  if (failed.length === batch.length) {
    console.error('All captures failed.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
