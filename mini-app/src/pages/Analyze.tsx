import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ChevronDown, ChevronRight, Loader2, Search, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import {
  analyzeSymbol, getQuote, postManualTrade, searchSymbols,
  type AnalyzeResult, type ManualTradeResult, type SuggestedTrade,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMyRole } from "@/hooks/useMyRole";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ResultDetail {
  ta_score?: number;
  der_score?: number;
  ta_detail?: string[];
  der_detail?: string[];
  gate_block?: boolean;
  gate_reason?: string;
  veto_reason?: string;
}

function normalizeSymbol(v: string) { return v.trim().toUpperCase(); }

function globalScoreColor(s: number) {
  if (s >= 7.5) return "bg-emerald-500";
  if (s >= 6)   return "bg-blue-500";
  if (s >= 4)   return "bg-orange-500";
  return "bg-red-500";
}
function globalScoreLabel(s: number) {
  if (s >= 7.5) return "Fort";
  if (s >= 6)   return "Exploitable";
  if (s >= 4)   return "Incertain";
  return "Faible";
}

function buildRationale(signal: string, ta: number, der: number, taD: string[], derD: string[]): string {
  if (signal === "NO_TRADE") return "Pas de signal suffisant — conditions de marché insuffisantes.";
  const dir    = signal === "LONG" ? "haussière" : "baissière";
  const taStr  = `structure TA ${dir} (${ta.toFixed(1)}/5)`;
  const derStr = der >= 3 ? `dérivés confirmants (${der.toFixed(1)}/5)` : `dérivés défavorables (${der.toFixed(1)}/5)`;
  const kw     = [...taD.slice(0, 2), ...derD.slice(0, 1)].filter(Boolean).join(", ");
  return `Signal ${signal} : ${taStr}, ${derStr}${kw ? ` — ${kw}` : ""}.`;
}

function pillVariant(d: string): "success" | "destructive" | "secondary" {
  if (d.startsWith("+")) return "success";
  if (d.startsWith("-")) return "destructive";
  return "secondary";
}

function fmtPrice(p: number): string {
  if (p >= 10000) return p.toFixed(1);
  if (p >= 100)   return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}

function precStr(p: number): string {
  if (p >= 100) return "2";
  if (p >= 1)   return "4";
  return "6";
}

// ── Score progress bar ────────────────────────────────────────────────────────

function ScoreBar({ value, max, cls }: { value: number; max: number; cls: string }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted/30">
      <div className={`h-full rounded-full transition-all ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── SVG Price Level Chart ─────────────────────────────────────────────────────

function PriceLevelChart({ entry, sl, tp, side }: { entry: number; sl: number; tp: number; side: "LONG" | "SHORT" }) {
  const W = 260, H = 110, LX = 152, PAD = 10;
  const minP = Math.min(sl, tp) * 0.9985;
  const maxP = Math.max(sl, tp) * 1.0015;
  const range = maxP - minP || 1;
  const toY = (p: number) => PAD + ((maxP - p) / range) * (H - PAD * 2);

  const yEntry = toY(entry);
  const ySl    = toY(sl);
  const yTp    = toY(tp);

  const profitTop = Math.min(yEntry, yTp);
  const profitH   = Math.abs(yEntry - yTp);
  const lossTop   = Math.min(ySl, yEntry);
  const lossH     = Math.abs(ySl - yEntry);

  const isLong = side === "LONG";
  const slPct  = ((Math.abs(entry - sl)  / entry) * 100).toFixed(1);
  const tpPct  = ((Math.abs(tp - entry)  / entry) * 100).toFixed(1);
  const rr     = Math.abs(entry - sl) > 0
    ? (Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(1) : "—";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="xMidYMid meet">
      {/* Profit zone */}
      <rect x={0} y={profitTop} width={LX - 6} height={profitH}
        fill={isLong ? "#22c55e18" : "#ef444418"} />
      {/* Loss zone */}
      <rect x={0} y={lossTop} width={LX - 6} height={lossH}
        fill={isLong ? "#ef444418" : "#22c55e18"} />
      {/* TP */}
      <line x1={0} x2={LX - 6} y1={yTp} y2={yTp}
        stroke="#22c55e" strokeWidth={1.5} strokeDasharray="5 3" />
      {/* Entry */}
      <line x1={0} x2={LX - 6} y1={yEntry} y2={yEntry}
        stroke="#cbd5e1" strokeWidth={1.5} />
      {/* SL */}
      <line x1={0} x2={LX - 6} y1={ySl} y2={ySl}
        stroke="#ef4444" strokeWidth={1.5} strokeDasharray="5 3" />
      {/* Labels */}
      <text x={LX} y={yTp}    dominantBaseline="middle" fill="#22c55e" fontSize={8} fontFamily="monospace">
        TP {fmtPrice(tp)} +{tpPct}%
      </text>
      <text x={LX} y={yEntry} dominantBaseline="middle" fill="#cbd5e1" fontSize={8} fontFamily="monospace">
        Entry {fmtPrice(entry)}
      </text>
      <text x={LX} y={ySl}    dominantBaseline="middle" fill="#ef4444" fontSize={8} fontFamily="monospace">
        SL {fmtPrice(sl)} -{slPct}%
      </text>
      {/* R:R badge */}
      <rect x={W - 52} y={H / 2 - 11} width={50} height={22} rx={5}
        fill="#1e293b" stroke="#334155" strokeWidth={1} />
      <text x={W - 27} y={H / 2 + 5} dominantBaseline="middle" textAnchor="middle"
        fill="#94a3b8" fontSize={9} fontFamily="monospace">
        R:R {rr}
      </text>
    </svg>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Analyze(): JSX.Element {
  const { isOperator } = useMyRole();

  // ── Shared state ──────────────────────────────────────────────────────────
  const [symbol, setSymbol]         = useState("");
  const [result, setResult]         = useState<AnalyzeResult | null>(null);
  const [analyzeError, setErr]      = useState<string | null>(null);
  const [isAnalyzing, setAnalyzing] = useState(false);
  const [activeTab, setActiveTab]   = useState("quant");

  const sym = useMemo(() => normalizeSymbol(symbol), [symbol]);

  const { data: suggestions } = useSWR(
    sym.length >= 1 ? ["symbols", sym] : null,
    () => searchSymbols(sym),
    { keepPreviousData: true, dedupingInterval: 500 }
  );

  const runAnalysis = async () => {
    if (!sym) return;
    try {
      setAnalyzing(true); setErr(null); setResult(null);
      setResult(await analyzeSymbol(sym, 30000));
    } catch (e) {
      setErr(e instanceof DOMException && e.name === "AbortError"
        ? "Timeout — l'analyse a dépassé 30 secondes."
        : e instanceof Error ? e.message : "Erreur inconnue.");
    } finally { setAnalyzing(false); }
  };

  // ── Result detail extraction ──────────────────────────────────────────────
  const detail    = result?.result as ResultDetail | undefined;
  const taScore   = detail?.ta_score  ?? 0;
  const derScore  = detail?.der_score ?? 0;
  const taDetail  = Array.isArray(detail?.ta_detail)  ? (detail.ta_detail  as string[]) : [];
  const derDetail = Array.isArray(detail?.der_detail) ? (detail.der_detail as string[]) : [];
  const isBlocked = Boolean(detail?.gate_block || detail?.veto_reason);
  const globalScore = result?.total ?? 0;

  // ── Manual trade state ────────────────────────────────────────────────────
  const [manualSide, setSide]            = useState<"LONG" | "SHORT">("LONG");
  const [sizeUsdt, setSize]              = useState("50");
  const [leverage, setLev]               = useState("10");
  const [entryPrice, setEntry]           = useState("");
  const [slPrice, setSl]                 = useState("");
  const [tpPrice, setTp]                 = useState("");
  const [showNote, setShowNote]          = useState(false);
  const [note, setNote]                  = useState("");
  const [submitting, setSubmit]          = useState(false);
  const [tradeRes, setTradeRes]          = useState<ManualTradeResult | null>(null);
  const [suggestionApplied, setApplied]  = useState(false);
  const [priceDriftWarning, setDrift]    = useState(false);

  const suggestion: SuggestedTrade | null = result?.llm?.suggested_trade ?? null;
  const isContrarian = result?.llm?.decision === "CONTRARIAN_FLIP";

  // Reset suggestion tracking + pre-fill side when result changes
  // Also force-clear SL/TP so stale values don't persist across analyses
  useEffect(() => {
    setApplied(false);
    setDrift(false);
    setSl("");
    setTp("");
    if (result?.signal && result.signal !== "NO_TRADE" && !result.llm?.suggested_trade) {
      setSide(result.signal as "LONG" | "SHORT");
    }
  }, [result]);

  // Fetch live price when switching to manual tab OR when a new result arrives (to trigger suggestion)
  useEffect(() => {
    if (activeTab !== "manual" || !sym) return;
    setEntry(""); // clear first so effect re-fires even if price is the same
    let dead = false;
    (async () => {
      try {
        const q = await getQuote(sym);
        if (!dead && q.price) setEntry(String(q.price));
      } catch { /* ignore */ }
    })();
    return () => { dead = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, sym, result]);

  // Apply LLM suggestion once entry price is loaded
  useEffect(() => {
    if (activeTab !== "manual" || !suggestion || suggestionApplied) return;
    const livePrice = parseFloat(entryPrice);
    if (!Number.isFinite(livePrice) || livePrice <= 0) return;

    setSide(suggestion.side);
    setLev(String(suggestion.leverage));
    if (suggestion.note) { setNote(suggestion.note); setShowNote(true); }

    if (suggestion.reference_price) {
      const drift = Math.abs(livePrice - suggestion.reference_price) / suggestion.reference_price;
      if (drift > 0.005) {
        setDrift(true);
        setApplied(true);
        return; // side/lev/note applied but SL/TP skipped — price moved too much
      }
    }

    const p = parseInt(precStr(livePrice));
    if (suggestion.side === "LONG") {
      setSl((livePrice * (1 - suggestion.sl_pct / 100)).toFixed(p));
      setTp((livePrice * (1 + suggestion.tp_pct / 100)).toFixed(p));
    } else {
      setSl((livePrice * (1 + suggestion.sl_pct / 100)).toFixed(p));
      setTp((livePrice * (1 - suggestion.tp_pct / 100)).toFixed(p));
    }
    setApplied(true);
  }, [activeTab, suggestion, suggestionApplied, entryPrice]);

  // Computed values
  const entry = parseFloat(entryPrice);
  const sl    = parseFloat(slPrice);
  const tp    = parseFloat(tpPrice);
  const lev   = parseFloat(leverage) || 1;
  const size  = parseFloat(sizeUsdt) || 0;
  const ok_e  = Number.isFinite(entry) && entry > 0;
  const ok_sl = Number.isFinite(sl) && sl > 0;
  const ok_tp = Number.isFinite(tp) && tp > 0;
  const slTpOk = ok_e && ok_sl && ok_tp && (
    (manualSide === "LONG"  && sl < entry && tp > entry) ||
    (manualSide === "SHORT" && sl > entry && tp < entry)
  );
  const slPct  = ok_e && ok_sl ? ((Math.abs(entry - sl)  / entry) * 100).toFixed(2) : null;
  const tpPct  = ok_e && ok_tp ? ((Math.abs(tp - entry)  / entry) * 100).toFixed(2) : null;
  const rr     = slTpOk && entry !== sl
    ? (Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(1) : null;
  const estLoss = slPct && size ? (size * parseFloat(slPct) / 100).toFixed(2) : null;
  const estGain = tpPct && size ? (size * parseFloat(tpPct) / 100).toFixed(2) : null;

  const canSubmit = isOperator && ok_e && ok_sl && ok_tp && slTpOk
    && Number.isFinite(lev) && lev >= 1 && size > 0 && !submitting;

  // Quick SL/TP adjustment helpers
  const prec = ok_e ? precStr(entry) : "4";
  const adjSl = (pct: number) => {
    if (!ok_e) return;
    const p = manualSide === "LONG" ? entry * (1 - pct / 100) : entry * (1 + pct / 100);
    setSl(p.toFixed(parseInt(prec)));
  };
  const adjTp = (pct: number) => {
    if (!ok_e) return;
    const p = manualSide === "LONG" ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
    setTp(p.toFixed(parseInt(prec)));
  };

  const submitTrade = async () => {
    if (!canSubmit) return;
    setSubmit(true); setTradeRes(null);
    try {
      const res = await postManualTrade({
        symbol: sym, side: manualSide,
        size_usdt: size, leverage: lev,
        sl_price: sl, tp_price: tp,
        note: note.trim() || undefined,
      });
      setTradeRes(res);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(res.ok ? "success" : "error");
    } catch (e) {
      setTradeRes({ ok: false, message: e instanceof Error ? e.message : "Erreur inconnue." });
    } finally { setSubmit(false); }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 px-4 py-5">

      {/* ── Shared header ─────────────────────────────────────────────── */}
      <h1 className="text-xl font-semibold">Analyse</h1>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runAnalysis()}
          placeholder="BTCUSDT, ETHUSDT, SOLUSDT…"
          className="pl-9"
          list="symbols-ac"
          autoComplete="off"
        />
        <datalist id="symbols-ac">
          {suggestions?.map((s) => <option key={s} value={s} />)}
        </datalist>
      </div>

      <Button onClick={runAnalysis} disabled={!sym || isAnalyzing} className="w-full">
        {isAnalyzing
          ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          : <Sparkles className="mr-2 h-4 w-4" />}
        {isAnalyzing ? "Analyse en cours…" : "Analyser"}
      </Button>

      {analyzeError && (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
          {analyzeError}
        </div>
      )}

      {/* ── Inner tabs ────────────────────────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-full">
          <TabsTrigger value="quant"  className="flex-1">Quantitatif</TabsTrigger>
          <TabsTrigger value="manual" className="flex-1">Manuel</TabsTrigger>
        </TabsList>

        {/* ── Tab: Quantitatif ───────────────────────────────────────── */}
        <TabsContent value="quant" className="mt-4 space-y-3">
          {!result && !analyzeError && (
            <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              Entrez un symbole et cliquez sur Analyser.
            </div>
          )}

          {result && (
            <>
              {/* Verdict */}
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={result.signal === "LONG" ? "success" : result.signal === "SHORT" ? "destructive" : "secondary"}
                        className="px-3 py-0.5 text-sm"
                      >
                        {result.signal === "LONG" ? "▲ LONG" : result.signal === "SHORT" ? "▼ SHORT" : "— NO TRADE"}
                      </Badge>
                      <span className="text-xl font-bold">{globalScore.toFixed(1)}</span>
                      <span className="text-xs text-muted-foreground">/10 · {globalScoreLabel(globalScore)}</span>
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">{result.symbol}</span>
                  </div>
                  <ScoreBar value={globalScore} max={10} cls={globalScoreColor(globalScore)} />
                </CardContent>
              </Card>

              {/* Gate / Veto */}
              {detail?.gate_block && (
                <div className="rounded-xl border border-orange-900/60 bg-orange-950/30 px-3 py-2 text-xs text-orange-300">
                  ⛔ GATE bloqué — {String(detail.gate_reason ?? "")}
                </div>
              )}
              {detail?.veto_reason && (
                <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                  🚫 VETO DER — {String(detail.veto_reason)}
                </div>
              )}

              {/* TA card */}
              <Card>
                <CardContent className="pt-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <TrendingUp className="h-4 w-4 text-emerald-400" />
                      Analyse Technique
                    </div>
                    <span className="text-sm font-bold text-emerald-400">{taScore.toFixed(1)}/5</span>
                  </div>
                  <ScoreBar value={taScore} max={5} cls="bg-emerald-500" />
                  {taDetail.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {taDetail.map((d, i) => (
                        <Badge key={i} variant={pillVariant(d)} className="px-2 py-0.5 text-xs font-mono">{d}</Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* DER card */}
              <Card>
                <CardContent className="pt-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <TrendingDown className="h-4 w-4 text-sky-400" />
                      Dérivés & Funding
                    </div>
                    <span className="text-sm font-bold text-sky-400">{derScore.toFixed(1)}/5</span>
                  </div>
                  <ScoreBar value={derScore} max={5} cls="bg-sky-500" />
                  {derDetail.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {derDetail.map((d, i) => (
                        <Badge key={i} variant={pillVariant(d)} className="px-2 py-0.5 text-xs font-mono">{d}</Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Rationale */}
              <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Pourquoi {result.signal} ?
                </div>
                <p className="text-sm leading-5">
                  {buildRationale(result.signal, taScore, derScore, taDetail, derDetail)}
                </p>
              </div>

              {/* LLM decision */}
              {result.llm ? (
                <Card>
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Sparkles className="h-4 w-4 text-primary" />
                      Décision LLM
                    </div>
                    <Badge
                      variant={
                        result.llm.decision?.toLowerCase().includes("long")  ? "success"     :
                        result.llm.decision?.toLowerCase().includes("short") ? "destructive" : "secondary"
                      }
                      className="px-3"
                    >
                      {result.llm.decision}
                    </Badge>
                    {result.llm.reasoning && (
                      <p className="text-sm leading-5 text-muted-foreground">{result.llm.reasoning}</p>
                    )}
                    {result.llm.suggested_trade && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
                        <Sparkles className="h-3 w-3 text-primary" />
                        <span className="font-medium text-primary">Suggestion :</span>
                        <span className={result.llm.suggested_trade.side === "LONG" ? "text-emerald-400" : "text-red-400"}>
                          {result.llm.suggested_trade.side}
                        </span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-red-300">SL -{result.llm.suggested_trade.sl_pct}%</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-emerald-300">TP +{result.llm.suggested_trade.tp_pct}%</span>
                        <span className="text-muted-foreground">·</span>
                        <span>{result.llm.suggested_trade.leverage}x</span>
                        <button
                          onClick={() => setActiveTab("manual")}
                          className="ml-auto text-primary underline underline-offset-2"
                        >
                          Voir Manuel →
                        </button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ) : isBlocked ? (
                <Card className="border-orange-900/50 bg-orange-950/20">
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium text-orange-300">
                      <span>⛔</span>
                      LLM non consulté
                    </div>
                    <p className="text-xs text-muted-foreground leading-5">
                      {String(
                        detail?.gate_reason ?? detail?.veto_reason ?? "Conditions de marché défavorables — signal bloqué avant validation LLM."
                      )}
                    </p>
                    <button
                      onClick={() => setActiveTab("manual")}
                      className="text-xs text-primary underline underline-offset-2"
                    >
                      Trader manuellement malgré tout →
                    </button>
                  </CardContent>
                </Card>
              ) : null}
            </>
          )}
        </TabsContent>

        {/* ── Tab: Manuel ────────────────────────────────────────────── */}
        <TabsContent value="manual" className="mt-4 space-y-4">

          {/* SVG chart — visible only when SL/TP are valid */}
          {slTpOk && (
            <Card>
              <CardContent className="pt-3">
                <PriceLevelChart entry={entry} sl={sl} tp={tp} side={manualSide} />
                <div className="mt-2.5 grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-lg bg-red-950/30 px-2 py-1.5">
                    <div className="text-muted-foreground">Stop Loss</div>
                    <div className="font-semibold text-red-300">-{slPct}%</div>
                    {estLoss && <div className="text-muted-foreground/70">-{estLoss} $</div>}
                  </div>
                  <div className="rounded-lg bg-muted/20 px-2 py-1.5">
                    <div className="text-muted-foreground">R:R</div>
                    <div className="font-bold text-primary">1:{rr}</div>
                  </div>
                  <div className="rounded-lg bg-emerald-950/30 px-2 py-1.5">
                    <div className="text-muted-foreground">Take Profit</div>
                    <div className="font-semibold text-emerald-300">+{tpPct}%</div>
                    {estGain && <div className="text-muted-foreground/70">+{estGain} $</div>}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Form card */}
          <Card>
            <CardContent className="pt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Trade manuel{sym ? ` — ${sym}` : ""}</span>
                {suggestionApplied && !priceDriftWarning && (
                  <Badge variant="secondary" className="gap-1 border-primary/30 bg-primary/10 text-primary text-[10px]">
                    <Sparkles className="h-2.5 w-2.5" />Suggestion LLM
                  </Badge>
                )}
                {isContrarian && (
                  <Badge variant="secondary" className="border-orange-500/30 bg-orange-950/20 text-orange-300 text-[10px]">
                    ⚠️ Contrarienne
                  </Badge>
                )}
                {priceDriftWarning && (
                  <Badge variant="secondary" className="border-orange-500/30 bg-orange-950/20 text-orange-300 text-[10px]">
                    ⚠️ Prix décalé — SL/TP à recalculer
                  </Badge>
                )}
              </div>

              {/* Side */}
              <div>
                <div className="mb-1.5 text-xs text-muted-foreground">Direction</div>
                <div className="flex gap-2">
                  {(["LONG", "SHORT"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => { setSide(s); setSl(""); setTp(""); }}
                      className={`flex-1 rounded-lg border py-2.5 text-sm font-semibold transition-colors ${
                        manualSide === s
                          ? s === "LONG"
                            ? "border-emerald-600 bg-emerald-950/40 text-emerald-300"
                            : "border-red-600 bg-red-950/40 text-red-300"
                          : "border-border bg-muted/20 text-muted-foreground"
                      }`}
                    >
                      {s === "LONG" ? "▲ LONG" : "▼ SHORT"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Size + Leverage */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs text-muted-foreground">Marge (USDT)</label>
                  <Input
                    type="number" inputMode="decimal"
                    value={sizeUsdt} onChange={(e) => setSize(e.target.value)}
                    placeholder="50" className="text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs text-muted-foreground">
                    Levier
                    {size > 0 && lev >= 1 && (
                      <span className="ml-1 text-[10px] text-muted-foreground/60">
                        = {(size * lev).toFixed(0)} USDT
                      </span>
                    )}
                  </label>
                  <Input
                    type="number" inputMode="decimal"
                    value={leverage} onChange={(e) => setLev(e.target.value)}
                    placeholder="10" min="1" max="125" className="text-sm"
                  />
                </div>
              </div>

              {/* Entry price */}
              <div>
                <label className="mb-1.5 block text-xs text-muted-foreground">
                  Prix d'entrée (marché actuel)
                </label>
                <Input
                  type="number" inputMode="decimal"
                  value={entryPrice} onChange={(e) => setEntry(e.target.value)}
                  placeholder="Prix auto-chargé…" className="text-sm"
                />
              </div>

              {/* SL */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Stop Loss</label>
                  <div className="flex gap-1">
                    {[0.5, 1, 2].map((p) => (
                      <button key={p} onClick={() => adjSl(p)}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-red-800/60 hover:text-red-300"
                      >
                        -{p}%
                      </button>
                    ))}
                  </div>
                </div>
                <Input
                  type="number" inputMode="decimal"
                  value={slPrice} onChange={(e) => setSl(e.target.value)}
                  placeholder={manualSide === "LONG" ? "< prix entrée" : "> prix entrée"}
                  className={`text-sm ${ok_e && ok_sl && !slTpOk ? "border-red-800/60" : ""}`}
                />
              </div>

              {/* TP */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Take Profit</label>
                  <div className="flex gap-1">
                    {[1, 2, 3].map((p) => (
                      <button key={p} onClick={() => adjTp(p)}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-emerald-800/60 hover:text-emerald-300"
                      >
                        +{p}%
                      </button>
                    ))}
                  </div>
                </div>
                <Input
                  type="number" inputMode="decimal"
                  value={tpPrice} onChange={(e) => setTp(e.target.value)}
                  placeholder={manualSide === "LONG" ? "> prix entrée" : "< prix entrée"}
                  className={`text-sm ${ok_e && ok_tp && !slTpOk ? "border-red-800/60" : ""}`}
                />
              </div>

              {/* Note optionnelle */}
              <div>
                <button
                  onClick={() => setShowNote(!showNote)}
                  className="flex items-center gap-1 text-xs text-muted-foreground"
                >
                  {showNote
                    ? <ChevronDown className="h-3 w-3" />
                    : <ChevronRight className="h-3 w-3" />}
                  {showNote ? "Masquer la note" : "+ Ajouter une note"}
                </button>
                {showNote && (
                  <textarea
                    value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="Raison du trade, observations…"
                    rows={3}
                    className="mt-2 w-full resize-none rounded-lg border border-border bg-muted/20 p-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                )}
              </div>

              {/* Info: bot management style */}
              <p className="text-[11px] leading-4 text-muted-foreground/70">
                Le bot ferme 50% de la position au TP, puis gère le reste avec un trailing stop.
                {!isOperator && " Rôle OPERATOR requis."}
              </p>

              {/* Trade result feedback */}
              {tradeRes && (
                <div className={`rounded-xl border p-3 text-sm ${
                  tradeRes.ok
                    ? "border-emerald-900/60 bg-emerald-950/30 text-emerald-200"
                    : "border-red-900/60 bg-red-950/30 text-red-200"
                }`}>
                  {tradeRes.ok ? "✅ " : "❌ "}
                  {tradeRes.message ?? (tradeRes.ok ? "Trade ouvert." : "Erreur inconnue.")}
                </div>
              )}

              {/* Submit */}
              <Button
                onClick={submitTrade}
                disabled={!canSubmit}
                className={`w-full font-semibold ${
                  manualSide === "LONG"
                    ? "border-0 bg-emerald-700 text-white hover:bg-emerald-600"
                    : "border-0 bg-red-700 text-white hover:bg-red-600"
                }`}
              >
                {submitting
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : manualSide === "LONG"
                    ? <TrendingUp className="mr-2 h-4 w-4" />
                    : <TrendingDown className="mr-2 h-4 w-4" />}
                {submitting
                  ? "Envoi en cours…"
                  : `Placer ${manualSide}${sym ? ` ${sym}` : ""}`}
              </Button>

            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
