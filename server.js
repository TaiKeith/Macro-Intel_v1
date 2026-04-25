import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3001;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

const NEWS_KEY = process.env.VITE_NEWSAPI_KEY;
const FCS_KEY  = process.env.VITE_FCSAPI_KEY;

// ── NewsAPI: top headlines by query ─────────────────────────────────────────
app.get("/api/news", async (req, res) => {
  const { q = "markets economy", pageSize = 10 } = req.query;
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&pageSize=${pageSize}&sortBy=publishedAt&language=en&apiKey=${NEWS_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FCS API: economic calendar ───────────────────────────────────────────────
app.get("/api/calendar", async (req, res) => {
  try {
    // Get today and tomorrow's date
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const fmt = d => d.toISOString().split("T")[0];

    const url = `https://fcsapi.com/api-v3/forex/economy_cal?from=${fmt(today)}&to=${fmt(tomorrow)}&access_key=${FCS_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.msg || "FCS error" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  MacroIntel proxy running on http://localhost:${PORT}`);
  console.log(`  NewsAPI key: ${NEWS_KEY ? "✓ loaded" : "✗ missing"}`);
  console.log(`  FCS key:     ${FCS_KEY  ? "✓ loaded" : "✗ missing"}\n`);
});
