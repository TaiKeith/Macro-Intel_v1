import { useState, useRef, useCallback, useEffect } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────
const PROXY = "http://localhost:3001";

const CATEGORIES = [
  { id: "all",           label: "ALL",          icon: "◈", query: "global markets economy geopolitics central bank" },
  { id: "macro",         label: "MACRO",         icon: "📊", query: "GDP inflation CPI employment trade balance economic data" },
  { id: "geopolitics",   label: "GEO·POL",       icon: "🌐", query: "geopolitical tensions war sanctions trade war political risk" },
  { id: "central_banks", label: "CENTRAL BANKS", icon: "🏦", query: "Federal Reserve ECB interest rates monetary policy central bank" },
  { id: "commodities",   label: "COMMODITIES",   icon: "⚡", query: "oil gold silver copper natural gas commodity prices" },
  { id: "crypto",        label: "CRYPTO",        icon: "₿",  query: "Bitcoin Ethereum crypto regulation DeFi blockchain" },
];

const SENTIMENT_CONFIG = {
  BULLISH: { color: "#00ff9d", bg: "rgba(0,255,157,0.07)",  short: "▲" },
  BEARISH: { color: "#ff4560", bg: "rgba(255,69,96,0.07)",  short: "▼" },
  NEUTRAL: { color: "#ffc107", bg: "rgba(255,193,7,0.07)",  short: "◆" },
  MIXED:   { color: "#9b59b6", bg: "rgba(155,89,182,0.07)", short: "⟺" },
};

const ASSET_CLASSES = ["Equities", "Bonds", "FX", "Commodities", "Crypto", "Rates"];
const COOLDOWN_SECS = 60;

// Impact levels from FCS API — map to red/orange/yellow like ForexFactory
const IMPACT_CONFIG = {
  "3": { color: "#ff4560", bg: "rgba(255,69,96,0.12)",  label: "HIGH",   dot: "🔴" },
  "2": { color: "#ff8c00", bg: "rgba(255,140,0,0.12)",  label: "MEDIUM", dot: "🟠" },
  "1": { color: "#ffc107", bg: "rgba(255,193,7,0.12)",  label: "LOW",    dot: "🟡" },
};

// ─── Fetch news from proxy ───────────────────────────────────────────────────
async function fetchNews(query, signal) {
  const res = await fetch(
    `${PROXY}/api/news?q=${encodeURIComponent(query)}&pageSize=15`,
    { signal }
  );
  if (!res.ok) throw new Error(`News fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`NewsAPI: ${data.error}`);
  return (data.articles || []).map(a => ({
    title:       a.title,
    description: a.description,
    source:      a.source?.name,
    publishedAt: a.publishedAt,
    url:         a.url,
  }));
}

// ─── Fetch economic calendar from proxy ─────────────────────────────────────
async function fetchCalendar(signal) {
  const res = await fetch(`${PROXY}/api/calendar`, { signal });
  if (!res.ok) throw new Error(`Calendar fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`FCS: ${data.error}`);
  // FCS returns { response: [...] }
  return (data.response || []);
}

// ─── Gemini analysis ─────────────────────────────────────────────────────────
async function callGemini(apiKey, prompt, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    console.error("Gemini error:", res.status, JSON.stringify(err));
    if (res.status === 429) {
      const isDaily = msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("daily");
      throw new Error(isDaily
        ? "Daily quota exhausted — resets at midnight Pacific"
        : "Rate limited — wait 60s and retry"
      );
    }
    if (res.status === 400) throw new Error(`Bad request: ${msg}`);
    if (res.status === 403) throw new Error("Invalid Gemini API key");
    throw new Error(msg);
  }

  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
}

// ─── Parse JSON from Gemini response ────────────────────────────────────────
function parseJSON(text) {
  const clean = text.replace(/```json|```/gi, "").trim();
  const start = clean.indexOf("[");
  const end   = clean.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { return []; }
}

// ─── Build the master prompt for Gemini ─────────────────────────────────────
function buildPrompt(articles, calendarEvents, category) {
  const articleText = articles.length > 0
    ? articles.map((a, i) =>
        `[${i+1}] ${a.source} | ${new Date(a.publishedAt).toLocaleTimeString()} \n    HEADLINE: ${a.title}\n    SUMMARY: ${a.description || "N/A"}`
      ).join("\n\n")
    : "No articles available.";

  const calendarText = calendarEvents.length > 0
    ? calendarEvents.map(e =>
        `• [${e.impact === "3" ? "HIGH" : e.impact === "2" ? "MEDIUM" : "LOW"}] ${e.country} ${e.event} @ ${e.time || "TBD"} — Actual: ${e.actual || "pending"} | Forecast: ${e.forecast || "N/A"} | Previous: ${e.previous || "N/A"}`
      ).join("\n")
    : "No calendar events today.";

  return `You are a senior macro strategist and market analyst at a top-tier hedge fund.

Below is REAL data pulled live right now. Analyze it and return trading signals.

═══════════════════════════════
LIVE NEWS ARTICLES (${articles.length} articles):
═══════════════════════════════
${articleText}

═══════════════════════════════
ECONOMIC CALENDAR (today/tomorrow):
═══════════════════════════════
${calendarText}

═══════════════════════════════
CATEGORY FOCUS: ${category.toUpperCase()}
═══════════════════════════════

Based on the REAL news and calendar data above, return ONLY a raw JSON array (no markdown, no explanation).

The array must contain 5 signal objects + 1 summary object.

Signal object shape:
{
  "id": 1,
  "headline": "concise max-10-word headline based on real news above",
  "category": "macro|geopolitics|central_banks|commodities|crypto",
  "sentiment": "BULLISH|BEARISH|NEUTRAL|MIXED",
  "confidence": 82,
  "summary": "2-sentence factual summary referencing real articles/events above",
  "marketImpact": "2-sentence market implication with specific assets mentioned",
  "assetImpacts": {
    "Equities":    { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific note" },
    "Bonds":       { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific note" },
    "FX":          { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific note" },
    "Commodities": { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific note" },
    "Crypto":      { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific note" },
    "Rates":       { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific note" }
  },
  "keyRisks":    ["specific risk from the data", "another specific risk"],
  "tradingIdeas":["specific actionable idea", "another idea"],
  "timeframe": "INTRADAY|SHORT_TERM|MEDIUM_TERM",
  "urgency":   "LOW|MEDIUM|HIGH|CRITICAL",
  "sources":   ["Source Name 1", "Source Name 2"]
}

Summary object (last in array):
{
  "id": 999,
  "type": "SUMMARY",
  "overallSentiment": "BULLISH|BEARISH|NEUTRAL|MIXED",
  "marketRegime": "short regime phrase",
  "topTheme": "one sentence on dominant theme from today's data",
  "tickerItems": ["ALERT 1", "ALERT 2", "ALERT 3", "ALERT 4", "ALERT 5"],
  "calendarInterpretation": "2-sentence interpretation of today's key calendar events and what the actual vs forecast means for markets"
}

Start with [ and end with ]. No other text.`;
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function MarketIntelDashboard() {
  const [activeCategory, setActiveCategory]     = useState("all");
  const [signals, setSignals]                   = useState([]);
  const [loading, setLoading]                   = useState(false);
  const [lastUpdated, setLastUpdated]           = useState(null);
  const [selectedSignal, setSelectedSignal]     = useState(null);
  const [overallSentiment, setOverallSentiment] = useState(null);
  const [ticker, setTicker]                     = useState([]);
  const [statusText, setStatusText]             = useState("READY");
  const [cooldown, setCooldown]                 = useState(0);
  const [errorMsg, setErrorMsg]                 = useState("");
  const [calendarEvents, setCalendarEvents]     = useState([]);
  const [calendarLoading, setCalendarLoading]   = useState(false);
  const [newsCount, setNewsCount]               = useState(0);
  const abortRef    = useRef(null);
  const cooldownRef = useRef(null);

  // Load calendar on mount
  useEffect(() => {
    const ctrl = new AbortController();
    setCalendarLoading(true);
    fetchCalendar(ctrl.signal)
      .then(events => {
        // Sort by impact descending, then by time
        const sorted = [...events].sort((a, b) => (b.impact || 0) - (a.impact || 0));
        setCalendarEvents(sorted);
      })
      .catch(e => { if (e.name !== "AbortError") console.warn("Calendar:", e.message); })
      .finally(() => setCalendarLoading(false));
    return () => ctrl.abort();
  }, []);

  const startCooldown = () => {
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    setCooldown(COOLDOWN_SECS);
    cooldownRef.current = setInterval(() => {
      setCooldown(c => { if (c <= 1) { clearInterval(cooldownRef.current); return 0; } return c - 1; });
    }, 1000);
  };

  const fetchSignals = useCallback(async () => {
    if (loading || cooldown > 0) return;
    const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!geminiKey) { setErrorMsg("Missing VITE_GEMINI_API_KEY in .env"); setStatusText("ERROR"); return; }

    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setErrorMsg("");
    setStatusText("FETCHING NEWS...");
    setSignals([]);
    setSelectedSignal(null);

    try {
      const cat = CATEGORIES.find(c => c.id === activeCategory) || CATEGORIES[0];

      // Step 1: fetch news
      setStatusText("FETCHING NEWS...");
      const articles = await fetchNews(cat.query, abortRef.current.signal);
      setNewsCount(articles.length);

      // Step 2: fetch/refresh calendar
      setStatusText("FETCHING CALENDAR...");
      let calEvents = calendarEvents;
      if (calEvents.length === 0) {
        try {
          calEvents = await fetchCalendar(abortRef.current.signal);
          setCalendarEvents(calEvents.sort((a, b) => (b.impact || 0) - (a.impact || 0)));
        } catch(e) { console.warn("Calendar refresh failed:", e.message); }
      }

      // Step 3: Gemini analysis
      setStatusText("ANALYSING WITH GEMINI...");
      const prompt   = buildPrompt(articles, calEvents, activeCategory);
      const rawText  = await callGemini(geminiKey, prompt, abortRef.current.signal);
      const parsed   = parseJSON(rawText);
      const summary  = parsed.find(s => s.type === "SUMMARY");
      const items    = parsed.filter(s => s.type !== "SUMMARY");

      if (items.length === 0) throw new Error("No signals parsed — please retry");

      setSignals(items);
      setOverallSentiment(summary || null);
      setTicker(summary?.tickerItems || []);
      setLastUpdated(new Date());
      setStatusText("LIVE");
      setSelectedSignal(items[0]);
      startCooldown();
    } catch (err) {
      if (err.name !== "AbortError") { setErrorMsg(err.message || "Unknown error"); setStatusText("ERROR"); }
    } finally {
      setLoading(false);
    }
  }, [activeCategory, loading, cooldown, calendarEvents]);

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const cfg      = s  => SENTIMENT_CONFIG[s] || SENTIMENT_CONFIG.NEUTRAL;
  const dirIcon  = d  => ({ UP:"▲", DOWN:"▼", MIXED:"⟺", NEUTRAL:"—" }[d] || "—");
  const dirColor = d  => ({ UP:"#00ff9d", DOWN:"#ff4560", MIXED:"#9b59b6", NEUTRAL:"#555" }[d] || "#555");
  const magBar   = m  => ({ HIGH:"███", MEDIUM:"██░", LOW:"█░░" }[m] || "░░░");
  const urgColor = u  => ({ CRITICAL:"#ff4560", HIGH:"#ff8c00", MEDIUM:"#ffc107", LOW:"#00ff9d" }[u] || "#888");
  const tfColor  = t  => ({ INTRADAY:"#00d4ff", SHORT_TERM:"#ffc107", MEDIUM_TERM:"#9b59b6" }[t] || "#888");
  const impCfg   = i  => IMPACT_CONFIG[String(i)] || IMPACT_CONFIG["1"];
  const canScan  = !loading && cooldown === 0;

  const statusColor = statusText === "LIVE" ? "#00ff9d"
    : statusText === "ERROR" ? "#ff4560"
    : statusText.includes("...") ? "#00d4ff"
    : "#00d4ff66";

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ height:"100vh", background:"#080c10", fontFamily:"'IBM Plex Mono','Courier New',monospace", color:"#c8d8e8", display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:#0d1117}
        ::-webkit-scrollbar-thumb{background:#1e3a5a;border-radius:2px}
        .ticker-inner{display:inline-block;animation:ticker 55s linear infinite;white-space:nowrap}
        @keyframes ticker{0%{transform:translateX(100vw)}100%{transform:translateX(-100%)}}
        .pulse{animation:pulse 1.8s ease-in-out infinite}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
        .sig-card{transition:transform .15s;cursor:pointer}
        .sig-card:hover{transform:translateX(3px)}
        .cal-row{transition:background .15s}
        .cal-row:hover{background:rgba(0,212,255,0.04)!important}
        .cat-btn{transition:color .15s;cursor:pointer;border:none;background:none;font-family:inherit}
        .grid-bg{
          background-image:linear-gradient(rgba(0,212,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,.02) 1px,transparent 1px);
          background-size:40px 40px;
        }
        .scan-btn{transition:background .2s;cursor:pointer;font-family:inherit}
        .scan-btn:hover:not([disabled]){background:rgba(0,212,255,.1)!important}
        a{color:inherit;text-decoration:none}
        a:hover{text-decoration:underline}
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ background:"#050810", borderBottom:"1px solid #0d1f35", padding:"8px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:15, fontWeight:700, letterSpacing:3, color:"#00d4ff" }}>MACRO</span>
          <span style={{ fontSize:15, fontWeight:700, letterSpacing:3, color:"#ff4560" }}>INTEL</span>
          <div style={{ marginLeft:6, fontSize:8, letterSpacing:2, padding:"2px 8px", border:`1px solid ${statusColor}44`, color:statusColor }}>
            {loading ? <span className="pulse">● {statusText}</span> : statusText}
          </div>
          {newsCount > 0 && !loading && (
            <div style={{ fontSize:7, color:"#2a5a78", letterSpacing:1, padding:"2px 6px", border:"1px solid #0d2535" }}>
              {newsCount} ARTICLES · GEMINI 2.5 FLASH
            </div>
          )}
        </div>
        {overallSentiment && (
          <div style={{ fontSize:8, color:"#ffc107", letterSpacing:2 }}>{overallSentiment.marketRegime?.toUpperCase()}</div>
        )}
        <div style={{ fontSize:7, color:"#1e2d3d", letterSpacing:1 }}>
          {lastUpdated ? `UPDATED ${lastUpdated.toLocaleTimeString()}` : "NO DATA"}
        </div>
      </div>

      {/* ── TICKER ── */}
      <div style={{ background:"#02070d", borderBottom:"1px solid #0a1520", padding:"4px 0", fontSize:8, letterSpacing:2, overflow:"hidden", minHeight:22, flexShrink:0 }}>
        {ticker.length > 0
          ? <div className="ticker-inner" style={{ color:"#3a6a80" }}>
              {[...ticker,...ticker].map((t,i) => <span key={i} style={{ marginRight:60 }}><span style={{ color:"#ff4560" }}>◈</span> {t.toUpperCase()}</span>)}
            </div>
          : <div style={{ padding:"0 16px", color:"#151e28" }}>◈ MACROINTEL v2 · NEWSAPI + FCS ECONOMIC CALENDAR + GEMINI 2.5 FLASH ANALYSIS · PRESS SCAN TO BEGIN ◈</div>
        }
      </div>

      {/* ── TABS ── */}
      <div style={{ background:"#050810", borderBottom:"1px solid #0d1f35", padding:"6px 16px", display:"flex", gap:2, alignItems:"center", overflowX:"auto", flexShrink:0 }}>
        {CATEGORIES.map(cat => (
          <button key={cat.id} className="cat-btn"
            onClick={() => setActiveCategory(cat.id)}
            style={{ padding:"4px 12px", fontSize:8, letterSpacing:2, color: activeCategory===cat.id?"#00d4ff":"#2a3a4a", borderBottom: activeCategory===cat.id?"2px solid #00d4ff":"2px solid transparent" }}>
            {cat.icon} {cat.label}
          </button>
        ))}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          {cooldown > 0 && <span style={{ fontSize:7, color:"#ffc10788", letterSpacing:1 }}>COOLDOWN {cooldown}s</span>}
          <button className="scan-btn" onClick={fetchSignals} disabled={!canScan}
            style={{ padding:"5px 16px", fontSize:8, letterSpacing:2, color: canScan?"#00d4ff":"#1e2d3d", border:`1px solid ${canScan?"#00d4ff33":"#0d1520"}`, background:"transparent", opacity: canScan?1:0.5 }}>
            {loading ? `● ${statusText}` : cooldown>0 ? `⏱ ${cooldown}s` : "⟳ SCAN"}
          </button>
        </div>
      </div>

      {/* ── ERROR ── */}
      {errorMsg && (
        <div style={{ background:"rgba(255,69,96,.07)", borderBottom:"1px solid #ff456022", padding:"6px 16px", fontSize:8, color:"#ff4560", letterSpacing:1, flexShrink:0 }}>
          ⚠ {errorMsg.toUpperCase()}
        </div>
      )}

      {/* ── BODY: 3 columns ── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>

        {/* ── COL 1: Signal list (240px) ── */}
        <div style={{ width:240, borderRight:"1px solid #0d1f35", overflowY:"auto", background:"#060a10", flexShrink:0 }}>
          {overallSentiment && !loading && (
            <div style={{ padding:"10px 12px", background:cfg(overallSentiment.overallSentiment).bg, borderBottom:`1px solid ${cfg(overallSentiment.overallSentiment).color}20` }}>
              <div style={{ fontSize:7, color:"#334", letterSpacing:2, marginBottom:2 }}>OVERALL SENTIMENT</div>
              <div style={{ fontSize:13, fontWeight:700, color:cfg(overallSentiment.overallSentiment).color, letterSpacing:3 }}>
                {cfg(overallSentiment.overallSentiment).short} {overallSentiment.overallSentiment}
              </div>
              {overallSentiment.topTheme && <div style={{ fontSize:8, color:"#556", marginTop:4, lineHeight:1.5 }}>{overallSentiment.topTheme}</div>}
            </div>
          )}

          {loading && (
            <div style={{ padding:"20px 12px" }}>
              <div style={{ fontSize:8, color:"#00d4ff", letterSpacing:2, textAlign:"center", marginBottom:12 }} className="pulse">{statusText}</div>
              {[...Array(5)].map((_,i) => <div key={i} style={{ height:55, background:"#0d1117", marginBottom:7, animation:`pulse ${1.2+i*.15}s ease-in-out infinite`, opacity:.1+i*.04 }} />)}
            </div>
          )}

          {!loading && signals.length === 0 && (
            <div style={{ padding:"40px 16px", textAlign:"center" }}>
              <div style={{ fontSize:28, opacity:.04, marginBottom:10 }}>◈</div>
              <div style={{ fontSize:8, color:"#1a2530", letterSpacing:2, marginBottom:14 }}>PRESS SCAN</div>
              <button className="scan-btn" onClick={fetchSignals} disabled={!canScan}
                style={{ padding:"6px 14px", fontSize:8, letterSpacing:2, color:"#00d4ff", border:"1px solid #00d4ff33", background:"transparent" }}>
                ⟳ SCAN NOW
              </button>
            </div>
          )}

          {signals.map(sig => {
            const scfg = cfg(sig.sentiment);
            const isSel = selectedSignal?.id === sig.id;
            return (
              <div key={sig.id} className="sig-card" onClick={() => setSelectedSignal(sig)}
                style={{ padding:"9px 12px", borderBottom:"1px solid #09121c", background: isSel?"#0a1520":"transparent", borderLeft: isSel?`2px solid ${scfg.color}`:"2px solid transparent" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                  <span style={{ fontSize:6, letterSpacing:2, color:urgColor(sig.urgency), border:`1px solid ${urgColor(sig.urgency)}30`, padding:"1px 4px" }}>{sig.urgency}</span>
                  <span style={{ fontSize:8, color:scfg.color, fontWeight:700 }}>{scfg.short} {sig.sentiment}</span>
                </div>
                <div style={{ fontSize:9, color:"#b0c0d0", lineHeight:1.4, marginBottom:4, fontWeight:500 }}>{sig.headline}</div>
                <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                  <span style={{ fontSize:6, color:"#2a5a78", background:"#0a1c2c", padding:"1px 4px" }}>{sig.category?.replace("_"," ").toUpperCase()}</span>
                  <span style={{ fontSize:6, color:tfColor(sig.timeframe) }}>{sig.timeframe?.replace("_"," ")}</span>
                  <span style={{ marginLeft:"auto", fontSize:6, color:"#223" }}>{sig.confidence}%</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── COL 2: Signal detail (flex) ── */}
        <div style={{ flex:1, overflowY:"auto", background:"#07090f", minWidth:0 }} className="grid-bg">
          {!selectedSignal && (
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", flexDirection:"column", gap:8 }}>
              <div style={{ fontSize:32, opacity:.04 }}>◈</div>
              <div style={{ fontSize:8, color:"#111d26", letterSpacing:3 }}>{signals.length>0?"SELECT A SIGNAL":"SCAN TO LOAD SIGNALS"}</div>
            </div>
          )}

          {selectedSignal && (
            <div style={{ padding:"18px 20px", maxWidth:700 }}>
              {/* Tags */}
              <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
                <span style={{ fontSize:7, letterSpacing:2, color:urgColor(selectedSignal.urgency), border:`1px solid ${urgColor(selectedSignal.urgency)}40`, padding:"2px 7px" }}>⚡ {selectedSignal.urgency}</span>
                <span style={{ fontSize:7, letterSpacing:2, color:"#3a6a88", border:"1px solid #0d2035", padding:"2px 7px" }}>{selectedSignal.category?.replace("_"," ").toUpperCase()}</span>
                <span style={{ fontSize:7, letterSpacing:2, color:tfColor(selectedSignal.timeframe), border:`1px solid ${tfColor(selectedSignal.timeframe)}35`, padding:"2px 7px" }}>{selectedSignal.timeframe?.replace("_"," ")}</span>
              </div>

              {/* Headline */}
              <h1 style={{ fontSize:17, fontFamily:"'Space Grotesk',sans-serif", fontWeight:800, color:"#ddeeff", lineHeight:1.35, marginBottom:10, letterSpacing:-.5 }}>
                {selectedSignal.headline}
              </h1>

              {/* Sentiment */}
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", background:cfg(selectedSignal.sentiment).bg, border:`1px solid ${cfg(selectedSignal.sentiment).color}30`, marginBottom:12 }}>
                <div style={{ fontSize:18, fontWeight:700, color:cfg(selectedSignal.sentiment).color }}>{cfg(selectedSignal.sentiment).short}</div>
                <div>
                  <div style={{ fontSize:10, color:cfg(selectedSignal.sentiment).color, fontWeight:600, letterSpacing:2 }}>{selectedSignal.sentiment}</div>
                  <div style={{ fontSize:7, color:"#334" }}>CONFIDENCE {selectedSignal.confidence}%</div>
                </div>
                <div style={{ marginLeft:"auto", width:60, height:3, background:"#1a2535", borderRadius:2, overflow:"hidden" }}>
                  <div style={{ width:`${selectedSignal.confidence}%`, height:"100%", background:cfg(selectedSignal.sentiment).color }} />
                </div>
              </div>

              {/* Summary + Impact */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
                {[["WHAT HAPPENED", selectedSignal.summary],["MARKET IMPACT", selectedSignal.marketImpact]].map(([label, text]) => (
                  <div key={label} style={{ background:"#09101a", border:"1px solid #0c1b2c", padding:"11px" }}>
                    <div style={{ fontSize:7, color:"#2a5a78", letterSpacing:3, marginBottom:6 }}>{label}</div>
                    <div style={{ fontSize:10, color:"#8fa8bc", lineHeight:1.7 }}>{text}</div>
                  </div>
                ))}
              </div>

              {/* Asset matrix */}
              <div style={{ background:"#09101a", border:"1px solid #0c1b2c", padding:"11px", marginBottom:12 }}>
                <div style={{ fontSize:7, color:"#2a5a78", letterSpacing:3, marginBottom:10 }}>ASSET CLASS IMPACT MATRIX</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:7 }}>
                  {ASSET_CLASSES.map(asset => {
                    const imp = selectedSignal.assetImpacts?.[asset];
                    if (!imp) return null;
                    return (
                      <div key={asset} style={{ background:"#050810", border:"1px solid #0a1420", padding:"7px 9px" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                          <span style={{ fontSize:6, color:"#3a4a5a", letterSpacing:1 }}>{asset.toUpperCase()}</span>
                          <span style={{ fontSize:9, fontWeight:700, color:dirColor(imp.direction) }}>{dirIcon(imp.direction)}</span>
                        </div>
                        <div style={{ fontSize:7, color:dirColor(imp.direction), letterSpacing:1, marginBottom:2 }}>{magBar(imp.magnitude)} {imp.magnitude}</div>
                        <div style={{ fontSize:7, color:"#334", lineHeight:1.4 }}>{imp.note}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Risks + Ideas */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                <div style={{ background:"#09101a", border:"1px solid #ff456018", padding:"11px" }}>
                  <div style={{ fontSize:7, color:"#ff4560", letterSpacing:3, marginBottom:6 }}>⚠ KEY RISKS</div>
                  {(selectedSignal.keyRisks||[]).map((r,i) => (
                    <div key={i} style={{ fontSize:9, color:"#7a9aaa", lineHeight:1.6, padding:"3px 0", borderBottom:"1px solid #111a20", display:"flex", gap:6 }}>
                      <span style={{ color:"#ff456040" }}>›</span>{r}
                    </div>
                  ))}
                </div>
                <div style={{ background:"#09101a", border:"1px solid #00ff9d18", padding:"11px" }}>
                  <div style={{ fontSize:7, color:"#00ff9d", letterSpacing:3, marginBottom:6 }}>💡 TRADING IDEAS</div>
                  {(selectedSignal.tradingIdeas||[]).map((t,i) => (
                    <div key={i} style={{ fontSize:9, color:"#7a9aaa", lineHeight:1.6, padding:"3px 0", borderBottom:"1px solid #0a1510", display:"flex", gap:6 }}>
                      <span style={{ color:"#00ff9d40" }}>›</span>{t}
                    </div>
                  ))}
                </div>
              </div>

              {/* Sources */}
              {selectedSignal.sources?.length > 0 && (
                <div style={{ fontSize:7, color:"#2a3a4a", letterSpacing:1, marginBottom:8 }}>
                  SOURCES: {selectedSignal.sources.join(" · ")}
                </div>
              )}

              {/* Calendar interpretation */}
              {overallSentiment?.calendarInterpretation && (
                <div style={{ background:"#09101a", border:"1px solid #ffc10722", padding:"11px", marginBottom:10 }}>
                  <div style={{ fontSize:7, color:"#ffc107", letterSpacing:3, marginBottom:6 }}>📅 CALENDAR INTERPRETATION</div>
                  <div style={{ fontSize:10, color:"#8fa8bc", lineHeight:1.7 }}>{overallSentiment.calendarInterpretation}</div>
                </div>
              )}

              <div style={{ fontSize:7, color:"#151e28", letterSpacing:1, textAlign:"center" }}>
                NOT FINANCIAL ADVICE · FOR INFORMATIONAL PURPOSES ONLY · DO YOUR OWN RESEARCH
              </div>
            </div>
          )}
        </div>

        {/* ── COL 3: Economic Calendar (260px) ── */}
        <div style={{ width:260, borderLeft:"1px solid #0d1f35", overflowY:"auto", background:"#060a10", flexShrink:0 }}>
          <div style={{ padding:"10px 12px", borderBottom:"1px solid #0d1f35", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ fontSize:8, color:"#3a6a88", letterSpacing:3 }}>📅 ECON CALENDAR</div>
            <div style={{ fontSize:7, color:"#1e2d3d" }}>TODAY + TOMORROW</div>
          </div>

          {/* Legend */}
          <div style={{ padding:"6px 12px", borderBottom:"1px solid #0a1520", display:"flex", gap:10 }}>
            {Object.entries(IMPACT_CONFIG).reverse().map(([k, v]) => (
              <div key={k} style={{ display:"flex", alignItems:"center", gap:3, fontSize:7, color:v.color }}>
                <div style={{ width:6, height:6, borderRadius:"50%", background:v.color }} />
                {v.label}
              </div>
            ))}
          </div>

          {calendarLoading && (
            <div style={{ padding:"20px 12px", textAlign:"center" }}>
              <div style={{ fontSize:8, color:"#00d4ff", letterSpacing:2 }} className="pulse">LOADING CALENDAR...</div>
            </div>
          )}

          {!calendarLoading && calendarEvents.length === 0 && (
            <div style={{ padding:"30px 12px", textAlign:"center" }}>
              <div style={{ fontSize:8, color:"#1a2530", letterSpacing:2, marginBottom:6 }}>NO EVENTS</div>
              <div style={{ fontSize:7, color:"#111d26" }}>CHECK SERVER CONNECTION</div>
            </div>
          )}

          {calendarEvents.map((ev, i) => {
            const ic = impCfg(ev.impact);
            const hasActual = ev.actual && ev.actual !== "" && ev.actual !== null;
            const beat = hasActual && ev.forecast
              ? parseFloat(ev.actual) > parseFloat(ev.forecast)
              : null;

            return (
              <div key={i} className="cal-row"
                style={{ padding:"8px 12px", borderBottom:"1px solid #08111c", borderLeft:`2px solid ${ic.color}44` }}>
                {/* Country + time */}
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <div style={{ width:5, height:5, borderRadius:"50%", background:ic.color, flexShrink:0 }} />
                    <span style={{ fontSize:7, color:ic.color, letterSpacing:1 }}>{ev.country}</span>
                  </div>
                  <span style={{ fontSize:7, color:"#2a3a4a" }}>{ev.time || "ALL DAY"}</span>
                </div>

                {/* Event name */}
                <div style={{ fontSize:9, color:"#a0b8c8", lineHeight:1.3, marginBottom:5, fontWeight:500 }}>
                  {ev.event}
                </div>

                {/* Actual / Forecast / Previous */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:3 }}>
                  {[
                    ["ACT", ev.actual, hasActual ? (beat === true ? "#00ff9d" : beat === false ? "#ff4560" : "#ffc107") : "#334"],
                    ["FORE", ev.forecast, "#4a8fa8"],
                    ["PREV", ev.previous, "#334"],
                  ].map(([label, val, color]) => (
                    <div key={label} style={{ background:"#050810", padding:"3px 5px", textAlign:"center" }}>
                      <div style={{ fontSize:6, color:"#2a3a4a", letterSpacing:1, marginBottom:1 }}>{label}</div>
                      <div style={{ fontSize:8, color, fontWeight: label==="ACT" && hasActual ? 700 : 400 }}>
                        {val || "—"}
                        {label==="ACT" && beat===true  && " ▲"}
                        {label==="ACT" && beat===false && " ▼"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {calendarEvents.length > 0 && (
            <div style={{ padding:"8px 12px", fontSize:7, color:"#1a2530", textAlign:"center", letterSpacing:1 }}>
              {calendarEvents.length} EVENTS · FCS API
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
