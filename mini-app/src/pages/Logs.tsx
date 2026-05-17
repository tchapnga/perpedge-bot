import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { type LogEntry, getLogs } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

type LogEntrySeq = LogEntry & { _seq: number };

function levelClass(level: LogEntry["level"]): string {
  if (level === "error") return "text-red-400";
  if (level === "warn")  return "text-yellow-400";
  return "text-gray-300";
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function Logs(): JSX.Element {
  const [logs,     setLogs]     = useState<LogEntrySeq[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);
  const sinceRef     = useRef<string | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const seqRef       = useRef(0);

  const errorCount = useMemo(
    () => logs.reduce((n, l) => (l.level === "error" ? n + 1 : n), 0),
    [logs]
  );

  // FIX 1: setTimeout récursif (anti-race condition — le prochain poll démarre
  // seulement après la fin du précédent, pas en parallèle)
  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const { logs: newLogs } = await getLogs(sinceRef.current);
        if (!active) return;
        if (newLogs.length > 0) {
          sinceRef.current = newLogs[newLogs.length - 1]?.ts;
          // FIX 2: clé stable via _seq — évite le re-render complet de 300 nœuds
          setLogs(prev => {
            const tagged = newLogs.map(l => ({ ...l, _seq: seqRef.current++ }));
            return [...prev, ...tagged].slice(-300);
          });
        }
        setApiError(null);
      } catch (err) {
        if (!active) return;
        setApiError(err instanceof Error ? err.message : "Erreur réseau");
      } finally {
        if (active) timer = window.setTimeout(poll, 2_000);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // FIX 3: auto-scroll conditionnel — scroll seulement si déjà en bas (<60px du fond)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (isAtBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col gap-3 px-4 py-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Logs</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Polling incrémental · 2 s</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={errorCount > 0 ? "destructive" : "secondary"}>
            {errorCount} err
          </Badge>
          <button
            type="button"
            onClick={() => { setLogs([]); sinceRef.current = new Date().toISOString(); }}
            className="rounded-xl border border-border bg-card p-2 text-muted-foreground hover:text-foreground"
            aria-label="Effacer l'affichage des logs"
            title="Efface uniquement l'affichage local"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {apiError ? (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {apiError}
        </div>
      ) : null}

      <div
        ref={containerRef}
        className="no-scrollbar flex-1 overflow-y-auto rounded-2xl border border-border bg-black px-3 py-3 font-mono text-xs leading-relaxed"
        role="log"
        aria-live="polite"
        aria-label="Logs système"
      >
        {logs.length === 0 ? (
          <span className="text-muted-foreground">En attente de logs…</span>
        ) : (
          logs.map(log => (
            <div key={log._seq} className="flex gap-1.5 whitespace-pre-wrap break-words py-0.5">
              <span className="shrink-0 text-muted-foreground">[{fmtTime(log.ts)}]</span>
              <span className={`shrink-0 font-semibold ${levelClass(log.level)}`}>
                {log.level.toUpperCase()}
              </span>
              <span className="text-gray-300">{log.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
