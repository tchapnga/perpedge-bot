import { useEffect, useRef, useState, type RefObject } from "react";
import useSWR from "swr";
import { BarChart2, CheckCircle2, Search, AlertTriangle, Terminal, Settings } from "lucide-react";
import Dashboard from "@/pages/Overview";
import Analyze  from "@/pages/Analyze";
import Risk     from "@/pages/Risk";
import Logs     from "@/pages/Logs";
import { getSignals, getStatus, patchConfig, toggleModule, type BotMode, type TradeProfile } from "@/lib/api";
import { ErrorBoundary } from "@/components/ErrorBoundary";
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

  const [activeTab, setActiveTab] = useState("overview");
  const [authExpired, setAuthExpired] = useState(false);

  const ebOverview = useRef<ErrorBoundary>(null);
  const ebAnalyze  = useRef<ErrorBoundary>(null);
  const ebRisk     = useRef<ErrorBoundary>(null);
  const ebLogs     = useRef<ErrorBoundary>(null);
  const ebConfig   = useRef<ErrorBoundary>(null);

  const ebRefs: Record<string, RefObject<ErrorBoundary>> = {
    overview: ebOverview, analyze: ebAnalyze, risk: ebRisk, logs: ebLogs, config: ebConfig,
  };

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

  useEffect(() => {
    const handler = () => setAuthExpired(true);
    window.addEventListener("auth-error", handler);
    return () => window.removeEventListener("auth-error", handler);
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
    <>
      {authExpired && (
        <div className="sticky top-0 z-50 border-b border-orange-800/60 bg-orange-950/80 px-4 py-2.5 text-sm backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <span className="text-orange-200">Session expirée — relancez depuis Telegram.</span>
            <button
              onClick={() => setAuthExpired(false)}
              className="rounded-lg border border-orange-700/40 px-2 py-0.5 text-xs text-orange-300 hover:bg-orange-900/40"
            >
              Fermer
            </button>
          </div>
        </div>
      )}
    <Tabs
      value={activeTab}
      onValueChange={(tab) => {
        ebRefs[tab]?.current?.resetErrorBoundary();
        setActiveTab(tab);
      }}
      className="min-h-dvh"
    >
      {/* Tab content — pb-20 to avoid overlap with bottom nav */}
      <div className="pb-20">
        <TabsContent value="overview" className="mt-0"><ErrorBoundary ref={ebOverview}><Dashboard /></ErrorBoundary></TabsContent>
        <TabsContent value="analyze"  className="mt-0"><ErrorBoundary ref={ebAnalyze}><Analyze /></ErrorBoundary></TabsContent>
        <TabsContent value="risk"     className="mt-0"><ErrorBoundary ref={ebRisk}><Risk /></ErrorBoundary></TabsContent>
        <TabsContent value="logs"     className="mt-0"><ErrorBoundary ref={ebLogs}><Logs /></ErrorBoundary></TabsContent>
        <TabsContent value="config"   className="mt-0"><ErrorBoundary ref={ebConfig}><ConfigPage /></ErrorBoundary></TabsContent>
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
    </>
  );
}

// ── Config page ───────────────────────────────────────────────────────────────
type ConfirmKind = "mode-live" | "profile-aggressive";

const PROFILE_OPTIONS: { value: TradeProfile; label: string; desc: string }[] = [
  { value: "conservative", label: "🌱 Conservateur", desc: "Spot DCA uniquement — exposition minimale" },
  { value: "balanced",     label: "⚖️ Équilibré",    desc: "Perp ou Spot selon les indicateurs" },
  { value: "aggressive",   label: "🔥 Agressif",     desc: "Perp + Spot en simultané (0.5× chacun)" },
];

const MODULE_META: Record<string, {
  accent: string; track: string; border: string; bg: string; desc: string;
}> = {
  scalp:         { accent: "bg-orange-500",  track: "bg-orange-600",  border: "border-orange-900/50",  bg: "bg-orange-950/15",  desc: "Entrées rapides sub-1h"  },
  capitulation:  { accent: "bg-red-500",     track: "bg-red-600",     border: "border-red-900/50",     bg: "bg-red-950/15",     desc: "Capitulation du marché"  },
  smartMoney:    { accent: "bg-violet-500",  track: "bg-violet-600",  border: "border-violet-900/50",  bg: "bg-violet-950/15",  desc: "Flux smart money & CVD"  },
  oi:            { accent: "bg-sky-500",     track: "bg-sky-600",     border: "border-sky-900/50",     bg: "bg-sky-950/15",     desc: "Open Interest & funding" },
  squeeze:       { accent: "bg-amber-500",   track: "bg-amber-600",   border: "border-amber-900/50",   bg: "bg-amber-950/15",   desc: "Détection de squeeze"    },
  crowdedUnwind: { accent: "bg-emerald-500", track: "bg-emerald-600", border: "border-emerald-900/50", bg: "bg-emerald-950/15", desc: "Débouclage de positions" },
};

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

  const handleMode    = (mode: BotMode)    => { if (mode === "LIVE")    { setConfirm({ kind: "mode-live",           payload: mode }); return; } applyMode(mode); };
  const handleProfile = (p: TradeProfile)  => { if (p === "aggressive") { setConfirm({ kind: "profile-aggressive", payload: p   }); return; } applyProfile(p); };
  const handleToggle  = (name: string, en: boolean) => withSave(async () => { await toggleModule(name, en); await mutate(); });

  const handleConfirm = () => {
    if (!confirm) return;
    const { kind, payload } = confirm;
    setConfirm(null);
    if (kind === "mode-live")               applyMode(payload as BotMode);
    else if (kind === "profile-aggressive") applyProfile(payload as TradeProfile);
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

      {/* Mode d'exécution */}
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
                className={`flex-1 rounded-xl border py-3.5 text-sm font-bold transition-all ${
                  active
                    ? mode === "LIVE"
                      ? "border-red-600/60 bg-red-950/30 text-red-300"
                      : "border-sky-600/50 bg-sky-950/20 text-sky-300"
                    : mode === "LIVE"
                      ? "border-white/[0.06] bg-transparent text-muted-foreground hover:border-red-900/40 hover:bg-red-950/10 hover:text-red-300/70"
                      : "border-white/[0.06] bg-transparent text-muted-foreground hover:border-white/[0.12] hover:text-foreground"
                }`}
              >
                <div className="flex items-center justify-center gap-1.5">
                  {mode === "LIVE" && (
                    <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-red-400" : "bg-muted-foreground/40"}`} />
                  )}
                  {mode}
                </div>
                <div className="mt-0.5 text-[10px] font-normal opacity-60">
                  {mode === "LIVE" ? "Ordres réels Binance" : "Signaux sans exécution"}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Profil de trade */}
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-sm space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
          Profil de trade
        </div>
        {PROFILE_OPTIONS.map(({ value: p, label, desc }) => {
          const active = status?.tradeProfile === p;
          return (
            <button
              key={p}
              onClick={() => handleProfile(p)}
              disabled={isSaving || statusLoading}
              className={`w-full rounded-xl border px-4 py-3 text-left transition-all ${
                active
                  ? p === "aggressive"
                    ? "border-orange-600/60 bg-orange-950/25 text-orange-300"
                    : "border-emerald-600/50 bg-emerald-950/20 text-emerald-300"
                  : "border-white/[0.06] bg-transparent text-muted-foreground hover:border-white/[0.12] hover:text-foreground"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{label}</span>
                {active && <CheckCircle2 className="h-4 w-4 shrink-0 opacity-80" />}
              </div>
              <div className={`mt-0.5 text-xs ${active ? "opacity-70" : "opacity-50"}`}>{desc}</div>
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
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="animate-pulse h-14 rounded-xl border border-white/[0.04] bg-white/[0.02]" />
            ))}
          </div>
        ) : Object.keys(modules).length > 0 ? (
          Object.entries(modules).map(([name, enabled]) => {
            const meta = MODULE_META[name];
            return (
              <div
                key={name}
                className={`relative overflow-hidden flex items-center gap-3 rounded-xl border pl-4 pr-3 py-3 transition-all ${
                  enabled && meta
                    ? `${meta.border} ${meta.bg}`
                    : enabled
                    ? "border-white/[0.08] bg-white/[0.04]"
                    : "border-white/[0.04] bg-transparent opacity-50"
                }`}
              >
                {/* Left accent bar — visible only when ON */}
                {enabled && (
                  <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl ${meta?.accent ?? "bg-emerald-500"}`} />
                )}

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold capitalize">{name}</div>
                  {meta?.desc && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground/60 truncate">{meta.desc}</div>
                  )}
                </div>

                {/* Toggle — overflow-hidden clips thumb, left-0.5 anchors it */}
                <button
                  onClick={() => handleToggle(name, !enabled)}
                  disabled={isSaving}
                  aria-checked={enabled}
                  role="switch"
                  className={`relative h-6 w-11 shrink-0 rounded-full overflow-hidden transition-colors duration-200 focus:outline-none disabled:opacity-50 ${
                    enabled ? (meta?.track ?? "bg-emerald-600") : "bg-zinc-700"
                  }`}
                >
                  {/* left-0.5 = 2px anchor; ON: +20px = right gap 2px; OFF: translate-x-0 stays at 2px */}
                  <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${
                    enabled ? "translate-x-5" : "translate-x-0"
                  }`} />
                </button>
              </div>
            );
          })
        ) : (
          <div className="text-sm text-muted-foreground">Aucun module exposé par l'API.</div>
        )}
      </div>

      {/* Derniers signaux */}
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
