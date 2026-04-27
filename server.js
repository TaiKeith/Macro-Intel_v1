import express    from "express";
import cors       from "cors";
import fetch      from "node-fetch";
import * as cheerio from "cheerio";
import dotenv     from "dotenv";

dotenv.config();

const app      = express();
const PORT     = 3001;
const NEWS_KEY = process.env.VITE_NEWSAPI_KEY;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// ── In-memory calendar cache ──────────────────────────────────────────────────
let calCache       = [];          // merged events (JSON base + scraped actuals)
let lastJsonFetch  = 0;           // timestamp of last JSON fetch
let lastScrapeFetch = 0;          // timestamp of last scrape
const JSON_TTL     = 10 * 60000;  // re-fetch JSON every 10 min
const SCRAPE_TTL   = 90 * 1000;   // re-scrape HTML every 90s (polite rate)

// ── Step 1: fetch the base JSON (forecast/previous, no actuals) ──────────────
async function fetchBaseCalendar() {
  const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`FF JSON ${r.status}`);
  return await r.json();          // array of { title, country, date, impact, forecast, previous }
}

// ── Step 2: scrape ForexFactory HTML for actuals ─────────────────────────────
async function scrapeActuals() {
  const r = await fetch("https://www.forexfactory.com/calendar", {
    headers: {
      "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control":   "no-cache",
      "Pragma":          "no-cache",
      "Sec-Fetch-Dest":  "document",
      "Sec-Fetch-Mode":  "navigate",
      "Sec-Fetch-Site":  "none",
      "Upgrade-Insecure-Requests": "1",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!r.ok) throw new Error(`FF scrape ${r.status}`);
  const html = await r.text();
  const $    = cheerio.load(html);

  const actuals = {}; // key: "COUNTRY|TITLE" => actual string

  // ForexFactory table rows — each event row has class "calendar__row"
  $("tr.calendar__row, tr[data-eventid]").each((_, row) => {
    const $row    = $(row);
    const title   = $row.find(".calendar__event-title, td.event span").text().trim();
    const country = $row.find(".calendar__currency, td.currency").text().trim();
    const actual  = $row.find(".calendar__actual, td.actual").text().trim();

    if (title && country && actual && actual !== "" && actual !== "\u00A0") {
      const key = `${country.toUpperCase()}|${title}`;
      actuals[key] = actual;
    }
  });

  console.log(`[SCRAPE] found ${Object.keys(actuals).length} actuals`);
  if (Object.keys(actuals).length === 0) {
    // Log a snippet to help debug selectors
    console.log("[SCRAPE] HTML snippet:", html.slice(0, 500));
  }
  return actuals;
}

// ── Merge base + actuals and filter to today/tomorrow ────────────────────────
function buildMergedCalendar(baseEvents, actuals) {
  const todayStr    = new Date().toISOString().split("T")[0];
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split("T")[0];

  return baseEvents
    .filter(e => {
      const d = (e.date || "").slice(0, 10);
      return d === todayStr || d === tomorrowStr;
    })
    .map(e => {
      const key    = `${(e.country||"").toUpperCase()}|${e.title||""}`;
      const actual = actuals[key] || e.actual || "";
      return {
        country:  e.country  || "",
        title:    e.title    || e.name || "",
        date:     (e.date    || "").slice(0, 10),
        time:     e.time     || "",
        actual,
        forecast: e.forecast || "",
        previous: e.previous || "",
        impact:   e.impact === "High"   ? "3"
                : e.impact === "Medium" ? "2" : "1",
      };
    })
    .sort((a, b) => Number(b.impact) - Number(a.impact));
}

// ── Calendar endpoint: smart caching ─────────────────────────────────────────
app.get("/api/calendar", async (req, res) => {
  const now    = Date.now();
  const force  = req.query.force === "1";

  try {
    // Re-fetch base JSON if stale
    if (force || now - lastJsonFetch > JSON_TTL || calCache.length === 0) {
      console.log("[CAL] fetching FF JSON base...");
      const base   = await fetchBaseCalendar();
      // Preserve any actuals we already have in cache by re-merging
      const existingActuals = {};
      calCache.forEach(e => {
        if (e.actual) existingActuals[`${e.country.toUpperCase()}|${e.title}`] = e.actual;
      });
      calCache      = buildMergedCalendar(base, existingActuals);
      lastJsonFetch = now;
      console.log(`[CAL] JSON base loaded: ${calCache.length} events for today/tomorrow`);
    }

    // Scrape actuals if stale (polite: every 90s)
    if (force || now - lastScrapeFetch > SCRAPE_TTL) {
      console.log("[CAL] scraping FF HTML for actuals...");
      try {
        const actuals    = await scrapeActuals();
        lastScrapeFetch  = now;
        // Merge scraped actuals into cached events
        calCache = calCache.map(e => {
          const key    = `${(e.country||"").toUpperCase()}|${e.title||""}`;
          const actual = actuals[key] || e.actual || "";
          return { ...e, actual };
        });
        const withActuals = calCache.filter(e => e.actual).length;
        console.log(`[CAL] after scrape: ${withActuals}/${calCache.length} events have actuals`);
      } catch(scrapeErr) {
        console.warn("[CAL] scrape failed (using cache):", scrapeErr.message);
        // Don't fail the whole request — return cached data
      }
    }

    res.json({ events: calCache, scrapedAt: new Date(lastScrapeFetch).toISOString() });
  } catch(e) {
    console.error("[CAL] error:", e.message);
    res.status(500).json({ error: e.message, events: calCache });
  }
});

// ── NEWS: top-headlines + everything fallback ─────────────────────────────────
app.get("/api/news", async (req, res) => {
  const { q = "markets economy", pageSize = 15 } = req.query;
  try {
    const url1 = `https://newsapi.org/v2/top-headlines?q=${encodeURIComponent(q)}&pageSize=${pageSize}&language=en&apiKey=${NEWS_KEY}`;
    console.log("[NEWS] top-headlines:", url1.replace(NEWS_KEY,"***"));
    const r1    = await fetch(url1);
    const data1 = await r1.json();
    console.log("[NEWS] top-headlines:", r1.status, "articles:", data1.articles?.length ?? 0);

    let articles = data1.articles || [];

    if (articles.length < 8) {
      const url2 = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&pageSize=${pageSize}&sortBy=publishedAt&language=en&apiKey=${NEWS_KEY}`;
      console.log("[NEWS] everything:", url2.replace(NEWS_KEY,"***"));
      const r2    = await fetch(url2);
      const data2 = await r2.json();
      console.log("[NEWS] everything:", r2.status, "articles:", data2.articles?.length ?? 0);
      if (r2.ok && data2.articles?.length) {
        const seen  = new Set(articles.map(a => a.title));
        articles    = [...articles, ...data2.articles.filter(a => !seen.has(a.title))].slice(0, pageSize);
      }
    }

    console.log("[NEWS] total returning:", articles.length);
    res.json({ articles });
  } catch(e) {
    console.error("[NEWS] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  MacroIntel proxy  →  http://localhost:${PORT}`);
  console.log(`  NewsAPI key : ${NEWS_KEY ? "✓" : "✗ MISSING"}`);
  console.log(`  Calendar    : FF JSON (10min) + FF HTML scrape (90s)\n`);
});
