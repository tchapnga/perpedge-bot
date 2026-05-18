import useSWR from "swr";
import { useState } from "react";
import { Activity, BarChart3, Gauge, ShieldAlert, Sigma, Target, TrendingDown, TrendingUp } from "lucide-react";
import { type RiskData, type TradeProfile, type BotStatus, getRisk, getStatus, patchConfig } from "@/lib/api";
import { Button } from "@/components/ui/button";

function fmt(v: number, d = 2): string {
  return Number.isFinite(v) ? v.toFixed(d) : "0.00";
}

function fmtPnl(v: number): string {
  return `${v >= 0 ? "+" : ""}${fmt(v)} USDT`;
}

interface MetricCardProps {
  label: string;
  value: string;
  helper?: string;
  danger?: boolean;
  success?: boolean;
  icon: React.ReactNode;
}

function MetricCard({ label, value, helper, danger = false, success = false, icon }: MetricCardProps): JSX.Element {
  const borderClass = danger
    ? "border-red-900/60 bg-red-950/20"
    : success
    ? "border-emerald-900/40 bg-emerald-950/10"
    : "border-white/[0.08] bg-white/[0.03]";

  const valueClass = danger
    ? "text-red-300"
    : success
    ? "text-emerald-300"
    : "text-foreground";

  const iconBgClass = danger
    ? "bg-red-900/30"
    : success
    ? "bg-emerald-900/30"
    : "bg-white/[0.06]";

  const iconColorClass = danger
    ? "text-red-400"
    : success
    ? "text-emerald-400"
    : "text-muted-foreground";

  return (
    <div className={`relative overflow-hidden rounded-xl border p-3.5 backdrop-blur-sm ${borderClass}`}>
      {/* Gradient overlay */}
      <div className="bg-gradient-to-br from-white/[0.04] to-transparent pointer-events-none absolute inset-0 rounded-xl" />

      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          <div className={`mt-1.5 text-xl font-bold leading-tight tabular-nums ${valueClass}`}>
            {value}
          </div>
          {helper ? (
            <div className="mt-1 text-xs text-muted-foreground">{helper}</div>
          ) : null}
        </div>
        <div className={`rounded-lg p-1.5 ${iconBgClass} ${iconColorClass}`}>
          {icon}
        </div>
      </div>
    </div>
  );
}

const PROFILE_OPTIONS: { value: TradeProfile; label: string; desc: string }[] = [
  { value: "conservative", label: "🌱 Conservateur", desc: "Spot DCA uniquement" },
  { value: "balanced",     label: "⚖️ Équilibré",    desc: "Perp ou Spot selon indicateurs" },
  { value: "aggressive",   label: "🔥 Agressif",     desc: "Perp + Spot (0.5× chacun)" },
];

function ProfileSelector({ current, onSave }: { current: TradeProfile; onSave: (p: TradeProfile) => Promise<void> }): JSX.Element {
  const [pending, setPending] = useState<TradeProfile | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSelect = (p: TradeProfile) => {
    if (p === "aggressive") {
      setPending(p);
    } else {
      void save(p);
    }
  };

  const save = async (p: TradeProfile) => {
    setSaving(true);
    try { await onSave(p); } finally { setSaving(false); }
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-sm">
      {/* Gradient overlay */}
      <div className="bg-gradient-to-br from-white/[0.04] to-transparent pointer-events-none absolute inset-0 rounded-xl" />

      <div className="relative space-y-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3">
            Profil de risque Smart Money
          </div>
        </div>

        {/* Inline confirm — no portal, works inside Telegram WebApp iframe */}
        {pending === "aggressive" && (
          <div className="rounded-xl border border-orange-500/60 bg-orange-950/30 px-4 py-3 space-y-2">
            <div className="text-sm font-semibold text-orange-200">⚠️ Profil Agressif</div>
            <p className="text-xs text-muted-foreground">
              Ce profil déclenche <b>Perp + Spot DCA simultanément</b> à <b>0.5× taille normale</b> (exposition totale 1.0×).
              Le circuit breaker reste actif.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={() => setPending(null)}>Annuler</Button>
              <Button size="sm" onClick={async () => { setPending(null); await save("aggressive"); }}>
                Confirmer Agressif
              </Button>
            </div>
          </div>
        )}

        {PROFILE_OPTIONS.map((opt) => {
          const active = current === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => handleSelect(opt.value)}
              disabled={saving}
              className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                active
                  ? "border-emerald-500/60 bg-emerald-950/20 text-emerald-300"
                  : "border-white/[0.06] bg-transparent text-muted-foreground hover:border-white/[0.12]"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">{opt.label}</div>
                {active && (
                  <span className="rounded-full border border-emerald-700/60 bg-emerald-950/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                    ACTIF
                  </span>
                )}
              </div>
              <div className="text-xs opacity-70 mt-0.5">{opt.desc}</div>
            </button>
          );
        })}

        <p className="text-xs text-muted-foreground pt-1">
          Le profil revient à <b>Équilibré</b> au redémarrage du bot.
        </p>
      </div>
    </div>
  );
}

export default function Risk(): JSX.Element {
  const { data, error, isLoading } = useSWR<RiskData>("/admin/risk", getRisk, {
    refreshInterval: 30_000,
  });
  const { data: status, mutate: mutateStatus } = useSWR<BotStatus>("/admin/status", getStatus, {
    refreshInterval: 30_000,
  });

  const currentProfile: TradeProfile = status?.tradeProfile ?? "balanced";

  const handleProfileSave = async (profile: TradeProfile) => {
    await patchConfig({ tradeProfile: profile });
    await mutateStatus();
  };

  const winRateDanger  = (data?.winRate ?? 100) < 40;
  const drawdownDanger = (data?.maxDrawdown ?? 0) > 15;
  const pnlDanger      = (data?.totalPnl ?? 0) < 0;
  const pnlSuccess     = (data?.totalPnl ?? 0) > 0;

  return (
    <div className="space-y-4 px-4 py-5">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold tracking-tight">Risk Cockpit</h1>
        <p className="mt-1 text-xs text-muted-foreground uppercase tracking-wider">
          Exposition · performances · drawdown
        </p>
      </div>

      {/* Loading skeleton */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="animate-pulse rounded-xl border border-white/[0.08] bg-white/[0.03] h-20"
            />
          ))}
        </div>
      ) : error ? (
        /* Error state */
        <div className="relative overflow-hidden rounded-xl border border-red-900/60 bg-red-950/20 px-4 py-4 backdrop-blur-sm">
          <div className="bg-gradient-to-br from-white/[0.04] to-transparent pointer-events-none absolute inset-0 rounded-xl" />
          <p className="relative text-sm text-red-300">
            API indisponible — {error instanceof Error ? error.message : "Erreur réseau"}
          </p>
        </div>
      ) : data ? (
        <>
          {/* Metric grid */}
          <div className="grid grid-cols-2 gap-3">
            <MetricCard
              label="Win rate"
              value={data.winRate !== null ? `${fmt(data.winRate, 1)}%` : "—"}
              helper={`${data.wins}W / ${data.losses}L`}
              danger={winRateDanger}
              icon={<Target className="h-4 w-4" />}
            />
            <MetricCard
              label="Trades clôturés"
              value={String(data.totalTrades)}
              icon={<BarChart3 className="h-4 w-4" />}
            />
            <MetricCard
              label="Max Drawdown"
              value={`${fmt(data.maxDrawdown)} USDT`}
              helper="Peak-to-trough"
              danger={drawdownDanger}
              icon={<ShieldAlert className="h-4 w-4" />}
            />
            <MetricCard
              label="Total PnL"
              value={fmtPnl(data.totalPnl)}
              helper={data.pnlRealtimeAvailable
                ? `Latent : ${fmtPnl(data.unrealizedPnl)}`
                : `Latent : — (hors ligne)`}
              danger={pnlDanger}
              success={pnlSuccess && !pnlDanger}
              icon={<Sigma className="h-4 w-4" />}
            />
            <MetricCard
              label="Exposition"
              value={`${fmt(data.totalExposure)} USDT`}
              helper={`${data.openPositions} position(s)`}
              icon={<Activity className="h-4 w-4" />}
            />
            <MetricCard
              label="Marge utilisée"
              value={`${fmt(data.totalMargin)} USDT`}
              helper="Somme des marges actives"
              icon={<Gauge className="h-4 w-4" />}
            />
          </div>

          {/* Alert thresholds */}
          <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-sm">
            <div className="bg-gradient-to-br from-white/[0.04] to-transparent pointer-events-none absolute inset-0 rounded-xl" />
            <div className="relative space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3">
                Seuils d'alerte
              </div>
              <div className={`flex items-center gap-2 text-xs ${drawdownDanger ? "text-red-300" : "text-emerald-300"}`}>
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${drawdownDanger ? "bg-red-400" : "bg-emerald-400"}`} />
                {drawdownDanger
                  ? <TrendingDown className="h-3 w-3 shrink-0" />
                  : <TrendingUp className="h-3 w-3 shrink-0" />
                }
                Drawdown {drawdownDanger ? ">" : "≤"} 15 USDT (seuil critique)
              </div>
              <div className={`flex items-center gap-2 text-xs ${winRateDanger ? "text-red-300" : "text-emerald-300"}`}>
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${winRateDanger ? "bg-red-400" : "bg-emerald-400"}`} />
                {winRateDanger
                  ? <TrendingDown className="h-3 w-3 shrink-0" />
                  : <TrendingUp className="h-3 w-3 shrink-0" />
                }
                Win rate {winRateDanger ? "<" : "≥"} 40%
              </div>
            </div>
          </div>

          <ProfileSelector current={currentProfile} onSave={handleProfileSave} />
        </>
      ) : null}
    </div>
  );
}
