import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3001;
const NEWS_KEY = process.env.VITE_NEWSAPI_KEY;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// ─────────────────────────────────────────────────────────
// CACHE CONFIG (FASTER for near real-time actuals)
// ─────────────────────────────────────────────────────────
let calCache = [];
let lastFetch = 0;
const JSON_TTL = 60 * 1000; // 60s refresh (important!)


// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function normalize(str) {
  return (str || "")
    .toString()
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function buildKey(e) {
  return [
    normalize(e.country),
    normalize(e.title || e.name),
    (e.date || "").slice(0, 10),
    (e.time || "").trim()
  ].join("|");
}


// ─────────────────────────────────────────────────────────
// FETCH FOREX FACTORY JSON (WITH ACTUALS)
// ─────────────────────────────────────────────────────────
async function fetchFFCalendar() {
  const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) throw new Error(`FF JSON ${res.status}`);

  return await res.json();
}


// ─────────────────────────────────────────────────────────
// BUILD CLEAN CALENDAR
// ─────────────────────────────────────────────────────────
function buildCalendar(events) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  return events
    .filter(e => {
      const d = (e.date || "").slice(0, 10);
      return d === todayStr || d === tomorrowStr;
    })
    .map(e => {
      const impact =
        e.impact === "High" ? "3" :
        e.impact === "Medium" ? "2" : "1";

      return {
        key: buildKey(e), // 🔑 strong key
        country: e.country || "",
        title: e.title || e.name || "",
        date: (e.date || "").slice(0, 10),
        time: e.time || "",
        actual: e.actual || "",        // ✅ NOW COMES DIRECTLY
        forecast: e.forecast || "",
        previous: e.previous || "",
        impact
      };
    })
    .sort((a, b) => Number(b.impact) - Number(a.impact));
}


// ─────────────────────────────────────────────────────────
// CALENDAR ENDPOINT
// ─────────────────────────────────────────────────────────
app.get("/api/calendar", async (req, res) => {
  const now = Date.now();
  const force = req.query.force === "1";

  try {
    if (force || now - lastFetch > JSON_TTL || calCache.length === 0) {
      console.log("[CAL] fetching FF JSON...");

      const raw = await fetchFFCalendar();
      calCache = buildCalendar(raw);

      lastFetch = now;

      const actualCount = calCache.filter(e => e.actual).length;
      console.log(`[CAL] events: ${calCache.length}, actuals: ${actualCount}`);
    }

    res.json({
      events: calCache,
      refreshedAt: new Date(lastFetch).toISOString()
    });

  } catch (e) {
    console.error("[CAL] error:", e.message);
    res.status(500).json({ error: e.message, events: calCache });
  }
});


// ─────────────────────────────────────────────────────────
// NEWS (UNCHANGED)
// ─────────────────────────────────────────────────────────
app.get("/api/news", async (req, res) => {
  const { q = "markets economy", pageSize = 15 } = req.query;

  try {
    const url1 = `https://newsapi.org/v2/top-headlines?q=${encodeURIComponent(q)}&pageSize=${pageSize}&language=en&apiKey=${NEWS_KEY}`;
    const r1 = await fetch(url1);
    const data1 = await r1.json();

    let articles = data1.articles || [];

    if (articles.length < 8) {
      const url2 = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&pageSize=${pageSize}&sortBy=publishedAt&language=en&apiKey=${NEWS_KEY}`;
      const r2 = await fetch(url2);
      const data2 = await r2.json();

      if (r2.ok && data2.articles?.length) {
        const seen = new Set(articles.map(a => a.title));
        articles = [
          ...articles,
          ...data2.articles.filter(a => !seen.has(a.title))
        ].slice(0, pageSize);
      }
    }

    res.json({ articles });

  } catch (e) {
    console.error("[NEWS] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nMacroIntel → http://localhost:${PORT}`);
  console.log(`Calendar → FF JSON (60s refresh, includes actuals)\n`);
});