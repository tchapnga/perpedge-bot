import { useRef, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, BarChart2, Pause, Play, RefreshCw, ShieldAlert, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type Command, type EquityPoint, type NetworkEnv, type PositionWithType,
  getEquity, getNetwork, getPositions, getRisk, getStatus, postCommand, switchNetwork,
} from "@/lib/api";
import { useMyRole } from "@/hooks/useMyRole";

function fmtPrice(v: number): string {
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v >= 1000)   return v.toFixed(2);
  if (v >= 1)      return v.toFixed(4);
  if (v >= 0.0001) return v.toFixed(6);
  return v.toPrecision(4);
}

// ── Heartbeat dot — triple-ring pulse ────────────────────────────────────────
function HeartbeatDot({ lastCycleAt }: { lastCycleAt?: string | null }): JSX.Element {
  const ghost = (
    <span className="relative inline-flex h-4 w-4 items-center justify-center">
      <span className="inline-block h-2 w-2 rounded-full bg-zinc-600" />
    </span>
  );
  if (!lastCycleAt) return ghost;
  const ts = Date.parse(lastCycleAt);
  if (isNaN(ts)) return ghost;
  const age = Date.now() - ts;
  const alive = age < 30_000;
  const warn  = age < 180_000;
  const dot  = alive ? "bg-emerald-400"   : warn ? "bg-orange-400"   : "bg-red-500";
  const ring = alive ? "bg-emerald-400/20" : warn ? "bg-orange-400/20" : "bg-red-500/20";
  return (
    <span title={lastCycleAt} className="relative inline-flex h-4 w-4 items-center justify-center">
      {alive && (
        <>
          <span className={`absolute h-4 w-4 rounded-full ${ring} animate-ping`} />
          <span
            className={`absolute h-3 w-3 rounded-full ${ring} animate-ping`}
            style={{ animationDelay: "0.35s", animationDuration: "1.4s" }}
          />
        </>
      )}
      <span className={`relative h-2 w-2 rounded-full ${dot}`} />
    </span>
  );
}

// ── Emergency Stop swipe — glowing red ───────────────────────────────────────
function SwipeConfirmButton({ onConfirm, disabled = false }: {
  onConfirm: () => void;
  disabled?: boolean;
}): JSX.Element {
  const [progress, setProgress] = useState(0);
  const trackRef    = useRef<HTMLDivElement>(null);
  const dragging    = useRef(false);
  const startX      = useRef(0);
  const progressRef = useRef(0);

  const cancelDrag = () => { dragging.current = false; setProgress(0); progressRef.current = 0; };

  const onTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !trackRef.current) return;
    const trackW = Math.max(trackRef.current.offsetWidth - 56, 1);
    const p = Math.max(0, Math.min(1, (e.clientX - startX.current) / trackW));
    progressRef.current = p;
    setProgress(p);
  };

  const onTrackPointerUp = () => {
    if (!dragging.current) return;
    const p = progressRef.current;
    cancelDrag();
    if (p >= 0.9) {
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("warning");
      onConfirm();
    }
  };

  const onThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    dragging.current    = true;
    startX.current      = e.clientX;
    progressRef.current = 0;
    e.preventDefault();
  };

  const glowing = progress > 0.5;

  return (
    <div
      ref={trackRef}
      className={`relative h-12 select-none overflow-hidden rounded-full border transition-all duration-200 ${
        disabled
          ? "border-zinc-800/60 bg-zinc-900/30 opacity-50"
          : glowing
            ? "border-red-600/80 bg-red-950/60 shadow-[0_0_24px_rgba(239,68,68,0.35)]"
            : "border-red-900/60 bg-red-950/40"
      }`}
      style={{ touchAction: "none" }}
      onPointerMove={onTrackPointerMove}
      onPointerUp={onTrackPointerUp}
      onPointerCancel={cancelDrag}
      onPointerLeave={cancelDrag}
    >
      {/* Fill */}
      <div
        className="absolute inset-y-0 left-0 bg-red-700/20 transition-[width]"
        style={{ width: `calc(28px + ${progress} * (100% - 28px))` }}
      />
      {/* Glow streak */}
      {glowing && (
        <div
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-transparent via-red-500/25 to-transparent"
          style={{ width: `calc(28px + ${progress} * (100% - 28px))` }}
        />
      )}
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-semibold tracking-wide text-red-300/80">
        {progress >= 0.9 ? "✓ Relâcher pour confirmer" : "← Glisser → Emergency Stop"}
      </span>
      <div
        className={`absolute top-1 flex h-10 w-10 cursor-grab items-center justify-center rounded-full shadow-lg active:cursor-grabbing transition-all duration-150 ${
          glowing
            ? "bg-red-500 shadow-[0_0_18px_rgba(239,68,68,0.65)]"
            : "bg-red-600"
        }`}
        style={{ left: `calc(4px + ${progress} * (100% - 56px))` }}
        onPointerDown={onThumbPointerDown}
      >
        <ShieldAlert className="h-5 w-5 text-white" />
      </div>
    </div>
  );
}

// ── Equity Sparkline — gradient fill + hover crosshair + tooltip ──────────────
function EquitySparkline({ series }: { series: EquityPoint[] }): JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (series.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
        Aucun trade clôturé
      </div>
    );
  }
  const W = 400, H = 64, PAD = 6;
  const values  = series.map(p => p.cumPnl);
  const min     = Math.min(...values, 0);
  const max     = Math.max(...values, 0.01);
  const range   = max - min || 1;
  const toX     = (i: number) => series.length > 1 ? (i / (series.length - 1)) * W : W / 2;
  const toY     = (v: number) => H - PAD - ((v - min) / range) * (H - PAD * 2);
  const linePts = series.map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.cumPnl).toFixed(1)}`).join(" ");
  const zeroY   = toY(0);
  const fillPts = `${linePts} L ${toX(series.length - 1).toFixed(1)} ${zeroY.toFixed(1)} L 0 ${zeroY.toFixed(1)} Z`;
  const last    = values[values.length - 1] ?? 0;
  const color   = last >= 0 ? "#22c55e" : "#ef4444";
  const gradId  = `spark-grad-${last >= 0 ? "pos" : "neg"}`;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || series.length < 2) return;
    const x   = (e.clientX - rect.left) / rect.width * W;
    const idx = Math.max(0, Math.min(series.length - 1, Math.round(x / W * (series.length - 1))));
    setHoverIdx(idx);
  };

  const hoveredVal = hoverIdx !== null ? (values[hoverIdx] ?? null) : null;
  const pctLeft    = hoverIdx !== null ? `${(toX(hoverIdx) / W * 100).toFixed(1)}%` : "0%";

  return (
    <div className="space-y-2">
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-16 w-full cursor-crosshair"
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={fillPts} fill={`url(#${gradId})`} />
          <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#ffffff18" strokeWidth={1} strokeDasharray="4 3" />
          <path d={linePts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hoverIdx !== null && (
            <>
              <line
                x1={toX(hoverIdx)} y1={PAD} x2={toX(hoverIdx)} y2={H - PAD}
                stroke="#ffffff35" strokeWidth={1} strokeDasharray="3 2"
              />
              <circle
                cx={toX(hoverIdx)} cy={toY(values[hoverIdx] ?? 0)}
                r={3.5} fill={color} stroke="#0d1117" strokeWidth={1.5}
              />
            </>
          )}
        </svg>
        {/* Hover tooltip */}
        {hoverIdx !== null && hoveredVal !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border/60 bg-card/95 px-2 py-1 text-xs shadow-lg backdrop-blur-sm"
            style={{ left: pctLeft, transform: "translateX(-50%) translateY(-6px)" }}
          >
            <span className={hoveredVal >= 0 ? "font-semibold text-emerald-400" : "font-semibold text-red-400"}>
              {hoveredVal >= 0 ? "+" : ""}{(hoveredVal as number).toFixed(2)} USDT
            </span>
            <span className="ml-1.5 text-muted-foreground">{series[hoverIdx ?? 0]?.date}</span>
          </div>
        )}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{series[0]?.date}</span>
        <span className={last >= 0 ? "font-semibold text-emerald-400" : "font-semibold text-red-400"}>
          {last >= 0 ? "+" : ""}{last.toFixed(2)} USDT
        </span>
        <span>{series[series.length - 1]?.date}</span>
      </div>
    </div>
  );
}

// ── Position card — colored accent + PnL micro-bar ───────────────────────────
function PositionCard({ pos }: { pos: PositionWithType }): JSX.Element {
  const pnl    = pos.unrealizedPnl ?? 0;
  const isLong = pos.side === "LONG";
  const pnlPos = pnl >= 0;
  const pnlPct = Math.min(Math.abs(pnl) / 50 * 100, 100); // visualize up to ±50 USDT

  return (
    <div className={`relative overflow-hidden rounded-xl border bg-card/60 p-3 backdrop-blur-sm ${
      isLong ? "border-emerald-900/50" : "border-red-900/50"
    }`}>
      {/* Left accent bar */}
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${isLong ? "bg-emerald-400" : "bg-red-400"}`} />
      {/* Radial tint */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{ background: `radial-gradient(ellipse at 0% 50%, ${isLong ? "#34d399" : "#f87171"} 0%, transparent 65%)` }}
      />

      <div className="relative pl-1">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tracking-tight">{pos.symbol}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold border ${
              pos.type === "PERP"
                ? "bg-blue-900/50 text-blue-300 border-blue-700/30"
                : "bg-amber-900/40 text-amber-300 border-amber-700/30"
            }`}>
              {pos.type}
            </span>
          </div>
          <Badge variant={isLong ? "success" : "destructive"} className="text-xs font-bold">
            {pos.side}
          </Badge>
        </div>

        <div className="grid grid-cols-3 gap-x-2 text-xs mb-2.5">
          <div>
            <div className="mb-0.5 text-muted-foreground">Entrée</div>
            <div className="font-semibold tabular-nums">${fmtPrice(pos.entry)}</div>
          </div>
          <div>
            <div className="mb-0.5 text-muted-foreground">Mark</div>
            <div className="font-semibold tabular-nums">
              {pos.markPrice != null ? `$${fmtPrice(pos.markPrice)}` : "—"}
            </div>
          </div>
          <div>
            <div className="mb-0.5 text-muted-foreground">PnL</div>
            <div className={`text-sm font-bold tabular-nums ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>
              {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}$
            </div>
          </div>
        </div>

        {/* PnL micro-bar */}
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full rounded-full transition-all duration-500 ${pnlPos ? "bg-emerald-400/70" : "bg-red-400/70"}`}
            style={{ width: `${pnlPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Stat card — glassmorphism ─────────────────────────────────────────────────
interface StatCardProps { label: string; value: string; helper?: string; danger?: boolean }
function StatCard({ label, value, helper, danger = false }: StatCardProps): JSX.Element {
  return (
    <div className={`relative overflow-hidden rounded-xl border p-3 backdrop-blur-sm ${
      danger ? "border-red-900/60 bg-red-950/20" : "border-white/[0.08] bg-white/[0.03]"
    }`}>
      {!danger && (
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent" />
      )}
      <div className="relative">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-lg font-bold leading-tight tabular-nums ${danger ? "text-red-300" : ""}`}>{value}</div>
        {helper && <div className="mt-0.5 text-xs text-muted-foreground">{helper}</div>}
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default function Dashboard(): JSX.Element {
  const [commandLoading, setCommandLoading] = useState<Command | null>(null);
  const [commandError, setCommandError]     = useState<string | null>(null);
  const [networkConfirm, setNetworkConfirm] = useState(false);
  const [networkSwitching, setNetworkSwitching] = useState(false);
  const { isOperator } = useMyRole();

  const { data: status,    mutate: mutateStatus    } = useSWR("status",              getStatus,    { refreshInterval: 5_000  });
  const { data: positions, mutate: mutatePositions  } = useSWR("positionsWithType",  getPositions, { refreshInterval: 5_000  });
  const { data: risk                               } = useSWR("/admin/risk",         getRisk,      { refreshInterval: 30_000 });
  const { data: equity                             } = useSWR("equity",              getEquity,    { refreshInterval: 60_000 });
  const { data: network, mutate: mutateNetwork, isValidating: networkLoading } =
    useSWR("network", getNetwork, { refreshInterval: 0, revalidateOnFocus: false });

  const executeCommand = async (cmd: Command): Promise<void> => {
    setCommandError(null);
    try {
      setCommandLoading(cmd);
      if (cmd !== "EMERGENCY_STOP") {
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
      }
      await postCommand(cmd);
    } catch (err) {
      setCommandError(err instanceof Error ? err.message : "Erreur de commande.");
    } finally {
      setCommandLoading(null);
      await Promise.all([mutateStatus(), mutatePositions()]).catch(() => undefined);
    }
  };

  const pauseLevel = status?.pauseLevel ?? (status?.isPaused ? "entries" : "none");
  const isEmerg    = status?.emergencyStopped ?? false;
  const isPaused   = pauseLevel !== "none";
  const busy       = commandLoading !== null;
  const profWarn   = status?.tradeProfile === "aggressive";

  return (
    <div className="space-y-4 px-4 py-5">

      {/* ── Header ─────────────────────────────────────── */}
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <HeartbeatDot lastCycleAt={status?.lastCycleAt} />
          <h1 className="text-xl font-bold tracking-tight">Dashboard</h1>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={status?.mode === "LIVE" ? "default" : "secondary"} className="text-xs font-semibold">
            {status?.mode ?? "…"}
          </Badge>
          <Badge
            variant={isEmerg ? "destructive" : isPaused ? "secondary" : "success"}
            className={`text-xs font-semibold ${
              !isEmerg && pauseLevel === "all"
                ? "border border-orange-500/60 bg-orange-950/30 text-orange-300"
                : ""
            }`}
          >
            {isEmerg
              ? "EMERGENCY STOP"
              : pauseLevel === "all"
                ? "PAUSED ALL"
                : pauseLevel === "entries"
                  ? "PAUSED ENTRIES"
                  : "RUNNING"}
          </Badge>
          {status?.tradeProfile && (
            <Badge
              variant="secondary"
              className={`text-xs font-semibold ${profWarn ? "border border-orange-500/60 bg-orange-950/30 text-orange-300" : ""}`}
            >
              {status.tradeProfile}{profWarn ? " ⚠" : ""}
            </Badge>
          )}
          {network ? (
            <button
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold leading-none transition-opacity ${
                network.network === "TESTNET"
                  ? "border-orange-500/60 bg-orange-950/40 text-orange-300"
                  : "border-emerald-700/60 bg-emerald-950/30 text-emerald-400"
              } ${(networkLoading || networkSwitching) ? "opacity-50 cursor-not-allowed" : "hover:opacity-75 cursor-pointer"}`}
              onClick={() => { if (!networkSwitching && !networkLoading) setNetworkConfirm(true); }}
              title="Cliquer pour changer le réseau"
            >
              {(networkLoading || networkSwitching) ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : null}
              {network.network === "TESTNET" ? "TESTNET" : "MAINNET · REAL FUNDS"}
            </button>
          ) : (
            <button
              className="inline-flex items-center gap-1 rounded-full border border-zinc-700/60 bg-zinc-900/40 px-2 py-0.5 text-[10px] font-semibold leading-none text-zinc-500 hover:opacity-75"
              onClick={() => mutateNetwork()}
              title="Cliquer pour rafraîchir"
            >
              {networkLoading ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : null}
              NETWORK ?
            </button>
          )}
        </div>
      </header>

      {/* ── Network switch confirmation ─────────────────── */}
      {networkConfirm && network && (() => {
        const target: NetworkEnv = network.network === "TESTNET" ? "MAINNET" : "TESTNET";
        const isToLive = target === "MAINNET";
        return (
          <div className="rounded-xl border border-orange-500/60 bg-orange-950/30 px-4 py-4 space-y-3">
            <div className="text-sm font-semibold text-orange-200">
              {isToLive ? "⚠️ Passer en MAINNET — FONDS RÉELS" : "↩️ Repasser en TESTNET"}
            </div>
            <p className="text-sm text-muted-foreground">
              {isToLive
                ? <span>Le bot basculera sur <b>Binance MAINNET</b>. Les ordres suivants utiliseront du <b>capital réel</b>. Le process sera redémarré.</span>
                : <span>Le bot repassera en <b>Binance Testnet</b>. Aucun capital réel ne sera utilisé.</span>
              }
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setNetworkConfirm(false)}>Annuler</Button>
              <Button
                size="sm"
                className={isToLive ? "bg-orange-600 hover:bg-orange-700 text-white" : ""}
                onClick={async () => {
                  setNetworkConfirm(false);
                  setNetworkSwitching(true);
                  try {
                    await switchNetwork(target);
                    await mutateNetwork();
                  } catch (err) {
                    setCommandError(err instanceof Error ? err.message : "Erreur changement réseau");
                  } finally {
                    setNetworkSwitching(false);
                  }
                }}
              >
                {isToLive ? "Confirmer MAINNET" : "Confirmer TESTNET"}
              </Button>
            </div>
          </div>
        );
      })()}

      {/* ── Alert banner ───────────────────────────────── */}
      {(isEmerg || isPaused) && (
        <div className={`rounded-xl border p-3 text-sm ${
          isEmerg
            ? "border-red-900/60 bg-red-950/40 text-red-200"
            : "border-orange-900/60 bg-orange-950/30 text-orange-200"
        }`}>
          <AlertTriangle className="mr-1.5 inline h-4 w-4" />
          {isEmerg
            ? "EMERGENCY STOP actif — toutes les entrées bloquées."
            : "Bot en pause — aucune nouvelle entrée."}
        </div>
      )}

      {/* ── Quick actions ──────────────────────────────── */}
      {isOperator && (
        <section className="space-y-2">
          {commandError && (
            <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-2.5 text-xs text-red-200">
              {commandError}
            </div>
          )}
          {isEmerg ? (
            <Button variant="secondary" className="w-full" onClick={() => executeCommand("RESET_EMERGENCY")} disabled={busy}>
              <ShieldAlert className="mr-2 h-4 w-4" />
              {commandLoading === "RESET_EMERGENCY" ? "Réinitialisation…" : "Reset Emergency Stop"}
            </Button>
          ) : (
            <>
              <div className="flex gap-2">
                {isPaused ? (
                  <Button className="flex-1" onClick={() => executeCommand("RESUME")} disabled={busy}>
                    <Play className="mr-1.5 h-4 w-4" />
                    {commandLoading === "RESUME" ? "…" : "Reprendre"}
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onClick={() => executeCommand("PAUSE_NEW_ENTRIES")}
                      disabled={busy}
                    >
                      <Pause className="mr-1.5 h-4 w-4" />
                      {commandLoading === "PAUSE_NEW_ENTRIES" ? "…" : "Pause Entrées"}
                    </Button>
                    <Button
                      variant="secondary"
                      className="flex-1 border-orange-700/60 text-orange-300 hover:bg-orange-950/30"
                      onClick={() => executeCommand("PAUSE_ALL")}
                      disabled={busy}
                    >
                      <Pause className="mr-1.5 h-4 w-4" />
                      {commandLoading === "PAUSE_ALL" ? "…" : "Pause Tout"}
                    </Button>
                  </>
                )}
              </div>
              <SwipeConfirmButton onConfirm={() => executeCommand("EMERGENCY_STOP")} disabled={busy} />
            </>
          )}
        </section>
      )}

      {/* ── Stats grid ─────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-2.5">
        <StatCard label="Positions" value={String(status?.openPositions ?? positions?.length ?? "—")} />
        <StatCard
          label="PnL latent"
          value={risk?.unrealizedPnl !== undefined
            ? `${risk.unrealizedPnl >= 0 ? "+" : ""}${risk.unrealizedPnl.toFixed(2)} $`
            : "+0.00 $"}
          danger={(risk?.unrealizedPnl ?? 0) < 0}
        />
        <StatCard label="Signaux" value={String(status?.signalsToday ?? "—")} helper="aujourd'hui" />
        <StatCard label="Cycles"  value={String(status?.cycleCount   ?? "—")} />
      </section>

      {/* ── Last signal ────────────────────────────────── */}
      {status?.lastSignal && (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 backdrop-blur-sm">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Target className="h-3 w-3 text-primary" />
            Dernier signal
          </div>
          <div className="flex items-center justify-between text-sm">
            <div>
              <span className="font-bold">{status.lastSignal.symbol}</span>
              <span className="ml-2 text-xs text-muted-foreground">{status.lastSignal.time}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  status.lastSignal.signal === "LONG"  ? "success"     :
                  status.lastSignal.signal === "SHORT" ? "destructive" : "secondary"
                }
                className="text-xs font-bold"
              >
                {status.lastSignal.signal}
              </Badge>
              <span className="text-xs font-semibold text-muted-foreground">{status.lastSignal.total}/10</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Risk snapshot ──────────────────────────────── */}
      {risk && (
        <div className="grid grid-cols-3 gap-2 text-center">
          {(
            [
              { label: "Exposition", value: `${risk.totalExposure.toFixed(0)} $`, danger: false },
              { label: "Marge",      value: `${risk.totalMargin.toFixed(0)} $`,   danger: false },
              {
                label:  "Win rate",
                value:  risk.winRate !== null ? `${risk.winRate.toFixed(0)}%` : "—",
                danger: (risk.winRate ?? 100) < 40,
              },
            ] as { label: string; value: string; danger: boolean }[]
          ).map(({ label, value, danger }) => (
            <div
              key={label}
              className={`rounded-xl border p-2 backdrop-blur-sm ${
                danger ? "border-red-900/60 bg-red-950/20" : "border-white/[0.08] bg-white/[0.03]"
              }`}
            >
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className={`text-sm font-bold ${danger ? "text-red-400" : ""}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Equity sparkline ───────────────────────────── */}
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 backdrop-blur-sm">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <BarChart2 className="h-3 w-3 text-primary" />
          Equity Curve
        </div>
        <EquitySparkline series={equity?.series ?? []} />
      </div>

      {/* ── Positions ──────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Positions actives
          </h2>
          {!!positions?.length && (
            <span className="text-xs text-muted-foreground">{positions.length} ouverte(s)</span>
          )}
        </div>
        {positions?.length ? (
          positions.map((p, i) => (
            <PositionCard key={`${p.symbol}-${p.type}-${i}`} pos={p} />
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-border/40 py-6 text-center text-sm text-muted-foreground">
            Aucune position active.
          </div>
        )}
      </section>

      {/* ── Modules ────────────────────────────────────── */}
      {status?.modules && Object.keys(status.modules).length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Modules</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(status.modules).map(([name, enabled]) => (
              <span
                key={name}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                  enabled
                    ? "border-emerald-700/60 bg-emerald-950/30 text-emerald-300"
                    : "border-border bg-muted/30 text-muted-foreground line-through"
                }`}
              >
                {name}
              </span>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}
