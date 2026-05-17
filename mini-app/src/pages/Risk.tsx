import useSWR from "swr";
import { useState } from "react";
import { Activity, BarChart3, Gauge, ShieldAlert, Sigma, Target } from "lucide-react";
import { type RiskData, type TradeProfile, type BotStatus, getRisk, getStatus, patchConfig } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  icon: React.ReactNode;
}

function MetricCard({ label, value, helper, danger = false, icon }: MetricCardProps): JSX.Element {
  const borderClass = danger
    ? "border-red-900/60 bg-red-950/30"
    : "border-emerald-900/40 bg-emerald-950/10";
  const valueClass = danger ? "text-red-300" : "text-emerald-300";

  return (
    <div className={`rounded-2xl border p-4 ${borderClass}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className={`mt-1.5 text-xl font-semibold leading-tight ${valueClass}`}>{value}</div>
          {helper ? <div className="mt-1 text-xs text-muted-foreground">{helper}</div> : null}
        </div>
        <div className="rounded-xl border border-border bg-card p-2 text-muted-foreground">
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
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Profil de risque Smart Money</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
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
                  ? "border-emerald-500 bg-emerald-950/40 text-emerald-300"
                  : "border-border bg-card text-muted-foreground hover:border-emerald-700"
              }`}
            >
              <div className="text-sm font-medium">{opt.label}</div>
              <div className="text-xs opacity-70">{opt.desc}</div>
            </button>
          );
        })}
        <p className="text-xs text-muted-foreground pt-1">
          Le profil revient à <b>Équilibré</b> au redémarrage du bot.
        </p>
      </CardContent>
    </Card>
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

  return (
    <div className="space-y-4 px-4 py-5">
      <div>
        <h1 className="text-xl font-semibold">Risk Cockpit</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Exposition, performances et drawdown.
        </p>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">Chargement…</CardContent>
        </Card>
      ) : error ? (
        <Card className="border-red-900/60">
          <CardContent className="pt-6 text-sm text-red-300">
            API indisponible — {error instanceof Error ? error.message : "Erreur réseau"}
          </CardContent>
        </Card>
      ) : data ? (
        <>
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
              danger={false}
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
              icon={<Sigma className="h-4 w-4" />}
            />
            <MetricCard
              label="Exposition"
              value={`${fmt(data.totalExposure)} USDT`}
              helper={`${data.openPositions} position(s)`}
              danger={false}
              icon={<Activity className="h-4 w-4" />}
            />
            <MetricCard
              label="Marge utilisée"
              value={`${fmt(data.totalMargin)} USDT`}
              helper="Somme des marges actives"
              danger={false}
              icon={<Gauge className="h-4 w-4" />}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Seuils d'alerte</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-xs">
              <div className={drawdownDanger ? "text-red-400" : "text-emerald-400"}>
                {drawdownDanger ? "⚠" : "✓"} Drawdown {drawdownDanger ? ">" : "≤"} 15 USDT (seuil critique)
              </div>
              <div className={winRateDanger ? "text-red-400" : "text-emerald-400"}>
                {winRateDanger ? "⚠" : "✓"} Win rate {winRateDanger ? "<" : "≥"} 40%
              </div>
            </CardContent>
          </Card>

          <ProfileSelector current={currentProfile} onSave={handleProfileSave} />
        </>
      ) : null}
    </div>
  );
}
