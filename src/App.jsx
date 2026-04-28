import { useState, useRef, useCallback, useEffect } from "react";

const PROXY = "http://localhost:3001";

const CATEGORIES = [
  { id: "all",           label: "ALL",          icon: "◈", query: "markets economy" },
  { id: "macro",         label: "MACRO",         icon: "📊", query: "inflation GDP employment" },
  { id: "geopolitics",   label: "GEO·POL",       icon: "🌐", query: "geopolitics trade war sanctions" },
  { id: "central_banks", label: "CENTRAL BANKS", icon: "🏦", query: "Federal Reserve interest rates" },
  { id: "commodities",   label: "COMMODITIES",   icon: "⚡", query: "oil gold commodities" },
  { id: "crypto",        label: "CRYPTO",        icon: "₿",  query: "Bitcoin crypto" },
];

const SENTIMENT_CONFIG = {
  BULLISH: { color: "#00ff9d", bg: "rgba(0,255,157,0.07)",  short: "▲" },
  BEARISH: { color: "#ff4560", bg: "rgba(255,69,96,0.07)",  short: "▼" },
  NEUTRAL: { color: "#ffc107", bg: "rgba(255,193,7,0.07)",  short: "◆" },
  MIXED:   { color: "#9b59b6", bg: "rgba(155,89,182,0.07)", short: "⟺" },
};

const ASSET_CLASSES = ["Equities", "Bonds", "FX", "Commodities", "Crypto", "Rates"];

// Your exact instruments — always shown
const MY_INSTRUMENTS = [
  { pair: "DXY",    label: "DXY",      flag: "🇺🇸", group: "USD" },
  { pair: "EURUSD", label: "EUR/USD",  flag: "🇪🇺", group: "Major" },
  { pair: "GBPUSD", label: "GBP/USD",  flag: "🇬🇧", group: "Major" },
  { pair: "USDJPY", label: "USD/JPY",  flag: "🇯🇵", group: "Major" },
  { pair: "EURJPY", label: "EUR/JPY",  flag: "🇪🇺", group: "Cross" },
  { pair: "GBPJPY", label: "GBP/JPY",  flag: "🇬🇧", group: "Cross" },
  { pair: "XAUUSD", label: "GOLD",     flag: "🥇", group: "Commodity" },
  { pair: "NAS100", label: "NAS100",   flag: "📈", group: "Index" },
];

const IMPACT_CONFIG = {
  "3": { color: "#ff4560", label: "HIGH"   },
  "2": { color: "#ff8c00", label: "MEDIUM" },
  "1": { color: "#ffc107", label: "LOW"    },
};

const COOLDOWN_SECS = 60;
const CAL_REFRESH_MS = 90000; // match server scrape cadence (90s)

// ─── helpers ─────────────────────────────────────────────────────────────────
function minsUntilEvent(ev) {
  if (!ev.time || !ev.date) return null;
  try {
    const dt = new Date(`${ev.date}T${ev.time}:00Z`);
    return Math.round((dt - Date.now()) / 60000);
  } catch { return null; }
}

async function fetchNews(query, signal) {
  const res = await fetch(`${PROXY}/api/news?q=${encodeURIComponent(query)}&pageSize=15`, { signal });
  if (!res.ok) throw new Error(`News fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`NewsAPI: ${data.error}`);
  return (data.articles || []).map(a => ({
    title: a.title, description: a.description,
    source: a.source?.name, publishedAt: a.publishedAt, url: a.url,
  }));
}

async function fetchCalendar(signal) {
  const opts = signal ? { signal } : {};
  const res  = await fetch(`${PROXY}/api/calendar`, opts);
  if (!res.ok) throw new Error(`Calendar fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Calendar: ${data.error}`);
  return data.events || [];
}

async function callGemini(apiKey, prompt, signal, useSearch = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      // Force JSON only when NOT using search (search grounding incompatible with responseMimeType)
      ...(useSearch ? {} : { responseMimeType: "application/json" }),
    },
  };
  if (useSearch) {
    body.tools = [{ googleSearch: {} }];
  }
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    console.error("Gemini error:", res.status, msg);
    if (res.status === 429) throw new Error(msg.toLowerCase().includes("quota") ? "Daily quota exhausted — resets midnight Pacific" : "Rate limited — wait 60s");
    throw new Error(msg);
  }
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
  console.log("[GEMINI] response length:", text.length, "| first 200 chars:", text.slice(0,200));
  return text;
}

// Dedicated Gemini call to interpret a single calendar event — uses web search to find actual value
async function interpretEvent(apiKey, ev) {
  const hasActual = ev.actual && ev.actual.trim() !== "";
  
  const today = new Date().toLocaleDateString("en-US", {month:"long", day:"numeric", year:"numeric"});
  const prompt = `You are a senior FX macro analyst. Today is ${today}.

Use Google Search to find the ACTUAL RELEASED VALUE for this economic event. Search specifically for the event name and country.

EVENT DETAILS:
Country:   ${ev.country}
Indicator: ${ev.title}
Date:      ${ev.date}
Time:      ${ev.time} UTC
Forecast:  ${ev.forecast || "N/A"}
Previous:  ${ev.previous || "N/A"}
${hasActual ? `Our Data Shows: ${ev.actual}` : `Our data feed does not have the actual yet. SEARCH FOR IT NOW.`}

SEARCH INSTRUCTIONS:
1. Search: "${ev.title} ${ev.country} ${ev.date} actual"
2. Also try: "${ev.country} ${ev.title} released today"
3. If the event released today or recently, the actual value WILL be available online
4. If truly not released yet, set verdict to "NOT YET RELEASED"

Once you have the actual value, compare vs forecast and interpret for forex traders.

Return ONLY a JSON object (no markdown):
{
  "actualValue": "the actual number you found e.g. 3.2% or 48.3 — string",
  "verdict": "BEAT|MISS|IN LINE|NO FORECAST|NOT YET RELEASED",
  "dollarImpact": "UP|DOWN|NEUTRAL",
  "summary": "1 plain-english sentence: what happened e.g. German GfK Consumer Climate came in at -20.6 vs -25.0 forecast — a beat",
  "meaning": "2 sentences explaining what this means for markets in simple terms",
  "pairImpacts": {
    "DXY":    { "direction": "UP|DOWN|NEUTRAL", "reason": "one sentence" },
    "EURUSD": { "direction": "UP|DOWN|NEUTRAL", "reason": "one sentence" },
    "GBPUSD": { "direction": "UP|DOWN|NEUTRAL", "reason": "one sentence" },
    "USDJPY": { "direction": "UP|DOWN|NEUTRAL", "reason": "one sentence" },
    "EURJPY": { "direction": "UP|DOWN|NEUTRAL", "reason": "one sentence" },
    "GBPJPY": { "direction": "UP|DOWN|NEUTRAL", "reason": "one sentence" },
    "XAUUSD": { "direction": "UP|DOWN|NEUTRAL", "reason": "one sentence" },
    "NAS100": { "direction": "UP|DOWN|NEUTRAL", "reason": "one sentence" }
  },
  "traderNote": "1 actionable sentence for a forex/gold/NAS100 day trader right now"
}`;

  const res = await callGemini(apiKey, prompt, null, true); // useSearch=true to find actuals
  try {
    const clean = res.replace(/```json|```/gi,"").trim();
    const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
    return JSON.parse(clean.slice(s, e+1));
  } catch { return null; }
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/gi, "").trim();
  const s = clean.indexOf("["), e = clean.lastIndexOf("]");
  if (s === -1 || e === -1) {
    console.error("[PARSE] No JSON array found in response. Full text:", text.slice(0, 500));
    return [];
  }
  try {
    return JSON.parse(clean.slice(s, e+1));
  } catch(err) {
    console.error("[PARSE] JSON parse failed:", err.message, "| snippet:", clean.slice(s, s+300));
    return [];
  }
}

function buildPrompt(articles, calendarEvents, category) {
  const now = new Date().toUTCString();
  const articleText = articles.length > 0
    ? articles.map((a,i) => `[${i+1}] ${a.source} | ${new Date(a.publishedAt).toLocaleString()}\n    TITLE: ${a.title}\n    DESC: ${a.description||"N/A"}`).join("\n\n")
    : "No live articles available — use your own knowledge of current macro conditions, recent central bank decisions, geopolitical events, and market themes to generate realistic and relevant signals.";
  const calText = calendarEvents.length > 0
    ? calendarEvents.map(e => `• [${e.impact==="3"?"HIGH":e.impact==="2"?"MEDIUM":"LOW"}] ${e.country} | ${e.title||e.event} | ${e.date||""} ${e.time||""} | Actual: ${e.actual||"pending"} | Forecast: ${e.forecast||"N/A"} | Prev: ${e.previous||"N/A"}`).join("\n")
    : "No calendar data available.";

  return `You are a senior FX macro strategist. The trader uses: EURUSD, GBPUSD, USDJPY, EURJPY, GBPJPY, XAUUSD (Gold), NAS100, and tracks DXY for USD correlation.
Current UTC: ${now}

Use ONLY the real data below. Do not invent events.

LIVE NEWS:
${articleText}

ECONOMIC CALENDAR (today/tomorrow):
${calText}

FOCUS: ${category.toUpperCase()}

YOUR RESPONSE MUST BE PURE JSON. Start your entire response with [ and end with ]. 
Do NOT include any text, explanation, or markdown before or after the JSON array.
Do NOT wrap in code fences. Just the raw JSON array.

5 signal objects + 1 summary object:

SIGNAL:
{
  "id": 1,
  "headline": "max 10 words, reference real event",
  "category": "macro|geopolitics|central_banks|commodities|crypto",
  "sentiment": "BULLISH|BEARISH|NEUTRAL|MIXED",
  "confidence": 80,
  "summary": "2 factual sentences from the real data above",
  "marketImpact": "2 sentences on what this means for forex/gold/NAS100 traders",
  "assetImpacts": {
    "Equities":    {"direction":"UP|DOWN|NEUTRAL|MIXED","magnitude":"LOW|MEDIUM|HIGH","note":"e.g. NAS100 impact"},
    "Bonds":       {"direction":"UP|DOWN|NEUTRAL|MIXED","magnitude":"LOW|MEDIUM|HIGH","note":"e.g. 10Y yield"},
    "FX":          {"direction":"UP|DOWN|NEUTRAL|MIXED","magnitude":"LOW|MEDIUM|HIGH","note":"e.g. USD broadly"},
    "Commodities": {"direction":"UP|DOWN|NEUTRAL|MIXED","magnitude":"LOW|MEDIUM|HIGH","note":"e.g. Gold XAU/USD"},
    "Crypto":      {"direction":"UP|DOWN|NEUTRAL|MIXED","magnitude":"LOW|MEDIUM|HIGH","note":"brief"},
    "Rates":       {"direction":"UP|DOWN|NEUTRAL|MIXED","magnitude":"LOW|MEDIUM|HIGH","note":"e.g. Fed rate expectations"}
  },
  "instrumentImpacts": {
    "DXY":    {"direction":"UP|DOWN|NEUTRAL","magnitude":"LOW|MEDIUM|HIGH","note":"specific DXY reason"},
    "EURUSD": {"direction":"UP|DOWN|NEUTRAL","magnitude":"LOW|MEDIUM|HIGH","note":"specific reason"},
    "GBPUSD": {"direction":"UP|DOWN|NEUTRAL","magnitude":"LOW|MEDIUM|HIGH","note":"specific reason"},
    "USDJPY": {"direction":"UP|DOWN|NEUTRAL","magnitude":"LOW|MEDIUM|HIGH","note":"specific reason"},
    "EURJPY": {"direction":"UP|DOWN|NEUTRAL","magnitude":"LOW|MEDIUM|HIGH","note":"specific reason"},
    "GBPJPY": {"direction":"UP|DOWN|NEUTRAL","magnitude":"LOW|MEDIUM|HIGH","note":"specific reason"},
    "XAUUSD": {"direction":"UP|DOWN|NEUTRAL","magnitude":"LOW|MEDIUM|HIGH","note":"specific gold reason"},
    "NAS100": {"direction":"UP|DOWN|NEUTRAL","magnitude":"LOW|MEDIUM|HIGH","note":"specific NAS100 reason"}
  },
  "keyRisks":    ["specific risk","another risk"],
  "tradingIdeas":["specific actionable idea for EU/GU/Gold/NAS trader","another idea"],
  "timeframe":"INTRADAY|SHORT_TERM|MEDIUM_TERM",
  "urgency":"LOW|MEDIUM|HIGH|CRITICAL",
  "sources":["Source 1","Source 2"]
}

SUMMARY (last):
{
  "id":999,"type":"SUMMARY",
  "overallSentiment":"BULLISH|BEARISH|NEUTRAL|MIXED",
  "marketRegime":"e.g. Risk-Off USD Strength",
  "topTheme":"one sentence dominant theme",
  "tickerItems":["ALERT 1","ALERT 2","ALERT 3","ALERT 4","ALERT 5"],
  "calendarInterpretation":"2 sentences: what released actuals mean for markets today",
  "fxSummary":"2 sentences on DXY direction and how it flows into EURUSD, GBPUSD, JPY crosses and Gold",
  "swingBias":"1 sentence on multi-day swing bias for EURUSD and GBPUSD based on current macro"
}`;
}

// ─── Main Component ───────────────────────────────────────────────────────────
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
  const [selectedEvent, setSelectedEvent]       = useState(null);   // for event detail modal
  const [eventAnalysis, setEventAnalysis]       = useState({});     // { eventKey: interpretation }
  const [analyzingEvent, setAnalyzingEvent]     = useState(null);
  const [calLastRefresh, setCalLastRefresh]     = useState(null);
  const abortRef      = useRef(null);
  const cooldownRef   = useRef(null);
  const calRefreshRef = useRef(null);

  // ── Calendar auto-refresh every 60s ───────────────────────────────────────
  const refreshCalendar = useCallback(async () => {
    try {
      const res  = await fetch(`${PROXY}/api/calendar`);
      const data = await res.json();
      const evs  = data.events || [];
      setCalendarEvents([...evs].sort((a,b) => (Number(b.impact)||0)-(Number(a.impact)||0)));
      // Use the server scrape time so we know when actuals were last pulled
      setCalLastRefresh(data.scrapedAt ? new Date(data.scrapedAt) : new Date());
    } catch(e) { console.warn("Cal refresh:", e.message); }
  }, []);

  useEffect(() => {
    setCalendarLoading(true);
    refreshCalendar().finally(() => setCalendarLoading(false));
    calRefreshRef.current = setInterval(refreshCalendar, CAL_REFRESH_MS);
    return () => clearInterval(calRefreshRef.current);
  }, [refreshCalendar]);

  const startCooldown = () => {
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    setCooldown(COOLDOWN_SECS);
    cooldownRef.current = setInterval(() => {
      setCooldown(c => { if (c<=1){clearInterval(cooldownRef.current);return 0;} return c-1; });
    }, 1000);
  };

  // ── Analyse a specific released calendar event ────────────────────────────
  const analyseEvent = useCallback(async (ev) => {
    const key = `${ev.country}-${ev.title}-${ev.date}`;
    if (eventAnalysis[key] || analyzingEvent === key) return;
    const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!geminiKey) return;
    setAnalyzingEvent(key);
    try {
      const result = await interpretEvent(geminiKey, ev);
      if (result) setEventAnalysis(prev => ({ ...prev, [key]: result }));
    } catch(e) { console.warn("Event analysis:", e.message); }
    finally { setAnalyzingEvent(null); }
  }, [eventAnalysis, analyzingEvent]);

  // ── Main scan ─────────────────────────────────────────────────────────────
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

      setStatusText("ANALYSING WITH GEMINI...");
      const rawText = await callGemini(geminiKey, buildPrompt(articles, calendarEvents, activeCategory), abortRef.current.signal);
      const parsed  = parseJSON(rawText);
      const summary = parsed.find(s => s.type==="SUMMARY");
      const items   = parsed.filter(s => s.type!=="SUMMARY");

      if (items.length === 0) throw new Error("No signals parsed — please retry");

      setSignals(items);
      setOverallSentiment(summary||null);
      setTicker(summary?.tickerItems||[]);
      setLastUpdated(new Date());
      setStatusText("LIVE");
      setSelectedSignal(items[0]);
      startCooldown();
    } catch(err) {
      if (err.name!=="AbortError") { setErrorMsg(err.message||"Unknown error"); setStatusText("ERROR"); }
    } finally { setLoading(false); }
  }, [activeCategory, loading, cooldown, calendarEvents]);

  // ── Style helpers ─────────────────────────────────────────────────────────
  const cfg      = s => SENTIMENT_CONFIG[s]||SENTIMENT_CONFIG.NEUTRAL;
  const dirIcon  = d => ({UP:"▲",DOWN:"▼",MIXED:"⟺",NEUTRAL:"—"}[d]||"—");
  const dirColor = d => ({UP:"#00ff9d",DOWN:"#ff4560",MIXED:"#9b59b6",NEUTRAL:"#6a8a9a"}[d]||"#6a8a9a");
  const magBar   = m => ({HIGH:"███",MEDIUM:"██░",LOW:"█░░"}[m]||"░░░");
  const urgColor = u => ({CRITICAL:"#ff4560",HIGH:"#ff8c00",MEDIUM:"#ffc107",LOW:"#00ff9d"}[u]||"#888");
  const tfColor  = t => ({INTRADAY:"#00d4ff",SHORT_TERM:"#ffc107",MEDIUM_TERM:"#9b59b6"}[t]||"#6a8a9a");
  const impCfg   = i => IMPACT_CONFIG[String(i)]||IMPACT_CONFIG["1"];
  const canScan  = !loading && cooldown===0;

  const T1="#ddeeff", T2="#a8bfcf", T3="#6a8a9a", T4="#3a5a6a";
  const BDR="#0d1f30", SRF="#09101a", SRF2="#060d14";
  const statusColor = statusText==="LIVE"?"#00ff9d":statusText==="ERROR"?"#ff4560":"#00d4ff";

  return (
    <div style={{ height:"100vh", background:"#070b10", fontFamily:"'IBM Plex Mono','Courier New',monospace", color:T2, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:#050a0f}
        ::-webkit-scrollbar-thumb{background:#1e3a5a;border-radius:2px}
        .ticker-inner{display:inline-block;animation:ticker 55s linear infinite;white-space:nowrap}
        @keyframes ticker{0%{transform:translateX(100vw)}100%{transform:translateX(-100%)}}
        .pulse{animation:pulse 1.8s ease-in-out infinite}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
        .blink{animation:blink 1s step-end infinite}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        .sig-card{transition:transform .15s,background .1s;cursor:pointer}
        .sig-card:hover{transform:translateX(3px)}
        .cal-row{transition:background .1s;cursor:pointer}
        .cal-row:hover{background:#0c1825!important}
        .cat-btn{transition:color .15s;cursor:pointer;border:none;background:none;font-family:inherit}
        .grid-bg{background-image:linear-gradient(rgba(0,180,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(0,180,255,.018) 1px,transparent 1px);background-size:40px 40px}
        .scan-btn{transition:all .2s;cursor:pointer;font-family:inherit}
        .scan-btn:hover:not([disabled]){background:rgba(0,212,255,.1)!important;border-color:#00d4ff88!important}
        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px}
        .modal-box{background:#08111a;border:1px solid #1a3550;max-width:600px;width:100%;max-height:80vh;overflow-y:auto;border-radius:2px}
      `}</style>

      {/* HEADER */}
      <div style={{ background:"#040810", borderBottom:`1px solid ${BDR}`, padding:"8px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:15, fontWeight:700, letterSpacing:3, color:"#00d4ff" }}>MACRO</span>
          <span style={{ fontSize:15, fontWeight:700, letterSpacing:3, color:"#ff4560" }}>INTEL</span>
          <div style={{ marginLeft:6, fontSize:8, letterSpacing:2, padding:"2px 8px", border:`1px solid ${statusColor}44`, color:statusColor }}>
            {loading?<span className="pulse">● {statusText}</span>:statusText}
          </div>
          {newsCount>0&&!loading&&<div style={{ fontSize:7, color:T4, padding:"2px 6px", border:`1px solid ${BDR}` }}>{newsCount} ARTICLES · GEMINI 2.5 FLASH</div>}
        </div>
        {overallSentiment&&<div style={{ fontSize:8, color:"#ffc107", letterSpacing:2, textAlign:"center" }}>{overallSentiment.marketRegime?.toUpperCase()}</div>}
        <div style={{ fontSize:7, color:T4 }}>{lastUpdated?`UPDATED ${lastUpdated.toLocaleTimeString()}`:"NO DATA"}</div>
      </div>

      {/* TICKER */}
      <div style={{ background:"#020609", borderBottom:`1px solid #08141e`, padding:"4px 0", fontSize:8, letterSpacing:2, overflow:"hidden", minHeight:22, flexShrink:0 }}>
        {ticker.length>0
          ?<div className="ticker-inner" style={{ color:"#4a8aa0" }}>{[...ticker,...ticker].map((t,i)=><span key={i} style={{ marginRight:60 }}><span style={{ color:"#ff4560" }}>◈</span> {t.toUpperCase()}</span>)}</div>
          :<div style={{ padding:"0 16px", color:"#1a2d3a" }}>◈ MACROINTEL · EU GU UJ EJ GJ GOLD NAS100 · NEWSAPI + FOREXFACTORY CALENDAR + GEMINI 2.5 FLASH ◈</div>
        }
      </div>

      {/* TABS */}
      <div style={{ background:"#040810", borderBottom:`1px solid ${BDR}`, padding:"6px 16px", display:"flex", gap:2, alignItems:"center", overflowX:"auto", flexShrink:0 }}>
        {CATEGORIES.map(cat=>(
          <button key={cat.id} className="cat-btn" onClick={()=>setActiveCategory(cat.id)}
            style={{ padding:"4px 12px", fontSize:8, letterSpacing:2, color:activeCategory===cat.id?"#00d4ff":T4, borderBottom:activeCategory===cat.id?"2px solid #00d4ff":"2px solid transparent", whiteSpace:"nowrap" }}>
            {cat.icon} {cat.label}
          </button>
        ))}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          {cooldown>0&&<span style={{ fontSize:7, color:"#ffc10799", letterSpacing:1 }}>COOLDOWN {cooldown}s</span>}
          <button className="scan-btn" onClick={fetchSignals} disabled={!canScan}
            style={{ padding:"5px 16px", fontSize:8, letterSpacing:2, color:canScan?"#00d4ff":T4, border:`1px solid ${canScan?"#00d4ff44":BDR}`, background:"transparent", opacity:canScan?1:0.5 }}>
            {loading?`● ${statusText}`:cooldown>0?`⏱ ${cooldown}s`:"⟳ SCAN"}
          </button>
        </div>
      </div>

      {errorMsg&&<div style={{ background:"rgba(255,69,96,.08)", borderBottom:"1px solid #ff456022", padding:"6px 16px", fontSize:8, color:"#ff6a7a", letterSpacing:1, flexShrink:0 }}>⚠ {errorMsg.toUpperCase()}</div>}

      {/* BODY: 3 columns */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>

        {/* COL 1: Signal List */}
        <div style={{ width:230, borderRight:`1px solid ${BDR}`, overflowY:"auto", background:SRF2, flexShrink:0 }}>
          {overallSentiment&&!loading&&(
            <div style={{ padding:"10px 12px", background:cfg(overallSentiment.overallSentiment).bg, borderBottom:`1px solid ${cfg(overallSentiment.overallSentiment).color}25` }}>
              <div style={{ fontSize:7, color:T3, letterSpacing:2, marginBottom:2 }}>OVERALL SENTIMENT</div>
              <div style={{ fontSize:13, fontWeight:700, color:cfg(overallSentiment.overallSentiment).color, letterSpacing:3 }}>
                {cfg(overallSentiment.overallSentiment).short} {overallSentiment.overallSentiment}
              </div>
              {overallSentiment.topTheme&&<div style={{ fontSize:8, color:T2, marginTop:4, lineHeight:1.5 }}>{overallSentiment.topTheme}</div>}
              {overallSentiment.swingBias&&(
                <div style={{ marginTop:6, padding:"5px 8px", background:"rgba(0,212,255,0.06)", border:"1px solid #00d4ff22", fontSize:8, color:"#00d4ff", lineHeight:1.5 }}>
                  📐 SWING: {overallSentiment.swingBias}
                </div>
              )}
            </div>
          )}

          {loading&&(
            <div style={{ padding:"20px 12px" }}>
              <div style={{ fontSize:8, color:"#00d4ff", letterSpacing:2, textAlign:"center", marginBottom:12 }} className="pulse">{statusText}</div>
              {[...Array(5)].map((_,i)=><div key={i} style={{ height:60, background:"#0c1520", marginBottom:7, animation:`pulse ${1.2+i*.15}s ease-in-out infinite`, opacity:.3 }}/>)}
            </div>
          )}

          {!loading&&signals.length===0&&(
            <div style={{ padding:"50px 16px", textAlign:"center" }}>
              <div style={{ fontSize:28, opacity:.06, marginBottom:10 }}>◈</div>
              <div style={{ fontSize:8, color:T4, letterSpacing:2, marginBottom:14 }}>PRESS SCAN TO BEGIN</div>
              <button className="scan-btn" onClick={fetchSignals} disabled={!canScan}
                style={{ padding:"6px 14px", fontSize:8, letterSpacing:2, color:"#00d4ff", border:"1px solid #00d4ff44", background:"transparent" }}>⟳ SCAN NOW</button>
            </div>
          )}

          {signals.map(sig=>{
            const scfg=cfg(sig.sentiment), isSel=selectedSignal?.id===sig.id;
            return(
              <div key={sig.id} className="sig-card" onClick={()=>setSelectedSignal(sig)}
                style={{ padding:"9px 12px", borderBottom:`1px solid #08121c`, background:isSel?"#0c1a28":"transparent", borderLeft:isSel?`2px solid ${scfg.color}`:"2px solid transparent" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ fontSize:6, letterSpacing:2, color:urgColor(sig.urgency), border:`1px solid ${urgColor(sig.urgency)}40`, padding:"1px 5px" }}>{sig.urgency}</span>
                  <span style={{ fontSize:8, color:scfg.color, fontWeight:700 }}>{scfg.short} {sig.sentiment}</span>
                </div>
                <div style={{ fontSize:10, color:T1, lineHeight:1.45, marginBottom:5, fontWeight:500 }}>{sig.headline}</div>
                <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                  <span style={{ fontSize:6, color:"#4a8aa0", background:"#0a1c2c", padding:"1px 5px" }}>{sig.category?.replace("_"," ").toUpperCase()}</span>
                  <span style={{ fontSize:6, color:tfColor(sig.timeframe) }}>{sig.timeframe?.replace("_"," ")}</span>
                  <span style={{ marginLeft:"auto", fontSize:6, color:T3 }}>{sig.confidence}%</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* COL 2: Signal Detail */}
        <div style={{ flex:1, overflowY:"auto", background:"#060b10", minWidth:0 }} className="grid-bg">
          {!selectedSignal&&(
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", flexDirection:"column", gap:8 }}>
              <div style={{ fontSize:32, opacity:.05 }}>◈</div>
              <div style={{ fontSize:8, color:T4, letterSpacing:3 }}>{signals.length>0?"SELECT A SIGNAL":"SCAN TO LOAD SIGNALS"}</div>
            </div>
          )}

          {selectedSignal&&(
            <div style={{ padding:"18px 20px", maxWidth:760 }}>
              {/* Tags */}
              <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
                <span style={{ fontSize:7, letterSpacing:2, color:urgColor(selectedSignal.urgency), border:`1px solid ${urgColor(selectedSignal.urgency)}50`, padding:"2px 7px" }}>⚡ {selectedSignal.urgency}</span>
                <span style={{ fontSize:7, letterSpacing:2, color:"#4a8aa0", border:`1px solid #1a3545`, padding:"2px 7px" }}>{selectedSignal.category?.replace("_"," ").toUpperCase()}</span>
                <span style={{ fontSize:7, letterSpacing:2, color:tfColor(selectedSignal.timeframe), border:`1px solid ${tfColor(selectedSignal.timeframe)}50`, padding:"2px 7px" }}>{selectedSignal.timeframe?.replace("_"," ")}</span>
                {selectedSignal.sources?.map((s,i)=><span key={i} style={{ fontSize:7, color:T3, border:`1px solid ${BDR}`, padding:"2px 7px" }}>{s}</span>)}
              </div>

              <h1 style={{ fontSize:18, fontFamily:"'Space Grotesk',sans-serif", fontWeight:800, color:T1, lineHeight:1.35, marginBottom:10, letterSpacing:-.3 }}>{selectedSignal.headline}</h1>

              {/* Sentiment */}
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", background:cfg(selectedSignal.sentiment).bg, border:`1px solid ${cfg(selectedSignal.sentiment).color}35`, marginBottom:14 }}>
                <div style={{ fontSize:18, fontWeight:700, color:cfg(selectedSignal.sentiment).color }}>{cfg(selectedSignal.sentiment).short}</div>
                <div>
                  <div style={{ fontSize:10, color:cfg(selectedSignal.sentiment).color, fontWeight:600, letterSpacing:2 }}>{selectedSignal.sentiment}</div>
                  <div style={{ fontSize:7, color:T3 }}>CONFIDENCE {selectedSignal.confidence}%</div>
                </div>
                <div style={{ marginLeft:"auto", width:70, height:3, background:"#1a2535", borderRadius:2, overflow:"hidden" }}>
                  <div style={{ width:`${selectedSignal.confidence}%`, height:"100%", background:cfg(selectedSignal.sentiment).color }}/>
                </div>
              </div>

              {/* Summary + Impact */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
                {[["WHAT HAPPENED",selectedSignal.summary],["MARKET IMPACT",selectedSignal.marketImpact]].map(([label,text])=>(
                  <div key={label} style={{ background:SRF, border:`1px solid ${BDR}`, padding:"11px" }}>
                    <div style={{ fontSize:7, color:"#4a8aa0", letterSpacing:3, marginBottom:6 }}>{label}</div>
                    <div style={{ fontSize:10, color:T2, lineHeight:1.75 }}>{text}</div>
                  </div>
                ))}
              </div>

              {/* YOUR INSTRUMENTS — always shown first */}
              <div style={{ background:SRF, border:"1px solid #1a3545", padding:"11px", marginBottom:12 }}>
                <div style={{ fontSize:7, color:"#00d4ff", letterSpacing:3, marginBottom:10 }}>💱 YOUR INSTRUMENTS</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:7 }}>
                  {MY_INSTRUMENTS.map(({pair,label,flag})=>{
                    const imp=selectedSignal.instrumentImpacts?.[pair];
                    if(!imp) return(
                      <div key={pair} style={{ background:SRF2, border:`1px solid #0a1828`, padding:"7px 9px", opacity:.4 }}>
                        <div style={{ fontSize:8, color:T3 }}>{flag} {label}</div>
                        <div style={{ fontSize:7, color:T4 }}>—</div>
                      </div>
                    );
                    return(
                      <div key={pair} style={{ background:SRF2, border:`1px solid ${dirColor(imp.direction)}28`, padding:"7px 9px" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                          <span style={{ fontSize:8, color:T2, fontWeight:600 }}>{flag} {label}</span>
                          <span style={{ fontSize:10, fontWeight:700, color:dirColor(imp.direction) }}>{dirIcon(imp.direction)}</span>
                        </div>
                        <div style={{ fontSize:7, color:dirColor(imp.direction), letterSpacing:1, marginBottom:2 }}>{magBar(imp.magnitude)} {imp.magnitude}</div>
                        <div style={{ fontSize:8, color:T2, lineHeight:1.4 }}>{imp.note}</div>
                      </div>
                    );
                  })}
                </div>
                {overallSentiment?.fxSummary&&(
                  <div style={{ marginTop:10, padding:"8px 10px", background:SRF2, border:`1px solid #1a3040`, fontSize:9, color:T2, lineHeight:1.7 }}>
                    <span style={{ color:T3, fontSize:7, letterSpacing:2 }}>DXY FLOW: </span>{overallSentiment.fxSummary}
                  </div>
                )}
              </div>

              {/* Asset Class Matrix */}
              <div style={{ background:SRF, border:`1px solid ${BDR}`, padding:"11px", marginBottom:12 }}>
                <div style={{ fontSize:7, color:"#4a8aa0", letterSpacing:3, marginBottom:10 }}>ASSET CLASS OVERVIEW</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:7 }}>
                  {ASSET_CLASSES.map(asset=>{
                    const imp=selectedSignal.assetImpacts?.[asset]; if(!imp) return null;
                    return(
                      <div key={asset} style={{ background:SRF2, border:`1px solid #0a1828`, padding:"7px 9px" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                          <span style={{ fontSize:6, color:T3, letterSpacing:1 }}>{asset.toUpperCase()}</span>
                          <span style={{ fontSize:9, fontWeight:700, color:dirColor(imp.direction) }}>{dirIcon(imp.direction)}</span>
                        </div>
                        <div style={{ fontSize:7, color:dirColor(imp.direction), letterSpacing:1, marginBottom:2 }}>{magBar(imp.magnitude)} {imp.magnitude}</div>
                        <div style={{ fontSize:8, color:T2, lineHeight:1.4 }}>{imp.note}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Risks + Ideas */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                <div style={{ background:SRF, border:"1px solid #ff456022", padding:"11px" }}>
                  <div style={{ fontSize:7, color:"#ff6a7a", letterSpacing:3, marginBottom:6 }}>⚠ KEY RISKS</div>
                  {(selectedSignal.keyRisks||[]).map((r,i)=>(
                    <div key={i} style={{ fontSize:9, color:T2, lineHeight:1.65, padding:"3px 0", borderBottom:`1px solid #101820`, display:"flex", gap:6 }}>
                      <span style={{ color:"#ff456055", flexShrink:0 }}>›</span>{r}
                    </div>
                  ))}
                </div>
                <div style={{ background:SRF, border:"1px solid #00ff9d22", padding:"11px" }}>
                  <div style={{ fontSize:7, color:"#00ff9d", letterSpacing:3, marginBottom:6 }}>💡 TRADING IDEAS</div>
                  {(selectedSignal.tradingIdeas||[]).map((t,i)=>(
                    <div key={i} style={{ fontSize:9, color:T2, lineHeight:1.65, padding:"3px 0", borderBottom:`1px solid #0a1510`, display:"flex", gap:6 }}>
                      <span style={{ color:"#00ff9d55", flexShrink:0 }}>›</span>{t}
                    </div>
                  ))}
                </div>
              </div>

              {/* Calendar interpretation */}
              {overallSentiment?.calendarInterpretation&&(
                <div style={{ background:SRF, border:"1px solid #ffc10722", padding:"11px", marginBottom:10 }}>
                  <div style={{ fontSize:7, color:"#ffc107", letterSpacing:3, marginBottom:6 }}>📅 CALENDAR INTERPRETATION</div>
                  <div style={{ fontSize:10, color:T2, lineHeight:1.75 }}>{overallSentiment.calendarInterpretation}</div>
                </div>
              )}

              <div style={{ fontSize:7, color:T4, letterSpacing:1, textAlign:"center" }}>NOT FINANCIAL ADVICE · FOR INFORMATIONAL PURPOSES ONLY · DO YOUR OWN RESEARCH</div>
            </div>
          )}
        </div>

        {/* COL 3: Economic Calendar */}
        <div style={{ width:260, borderLeft:`1px solid ${BDR}`, overflowY:"auto", background:SRF2, flexShrink:0 }}>
          <div style={{ padding:"8px 12px", borderBottom:`1px solid ${BDR}`, display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, background:SRF2, zIndex:1 }}>
            <div style={{ fontSize:8, color:"#4a8aa0", letterSpacing:3 }}>📅 ECON CALENDAR</div>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <div style={{ width:5, height:5, borderRadius:"50%", background:"#00ff9d" }} className="blink"/>
              <span style={{ fontSize:6, color:T4 }}>{calLastRefresh?`SCRAPED ${calLastRefresh.toLocaleTimeString()}`:"LOADING"}</span>
            </div>
          </div>

          {/* Legend */}
          <div style={{ padding:"5px 12px", borderBottom:`1px solid #08141e`, display:"flex", gap:12, alignItems:"center" }}>
            {[["3","HIGH"],["2","MED"],["1","LOW"]].map(([k,l])=>(
              <div key={k} style={{ display:"flex", alignItems:"center", gap:3, fontSize:7, color:IMPACT_CONFIG[k].color }}>
                <div style={{ width:5, height:5, borderRadius:"50%", background:IMPACT_CONFIG[k].color }}/>{l}
              </div>
            ))}
            <span style={{ marginLeft:"auto", fontSize:6, color:T4 }}>↻ 60s</span>
          </div>

          {calendarLoading&&(
            <div style={{ padding:"20px 12px", textAlign:"center" }}>
              <div style={{ fontSize:8, color:"#00d4ff", letterSpacing:2 }} className="pulse">LOADING...</div>
            </div>
          )}

          {!calendarLoading&&calendarEvents.length===0&&(
            <div style={{ padding:"30px 12px", textAlign:"center" }}>
              <div style={{ fontSize:8, color:T4, letterSpacing:2, marginBottom:4 }}>NO EVENTS</div>
              <div style={{ fontSize:7, color:"#1a2a35", lineHeight:1.5 }}>Check server is running</div>
            </div>
          )}

          {calendarEvents.map((ev,i)=>{
            const ic=impCfg(ev.impact);
            const eventName=ev.title||ev.event||ev.name||"Unknown";
            const country=ev.country||ev.currency||"";
            const actual=ev.actual??ev.act??"";
            const forecast=ev.forecast??ev.fore??"";
            const previous=ev.previous??ev.prev??"";
            const time=ev.time??ev.event_time??"";
            const date=ev.date??ev.event_date??"";
            const hasActual=actual!==""&&actual!==null&&actual!==undefined;
            let beat=null;
            if(hasActual&&forecast){
              const a=parseFloat(String(actual).replace(/[^0-9.-]/g,"")),f=parseFloat(String(forecast).replace(/[^0-9.-]/g,""));
              if(!isNaN(a)&&!isNaN(f)) beat=a>f;
            }
            const mins=minsUntilEvent(ev);
            const isUpcoming=mins!==null&&mins>0&&mins<=30;
            const isLive=mins!==null&&mins<=0&&mins>-60;
            const key=`${country}-${eventName}-${date}`;
            const analysis=eventAnalysis[key];
            const isAnalyzing=analyzingEvent===key;

            return(
              <div key={i} className="cal-row" onClick={()=>{ setSelectedEvent(ev); if(!analysis&&!isAnalyzing) analyseEvent(ev); }}
                style={{ padding:"8px 12px", borderBottom:`1px solid #07111a`, borderLeft:`2px solid ${ic.color}${isUpcoming||isLive?"ff":"55"}`, background:isLive?"rgba(255,69,96,0.05)":isUpcoming?"rgba(255,140,0,0.04)":"transparent" }}>

                {/* Upcoming / Live alert badge */}
                {isUpcoming&&<div style={{ fontSize:7, color:"#ff8c00", letterSpacing:2, marginBottom:3 }} className="blink">⚡ IN {mins}MIN</div>}
                {isLive&&<div style={{ fontSize:7, color:"#ff4560", letterSpacing:2, marginBottom:3 }} className="blink">🔴 LIVE NOW</div>}

                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3, alignItems:"center" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <div style={{ width:5, height:5, borderRadius:"50%", background:ic.color, flexShrink:0 }}/>
                    <span style={{ fontSize:7, color:ic.color, letterSpacing:1, fontWeight:600 }}>{country}</span>
                  </div>
                  <span style={{ fontSize:7, color:T3 }}>{time||date||"ALL DAY"}</span>
                </div>

                <div style={{ fontSize:9, color:T1, lineHeight:1.35, marginBottom:5, fontWeight:500 }}>{eventName}</div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:3 }}>
                  {[
                    ["ACT", analysis?.actualValue||actual||"—", analysis?.actualValue?(analysis.verdict==="BEAT"?"#00ff9d":analysis.verdict==="MISS"?"#ff4560":"#ffc107"):(hasActual?(beat===true?"#00ff9d":beat===false?"#ff4560":"#ffc107"):T4)],
                    ["FORE",forecast,"#4a8aa0"],
                    ["PREV",previous,T3],
                  ].map(([label,val,color])=>(
                    <div key={label} style={{ background:"#04090e", padding:"3px 5px", textAlign:"center" }}>
                      <div style={{ fontSize:6, color:T4, letterSpacing:1, marginBottom:1 }}>{label}</div>
                      <div style={{ fontSize:8, color, fontWeight:label==="ACT"&&hasActual?700:400 }}>
                        {String(val||"—")}
                        {label==="ACT"&&(analysis?.verdict==="BEAT"||beat===true)&&" ▲"}
                        {label==="ACT"&&(analysis?.verdict==="MISS"||beat===false)&&" ▼"}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Show analysis snippet if available */}
                {analysis&&(
                  <div style={{ marginTop:6, padding:"5px 7px", background:"rgba(0,212,255,0.05)", border:"1px solid #00d4ff22", fontSize:8, color:T2, lineHeight:1.5 }}>
                    <span style={{ color: analysis.dollarImpact==="UP"?"#00ff9d":analysis.dollarImpact==="DOWN"?"#ff4560":"#ffc107", fontWeight:700 }}>
                      {analysis.verdict} {analysis.dollarImpact==="UP"?"USD▲":analysis.dollarImpact==="DOWN"?"USD▼":"USD—"}
                    </span>
                    {" · "}{analysis.summary}
                  </div>
                )}
                {isAnalyzing&&<div style={{ marginTop:5, fontSize:7, color:"#00d4ff" }} className="pulse">ANALYSING...</div>}
                {!analysis&&!isAnalyzing&&<div style={{ marginTop:4, fontSize:7, color:T4 }}>↗ tap for analysis</div>}
              </div>
            );
          })}

          {calendarEvents.length>0&&(
            <div style={{ padding:"8px 12px", fontSize:7, color:T4, textAlign:"center", letterSpacing:1 }}>
              {calendarEvents.length} EVENTS · FOREXFACTORY · AUTO-REFRESH
            </div>
          )}
        </div>
      </div>

      {/* EVENT DETAIL MODAL */}
      {selectedEvent&&(()=>{
        const ev=selectedEvent;
        const eventName=ev.title||ev.event||ev.name||"Unknown";
        const country=ev.country||"";
        const actual=ev.actual??"";
        const forecast=ev.forecast??"";
        const previous=ev.previous??"";
        const date=ev.date||"";
        const key=`${country}-${eventName}-${date}`;
        const analysis=eventAnalysis[key];
        const isAnalyzing=analyzingEvent===key;
        const hasActual=actual!=="";
        let beat=null;
        if(hasActual&&forecast){
          const a=parseFloat(String(actual).replace(/[^0-9.-]/g,"")),f=parseFloat(String(forecast).replace(/[^0-9.-]/g,""));
          if(!isNaN(a)&&!isNaN(f)) beat=a>f;
        }
        return(
          <div className="modal-overlay" onClick={()=>setSelectedEvent(null)}>
            <div className="modal-box" onClick={e=>e.stopPropagation()}>
              <div style={{ padding:"14px 16px", borderBottom:`1px solid ${BDR}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <div style={{ fontSize:7, color:impCfg(ev.impact).color, letterSpacing:2, marginBottom:2 }}>{impCfg(ev.impact).label} IMPACT · {country} · {ev.time||ev.date}</div>
                  <div style={{ fontSize:14, fontFamily:"'Space Grotesk',sans-serif", fontWeight:800, color:T1 }}>{eventName}</div>
                </div>
                <button onClick={()=>setSelectedEvent(null)} style={{ background:"none", border:"none", color:T3, fontSize:16, cursor:"pointer" }}>✕</button>
              </div>

              {/* Actual / Forecast / Previous big display */}
              <div style={{ padding:"14px 16px", borderBottom:`1px solid ${BDR}`, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                {[
                  ["ACTUAL", analysis?.actualValue||actual||"—", analysis?.actualValue||(beat===true?"#00ff9d":beat===false?"#ff4560":"#ffc107")],
                  ["FORECAST",forecast,"#4a8aa0"],
                  ["PREVIOUS",previous,T3],
                ].map(([label,val,color])=>(
                  <div key={label} style={{ background:"#04090e", padding:"10px", textAlign:"center", border:`1px solid ${label==="ACTUAL"&&hasActual?color+"44":BDR}` }}>
                    <div style={{ fontSize:7, color:T4, letterSpacing:2, marginBottom:4 }}>{label}</div>
                    <div style={{ fontSize:18, fontWeight:700, color, fontFamily:"'Space Grotesk',sans-serif" }}>
                      {String(val||"—")}
                    </div>
                    {label==="ACTUAL"&&beat===true&&<div style={{ fontSize:8, color:"#00ff9d", marginTop:2 }}>▲ BEAT FORECAST</div>}
                    {label==="ACTUAL"&&beat===false&&<div style={{ fontSize:8, color:"#ff4560", marginTop:2 }}>▼ MISSED FORECAST</div>}
                  </div>
                ))}
              </div>

              {/* Analysis section */}
              <div style={{ padding:"14px 16px" }}>
                {isAnalyzing&&(
                  <div style={{ textAlign:"center", padding:"20px", fontSize:9, color:"#00d4ff" }} className="pulse">
                    GEMINI ANALYSING EVENT...
                  </div>
                )}

                {!hasActual&&!isAnalyzing&&!analysis&&(
                  <div style={{ textAlign:"center", padding:"20px" }}>
                    <div style={{ fontSize:9, color:T3, marginBottom:12 }}>ACTUAL NOT IN FEED — GEMINI WILL SEARCH FOR IT</div>
                    <button className="scan-btn" onClick={()=>analyseEvent(selectedEvent)}
                      style={{ padding:"7px 18px", fontSize:9, letterSpacing:2, color:"#00d4ff", border:"1px solid #00d4ff44", background:"transparent" }}>
                      ⟳ SEARCH &amp; ANALYSE
                    </button>
                  </div>
                )}

                {hasActual&&!analysis&&!isAnalyzing&&(
                  <div style={{ textAlign:"center", padding:"20px" }}>
                    <button className="scan-btn" onClick={()=>analyseEvent(ev)}
                      style={{ padding:"8px 20px", fontSize:9, letterSpacing:2, color:"#00d4ff", border:"1px solid #00d4ff44", background:"transparent" }}>
                      ⟳ ANALYSE WITH GEMINI
                    </button>
                  </div>
                )}

                {analysis&&(
                  <div>
                    {/* Verdict banner */}
                    <div style={{ padding:"8px 12px", background:analysis.dollarImpact==="UP"?"rgba(0,255,157,0.08)":analysis.dollarImpact==="DOWN"?"rgba(255,69,96,0.08)":"rgba(255,193,7,0.08)", border:`1px solid ${analysis.dollarImpact==="UP"?"#00ff9d":analysis.dollarImpact==="DOWN"?"#ff4560":"#ffc107"}33`, marginBottom:12 }}>
                      <div style={{ fontSize:12, fontWeight:700, color:analysis.dollarImpact==="UP"?"#00ff9d":analysis.dollarImpact==="DOWN"?"#ff4560":"#ffc107", letterSpacing:2, marginBottom:4 }}>
                        {analysis.verdict} — USD {analysis.dollarImpact==="UP"?"STRENGTHENING ▲":analysis.dollarImpact==="DOWN"?"WEAKENING ▼":"NEUTRAL —"}
                      </div>
                      <div style={{ fontSize:10, color:T2, lineHeight:1.6 }}>{analysis.summary}</div>
                    </div>

                    {/* What it means */}
                    <div style={{ background:SRF, border:`1px solid ${BDR}`, padding:"10px", marginBottom:12 }}>
                      <div style={{ fontSize:7, color:"#4a8aa0", letterSpacing:3, marginBottom:6 }}>WHAT THIS MEANS FOR MARKETS</div>
                      <div style={{ fontSize:10, color:T2, lineHeight:1.75 }}>{analysis.meaning}</div>
                    </div>

                    {/* Your pairs */}
                    <div style={{ marginBottom:12 }}>
                      <div style={{ fontSize:7, color:"#00d4ff", letterSpacing:3, marginBottom:8 }}>YOUR INSTRUMENTS</div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
                        {MY_INSTRUMENTS.map(({pair,label,flag})=>{
                          const pi=analysis.pairImpacts?.[pair]; if(!pi) return null;
                          return(
                            <div key={pair} style={{ background:SRF2, border:`1px solid ${dirColor(pi.direction)}28`, padding:"7px 10px" }}>
                              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                                <span style={{ fontSize:9, color:T2, fontWeight:600 }}>{flag} {label}</span>
                                <span style={{ fontSize:11, fontWeight:700, color:dirColor(pi.direction) }}>{dirIcon(pi.direction)}</span>
                              </div>
                              <div style={{ fontSize:8, color:T2, lineHeight:1.4 }}>{pi.reason}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Trader note */}
                    <div style={{ padding:"9px 12px", background:"rgba(0,255,157,0.05)", border:"1px solid #00ff9d22" }}>
                      <div style={{ fontSize:7, color:"#00ff9d", letterSpacing:3, marginBottom:5 }}>⚡ TRADER NOTE</div>
                      <div style={{ fontSize:10, color:T1, lineHeight:1.6, fontWeight:500 }}>{analysis.traderNote}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
