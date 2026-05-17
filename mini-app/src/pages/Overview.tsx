import { useRef, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, BarChart2, Pause, Play, RefreshCw, ShieldAlert, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type Command, type EquityPoint, type PositionWithType,
  getEquity, getNetwork, getPositions, getRisk, getStatus, postCommand,
} from "@/lib/api";
import { useMyRole } from "@/hooks/useMyRole";

function fmtPrice(v: number): string {
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v >= 1000)   return v.toFixed(2);
  if (v >= 1)      return v.toFixed(4);
  if (v >= 0.0001) return v.toFixed(6);
  return v.toPrecision(4);
}

// ── Heartbeat dot ─────────────────────────────────────────────────────────────
function HeartbeatDot({ lastCycleAt }: { lastCycleAt?: string | null }): JSX.Element {
  if (!lastCycleAt) return <span className="inline-block h-2 w-2 rounded-full bg-zinc-500" />;
  const ts    = Date.parse(lastCycleAt);
  if (isNaN(ts)) return <span className="inline-block h-2 w-2 rounded-full bg-zinc-500" />;
  const ageMs = Date.now() - ts;
  const cls   = ageMs < 30_000  ? "bg-emerald-400 animate-pulse"
              : ageMs < 180_000 ? "bg-orange-400"
              : "bg-red-500";
  return <span title={lastCycleAt} className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}

// ── Swipe-to-confirm Emergency Stop ──────────────────────────────────────────
function SwipeConfirmButton({
  onConfirm,
  disabled = false,
}: {
  onConfirm: () => void;
  disabled?: boolean;
}): JSX.Element {
  const [progress, setProgress] = useState(0);
  const trackRef  = useRef<HTMLDivElement>(null);
  const dragging  = useRef(false);
  const startX    = useRef(0);
  const progressRef = useRef(0);

  const cancelDrag = () => { dragging.current = false; setProgress(0); progressRef.current = 0; };

  // Handlers on TRACK so they fire even when finger outruns the thumb
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
    cancelDrag(); // clear flag BEFORE calling onConfirm to prevent double-trigger
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

  return (
    <div
      ref={trackRef}
      className={`relative h-12 select-none overflow-hidden rounded-full border ${
        disabled
          ? "border-zinc-800/60 bg-zinc-900/30 opacity-50"
          : "border-red-900/60 bg-red-950/40"
      }`}
      style={{ touchAction: "none" }}
      onPointerMove={onTrackPointerMove}
      onPointerUp={onTrackPointerUp}
      onPointerCancel={cancelDrag}
      onPointerLeave={cancelDrag}
    >
      <div
        className="absolute inset-y-0 left-0 bg-red-700/30"
        style={{ width: `calc(28px + ${progress} * (100% - 28px))` }}
      />
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-medium text-red-300/80">
        {progress >= 0.9 ? "✓ Relâcher pour confirmer" : "← Glisser → Emergency Stop"}
      </span>
      <div
        className="absolute top-1 flex h-10 w-10 cursor-grab items-center justify-center rounded-full bg-red-500 shadow-md active:cursor-grabbing"
        style={{ left: `calc(4px + ${progress} * (100% - 56px))` }}
        onPointerDown={onThumbPointerDown}
      >
        <ShieldAlert className="h-5 w-5 text-white" />
      </div>
    </div>
  );
}

// ── Equity Sparkline ─────────────────────────────────────────────────────────
function EquitySparkline({ series }: { series: EquityPoint[] }): JSX.Element {
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
  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" preserveAspectRatio="none">
        <path d={fillPts} fill={color} fillOpacity={0.12} />
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#ffffff30" strokeWidth={1} strokeDasharray="4 3" />
        <path d={linePts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
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

// ── Position card (PERP / SCALP typed) ───────────────────────────────────────
function PositionCard({ pos }: { pos: PositionWithType }): JSX.Element {
  const pnl    = pos.unrealizedPnl ?? 0;
  const pnlCls = pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-red-400" : "text-muted-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{pos.symbol}</span>
          <span className={`rounded px-1 py-0.5 text-[10px] font-bold ${
            pos.type === "PERP"
              ? "bg-blue-900/50 text-blue-300"
              : "bg-amber-900/40 text-amber-300"
          }`}>
            {pos.type}
          </span>
        </div>
        <Badge variant={pos.side === "LONG" ? "success" : "destructive"} className="text-xs">
          {pos.side}
        </Badge>
      </div>
      <div className="grid grid-cols-3 gap-x-2 text-xs">
        <div>
          <div className="text-muted-foreground">Entrée</div>
          <div className="font-medium tabular-nums">${fmtPrice(pos.entry)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Mark</div>
          <div className="font-medium tabular-nums">
            {pos.markPrice != null ? `$${fmtPrice(pos.markPrice)}` : "—"}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">PnL</div>
          <div className={`font-semibold tabular-nums ${pnlCls}`}>
            {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} $
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Compact stat card ─────────────────────────────────────────────────────────
interface StatCardProps { label: string; value: string; helper?: string; danger?: boolean }
function StatCard({ label, value, helper, danger = false }: StatCardProps): JSX.Element {
  return (
    <div className={`rounded-xl border p-3 ${danger ? "border-red-900/60 bg-red-950/20" : "border-border bg-card"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold leading-tight ${danger ? "text-red-300" : ""}`}>{value}</div>
      {helper && <div className="mt-0.5 text-xs text-muted-foreground">{helper}</div>}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default function Dashboard(): JSX.Element {
  const [commandLoading, setCommandLoading] = useState<Command | null>(null);
  const [commandError, setCommandError]     = useState<string | null>(null);
  const { isOperator } = useMyRole();

  const { data: status,    mutate: mutateStatus    } = useSWR("status",     getStatus,    { refreshInterval: 5_000  });
  const { data: positions, mutate: mutatePositions  } = useSWR("positionsWithType", getPositions, { refreshInterval: 5_000  });
  const { data: risk                               } = useSWR("/admin/risk", getRisk,      { refreshInterval: 30_000 });
  const { data: equity                             } = useSWR("equity",      getEquity,    { refreshInterval: 60_000 });
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
          <h1 className="text-xl font-semibold">Dashboard</h1>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={status?.mode === "LIVE" ? "default" : "secondary"} className="text-xs">
            {status?.mode ?? "…"}
          </Badge>
          <Badge
            variant={isEmerg ? "destructive" : isPaused ? "secondary" : "success"}
            className={`text-xs ${
              !isEmerg && pauseLevel === "all" ? "border border-orange-500/60 bg-orange-950/30 text-orange-300" : ""
            }`}
          >
            {isEmerg ? "EMERGENCY STOP" : pauseLevel === "all" ? "PAUSED ALL" : pauseLevel === "entries" ? "PAUSED ENTRIES" : "RUNNING"}
          </Badge>
          {status?.tradeProfile && (
            <Badge
              variant="secondary"
              className={`text-xs ${profWarn ? "border border-orange-500/60 bg-orange-950/30 text-orange-300" : ""}`}
            >
              {status.tradeProfile}{profWarn ? " ⚠" : ""}
            </Badge>
          )}
          {/* Badge réseau — chargé une fois, refresh manuel */}
          {network ? (
            <button
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none transition-opacity ${
                network.network === "TESTNET"
                  ? "border-orange-500/60 bg-orange-950/40 text-orange-300"
                  : "border-emerald-700/60 bg-emerald-950/30 text-emerald-400"
              } ${networkLoading ? "opacity-50" : ""}`}
              onClick={() => mutateNetwork()}
              title="Cliquer pour rafraîchir"
            >
              {networkLoading ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : null}
              {network.network === "TESTNET" ? "TESTNET" : "MAINNET · REAL FUNDS"}
            </button>
          ) : (
            <button
              className="inline-flex items-center gap-1 rounded-full border border-zinc-700/60 bg-zinc-900/40 px-2 py-0.5 text-[10px] font-semibold text-zinc-500 leading-none"
              onClick={() => mutateNetwork()}
              title="Cliquer pour rafraîchir"
            >
              {networkLoading ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : null}
              NETWORK ?
            </button>
          )}
        </div>
      </header>

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
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => executeCommand("RESET_EMERGENCY")}
              disabled={busy}
            >
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
              <SwipeConfirmButton
                onConfirm={() => executeCommand("EMERGENCY_STOP")}
                disabled={busy}
              />
            </>
          )}
        </section>
      )}

      {/* ── Stats ──────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-3">
        <StatCard
          label="Positions"
          value={String(status?.openPositions ?? positions?.length ?? "—")}
        />
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Target className="h-4 w-4 text-primary" />
              Dernier signal
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between text-sm">
            <div>
              <span className="font-semibold">{status.lastSignal.symbol}</span>
              <span className="ml-2 text-xs text-muted-foreground">{status.lastSignal.time}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  status.lastSignal.signal === "LONG"  ? "success"     :
                  status.lastSignal.signal === "SHORT" ? "destructive" : "secondary"
                }
                className="text-xs"
              >
                {status.lastSignal.signal}
              </Badge>
              <span className="text-xs text-muted-foreground">{status.lastSignal.total}/10</span>
            </div>
          </CardContent>
        </Card>
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
              className={`rounded-xl border p-2 ${
                danger ? "border-red-900/60 bg-red-950/20" : "border-border bg-card"
              }`}
            >
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className={`text-sm font-semibold ${danger ? "text-red-400" : ""}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Equity sparkline ───────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart2 className="h-4 w-4 text-primary" />
            Equity Curve
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EquitySparkline series={equity?.series ?? []} />
        </CardContent>
      </Card>

      {/* ── Positions ──────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Positions actives</h2>
          {!!positions?.length && (
            <span className="text-xs text-muted-foreground">{positions.length} ouverte(s)</span>
          )}
        </div>
        {positions?.length ? (
          positions.map((p, i) => (
            <PositionCard key={`${p.symbol}-${p.type}-${i}`} pos={p} />
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
            Aucune position active.
          </div>
        )}
      </section>

      {/* ── Modules (read-only) ────────────────────────── */}
      {status?.modules && Object.keys(status.modules).length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Modules</h2>
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
