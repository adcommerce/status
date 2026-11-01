// ADCommerce status checker. Runs in GitHub Actions every 5 minutes (cron-job.org dispatch; GitHub schedule as fallback).
// Node 22, no dependencies.
//
// Public files it writes (committed only when something changes, plus one roll-up a day):
//   data/status.json     current state of each part, today's worst, providers' state, open incidents' ids
//   data/history.json    one entry per day (Ulaanbaatar time), last 90 days: each part's worst state and uptime %
//   data/incidents.json  incidents of the last 90 days, with their updates (MN/EN)
// Private working state (never committed; carried between runs in the Actions cache):
//   .work/state.json     failure streaks, today's run counts, the store rotation, Slack thread ids
//
// Nothing internal goes into data/: part names, states, times and our own words only. Store hosts come from the
// STORE_SITES secret and are named only in Slack.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";

const UA = "curl/8.7 adcommerce-status-bot (+https://status.adcommerce.mn)";
const TIMEOUT_MS = 12_000;
const DEGRADED_AFTER = 2; // failed runs in a row
const DOWN_AFTER = 3;
const STORES_PER_RUN = 3; // rotation, plus any store that failed last run
const KEEP_DAYS = 90;
const TZ = "Asia/Ulaanbaatar";

const env = process.env;
const DRY = env.STATUS_DRY === "1"; // no Slack, print instead
const SIMULATE = env.SIMULATE_FAIL || ""; // e.g. "admin" — treat that part's checks as failed (test alerts)
const TEST_LABEL = env.TEST_LABEL || ""; // prefix for Slack messages in a test
const SLACK_TOKEN = env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = env.SLACK_CHANNEL || "";
const STORE_SITES = (env.STORE_SITES || "").split(/[\s,]+/).filter(Boolean);
const PAGE_URL = "https://status.adcommerce.mn";

// ─── Parts ─────────────────────────────────────────────────────────────────────
// Public names, both languages. Each check returns { ok, note } where note is for Slack only.
const PARTS = [
  { id: "signin", mn: "Нэвтрэх", en: "Sign-in" },
  { id: "admin", mn: "Админ", en: "Admin" },
  { id: "stores", mn: "Онлайн дэлгүүрүүд", en: "Online stores" },
  { id: "checkout", mn: "Төлбөр тооцоо (checkout)", en: "Checkout" },
  { id: "agent", mn: "AD агент", en: "AD agent" },
  { id: "media", mn: "Зураг, файл", en: "Media" },
  { id: "email", mn: "Имэйл", en: "Email", provider: "Resend" },
];

async function probe(url, { method = "GET", expect, redirect = "manual", json = false } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method, redirect, headers: { "user-agent": UA, accept: json ? "application/json" : "*/*" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let body = null;
    if (json) { try { body = await r.json(); } catch { body = null; } } else if (method !== "HEAD") { await r.arrayBuffer().catch(() => {}); }
    const ms = Date.now() - t0;
    const ok = expect ? expect(r.status, body) : r.status < 400;
    return { ok, status: r.status, ms, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e?.name === "TimeoutError" ? "timeout" : "network error" };
  }
}

// One retry after 3 s: a single blip from the runner's network isn't a failed run.
async function probeRetry(url, opts) {
  const a = await probe(url, opts);
  if (a.ok) return a;
  await new Promise((r) => setTimeout(r, 3000));
  const b = await probe(url, opts);
  return b.ok ? b : a;
}

const deepOk = (s, b) => s === 200 && b?.status === "ok";
const describe = (name, r) => `${name}: ${r.ok ? "ok" : r.error || `HTTP ${r.status}`} (${r.ms} ms)`;

async function checkAll(work) {
  const res = {};
  // Sign-in: Auth's deep check (its database answers) + its OIDC discovery.
  {
    const [deep, disc] = await Promise.all([
      probeRetry("https://auth.adcommerce.mn/health/deep", { json: true, expect: deepOk }),
      probeRetry("https://auth.adcommerce.mn/.well-known/openid-configuration", { json: true, expect: (s, b) => s === 200 && !!b?.issuer }),
    ]);
    res.signin = { ok: deep.ok && disc.ok, note: [describe("Auth /health/deep", deep), describe("Auth discovery", disc)].join("; ") };
  }
  // Admin: the app answers (its root redirects to /login) + API v3's deep check (the platform database answers).
  {
    const [app, api] = await Promise.all([
      probeRetry("https://admin.adcommerce.mn/login"),
      probeRetry("https://api-v3.adcommerce.mn/health/deep", { json: true, expect: deepOk }),
    ]);
    res.admin = { ok: app.ok && api.ok, note: [describe("admin.adcommerce.mn/login", app), describe("API v3 /health/deep", api)].join("; ") };
  }
  // Checkout: the checkout Worker answers. A made-up path is a plain 404 from the Worker; never a cart, never pay.
  {
    const r = await probeRetry("https://checkout.adcommerce.mn/checkouts/status-check", { expect: (s) => s === 404 || (s >= 200 && s < 400) });
    res.checkout = { ok: r.ok, note: describe("checkout.adcommerce.mn", r) };
  }
  // AD agent: Agent v3's own database, asked through API v3's binding (Agent has no public address).
  {
    const r = await probeRetry("https://api-v3.adcommerce.mn/health/agent", { json: true, expect: deepOk });
    res.agent = { ok: r.ok, note: describe("API v3 /health/agent", r) };
  }
  // Media: the CDN serves a known public file (HEAD: no download).
  {
    const r = await probeRetry("https://cdn.adcommerce.mn/adcommerce/fonts/SamsungOne-700.woff2", { method: "HEAD", expect: (s) => s === 200 });
    res.media = { ok: r.ok, note: describe("cdn.adcommerce.mn", r) };
  }
  // Online stores: a few home pages per run (rotation), plus every store that failed last time. curl user agent:
  // never counted as a shopper session. A password page (401) or a redirect is a site that answers.
  {
    const n = STORE_SITES.length;
    const failing = Object.keys(work.storeFail || {}).filter((h) => STORE_SITES.includes(h));
    const pick = new Set(failing);
    for (let i = 0; i < Math.min(STORES_PER_RUN, n); i++) pick.add(STORE_SITES[(work.storeCursor + i) % n]);
    work.storeCursor = n ? (work.storeCursor + STORES_PER_RUN) % n : 0;
    const hosts = [...pick];
    const results = await Promise.all(hosts.map((h) => probeRetry(`https://${h}/`, { expect: (s) => (s >= 200 && s < 400) || s === 401 || s === 403 }).then((r) => [h, r])));
    const storeFail = { ...(work.storeFail || {}) };
    const notes = [];
    for (const [h, r] of results) {
      if (r.ok) delete storeFail[h];
      else { storeFail[h] = (storeFail[h] || 0) + 1; notes.push(describe(h, r)); }
    }
    work.storeFail = storeFail;
    const bad = Object.values(storeFail);
    const worst = bad.length ? Math.max(...bad) : 0;
    // Part streak = the worst store's streak. Down needs more than one store failing 3 runs; one store alone is partial.
    const manyDown = bad.filter((c) => c >= DOWN_AFTER).length >= 2 || (n > 0 && bad.length === n);
    res.stores = { ok: worst === 0, forcedStreak: worst, capDegraded: !manyDown, note: (notes.join("; ") || `${hosts.length} checked, all ok`) + ` (${hosts.length} of ${n} this run)`, total: n, failing: bad.length };
  }
  // Email: Resend's public status (their own components); shown as the provider's state.
  {
    const r = await probe("https://resend-status.com/api/v2/summary.json", { json: true, expect: (s, b) => s === 200 && !!b?.status });
    let state = "ok", note = "Resend: unknown";
    if (r.ok) {
      const comps = (r.body.components || []).filter((c) => ["Single Email", "Batch Emails", "General API", "SMTP"].includes(c.name));
      const st = comps.map((c) => c.status);
      if (st.includes("major_outage")) state = "down";
      else if (st.some((s) => s === "partial_outage" || s === "degraded_performance")) state = "degraded";
      note = `Resend: ${r.body.status?.description || "?"}` + (comps.length ? ` (${comps.map((c) => `${c.name} ${c.status}`).join(", ")})` : "");
    }
    res.email = { ok: state === "ok", direct: r.ok ? state : null, note };
  }
  if (SIMULATE) for (const id of SIMULATE.split(",")) if (res[id]) { res[id].ok = false; res[id].direct = res[id].direct ? "down" : undefined; res[id].note = `SIMULATED FAILURE (test); real: ${res[id].note}`; }
  return res;
}

async function cloudflare() {
  const r = await probe("https://www.cloudflarestatus.com/api/v2/summary.json", { json: true, expect: (s, b) => s === 200 && !!b?.status });
  if (!r.ok) return null;
  const incidents = (r.body.incidents || []).filter((i) => i.status !== "resolved" && i.status !== "postmortem" && i.impact !== "none")
    .map((i) => ({ name: String(i.name).slice(0, 140), impact: i.impact, url: i.shortlink || "https://www.cloudflarestatus.com" }));
  return { indicator: r.body.status?.indicator || "none", description: r.body.status?.description || "", incidents: incidents.slice(0, 5) };
}

// ─── State ─────────────────────────────────────────────────────────────────────
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1) + "\n");
const dayOf = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
const rank = { ok: 0, degraded: 1, down: 2 };
const worse = (a, b) => (rank[a] >= rank[b] ? a : b);

function nextState(part, r, streak) {
  if (r.direct !== undefined && r.direct !== null) return r.direct; // provider-reported state
  const fails = r.forcedStreak !== undefined ? r.forcedStreak : streak;
  if (fails >= DOWN_AFTER) return r.capDegraded ? "degraded" : "down";
  if (fails >= DEGRADED_AFTER) return "degraded";
  if (fails === 0) return "ok";
  return null; // one failed run: keep the current state
}

const TEXT = {
  degraded: { mn: "Хэсэгчилсэн доголдол. Шалгаж байна.", en: "Partly degraded. We're looking into it." },
  down: { mn: "Ажиллахгүй байна. Шалгаж байна.", en: "Not working. We're looking into it." },
  ok: { mn: "Хэвийн ажиллаж байна.", en: "Working normally again." },
  cf: { mn: " Cloudflare-д (манай хостинг) доголдол зарласан.", en: " Cloudflare (our hosting provider) reports an incident." },
};

// ─── Slack ─────────────────────────────────────────────────────────────────────
async function slack(text, thread_ts, broadcast = false) {
  const msg = (TEST_LABEL ? `[${TEST_LABEL}] ` : "") + text;
  if (DRY || !SLACK_TOKEN || !SLACK_CHANNEL) { console.log("SLACK (not sent)", thread_ts ? "(in thread)" : "", DRY ? msg : msg.split("\n")[0]); return null; }
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${SLACK_TOKEN}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text: msg, thread_ts, reply_broadcast: !!(thread_ts && broadcast), unfurl_links: false, unfurl_media: false }),
  }).then((x) => x.json()).catch(() => ({ ok: false, error: "network" }));
  if (!r.ok) { console.log("slack error:", r.error); return null; }
  return r.ts;
}
const icon = { ok: "✅", degraded: "🟠", down: "🔴" };
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // A test (TEST_LABEL set) runs on its own copies under .work/test, so nothing of it reaches the public data/.
  const D = TEST_LABEL ? ".work/test" : "data";
  const W = TEST_LABEL ? ".work/test/state.json" : ".work/state.json";
  mkdirSync(D, { recursive: true });
  mkdirSync(".work", { recursive: true });
  const now = new Date();
  const nowIso = now.toISOString();
  const today = dayOf(now);
  const status = readJson(`${D}/status.json`, { parts: {}, today: { date: today, worst: {} }, providers: {} });
  const history = readJson(`${D}/history.json`, { days: [] });
  const incidents = readJson(`${D}/incidents.json`, { incidents: [] });
  const work = readJson(W, { streak: {}, today: { date: today, runs: {} }, storeCursor: 0, storeFail: {}, slack: {} });
  let changed = false;

  // Day roll-over: yesterday's roll-up into history (worst state, uptime % from the runs counted).
  if (work.today.date !== today) {
    const d = work.today.date;
    const entry = { date: d, parts: {} };
    for (const p of PARTS) {
      const c = work.today.runs[p.id] || { n: 0, ok: 0 };
      const w = status.today?.date === d ? status.today.worst?.[p.id] || "ok" : "ok";
      entry.parts[p.id] = { w, up: c.n ? Math.round((c.ok / c.n) * 10000) / 100 : null };
    }
    if (!history.days.some((x) => x.date === d)) history.days.push(entry);
    history.days = history.days.sort((a, b) => a.date.localeCompare(b.date)).slice(-KEEP_DAYS);
    work.today = { date: today, runs: {} };
    status.today = { date: today, worst: {} };
    for (const p of PARTS) if (status.parts[p.id]?.state && status.parts[p.id].state !== "ok") status.today.worst[p.id] = status.parts[p.id].state;
    changed = true;
  }

  const [results, cf] = await Promise.all([checkAll(work), cloudflare()]);
  if (cf) {
    const prev = status.providers?.cloudflare;
    const sig = (x) => x ? `${x.indicator}|${x.incidents.map((i) => i.name).join("|")}` : "";
    if (sig(prev) !== sig(cf)) { status.providers = { ...(status.providers || {}), cloudflare: cf }; changed = true; }
  }
  const cfNote = cf && cf.incidents.length ? `\nCloudflare reports: ${cf.incidents.map((i) => `${i.name} (${i.impact})`).join("; ")}` : "";

  for (const p of PARTS) {
    const r = results[p.id];
    const streak = r.ok ? 0 : (work.streak[p.id] || 0) + 1;
    work.streak[p.id] = streak;
    const c = (work.today.runs[p.id] ||= { n: 0, ok: 0 });
    c.n++; if (r.ok) c.ok++;
    const cur = status.parts[p.id]?.state || "ok";
    const next = nextState(p, r, streak) ?? cur;
    if (!status.parts[p.id]) { status.parts[p.id] = { state: next, since: nowIso }; changed = true; }
    if (next !== cur) {
      status.parts[p.id] = { state: next, since: nowIso };
      status.today.worst[p.id] = worse(status.today.worst[p.id] || "ok", next);
      changed = true;
      const cfHit = !!(cf && cf.incidents.length);
      let inc = incidents.incidents.find((i) => i.part === p.id && !i.resolved);
      if (next !== "ok") {
        const upd = { t: nowIso, state: next, mn: TEXT[next].mn + (cfHit ? TEXT.cf.mn : ""), en: TEXT[next].en + (cfHit ? TEXT.cf.en : "") };
        if (!inc) {
          inc = { id: `${today}-${p.id}`, part: p.id, started: nowIso, resolved: null, worst: next, cloudflare: cfHit, test: !!TEST_LABEL, updates: [upd] };
          let n = 2; while (incidents.incidents.some((i) => i.id === inc.id)) inc.id = `${today}-${p.id}-${n++}`;
          incidents.incidents.push(inc);
          const head = `${icon[next]} *${p.en}* ${next === "down" ? "is down" : "is degraded"}${p.provider ? ` (provider: ${p.provider})` : ""} — failing for ${streak || 1} runs.\n${r.note}${cfNote}\n${PAGE_URL}`;
          const ts = await slack((next === "down" && !TEST_LABEL ? "<!here> " : "") + head);
          if (ts) work.slack[inc.id] = ts;
        } else {
          inc.updates.push(upd);
          inc.worst = worse(inc.worst, next);
          inc.cloudflare = inc.cloudflare || cfHit;
          const ts = work.slack[inc.id];
          await slack(`${icon[next]} *${p.en}*: now ${next}.\n${r.note}${cfNote}`, ts);
        }
      } else if (inc) {
        inc.resolved = nowIso;
        inc.updates.push({ t: nowIso, state: "ok", mn: TEXT.ok.mn, en: TEXT.ok.en });
        const ts = work.slack[inc.id];
        await slack(`${icon.ok} *${p.en}* recovered after ${fmtDur(now - new Date(inc.started))}.\n${r.note}`, ts, true);
        delete work.slack[inc.id];
      }
    }
  }

  // Keep 90 days of incidents (open ones always).
  const cutoff = new Date(now - KEEP_DAYS * 864e5).toISOString();
  const before = incidents.incidents.length;
  incidents.incidents = incidents.incidents.filter((i) => !i.resolved || i.resolved >= cutoff);
  if (incidents.incidents.length !== before) changed = true;

  status.updated = changed ? nowIso : status.updated || nowIso;
  status.open = incidents.incidents.filter((i) => !i.resolved).map((i) => i.id);
  status.parts_order = PARTS.map((p) => ({ id: p.id, mn: p.mn, en: p.en, provider: p.provider || null }));

  writeJson(W, work);
  if (changed) {
    writeJson(`${D}/status.json`, status);
    writeJson(`${D}/history.json`, history);
    writeJson(`${D}/incidents.json`, incidents);
  }
  const summary = PARTS.map((p) => `${p.id}:${results[p.id].ok ? "ok" : "FAIL"}→${status.parts[p.id].state}`).join(" ");
  console.log(`${nowIso} ${summary} cf:${cf?.indicator ?? "?"} changed:${changed}`);
  // Actions logs of a public repo are public: no store hosts here (Slack names them).
  for (const p of PARTS) if (!results[p.id].ok) console.log(`  ${p.id}: ${p.id === "stores" ? `${results.stores.failing} of ${results.stores.total} store sites failing` : results[p.id].note}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `changed=${changed && !TEST_LABEL}\n`);
}

await main();
