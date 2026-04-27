import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = 3001;

/* =========================
   NORMALIZATION (CRITICAL)
========================= */
function normalize(str) {
  return (str || "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   KEY BUILDER (FIXED)
   ❌ Removed time (unreliable)
========================= */
function makeKey(e) {
  return `${normalize(e.country)}|${normalize(e.title)}|${e.date}`;
}

/* =========================
   FETCH FOREX FACTORY DATA
========================= */
async function fetchFFData() {
  const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  return await res.json();
}

/* =========================
   BUILD EVENTS (Forecast + Previous)
========================= */
function buildEvents(data) {
  return data.map(e => ({
    key: makeKey(e),
    country: e.country || "",
    title: e.title || "",
    date: e.date || "",
    time: e.time || "",
    actual: "", // will be filled later
    forecast: e.forecast || "",
    previous: e.previous || "",
    impact: e.impact || ""
  }));
}

/* =========================
   EXTRACT ACTUALS
========================= */
function extractActuals(data) {
  const actuals = {};

  data.forEach(e => {
    if (e.actual) {
      const key = makeKey(e);
      actuals[key] = e.actual;
    }
  });

  return actuals;
}

/* =========================
   MERGE ACTUALS
========================= */
function mergeActuals(events, actualsMap) {
  return events.map(e => {
    const key = makeKey(e);

    return {
      ...e,
      actual: actualsMap[key] || ""
    };
  });
}

/* =========================
   API ROUTE
========================= */
app.get("/api/calendar", async (req, res) => {
  try {
    const data = await fetchFFData();

    const events = buildEvents(data);
    const actualsMap = extractActuals(data);
    const merged = mergeActuals(events, actualsMap);

    // DEBUG (optional)
    // merged.forEach(e => {
    //   if (!e.actual && e.forecast) {
    //     console.log("NO MATCH:", e.key);
    //   }
    // });

    res.json({
      events: merged,
      refreshedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to fetch calendar"
    });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});