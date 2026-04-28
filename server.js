import express from "express";
import cors    from "cors";
import fetch   from "node-fetch";
import dotenv  from "dotenv";

dotenv.config();

const app      = express();
const PORT     = 3001;
const NEWS_KEY = process.env.VITE_NEWSAPI_KEY;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// ── Calendar: FF JSON feed (forecast + previous only, no actuals)
// Actuals are fetched live via Gemini Google Search when user taps an event
let calCache = [], lastFetch = 0;
const CAL_TTL = 5 * 60000; // refresh every 5 min

app.get("/api/calendar", async (req, res) => {
  const now = Date.now();
  try {
    if (now - lastFetch > CAL_TTL || calCache.length === 0) {
      console.log("[CAL] fetching FF JSON...");
      const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`FF ${r.status}`);
      const raw = await r.json();
      const todayStr    = new Date().toISOString().split("T")[0];
      const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split("T")[0];
      calCache = raw
        .filter(e => { const d = (e.date||"").slice(0,10); return d===todayStr||d===tomorrowStr; })
        .map(e => ({
          country:  e.country||"",
          title:    e.title||e.name||"",
          date:     (e.date||"").slice(0,10),
          time:     e.time||"",
          actual:   "", // FF JSON never has actuals — Gemini searches for them on demand
          forecast: e.forecast||"",
          previous: e.previous||"",
          impact:   e.impact==="High"?"3":e.impact==="Medium"?"2":"1",
        }))
        .sort((a,b) => Number(b.impact)-Number(a.impact));
      lastFetch = now;
      console.log(`[CAL] loaded ${calCache.length} events (today+tomorrow)`);
    }
    res.json({ events: calCache });
  } catch(e) {
    console.error("[CAL] error:", e.message);
    res.status(500).json({ error: e.message, events: calCache });
  }
});

// ── News: try multiple query strategies until we get articles
app.get("/api/news", async (req, res) => {
  const { q = "markets economy", pageSize = 15 } = req.query;

  // Truncate query to first 2 words max for NewsAPI compatibility
  const shortQ = q.split(" ").slice(0, 2).join(" ");
  const fallbackQueries = [shortQ, "economy", "finance", "markets"];

  let articles = [];

  for (const query of fallbackQueries) {
    if (articles.length >= 5) break;

    // Try top-headlines first
    try {
      const url = `https://newsapi.org/v2/top-headlines?q=${encodeURIComponent(query)}&pageSize=${pageSize}&language=en&apiKey=${NEWS_KEY}`;
      console.log("[NEWS] top-headlines:", url.replace(NEWS_KEY,"***"));
      const r = await fetch(url);
      const d = await r.json();
      console.log("[NEWS] top-headlines:", r.status, "| articles:", d.articles?.length??0);
      if (r.ok && d.articles?.length) {
        const seen = new Set(articles.map(a=>a.title));
        articles = [...articles, ...d.articles.filter(a=>!seen.has(a.title))];
      }
    } catch(e) { console.warn("[NEWS] top-headlines error:", e.message); }

    if (articles.length >= 5) break;

    // Try /everything
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&pageSize=${pageSize}&sortBy=publishedAt&language=en&apiKey=${NEWS_KEY}`;
      console.log("[NEWS] everything:", url.replace(NEWS_KEY,"***"));
      const r = await fetch(url);
      const d = await r.json();
      console.log("[NEWS] everything:", r.status, "| articles:", d.articles?.length??0);
      if (r.ok && d.articles?.length) {
        const seen = new Set(articles.map(a=>a.title));
        articles = [...articles, ...d.articles.filter(a=>!seen.has(a.title))];
      }
    } catch(e) { console.warn("[NEWS] everything error:", e.message); }
  }

  articles = articles.slice(0, pageSize);
  console.log("[NEWS] total returning:", articles.length);
  // Return even if 0 — Gemini will use its own knowledge as fallback
  res.json({ articles });
});

app.listen(PORT, () => {
  console.log(`\n  MacroIntel proxy  →  http://localhost:${PORT}`);
  console.log(`  NewsAPI   : ${NEWS_KEY?"✓":"✗ MISSING"}`);
  console.log(`  Calendar  : FF JSON (5min cache) — actuals via Gemini Search on demand\n`);
});
