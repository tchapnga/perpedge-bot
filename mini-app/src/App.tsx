import { useEffect, useState } from "react";
import useSWR from "swr";
import { BarChart2, Search, AlertTriangle, Terminal, Settings } from "lucide-react";
import Dashboard from "@/pages/Overview";
import Analyze  from "@/pages/Analyze";
import Risk     from "@/pages/Risk";
import Logs     from "@/pages/Logs";
import { getSignals, getStatus, patchConfig, toggleModule, type BotMode, type TradeProfile } from "@/lib/api";
import { useMyRole } from "@/hooks/useMyRole";
import { Badge }   from "@/components/ui/badge";
import { Button }  from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    // P8D.8 — thème Telegram
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
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="rounded-2xl border border-border bg-card p-8 text-center max-w-sm">
          <p className="text-lg font-semibold">PerpEdge Admin</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Cette interface est accessible uniquement via le bot Telegram.
          </p>
        </div>
      </main>
    );
  }

  return (
    <Tabs defaultValue="overview" className="min-h-dvh">
      {/* Contenu des onglets — pb-20 pour ne pas être masqué par la barre */}
      <div className="pb-20">
        <TabsContent value="overview" className="mt-0"><Dashboard /></TabsContent>
        <TabsContent value="analyze"  className="mt-0"><Analyze /></TabsContent>
        <TabsContent value="risk"     className="mt-0"><Risk /></TabsContent>
        <TabsContent value="logs"     className="mt-0"><Logs /></TabsContent>
        <TabsContent value="config"   className="mt-0"><ConfigPage /></TabsContent>
      </div>

      {/* P8D.8 — Bottom navigation bar (mobile-first Telegram) */}
      <TabsList className="fixed inset-x-0 bottom-0 z-50 grid w-full grid-cols-5 h-16 rounded-none border-t border-border bg-card px-0">
        {[
          { value: "overview", label: "Dashboard", Icon: BarChart2    },
          { value: "analyze",  label: "Analyse",  Icon: Search       },
          { value: "risk",     label: "Risk",   Icon: AlertTriangle  },
          { value: "logs",     label: "Logs",   Icon: Terminal       },
          { value: "config",   label: "Config", Icon: Settings       },
        ].map(({ value, label, Icon }) => (
          <TabsTrigger
            key={value}
            value={value}
            className="flex h-full flex-col items-center justify-center gap-0.5 rounded-none px-1 py-1 text-[10px] font-medium data-[state=active]:bg-muted data-[state=active]:text-primary data-[state=active]:shadow-none"
          >
            <Icon className="h-4 w-4" />
            <span>{label}</span>
          </TabsTrigger>
        ))}
        {/* P8E — RoleBadge discret en coin droit de la nav */}
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

// ── Config page (mode + modules) ─────────────────────────────────────────────
type ConfirmKind = "mode-live" | "profile-aggressive";

function ConfigPage(): JSX.Element {
  const { data: status, isLoading: statusLoading, mutate } = useSWR("config-status", getStatus, { refreshInterval: 5000 });
  const { data: signals } = useSWR("signals-cfg", getSignals, { refreshInterval: 10000 });

  const [isSaving, setIsSaving]     = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);
  const [confirm, setConfirm]       = useState<{ kind: ConfirmKind; payload: string } | null>(null);

  const modules = status?.modules ?? {};

  const withSave = (fn: () => Promise<void>): void => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    fn()
      .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : "Erreur API"))
      .finally(() => setIsSaving(false));
  };

  const applyMode = (mode: BotMode) =>
    withSave(async () => { await patchConfig({ mode }); await mutate(); });

  const applyProfile = (tradeProfile: TradeProfile) =>
    withSave(async () => { await patchConfig({ tradeProfile }); await mutate(); });

  const handleMode = (mode: BotMode) => {
    if (mode === "LIVE") { setConfirm({ kind: "mode-live", payload: mode }); return; }
    applyMode(mode);
  };

  const handleProfile = (p: TradeProfile) => {
    if (p === "aggressive") { setConfirm({ kind: "profile-aggressive", payload: p }); return; }
    applyProfile(p);
  };

  const handleToggle = (name: string, enabled: boolean) =>
    withSave(async () => { await toggleModule(name, enabled); await mutate(); });

  const handleConfirm = () => {
    if (!confirm) return;
    const { kind, payload } = confirm;
    setConfirm(null);
    if (kind === "mode-live")           applyMode(payload as BotMode);
    else if (kind === "profile-aggressive") applyProfile(payload as TradeProfile);
  };

  return (
    <div className="space-y-5 px-4 py-5">
      <div>
        <h1 className="text-xl font-semibold">Configuration</h1>
        <p className="mt-1 text-sm text-muted-foreground">Mode d'exécution et modules.</p>
      </div>

      {saveError && (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {saveError}
        </div>
      )}

      {/* Inline confirmation — no portal, guaranteed to work inside Telegram WebApp iframe */}
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
            <Button variant="secondary" onClick={() => setConfirm(null)}>Annuler</Button>
            <Button onClick={handleConfirm}>
              {confirm.kind === "mode-live" ? "Confirmer LIVE" : "Confirmer Agressif"}
            </Button>
          </div>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">Mode</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {(["LIVE", "SHADOW"] as const).map((mode) => (
            <Button
              key={mode}
              variant={status?.mode === mode ? "default" : "secondary"}
              disabled={isSaving || statusLoading}
              onClick={() => handleMode(mode)}
            >
              {mode}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Profil de trade</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {(["conservative", "balanced", "aggressive"] as const).map((p) => (
            <Button
              key={p}
              variant={status?.tradeProfile === p ? "default" : "secondary"}
              className={p === "aggressive" ? "border border-orange-500/60 text-orange-300 hover:bg-orange-950/30" : ""}
              disabled={isSaving || statusLoading}
              onClick={() => handleProfile(p)}
            >
              {p}{p === "aggressive" ? " ⚠" : ""}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Modules</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {statusLoading ? (
            <div className="text-sm text-muted-foreground">Chargement…</div>
          ) : Object.keys(modules).length > 0 ? (
            Object.entries(modules).map(([name, enabled]) => (
              <div key={name} className="flex items-center justify-between rounded-xl border border-border p-3">
                <div>
                  <div className="font-medium">{name}</div>
                  <div className="text-sm text-muted-foreground">{enabled ? "Activé" : "Désactivé"}</div>
                </div>
                <Button
                  variant={enabled ? "secondary" : "default"}
                  disabled={isSaving}
                  onClick={() => handleToggle(name, !enabled)}
                >
                  {enabled ? "Désactiver" : "Activer"}
                </Button>
              </div>
            ))
          ) : (
            <div className="text-sm text-muted-foreground">Aucun module exposé par l'API.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Derniers signaux</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] text-left text-sm">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Symbol</th>
                  <th className="py-2 pr-4 font-medium">Signal</th>
                  <th className="py-2 pr-4 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {signals?.length ? (
                  signals.slice(0, 10).map((s) => (
                    <tr key={`${s.symbol}-${s.time}`} className="border-b border-border/50">
                      <td className="py-2 pr-4 font-medium">{s.symbol}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={s.signal === "LONG" ? "success" : s.signal === "SHORT" ? "destructive" : "secondary"}>
                          {s.signal}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4">{s.total}/10</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} className="py-6 text-center text-muted-foreground text-sm">
                      Aucun signal récent.
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
