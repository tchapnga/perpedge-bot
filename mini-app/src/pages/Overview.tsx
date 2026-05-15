import { useState } from "react";
import useSWR from "swr";
import { AlertTriangle, Pause, Play, ShieldAlert, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { type Command, type EquityPoint, getEquity, getPositions, getSignals, getStatus, postCommand } from "@/lib/api";

// ── P8D.5 — Equity Sparkline SVG ─────────────────────────────────────────────
function EquitySparkline({ series }: { series: EquityPoint[] }): JSX.Element {
  if (series.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
        Aucun trade clôturé
      </div>
    );
  }

  const W = 400, H = 64, PAD = 6;
  const values = series.map((p) => p.cumPnl);
  const min    = Math.min(...values, 0);
  const max    = Math.max(...values, 0.01);
  const range  = max - min || 1;

  const toX = (i: number): number =>
    series.length > 1 ? (i / (series.length - 1)) * W : W / 2;
  const toY = (v: number): number =>
    H - PAD - ((v - min) / range) * (H - PAD * 2);

  const linePts = series.map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.cumPnl).toFixed(1)}`).join(" ");
  const zeroY   = toY(0);
  const lastX   = toX(series.length - 1);
  const fillPts = `${linePts} L ${lastX.toFixed(1)} ${zeroY.toFixed(1)} L 0 ${zeroY.toFixed(1)} Z`;

  const last  = values[values.length - 1] ?? 0;
  const color = last >= 0 ? "#22c55e" : "#ef4444";

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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-CH", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function pnlClass(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-red-400";
  return "text-muted-foreground";
}

export default function Overview(): JSX.Element {
  const [commandLoading, setCommandLoading] = useState<Command | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: status, error: statusError, mutate: mutateStatus } = useSWR(
    "status",
    getStatus,
    { refreshInterval: 5000 }
  );
  const { data: positions, error: positionsError, mutate: mutatePositions } = useSWR(
    "positions",
    getPositions,
    { refreshInterval: 5000 }
  );
  const { data: signals } = useSWR("signals", getSignals, { refreshInterval: 5000 });
  const { data: equity  } = useSWR("equity",  getEquity,  { refreshInterval: 60000 });

  const executeCommand = async (cmd: Command): Promise<void> => {
    setCommandError(null);
    try {
      setCommandLoading(cmd);
      if (cmd === "EMERGENCY_STOP") {
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("warning");
      } else {
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
      }
      await postCommand(cmd);
      setDialogOpen(false);
    } catch (err) {
      setCommandError(err instanceof Error ? err.message : "Erreur lors de l'exécution de la commande.");
    } finally {
      setCommandLoading(null);
      await Promise.all([mutateStatus(), mutatePositions()]).catch(() => undefined);
    }
  };

  const totalPnl =
    status?.unrealizedPnl ?? positions?.reduce((acc, p) => acc + (p.unrealizedPnl ?? 0), 0) ?? 0;
  const openPositions = status?.openPositions ?? positions?.length ?? 0;
  const signalsToday = status?.signalsToday ?? signals?.length ?? 0;

  if (statusError || positionsError) {
    return (
      <Card className="border-red-900/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-300">
            <AlertTriangle className="h-5 w-5" />
            API indisponible
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Vérifie que l'API Fastify écoute sur le port 3002 et que les headers d'auth sont acceptés.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5 px-4 py-5">
      <header className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">PerpEdge Cockpit</h1>
          <p className="text-sm text-muted-foreground">Supervision du bot autonome de trading perpétuel.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status?.mode === "LIVE" ? "default" : "secondary"}>
            {status?.mode ?? "LOADING"}
          </Badge>
          <Badge variant={status?.emergencyStopped ? "destructive" : status?.isPaused ? "secondary" : "success"}>
            {status?.emergencyStopped ? "EMERGENCY" : status?.isPaused ? "PAUSED" : "RUNNING"}
          </Badge>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Positions ouvertes" value={String(openPositions)} />
        <StatCard
          title="PnL total"
          value={formatCurrency(totalPnl)}
          className={pnlClass(totalPnl)}
        />
        <StatCard title="Signaux aujourd'hui" value={String(signalsToday)} />
        <StatCard title="Cycles" value={String(status?.cycleCount ?? "—")} />
      </section>

      {commandError ? (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
          {commandError}
        </div>
      ) : null}

      <section className="flex flex-wrap gap-3">
        {status?.emergencyStopped ? (
          <Button
            variant="secondary"
            onClick={() => executeCommand("RESET_EMERGENCY")}
            disabled={commandLoading !== null}
          >
            <ShieldAlert className="mr-2 h-4 w-4" />
            Reset Emergency
          </Button>
        ) : status?.isPaused ? (
          <Button onClick={() => executeCommand("RESUME")} disabled={commandLoading !== null}>
            <Play className="mr-2 h-4 w-4" />
            Reprendre
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => executeCommand("PAUSE_NEW_ENTRIES")}
            disabled={commandLoading !== null}
          >
            <Pause className="mr-2 h-4 w-4" />
            Pause
          </Button>
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="destructive">
              <ShieldAlert className="mr-2 h-4 w-4" />
              Emergency Stop
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirmer l'arrêt d'urgence</DialogTitle>
              <DialogDescription>
                Cette action bloque immédiatement toutes les nouvelles entrées. Réservée aux
                situations critiques.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                Annuler
              </Button>
              <Button
                variant="destructive"
                onClick={() => executeCommand("EMERGENCY_STOP")}
                disabled={commandLoading !== null}
              >
                Confirmer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            Equity Curve
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EquitySparkline series={equity?.series ?? []} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Positions actives</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="py-3 pr-4 font-medium">Symbol</th>
                  <th className="py-3 pr-4 font-medium">Side</th>
                  <th className="py-3 pr-4 font-medium">Entry</th>
                  <th className="py-3 pr-4 font-medium">PnL</th>
                </tr>
              </thead>
              <tbody>
                {positions?.length ? (
                  positions.map((p, i) => (
                    <tr key={`${p.symbol}-${i}`} className="border-b border-border/60">
                      <td className="py-3 pr-4 font-medium">{p.symbol}</td>
                      <td className="py-3 pr-4">
                        <Badge variant={p.side === "LONG" ? "success" : "destructive"}>
                          {p.side}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4">{p.entry}</td>
                      <td className={`py-3 pr-4 font-semibold ${pnlClass(p.unrealizedPnl ?? 0)}`}>
                        {formatCurrency(p.unrealizedPnl ?? 0)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-muted-foreground">
                      Aucune position active.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface StatCardProps {
  title: string;
  value: string;
  className?: string;
}

function StatCard({ title, value, className }: StatCardProps): JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold ${className ?? ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
