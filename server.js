import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app      = express();
const PORT     = 3001;
const NEWS_KEY = process.env.VITE_NEWSAPI_KEY;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// ── NEWS: top-headlines + everything fallback, no date restriction ────────────
app.get("/api/news", async (req, res) => {
  const { q = "markets economy", pageSize = 15 } = req.query;
  try {
    // 1. Try top-headlines (most current breaking news)
    const url1 = `https://newsapi.org/v2/top-headlines?q=${encodeURIComponent(q)}&pageSize=${pageSize}&language=en&apiKey=${NEWS_KEY}`;
    console.log("[NEWS] top-headlines:", url1.replace(NEWS_KEY,"***"));
    const r1    = await fetch(url1);
    const data1 = await r1.json();
    console.log("[NEWS] top-headlines:", r1.status, "articles:", data1.articles?.length ?? 0);

    let articles = data1.articles || [];

    // 2. If < 8 results, supplement with /everything sorted by publishedAt
    if (articles.length < 8) {
      const url2 = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&pageSize=${pageSize}&sortBy=publishedAt&language=en&apiKey=${NEWS_KEY}`;
      console.log("[NEWS] everything:", url2.replace(NEWS_KEY,"***"));
      const r2    = await fetch(url2);
      const data2 = await r2.json();
      console.log("[NEWS] everything:", r2.status, "articles:", data2.articles?.length ?? 0);
      if (r2.ok && data2.articles?.length) {
        const seen  = new Set(articles.map(a => a.title));
        const extra = data2.articles.filter(a => !seen.has(a.title));
        articles    = [...articles, ...extra].slice(0, pageSize);
      }
    }

    console.log("[NEWS] total articles returning:", articles.length);
    res.json({ articles });
  } catch (e) {
    console.error("[NEWS] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CALENDAR: ForexFactory JSON feed (no key required) ───────────────────────
app.get("/api/calendar", async (req, res) => {
  // ForexFactory exposes a public JSON calendar
  const ffUrl = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

  try {
    console.log("[CAL] fetching ForexFactory calendar...");
    const r = await fetch(ffUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    console.log("[CAL] FF status:", r.status);

    if (!r.ok) throw new Error(`FF returned ${r.status}`);

    const raw = await r.json();
    console.log("[CAL] FF raw count:", raw.length, "| sample keys:", raw[0] ? Object.keys(raw[0]) : "empty");

    // Filter to today + tomorrow only, and normalize field names
    const todayStr    = new Date().toISOString().split("T")[0];
    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split("T")[0];

    const events = raw
      .filter(e => {
        const d = (e.date || "").slice(0, 10);
        return d === todayStr || d === tomorrowStr;
      })
      .map(e => ({
        country:  e.country  || "",
        title:    e.title    || e.name || "",
        date:     (e.date    || "").slice(0, 10),
        time:     e.time     || "",
        actual:   e.actual   || "",
        forecast: e.forecast || "",
        previous: e.previous || "",
        // FF uses "Low"/"Medium"/"High"
        impact: e.impact === "High"   ? "3"
              : e.impact === "Medium" ? "2" : "1",
      }))
      .sort((a, b) => (Number(b.impact)||0) - (Number(a.impact)||0));

    console.log("[CAL] filtered events (today+tomorrow):", events.length);
    res.json({ events });
  } catch (e) {
    console.error("[CAL] ForexFactory failed:", e.message);
    res.status(500).json({ error: e.message, events: [] });
  }
});

app.listen(PORT, () => {
  console.log(`\n  MacroIntel proxy  →  http://localhost:${PORT}`);
  console.log(`  NewsAPI key : ${NEWS_KEY ? "✓" : "✗ MISSING"}`);
  console.log(`  Calendar    : ForexFactory (no key needed)\n`);
});
