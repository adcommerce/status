// status.adcommerce.mn — reads data/*.json (written by scripts/check.mjs) and renders the page. No dependencies.
(() => {
  const T = {
    mn: {
      eyebrow: "Системийн төлөв", parts: "Хэсгүүд", past: "Сүүлийн тохиолдлууд", today: "Өнөөдөр", days90: "90 хоногийн өмнө", days45: "45 хоногийн өмнө",
      s_ok: "Хэвийн", s_degraded: "Доголдолтой", s_down: "Ажиллахгүй", s_none: "Мэдээлэлгүй",
      all_ok: "Бүх систем хэвийн ажиллаж байна", some: (n) => `Доголдол: ${n}`, major: (n) => `Тасалдал: ${n}`,
      checked: (t) => `Сүүлд шалгасан: ${t}`, every5: "5 минут тутам шалгадаг.", ago: (m) => (m < 1 ? "саяхан" : m < 60 ? `${m} минутын өмнө` : `${Math.floor(m / 60)} цагийн өмнө`),
      uptime: (p) => `${p}% ажилласан`, noIncidents: "Сүүлийн 90 хоногт тохиолдол гараагүй.", ongoing: "Үргэлжилж байна", resolved: "Шийдэгдсэн",
      lasted: (d) => `${d} үргэлжилсэн`, provider: "нийлүүлэгч", cf_title: "Cloudflare (манай хостинг):", cf_ok: "хэвийн", now: "Одоо",
      min: "мин", hour: "цаг",
    },
    en: {
      eyebrow: "System status", parts: "Components", past: "Past incidents", today: "Today", days90: "90 days ago", days45: "45 days ago",
      s_ok: "Operational", s_degraded: "Degraded", s_down: "Outage", s_none: "No data",
      all_ok: "All systems operational", some: (n) => `Degraded: ${n}`, major: (n) => `Outage: ${n}`,
      checked: (t) => `Last checked ${t}`, every5: "Checked every 5 minutes.", ago: (m) => (m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`),
      uptime: (p) => `${p}% uptime`, noIncidents: "No incidents in the last 90 days.", ongoing: "Ongoing", resolved: "Resolved",
      lasted: (d) => `lasted ${d}`, provider: "provider", cf_title: "Cloudflare (our hosting provider):", cf_ok: "operational", now: "Now",
      min: "min", hour: "h",
    },
  };
  const qs = new URLSearchParams(location.search);
  let lang = qs.get("lang") || localStorage.getItem("adc-status-lang") || "mn";
  if (!T[lang]) lang = "mn";
  let data = null, lastRun = null;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TZ = "Asia/Ulaanbaatar";
  const dayKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const fmtTime = (iso) => new Intl.DateTimeFormat(lang === "mn" ? "mn-MN" : "en-GB", { timeZone: TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  const fmtDay = (key) => new Intl.DateTimeFormat(lang === "mn" ? "mn-MN" : "en-GB", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(key + "T00:00:00Z"));
  const dur = (ms) => { const t = T[lang]; const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} ${t.min}` : `${Math.floor(m / 60)} ${t.hour} ${m % 60} ${t.min}`; };

  async function load() {
    const bust = `?t=${Math.floor(Date.now() / 60000)}`;
    const get = (f) => fetch(`data/${f}.json${bust}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [status, history, incidents] = await Promise.all([get("status"), get("history"), get("incidents")]);
    data = { status: status || { parts: {} }, history: history || { days: [] }, incidents: (incidents?.incidents || []).filter((i) => !i.test) };
    render();
    // The last finished run, from GitHub's public API (the data files change only when a state does).
    fetch("https://api.github.com/repos/adcommerce/status/actions/workflows/check.yml/runs?per_page=1&status=success")
      .then((r) => (r.ok ? r.json() : null)).then((j) => { const r = j?.workflow_runs?.[0]; if (r) { lastRun = r.updated_at; renderChecked(); } }).catch(() => {});
  }

  function renderChecked() {
    const t = T[lang];
    const ref = lastRun || data?.status?.updated;
    $("#checked").textContent = ref ? `${t.checked(t.ago(Math.floor((Date.now() - new Date(ref)) / 60000)))} · ${t.every5}` : t.every5;
  }

  function render() {
    const t = T[lang];
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-t]").forEach((el) => { const v = t[el.dataset.t]; if (typeof v === "string") el.textContent = v; });
    document.querySelectorAll(".lang button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    if (matchMedia("(max-width: 600px)").matches) $(".axis span").textContent = t.days45;
    if (!data) return;
    const { status, history, incidents } = data;
    const parts = status.parts_order || [];
    const name = (p) => (lang === "mn" ? p.mn : p.en);

    // Overall line.
    const bad = parts.filter((p) => (status.parts[p.id]?.state || "ok") !== "ok");
    const anyDown = bad.some((p) => status.parts[p.id].state === "down");
    const h1 = $("#overall");
    h1.className = "overall " + (bad.length ? (anyDown ? "down" : "degraded") : "ok");
    h1.innerHTML = `<span class="bullet" aria-hidden="true"></span><span>${esc(bad.length ? (anyDown ? t.major : t.some)(bad.map(name).join(", ")) : t.all_ok)}</span>`;
    renderChecked();

    // Parts with 90 daily bars.
    const byDay = new Map(history.days.map((d) => [d.date, d]));
    const today = dayKey(new Date());
    const days = [];
    for (let i = 89; i >= 0; i--) days.push(dayKey(new Date(Date.now() - i * 864e5)));
    $("#parts").innerHTML = parts.map((p) => {
      const cur = status.parts[p.id]?.state || "ok";
      let sum = 0, n = 0;
      const bars = days.map((d) => {
        let w = null, up = null;
        if (d === today) w = status.today?.date === today ? worst(status.today.worst?.[p.id] || "ok", cur) : cur;
        else { const e = byDay.get(d)?.parts?.[p.id]; if (e) { w = e.w; up = e.up; } }
        if (up != null) { sum += up; n++; }
        const label = `${fmtDay(d)} — ${w ? t["s_" + w] : t.s_none}${up != null ? ` · ${t.uptime(up)}` : ""}`;
        return `<i class="${w || ""}" title="${esc(label)}" aria-label="${esc(label)}"></i>`;
      }).join("");
      const uptime = n ? (Math.round((sum / n) * 100) / 100).toFixed(2) : null;
      return `<li class="part"><div class="part-row"><span class="part-name">${esc(name(p))}${p.provider ? `<small>${esc(p.provider)} · ${t.provider}</small>` : ""}</span>
        <span class="state ${cur}">${t["s_" + cur]}</span></div><div class="bars" role="img" aria-label="${esc(name(p))}">${bars}</div>
        ${uptime ? `<div class="uptime"><span></span><span>${t.uptime(uptime)}</span></div>` : ""}</li>`;
    }).join("");

    // Cloudflare context.
    const cf = status.providers?.cloudflare;
    const prov = $("#provider");
    if (cf && cf.incidents?.length && bad.length) {
      prov.hidden = false;
      prov.innerHTML = `<strong>${t.cf_title}</strong> ${esc(cf.description)}<ul>${cf.incidents.map((i) => `<li><a href="${esc(i.url)}" rel="noopener">${esc(i.name)}</a></li>`).join("")}</ul>`;
    } else prov.hidden = true;

    // Incidents.
    const partName = (id) => { const p = parts.find((x) => x.id === id); return p ? name(p) : id; };
    const incHtml = (i) => `<article class="inc ${esc(i.worst)}"><div class="inc-head"><span>${esc(partName(i.part))} — ${t["s_" + i.worst]}</span>
      <span class="inc-when">${fmtTime(i.started)}${i.resolved ? ` · ${t.resolved}, ${t.lasted(dur(new Date(i.resolved) - new Date(i.started)))}` : ` · ${t.ongoing}`}</span></div>
      <ol>${i.updates.slice().reverse().map((u) => `<li><time datetime="${esc(u.t)}">${fmtTime(u.t)}</time>${esc(lang === "mn" ? u.mn : u.en)}</li>`).join("")}</ol></article>`;
    const open = incidents.filter((i) => !i.resolved);
    const openEl = $("#open");
    openEl.hidden = !open.length;
    openEl.innerHTML = open.length ? `<h2>${t.ongoing}</h2>` + open.map(incHtml).join("") : "";
    const past = incidents.filter((i) => i.resolved).sort((a, b) => b.started.localeCompare(a.started)).slice(0, 20);
    $("#past").innerHTML = past.length ? past.map(incHtml).join("") : `<p class="empty">${t.noIncidents}</p>`;
  }
  const rank = { ok: 0, degraded: 1, down: 2 };
  const worst = (a, b) => (rank[a] >= rank[b] ? a : b);

  document.querySelectorAll(".lang button").forEach((b) => b.addEventListener("click", () => {
    lang = b.dataset.lang; localStorage.setItem("adc-status-lang", lang); render();
  }));
  render();
  load();
  setInterval(load, 120000);
})();
