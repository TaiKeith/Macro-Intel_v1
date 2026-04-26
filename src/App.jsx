import { useState, useRef, useCallback, useEffect } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────
const PROXY = "http://localhost:3001";

const CATEGORIES = [
  { id: "all",           label: "ALL",          icon: "◈", query: "global markets economy geopolitics central bank forex stocks bonds" },
  { id: "macro",         label: "MACRO",         icon: "📊", query: "GDP inflation CPI PPI employment NFP trade balance economic data" },
  { id: "geopolitics",   label: "GEO·POL",       icon: "🌐", query: "geopolitical tensions war sanctions trade war political risk elections" },
  { id: "central_banks", label: "CENTRAL BANKS", icon: "🏦", query: "Federal Reserve ECB Bank of England BOJ interest rates monetary policy FOMC" },
  { id: "commodities",   label: "COMMODITIES",   icon: "⚡", query: "oil crude gold silver copper natural gas commodity prices OPEC" },
  { id: "crypto",        label: "CRYPTO",        icon: "₿",  query: "Bitcoin Ethereum crypto regulation DeFi blockchain institutional" },
];

const SENTIMENT_CONFIG = {
  BULLISH: { color: "#00ff9d", bg: "rgba(0,255,157,0.07)",  short: "▲" },
  BEARISH: { color: "#ff4560", bg: "rgba(255,69,96,0.07)",  short: "▼" },
  NEUTRAL: { color: "#ffc107", bg: "rgba(255,193,7,0.07)",  short: "◆" },
  MIXED:   { color: "#9b59b6", bg: "rgba(155,89,182,0.07)", short: "⟺" },
};

const ASSET_CLASSES = ["Equities", "Bonds", "FX", "Commodities", "Crypto", "Rates"];

const FX_PAIRS = [
  { pair: "DXY",    label: "US DOLLAR INDEX",  flag: "🇺🇸" },
  { pair: "EURUSD", label: "EUR/USD",           flag: "🇪🇺" },
  { pair: "GBPUSD", label: "GBP/USD",           flag: "🇬🇧" },
  { pair: "USDJPY", label: "USD/JPY",           flag: "🇯🇵" },
  { pair: "USDCHF", label: "USD/CHF",           flag: "🇨🇭" },
  { pair: "AUDUSD", label: "AUD/USD",           flag: "🇦🇺" },
];

const IMPACT_CONFIG = {
  "3": { color: "#ff4560", label: "HIGH"   },
  "2": { color: "#ff8c00", label: "MEDIUM" },
  "1": { color: "#ffc107", label: "LOW"    },
};

const COOLDOWN_SECS = 60;

// ─── API helpers ─────────────────────────────────────────────────────────────
async function fetchNews(query, signal) {
  const res = await fetch(`${PROXY}/api/news?q=${encodeURIComponent(query)}&pageSize=15`, { signal });
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

async function fetchCalendar(signal) {
  const res = await fetch(`${PROXY}/api/calendar`, { signal });
  if (!res.ok) throw new Error(`Calendar fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`FCS: ${data.error}`);
  return data.events || [];
}

async function callGemini(apiKey, prompt, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
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
      throw new Error(isDaily ? "Daily quota exhausted — resets midnight Pacific" : "Rate limited — wait 60s");
    }
    if (res.status === 400) throw new Error(`Bad request: ${msg}`);
    if (res.status === 403) throw new Error("Invalid Gemini API key");
    throw new Error(msg);
  }
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/gi, "").trim();
  const start = clean.indexOf("[");
  const end   = clean.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { return []; }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildPrompt(articles, calendarEvents, category) {
  const now = new Date().toUTCString();

  const articleText = articles.length > 0
    ? articles.map((a, i) =>
        `[${i+1}] ${a.source} | ${new Date(a.publishedAt).toLocaleString()}\n    TITLE: ${a.title}\n    DESC: ${a.description || "N/A"}`
      ).join("\n\n")
    : "No articles available.";

  const calText = calendarEvents.length > 0
    ? calendarEvents.map(e =>
        `• [${e.impact==="3"?"HIGH":e.impact==="2"?"MEDIUM":"LOW"}] ${e.country} | ${e.title||e.event} | ${e.date||""} ${e.time||""} | Actual: ${e.actual||"pending"} | Forecast: ${e.forecast||"N/A"} | Prev: ${e.previous||e.prev||"N/A"}`
      ).join("\n")
    : "No calendar data available.";

  return `You are a senior macro strategist and FX analyst at a top-tier hedge fund.
Current UTC time: ${now}

You have been given LIVE news articles published in the last 24 hours and today's economic calendar. 
Use ONLY this real data to produce your analysis — do not invent events.

═══════════════════════════════════════
LIVE NEWS (last 24h):
═══════════════════════════════════════
${articleText}

═══════════════════════════════════════
ECONOMIC CALENDAR (today/tomorrow):
═══════════════════════════════════════
${calText}

═══════════════════════════════════════
TASK: Category focus = ${category.toUpperCase()}
═══════════════════════════════════════

Return ONLY a raw JSON array. No markdown. No explanation. Start with [ end with ].

Array must contain exactly 5 signal objects then 1 summary object.

SIGNAL object:
{
  "id": 1,
  "headline": "max 10-word headline referencing real news above",
  "category": "macro|geopolitics|central_banks|commodities|crypto",
  "sentiment": "BULLISH|BEARISH|NEUTRAL|MIXED",
  "confidence": 80,
  "summary": "2 factual sentences citing actual articles/events from the data above",
  "marketImpact": "2 sentences on direct market implications with specific asset names",
  "assetImpacts": {
    "Equities":    { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific e.g. S&P500, tech sector" },
    "Bonds":       { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific e.g. 10Y Treasury yield" },
    "FX":          { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific pairs e.g. USD strengthens" },
    "Commodities": { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific e.g. WTI crude, Gold" },
    "Crypto":      { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific e.g. BTC risk-off" },
    "Rates":       { "direction": "UP|DOWN|NEUTRAL|MIXED", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific e.g. Fed funds futures" }
  },
  "fxImpacts": {
    "DXY":    { "direction": "UP|DOWN|NEUTRAL", "magnitude": "LOW|MEDIUM|HIGH", "note": "why DXY moves e.g. hawkish Fed data boosts dollar" },
    "EURUSD": { "direction": "UP|DOWN|NEUTRAL", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific reason" },
    "GBPUSD": { "direction": "UP|DOWN|NEUTRAL", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific reason" },
    "USDJPY": { "direction": "UP|DOWN|NEUTRAL", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific reason" },
    "USDCHF": { "direction": "UP|DOWN|NEUTRAL", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific reason" },
    "AUDUSD": { "direction": "UP|DOWN|NEUTRAL", "magnitude": "LOW|MEDIUM|HIGH", "note": "specific reason" }
  },
  "keyRisks":    ["risk from real data", "another specific risk"],
  "tradingIdeas":["actionable idea based on data", "another idea"],
  "timeframe": "INTRADAY|SHORT_TERM|MEDIUM_TERM",
  "urgency":   "LOW|MEDIUM|HIGH|CRITICAL",
  "sources":   ["Source Name 1", "Source Name 2"]
}

SUMMARY object (last):
{
  "id": 999,
  "type": "SUMMARY",
  "overallSentiment": "BULLISH|BEARISH|NEUTRAL|MIXED",
  "marketRegime": "e.g. Risk-Off Dollar Strength",
  "topTheme": "one sentence on dominant theme from today's real data",
  "tickerItems": ["ALERT 1", "ALERT 2", "ALERT 3", "ALERT 4", "ALERT 5"],
  "calendarInterpretation": "2 sentences interpreting actual vs forecast for key calendar events today and what the beat/miss means for markets",
  "fxSummary": "2 sentences summarising overall FX market direction based on today's macro data — mention DXY, EUR, GBP specifically"
}`;
}

// ─── Component ────────────────────────────────────────────────────────────────
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

  useEffect(() => {
    const ctrl = new AbortController();
    setCalendarLoading(true);
    fetchCalendar(ctrl.signal)
      .then(evs => setCalendarEvents([...evs].sort((a,b) => (Number(b.impact)||0) - (Number(a.impact)||0))))
      .catch(e  => { if (e.name !== "AbortError") console.warn("Calendar load:", e.message); })
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

    setLoading(true); setErrorMsg(""); setSignals([]); setSelectedSignal(null);

    try {
      const cat = CATEGORIES.find(c => c.id === activeCategory) || CATEGORIES[0];

      setStatusText("FETCHING NEWS...");
      const articles = await fetchNews(cat.query, abortRef.current.signal);
      setNewsCount(articles.length);

      setStatusText("FETCHING CALENDAR...");
      let calEvs = calendarEvents;
      if (calEvs.length === 0) {
        try {
          calEvs = await fetchCalendar(abortRef.current.signal);
          setCalendarEvents([...calEvs].sort((a,b) => (Number(b.impact)||0)-(Number(a.impact)||0)));
        } catch(e) { console.warn("Calendar refresh:", e.message); }
      }

      setStatusText("ANALYSING WITH GEMINI...");
      const rawText = await callGemini(geminiKey, buildPrompt(articles, calEvs, activeCategory), abortRef.current.signal);
      const parsed  = parseJSON(rawText);
      const summary = parsed.find(s => s.type === "SUMMARY");
      const items   = parsed.filter(s => s.type !== "SUMMARY");

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

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const cfg      = s => SENTIMENT_CONFIG[s] || SENTIMENT_CONFIG.NEUTRAL;
  const dirIcon  = d => ({ UP:"▲", DOWN:"▼", MIXED:"⟺", NEUTRAL:"—" }[d] || "—");
  const dirColor = d => ({ UP:"#00ff9d", DOWN:"#ff4560", MIXED:"#9b59b6", NEUTRAL:"#7a8a9a" }[d] || "#7a8a9a");
  const magBar   = m => ({ HIGH:"███", MEDIUM:"██░", LOW:"█░░" }[m] || "░░░");
  const urgColor = u => ({ CRITICAL:"#ff4560", HIGH:"#ff8c00", MEDIUM:"#ffc107", LOW:"#00ff9d" }[u] || "#888");
  const tfColor  = t => ({ INTRADAY:"#00d4ff", SHORT_TERM:"#ffc107", MEDIUM_TERM:"#9b59b6" }[t] || "#7a8a9a");
  const impCfg   = i => IMPACT_CONFIG[String(i)] || IMPACT_CONFIG["1"];
  const canScan  = !loading && cooldown === 0;

  const statusColor = statusText==="LIVE" ? "#00ff9d"
    : statusText==="ERROR" ? "#ff4560"
    : "#00d4ff";

  // ── Colours that are actually readable ───────────────────────────────────────
  const TEXT_PRIMARY   = "#ddeeff";   // headlines, important values
  const TEXT_SECONDARY = "#a8bfcf";   // body text, summaries
  const TEXT_MUTED     = "#6a8a9a";   // labels, metadata
  const TEXT_DIM       = "#3a5a6a";   // very secondary info
  const BORDER         = "#0d1f30";
  const SURFACE        = "#09101a";
  const SURFACE2       = "#060d14";

  return (
    <div style={{ height:"100vh", background:"#070b10", fontFamily:"'IBM Plex Mono','Courier New',monospace", color:TEXT_SECONDARY, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:#050a0f}
        ::-webkit-scrollbar-thumb{background:#1e3a5a;border-radius:2px}
        .ticker-inner{display:inline-block;animation:ticker 55s linear infinite;white-space:nowrap}
        @keyframes ticker{0%{transform:translateX(100vw)}100%{transform:translateX(-100%)}}
        .pulse{animation:pulse 1.8s ease-in-out infinite}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        .sig-card{transition:transform .15s,background .1s;cursor:pointer}
        .sig-card:hover{transform:translateX(3px)}
        .cal-row{transition:background .1s;cursor:default}
        .cal-row:hover{background:#0a141e!important}
        .cat-btn{transition:color .15s;cursor:pointer;border:none;background:none;font-family:inherit}
        .grid-bg{
          background-image:linear-gradient(rgba(0,180,255,.018) 1px,transparent 1px),
            linear-gradient(90deg,rgba(0,180,255,.018) 1px,transparent 1px);
          background-size:40px 40px;
        }
        .scan-btn{transition:all .2s;cursor:pointer;font-family:inherit}
        .scan-btn:hover:not([disabled]){background:rgba(0,212,255,.1)!important;border-color:#00d4ff88!important}
      `}</style>

      {/* HEADER */}
      <div style={{ background:"#040810", borderBottom:`1px solid ${BORDER}`, padding:"8px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:15, fontWeight:700, letterSpacing:3, color:"#00d4ff" }}>MACRO</span>
          <span style={{ fontSize:15, fontWeight:700, letterSpacing:3, color:"#ff4560" }}>INTEL</span>
          <div style={{ marginLeft:6, fontSize:8, letterSpacing:2, padding:"2px 8px", border:`1px solid ${statusColor}44`, color:statusColor }}>
            {loading ? <span className="pulse">● {statusText}</span> : statusText}
          </div>
          {newsCount > 0 && !loading && (
            <div style={{ fontSize:7, color:TEXT_DIM, letterSpacing:1, padding:"2px 6px", border:`1px solid ${BORDER}` }}>
              {newsCount} ARTICLES · GEMINI 2.5 FLASH
            </div>
          )}
        </div>
        {overallSentiment && <div style={{ fontSize:8, color:"#ffc107", letterSpacing:2 }}>{overallSentiment.marketRegime?.toUpperCase()}</div>}
        <div style={{ fontSize:7, color:TEXT_DIM, letterSpacing:1 }}>{lastUpdated ? `UPDATED ${lastUpdated.toLocaleTimeString()}` : "NO DATA"}</div>
      </div>

      {/* TICKER */}
      <div style={{ background:"#020609", borderBottom:`1px solid #08141e`, padding:"4px 0", fontSize:8, letterSpacing:2, overflow:"hidden", minHeight:22, flexShrink:0 }}>
        {ticker.length > 0
          ? <div className="ticker-inner" style={{ color:"#4a8aa0" }}>
              {[...ticker,...ticker].map((t,i) => <span key={i} style={{ marginRight:60 }}><span style={{ color:"#ff4560" }}>◈</span> {t.toUpperCase()}</span>)}
            </div>
          : <div style={{ padding:"0 16px", color:"#1a2d3a" }}>◈ MACROINTEL v2 · NEWSAPI + FCS ECONOMIC CALENDAR + GEMINI 2.5 FLASH · PRESS SCAN TO BEGIN ◈</div>
        }
      </div>

      {/* TABS */}
      <div style={{ background:"#040810", borderBottom:`1px solid ${BORDER}`, padding:"6px 16px", display:"flex", gap:2, alignItems:"center", overflowX:"auto", flexShrink:0 }}>
        {CATEGORIES.map(cat => (
          <button key={cat.id} className="cat-btn"
            onClick={() => setActiveCategory(cat.id)}
            style={{ padding:"4px 12px", fontSize:8, letterSpacing:2, color: activeCategory===cat.id?"#00d4ff":TEXT_DIM, borderBottom: activeCategory===cat.id?"2px solid #00d4ff":"2px solid transparent", whiteSpace:"nowrap" }}>
            {cat.icon} {cat.label}
          </button>
        ))}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          {cooldown > 0 && <span style={{ fontSize:7, color:"#ffc10799", letterSpacing:1 }}>COOLDOWN {cooldown}s</span>}
          <button className="scan-btn" onClick={fetchSignals} disabled={!canScan}
            style={{ padding:"5px 16px", fontSize:8, letterSpacing:2, color: canScan?"#00d4ff":TEXT_DIM, border:`1px solid ${canScan?"#00d4ff44":BORDER}`, background:"transparent", opacity: canScan?1:0.5 }}>
            {loading ? `● ${statusText}` : cooldown>0 ? `⏱ ${cooldown}s` : "⟳ SCAN"}
          </button>
        </div>
      </div>

      {/* ERROR */}
      {errorMsg && (
        <div style={{ background:"rgba(255,69,96,.08)", borderBottom:"1px solid #ff456022", padding:"6px 16px", fontSize:8, color:"#ff6a7a", letterSpacing:1, flexShrink:0 }}>
          ⚠ {errorMsg.toUpperCase()}
        </div>
      )}

      {/* BODY */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>

        {/* COL 1: Signal List */}
        <div style={{ width:235, borderRight:`1px solid ${BORDER}`, overflowY:"auto", background:SURFACE2, flexShrink:0 }}>
          {overallSentiment && !loading && (
            <div style={{ padding:"10px 12px", background:cfg(overallSentiment.overallSentiment).bg, borderBottom:`1px solid ${cfg(overallSentiment.overallSentiment).color}25` }}>
              <div style={{ fontSize:7, color:TEXT_MUTED, letterSpacing:2, marginBottom:2 }}>OVERALL SENTIMENT</div>
              <div style={{ fontSize:14, fontWeight:700, color:cfg(overallSentiment.overallSentiment).color, letterSpacing:3 }}>
                {cfg(overallSentiment.overallSentiment).short} {overallSentiment.overallSentiment}
              </div>
              {overallSentiment.topTheme && (
                <div style={{ fontSize:8, color:TEXT_SECONDARY, marginTop:5, lineHeight:1.5 }}>{overallSentiment.topTheme}</div>
              )}
            </div>
          )}

          {loading && (
            <div style={{ padding:"20px 12px" }}>
              <div style={{ fontSize:8, color:"#00d4ff", letterSpacing:2, textAlign:"center", marginBottom:12 }} className="pulse">{statusText}</div>
              {[...Array(5)].map((_,i) => <div key={i} style={{ height:60, background:"#0c1520", marginBottom:7, animation:`pulse ${1.2+i*.15}s ease-in-out infinite`, opacity:.3 }} />)}
            </div>
          )}

          {!loading && signals.length === 0 && (
            <div style={{ padding:"50px 16px", textAlign:"center" }}>
              <div style={{ fontSize:28, opacity:.06, marginBottom:10 }}>◈</div>
              <div style={{ fontSize:8, color:TEXT_DIM, letterSpacing:2, marginBottom:14 }}>PRESS SCAN TO BEGIN</div>
              <button className="scan-btn" onClick={fetchSignals} disabled={!canScan}
                style={{ padding:"6px 14px", fontSize:8, letterSpacing:2, color:"#00d4ff", border:"1px solid #00d4ff44", background:"transparent" }}>
                ⟳ SCAN NOW
              </button>
            </div>
          )}

          {signals.map(sig => {
            const scfg = cfg(sig.sentiment);
            const isSel = selectedSignal?.id === sig.id;
            return (
              <div key={sig.id} className="sig-card" onClick={() => setSelectedSignal(sig)}
                style={{ padding:"9px 12px", borderBottom:`1px solid #08121c`, background: isSel?"#0c1a28":"transparent", borderLeft: isSel?`2px solid ${scfg.color}`:"2px solid transparent" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ fontSize:6, letterSpacing:2, color:urgColor(sig.urgency), border:`1px solid ${urgColor(sig.urgency)}40`, padding:"1px 5px" }}>{sig.urgency}</span>
                  <span style={{ fontSize:8, color:scfg.color, fontWeight:700 }}>{scfg.short} {sig.sentiment}</span>
                </div>
                <div style={{ fontSize:10, color:TEXT_PRIMARY, lineHeight:1.45, marginBottom:5, fontWeight:500 }}>{sig.headline}</div>
                <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                  <span style={{ fontSize:6, color:"#4a8aa0", background:"#0a1c2c", padding:"1px 5px", letterSpacing:1 }}>{sig.category?.replace("_"," ").toUpperCase()}</span>
                  <span style={{ fontSize:6, color:tfColor(sig.timeframe) }}>{sig.timeframe?.replace("_"," ")}</span>
                  <span style={{ marginLeft:"auto", fontSize:6, color:TEXT_MUTED }}>{sig.confidence}%</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* COL 2: Signal Detail */}
        <div style={{ flex:1, overflowY:"auto", background:"#060b10", minWidth:0 }} className="grid-bg">
          {!selectedSignal && (
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", flexDirection:"column", gap:8 }}>
              <div style={{ fontSize:32, opacity:.05 }}>◈</div>
              <div style={{ fontSize:8, color:TEXT_DIM, letterSpacing:3 }}>{signals.length>0?"SELECT A SIGNAL":"SCAN TO LOAD SIGNALS"}</div>
            </div>
          )}

          {selectedSignal && (
            <div style={{ padding:"18px 20px", maxWidth:740 }}>
              {/* Tags */}
              <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
                <span style={{ fontSize:7, letterSpacing:2, color:urgColor(selectedSignal.urgency), border:`1px solid ${urgColor(selectedSignal.urgency)}50`, padding:"2px 7px" }}>⚡ {selectedSignal.urgency}</span>
                <span style={{ fontSize:7, letterSpacing:2, color:"#4a8aa0", border:`1px solid #1a3545`, padding:"2px 7px" }}>{selectedSignal.category?.replace("_"," ").toUpperCase()}</span>
                <span style={{ fontSize:7, letterSpacing:2, color:tfColor(selectedSignal.timeframe), border:`1px solid ${tfColor(selectedSignal.timeframe)}50`, padding:"2px 7px" }}>{selectedSignal.timeframe?.replace("_"," ")}</span>
                {selectedSignal.sources?.map((s,i) => (
                  <span key={i} style={{ fontSize:7, color:TEXT_MUTED, border:`1px solid ${BORDER}`, padding:"2px 7px" }}>{s}</span>
                ))}
              </div>

              {/* Headline */}
              <h1 style={{ fontSize:18, fontFamily:"'Space Grotesk',sans-serif", fontWeight:800, color:TEXT_PRIMARY, lineHeight:1.35, marginBottom:10, letterSpacing:-.3 }}>
                {selectedSignal.headline}
              </h1>

              {/* Sentiment bar */}
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", background:cfg(selectedSignal.sentiment).bg, border:`1px solid ${cfg(selectedSignal.sentiment).color}35`, marginBottom:14 }}>
                <div style={{ fontSize:18, fontWeight:700, color:cfg(selectedSignal.sentiment).color }}>{cfg(selectedSignal.sentiment).short}</div>
                <div>
                  <div style={{ fontSize:10, color:cfg(selectedSignal.sentiment).color, fontWeight:600, letterSpacing:2 }}>{selectedSignal.sentiment}</div>
                  <div style={{ fontSize:7, color:TEXT_MUTED }}>CONFIDENCE {selectedSignal.confidence}%</div>
                </div>
                <div style={{ marginLeft:"auto", width:70, height:3, background:"#1a2535", borderRadius:2, overflow:"hidden" }}>
                  <div style={{ width:`${selectedSignal.confidence}%`, height:"100%", background:cfg(selectedSignal.sentiment).color }} />
                </div>
              </div>

              {/* Summary + Impact */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
                {[["WHAT HAPPENED", selectedSignal.summary],["MARKET IMPACT", selectedSignal.marketImpact]].map(([label, text]) => (
                  <div key={label} style={{ background:SURFACE, border:`1px solid ${BORDER}`, padding:"11px" }}>
                    <div style={{ fontSize:7, color:"#4a8aa0", letterSpacing:3, marginBottom:6 }}>{label}</div>
                    <div style={{ fontSize:10, color:TEXT_SECONDARY, lineHeight:1.75 }}>{text}</div>
                  </div>
                ))}
              </div>

              {/* Asset Matrix */}
              <div style={{ background:SURFACE, border:`1px solid ${BORDER}`, padding:"11px", marginBottom:12 }}>
                <div style={{ fontSize:7, color:"#4a8aa0", letterSpacing:3, marginBottom:10 }}>ASSET CLASS IMPACT MATRIX</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:7 }}>
                  {ASSET_CLASSES.map(asset => {
                    const imp = selectedSignal.assetImpacts?.[asset];
                    if (!imp) return null;
                    return (
                      <div key={asset} style={{ background:SURFACE2, border:`1px solid #0a1828`, padding:"7px 9px" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                          <span style={{ fontSize:6, color:TEXT_MUTED, letterSpacing:1 }}>{asset.toUpperCase()}</span>
                          <span style={{ fontSize:9, fontWeight:700, color:dirColor(imp.direction) }}>{dirIcon(imp.direction)}</span>
                        </div>
                        <div style={{ fontSize:7, color:dirColor(imp.direction), letterSpacing:1, marginBottom:3 }}>{magBar(imp.magnitude)} {imp.magnitude}</div>
                        <div style={{ fontSize:8, color:TEXT_SECONDARY, lineHeight:1.4 }}>{imp.note}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* FX PAIRS SECTION */}
              <div style={{ background:SURFACE, border:`1px solid #1a3545`, padding:"11px", marginBottom:12 }}>
                <div style={{ fontSize:7, color:"#00d4ff", letterSpacing:3, marginBottom:10 }}>💱 FX PAIRS IMPACT</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:7 }}>
                  {FX_PAIRS.map(({ pair, label, flag }) => {
                    const imp = selectedSignal.fxImpacts?.[pair];
                    if (!imp) return (
                      <div key={pair} style={{ background:SURFACE2, border:`1px solid #0a1828`, padding:"7px 9px", opacity:0.4 }}>
                        <div style={{ fontSize:7, color:TEXT_MUTED }}>{flag} {pair}</div>
                        <div style={{ fontSize:7, color:TEXT_DIM }}>—</div>
                      </div>
                    );
                    return (
                      <div key={pair} style={{ background:SURFACE2, border:`1px solid ${dirColor(imp.direction)}25`, padding:"7px 9px" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                          <span style={{ fontSize:7, color:TEXT_SECONDARY, fontWeight:600 }}>{flag} {pair}</span>
                          <span style={{ fontSize:10, fontWeight:700, color:dirColor(imp.direction) }}>{dirIcon(imp.direction)}</span>
                        </div>
                        <div style={{ fontSize:7, color:dirColor(imp.direction), letterSpacing:1, marginBottom:3 }}>{magBar(imp.magnitude)} {imp.magnitude}</div>
                        <div style={{ fontSize:8, color:TEXT_SECONDARY, lineHeight:1.4 }}>{imp.note}</div>
                      </div>
                    );
                  })}
                </div>
                {overallSentiment?.fxSummary && (
                  <div style={{ marginTop:10, padding:"8px 10px", background:SURFACE2, border:`1px solid #1a3040`, fontSize:9, color:TEXT_SECONDARY, lineHeight:1.7 }}>
                    {overallSentiment.fxSummary}
                  </div>
                )}
              </div>

              {/* Risks + Ideas */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                <div style={{ background:SURFACE, border:"1px solid #ff456022", padding:"11px" }}>
                  <div style={{ fontSize:7, color:"#ff6a7a", letterSpacing:3, marginBottom:6 }}>⚠ KEY RISKS</div>
                  {(selectedSignal.keyRisks||[]).map((r,i) => (
                    <div key={i} style={{ fontSize:9, color:TEXT_SECONDARY, lineHeight:1.65, padding:"3px 0", borderBottom:`1px solid #101820`, display:"flex", gap:6 }}>
                      <span style={{ color:"#ff456055", flexShrink:0 }}>›</span>{r}
                    </div>
                  ))}
                </div>
                <div style={{ background:SURFACE, border:"1px solid #00ff9d22", padding:"11px" }}>
                  <div style={{ fontSize:7, color:"#00ff9d", letterSpacing:3, marginBottom:6 }}>💡 TRADING IDEAS</div>
                  {(selectedSignal.tradingIdeas||[]).map((t,i) => (
                    <div key={i} style={{ fontSize:9, color:TEXT_SECONDARY, lineHeight:1.65, padding:"3px 0", borderBottom:`1px solid #0a1510`, display:"flex", gap:6 }}>
                      <span style={{ color:"#00ff9d55", flexShrink:0 }}>›</span>{t}
                    </div>
                  ))}
                </div>
              </div>

              {/* Calendar interpretation */}
              {overallSentiment?.calendarInterpretation && (
                <div style={{ background:SURFACE, border:"1px solid #ffc10722", padding:"11px", marginBottom:10 }}>
                  <div style={{ fontSize:7, color:"#ffc107", letterSpacing:3, marginBottom:6 }}>📅 CALENDAR INTERPRETATION</div>
                  <div style={{ fontSize:10, color:TEXT_SECONDARY, lineHeight:1.75 }}>{overallSentiment.calendarInterpretation}</div>
                </div>
              )}

              <div style={{ fontSize:7, color:TEXT_DIM, letterSpacing:1, textAlign:"center", paddingTop:4 }}>
                NOT FINANCIAL ADVICE · FOR INFORMATIONAL PURPOSES ONLY · DO YOUR OWN RESEARCH
              </div>
            </div>
          )}
        </div>

        {/* COL 3: Economic Calendar */}
        <div style={{ width:255, borderLeft:`1px solid ${BORDER}`, overflowY:"auto", background:SURFACE2, flexShrink:0 }}>
          <div style={{ padding:"10px 12px", borderBottom:`1px solid ${BORDER}`, display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, background:SURFACE2, zIndex:1 }}>
            <div style={{ fontSize:8, color:"#4a8aa0", letterSpacing:3 }}>📅 ECON CALENDAR</div>
            <div style={{ fontSize:7, color:TEXT_DIM }}>TODAY + 2 DAYS</div>
          </div>

          {/* Legend */}
          <div style={{ padding:"6px 12px", borderBottom:`1px solid #08141e`, display:"flex", gap:12 }}>
            {[["3","HIGH"],["2","MED"],["1","LOW"]].map(([k,l]) => (
              <div key={k} style={{ display:"flex", alignItems:"center", gap:3, fontSize:7, color:IMPACT_CONFIG[k].color }}>
                <div style={{ width:6, height:6, borderRadius:"50%", background:IMPACT_CONFIG[k].color }} />{l}
              </div>
            ))}
          </div>

          {calendarLoading && (
            <div style={{ padding:"20px 12px", textAlign:"center" }}>
              <div style={{ fontSize:8, color:"#00d4ff", letterSpacing:2 }} className="pulse">LOADING...</div>
            </div>
          )}

          {!calendarLoading && calendarEvents.length === 0 && (
            <div style={{ padding:"30px 12px", textAlign:"center" }}>
              <div style={{ fontSize:8, color:TEXT_DIM, letterSpacing:2, marginBottom:4 }}>NO EVENTS LOADED</div>
              <div style={{ fontSize:7, color:"#1a2a35", lineHeight:1.5 }}>Check server is running:<br/>node server.js</div>
            </div>
          )}

          {calendarEvents.map((ev, i) => {
            const ic = impCfg(ev.impact);
            // FCS API uses different field names — handle all variants
            const eventName = ev.title || ev.event || ev.name || "Unknown Event";
            const country   = ev.country || ev.currency || "";
            const actual    = ev.actual   ?? ev.act    ?? "";
            const forecast  = ev.forecast ?? ev.fore   ?? "";
            const previous  = ev.previous ?? ev.prev   ?? "";
            const time      = ev.time     ?? ev.event_time ?? "";
            const date      = ev.date     ?? ev.event_date ?? "";

            const hasActual = actual !== "" && actual !== null && actual !== undefined;
            let beat = null;
            if (hasActual && forecast) {
              const a = parseFloat(String(actual).replace(/[^0-9.-]/g,""));
              const f = parseFloat(String(forecast).replace(/[^0-9.-]/g,""));
              if (!isNaN(a) && !isNaN(f)) beat = a > f;
            }

            return (
              <div key={i} className="cal-row"
                style={{ padding:"8px 12px", borderBottom:`1px solid #07111a`, borderLeft:`2px solid ${ic.color}55` }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3, alignItems:"center" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <div style={{ width:5, height:5, borderRadius:"50%", background:ic.color, flexShrink:0 }} />
                    <span style={{ fontSize:7, color:ic.color, letterSpacing:1, fontWeight:600 }}>{country}</span>
                  </div>
                  <span style={{ fontSize:7, color:TEXT_MUTED }}>{time || date || "ALL DAY"}</span>
                </div>

                <div style={{ fontSize:9, color:TEXT_PRIMARY, lineHeight:1.35, marginBottom:6, fontWeight:500 }}>
                  {eventName}
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:3 }}>
                  {[
                    ["ACT",  actual,   hasActual ? (beat===true?"#00ff9d":beat===false?"#ff4560":"#ffc107") : TEXT_DIM],
                    ["FORE", forecast, "#4a8aa0"],
                    ["PREV", previous, TEXT_MUTED],
                  ].map(([label, val, color]) => (
                    <div key={label} style={{ background:"#04090e", padding:"3px 5px", textAlign:"center" }}>
                      <div style={{ fontSize:6, color:TEXT_DIM, letterSpacing:1, marginBottom:1 }}>{label}</div>
                      <div style={{ fontSize:8, color, fontWeight: label==="ACT"&&hasActual?700:400 }}>
                        {String(val||"—")}
                        {label==="ACT"&&beat===true&&" ▲"}
                        {label==="ACT"&&beat===false&&" ▼"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {calendarEvents.length > 0 && (
            <div style={{ padding:"8px 12px", fontSize:7, color:TEXT_DIM, textAlign:"center", letterSpacing:1 }}>
              {calendarEvents.length} EVENTS · FCS API
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
