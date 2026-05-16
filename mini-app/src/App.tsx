import { useEffect } from "react";
import useSWR from "swr";
import { BarChart2, Search, AlertTriangle, Terminal, Settings } from "lucide-react";
import Overview from "@/pages/Overview";
import Analyze  from "@/pages/Analyze";
import Risk     from "@/pages/Risk";
import Logs     from "@/pages/Logs";
import { getSignals, getStatus, patchConfig, toggleModule } from "@/lib/api";
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
        <TabsContent value="overview" className="mt-0"><Overview /></TabsContent>
        <TabsContent value="analyze"  className="mt-0"><Analyze /></TabsContent>
        <TabsContent value="risk"     className="mt-0"><Risk /></TabsContent>
        <TabsContent value="logs"     className="mt-0"><Logs /></TabsContent>
        <TabsContent value="config"   className="mt-0"><ConfigPage /></TabsContent>
      </div>

      {/* P8D.8 — Bottom navigation bar (mobile-first Telegram) */}
      <TabsList className="fixed inset-x-0 bottom-0 z-50 grid w-full grid-cols-5 h-16 rounded-none border-t border-border bg-card px-0">
        {[
          { value: "overview", label: "Vue",    Icon: BarChart2      },
          { value: "analyze",  label: "Trade",  Icon: Search         },
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
function ConfigPage(): JSX.Element {
  const { data: status, mutate } = useSWR("config-status", getStatus, { refreshInterval: 5000 });

  const setMode = async (mode: "LIVE" | "SHADOW" | "DRY_RUN"): Promise<void> => {
    await patchConfig({ mode });
    await mutate();
  };

  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    await toggleModule(name, enabled);
    await mutate();
  };

  const { data: signals } = useSWR("signals-cfg", getSignals, { refreshInterval: 10000 });
  const modules = status?.modules ?? {};

  return (
    <div className="space-y-5 px-4 py-5">
      <div>
        <h1 className="text-xl font-semibold">Configuration</h1>
        <p className="mt-1 text-sm text-muted-foreground">Mode d'exécution et modules.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Mode</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {(["LIVE", "SHADOW", "DRY_RUN"] as const).map((mode) => (
            <Button
              key={mode}
              variant={status?.mode === mode ? "default" : "secondary"}
              onClick={() => setMode(mode)}
            >
              {mode}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Modules</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {Object.keys(modules).length > 0 ? (
            Object.entries(modules).map(([name, enabled]) => (
              <div key={name} className="flex items-center justify-between rounded-xl border border-border p-3">
                <div>
                  <div className="font-medium">{name}</div>
                  <div className="text-sm text-muted-foreground">{enabled ? "Activé" : "Désactivé"}</div>
                </div>
                <Button variant={enabled ? "secondary" : "default"} onClick={() => toggle(name, !enabled)}>
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
        <CardHeader><CardTitle>Derniers signaux</CardTitle></CardHeader>
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
                  signals.slice(0, 10).map((s, i) => (
                    <tr key={`${s.symbol}-${i}`} className="border-b border-border/50">
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
