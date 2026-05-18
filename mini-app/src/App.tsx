import { useEffect, useState } from "react";
import useSWR from "swr";
import { BarChart2, CheckCircle2, Search, AlertTriangle, Terminal, Settings } from "lucide-react";
import Dashboard from "@/pages/Overview";
import Analyze  from "@/pages/Analyze";
import Risk     from "@/pages/Risk";
import Logs     from "@/pages/Logs";
import { getSignals, getStatus, patchConfig, toggleModule, type BotMode, type TradeProfile } from "@/lib/api";
import { useMyRole } from "@/hooks/useMyRole";
import { Badge }  from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function roleBadgeClass(role: string): string {
  if (role === "ADMIN")    return "bg-emerald-600 text-white hover:bg-emerald-600";
  if (role === "OPERATOR") return "bg-blue-600 text-white hover:bg-blue-600";
  if (role === "TRADER")   return "bg-purple-600 text-white hover:bg-purple-600";
  return "bg-zinc-600 text-white hover:bg-zinc-600";
}

export default function App(): JSX.Element {
  const isTelegram = Boolean(window.Telegram?.WebApp?.initData);
  const { role, isLoading: roleLoading } = useMyRole();

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready?.();
    tg?.expand?.();
    tg?.enableClosingConfirmation?.();
    try {
      tg?.setHeaderColor?.("#0d1117");
      tg?.setBackgroundColor?.("#0d1117");
    } catch {}
    document.documentElement.setAttribute("data-theme", tg?.colorScheme ?? "dark");
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isProd = (import.meta as any).env?.PROD === true;
  if (!isTelegram && isProd) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 bg-[#0d1117]">
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-8 text-center max-w-sm backdrop-blur-sm">
          <div className="mb-3 text-3xl">🤖</div>
          <p className="text-lg font-bold tracking-tight">PerpEdge Admin</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Cette interface est accessible uniquement via le bot Telegram.
          </p>
        </div>
      </main>
    );
  }

  return (
    <Tabs defaultValue="overview" className="min-h-dvh">
      {/* Tab content — pb-20 to avoid overlap with bottom nav */}
      <div className="pb-20">
        <TabsContent value="overview" className="mt-0"><Dashboard /></TabsContent>
        <TabsContent value="analyze"  className="mt-0"><Analyze /></TabsContent>
        <TabsContent value="risk"     className="mt-0"><Risk /></TabsContent>
        <TabsContent value="logs"     className="mt-0"><Logs /></TabsContent>
        <TabsContent value="config"   className="mt-0"><ConfigPage /></TabsContent>
      </div>

      {/* Bottom navigation — top border indicator on active */}
      <TabsList className="fixed inset-x-0 bottom-0 z-50 grid w-full grid-cols-5 h-16 rounded-none border-t border-white/[0.08] bg-[#0d1117]/95 px-0 backdrop-blur-md">
        {[
          { value: "overview", label: "Dashboard", Icon: BarChart2    },
          { value: "analyze",  label: "Analyse",   Icon: Search       },
          { value: "risk",     label: "Risk",      Icon: AlertTriangle },
          { value: "logs",     label: "Logs",      Icon: Terminal     },
          { value: "config",   label: "Config",    Icon: Settings     },
        ].map(({ value, label, Icon }) => (
          <TabsTrigger
            key={value}
            value={value}
            className="relative flex h-full flex-col items-center justify-center gap-0.5 rounded-none border-t-2 border-transparent px-1 py-1 text-[10px] font-medium text-muted-foreground transition-colors data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
          >
            <Icon className="h-[18px] w-[18px]" />
            <span>{label}</span>
          </TabsTrigger>
        ))}
        {!roleLoading && (
          <Badge
            className={`absolute right-1.5 top-1 h-4 px-1.5 text-[9px] font-bold uppercase tracking-wide border-none ${roleBadgeClass(role)}`}
          >
            {role}
          </Badge>
        )}
      </TabsList>
    </Tabs>
  );
}

// ── Config page ───────────────────────────────────────────────────────────────
type ConfirmKind = "mode-live" | "profile-aggressive";

function ConfigPage(): JSX.Element {
  const { data: status, isLoading: statusLoading, mutate } = useSWR("config-status", getStatus, { refreshInterval: 5000 });
  const { data: signals } = useSWR("signals-cfg", getSignals, { refreshInterval: 10000 });

  const [isSaving, setIsSaving]   = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, setConfirm]     = useState<{ kind: ConfirmKind; payload: string } | null>(null);

  const modules = status?.modules ?? {};

  const withSave = (fn: () => Promise<void>): void => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    fn()
      .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : "Erreur API"))
      .finally(() => setIsSaving(false));
  };

  const applyMode    = (mode: BotMode)              => withSave(async () => { await patchConfig({ mode });         await mutate(); });
  const applyProfile = (tradeProfile: TradeProfile) => withSave(async () => { await patchConfig({ tradeProfile }); await mutate(); });

  const handleMode    = (mode: BotMode)    => { if (mode === "LIVE")       { setConfirm({ kind: "mode-live",           payload: mode }); return; } applyMode(mode); };
  const handleProfile = (p: TradeProfile)  => { if (p === "aggressive")    { setConfirm({ kind: "profile-aggressive", payload: p   }); return; } applyProfile(p); };
  const handleToggle  = (name: string, en: boolean) => withSave(async () => { await toggleModule(name, en); await mutate(); });

  const handleConfirm = () => {
    if (!confirm) return;
    const { kind, payload } = confirm;
    setConfirm(null);
    if (kind === "mode-live")               applyMode(payload as BotMode);
    else if (kind === "profile-aggressive") applyProfile(payload as TradeProfile);
  };

  const PROFILE_LABELS: Record<string, string> = {
    conservative: "🌱 Conservateur",
    balanced:     "⚖️ Équilibré",
    aggressive:   "🔥 Agressif",
  };

  return (
    <div className="space-y-4 px-4 py-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Configuration</h1>
        <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Mode · Profil · Modules
        </p>
      </div>

      {saveError && (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          ⚠ {saveError}
        </div>
      )}

      {/* Inline confirm — no portal, works inside Telegram WebApp iframe */}
      {confirm && (
        <div className="rounded-xl border border-orange-500/60 bg-orange-950/30 px-4 py-4 space-y-3">
          <div className="text-sm font-semibold text-orange-200">
            {confirm.kind === "mode-live" ? "⚠️ Passer en mode LIVE" : "⚠️ Profil Agressif"}
          </div>
          <p className="text-sm text-muted-foreground">
            {confirm.kind === "mode-live"
              ? <span>Le mode <b>LIVE</b> exécute de vrais ordres sur Binance avec du capital réel. Confirmer ?</span>
              : <span>Ce profil déclenche <b>Perp + Spot DCA simultanément</b> à <b>0.5× taille normale</b> (exposition totale 1.0×). Le circuit breaker reste actif.</span>
            }
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirm(null)}>Annuler</Button>
            <Button size="sm" onClick={handleConfirm}>
              {confirm.kind === "mode-live" ? "Confirmer LIVE" : "Confirmer Agressif"}
            </Button>
          </div>
        </div>
      )}

      {/* Mode */}
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-sm space-y-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Mode d'exécution
        </div>
        <div className="flex gap-2">
          {(["LIVE", "SHADOW"] as const).map((mode) => {
            const active = status?.mode === mode;
            return (
              <button
                key={mode}
                onClick={() => handleMode(mode)}
                disabled={isSaving || statusLoading}
                className={`flex-1 rounded-xl border py-3 text-sm font-bold transition-all ${
                  active
                    ? mode === "LIVE"
                      ? "border-emerald-600/60 bg-emerald-950/30 text-emerald-300"
                      : "border-white/[0.15] bg-white/[0.07] text-foreground"
                    : "border-white/[0.06] bg-transparent text-muted-foreground hover:border-white/[0.12] hover:text-foreground"
                }`}
              >
                <div>{mode}</div>
                <div className="mt-0.5 text-[10px] font-normal opacity-70">
                  {mode === "LIVE" ? "Ordres réels Binance" : "Signaux sans exécution"}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Trade profile */}
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-sm space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Profil de trade
        </div>
        {(["conservative", "balanced", "aggressive"] as const).map((p) => {
          const active = status?.tradeProfile === p;
          return (
            <button
              key={p}
              onClick={() => handleProfile(p)}
              disabled={isSaving || statusLoading}
              className={`w-full rounded-xl border px-4 py-2.5 text-left text-sm font-medium transition-all ${
                active
                  ? p === "aggressive"
                    ? "border-orange-600/60 bg-orange-950/30 text-orange-300"
                    : "border-emerald-600/60 bg-emerald-950/20 text-emerald-300"
                  : "border-white/[0.06] bg-transparent text-muted-foreground hover:border-white/[0.12] hover:text-foreground"
              }`}
            >
              <div className="flex items-center justify-between">
                <span>{PROFILE_LABELS[p]}</span>
                {active && <CheckCircle2 className="h-3.5 w-3.5 opacity-80" />}
              </div>
            </button>
          );
        })}
      </div>

      {/* Modules */}
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-sm space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
          Modules
        </div>
        {statusLoading ? (
          <div className="text-sm text-muted-foreground">Chargement…</div>
        ) : Object.keys(modules).length > 0 ? (
          Object.entries(modules).map(([name, enabled]) => (
            <div key={name} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <div>
                <div className="text-sm font-medium">{name}</div>
                <div className={`text-xs ${enabled ? "text-emerald-400" : "text-muted-foreground"}`}>
                  {enabled ? "Actif" : "Inactif"}
                </div>
              </div>
              {/* Toggle switch */}
              <button
                onClick={() => handleToggle(name, !enabled)}
                disabled={isSaving}
                aria-checked={enabled}
                role="switch"
                className={`relative h-6 w-11 rounded-full transition-colors focus:outline-none ${enabled ? "bg-emerald-600" : "bg-zinc-700"}`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`}
                />
              </button>
            </div>
          ))
        ) : (
          <div className="text-sm text-muted-foreground">Aucun module exposé par l'API.</div>
        )}
      </div>

      {/* Recent signals */}
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-sm">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3">
          Derniers signaux
        </div>
        {signals?.length ? (
          <div className="space-y-1.5">
            {signals.slice(0, 10).map((s) => (
              <div key={`${s.symbol}-${s.time}`} className="flex items-center gap-3 rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2">
                <span className="font-mono text-sm font-bold">{s.symbol}</span>
                <Badge
                  variant={s.signal === "LONG" ? "success" : s.signal === "SHORT" ? "destructive" : "secondary"}
                  className="text-[10px] font-bold"
                >
                  {s.signal}
                </Badge>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{s.total}/10</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-4 text-center text-sm text-muted-foreground">Aucun signal récent.</div>
        )}
      </div>
    </div>
  );
}
