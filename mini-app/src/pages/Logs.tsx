import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Trash2 } from "lucide-react";
import { type LogEntry, getLogs } from "@/lib/api";

type LogEntrySeq = LogEntry & { _seq: number };

function levelTag(level: LogEntry["level"]): { tag: string; tagClass: string; rowClass: string; msgClass: string } {
  if (level === "error") return {
    tag: "ERR",
    tagClass: "text-red-400",
    rowClass: "bg-red-950/20 rounded px-1",
    msgClass: "text-red-200",
  };
  if (level === "warn") return {
    tag: "WRN",
    tagClass: "text-amber-400",
    rowClass: "bg-amber-950/15 rounded px-1",
    msgClass: "text-amber-200",
  };
  return {
    tag: "INF",
    tagClass: "text-zinc-500",
    rowClass: "",
    msgClass: "text-zinc-400",
  };
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function Logs(): JSX.Element {
  const [logs,          setLogs]         = useState<LogEntrySeq[]>([]);
  const [apiError,      setApiError]     = useState<string | null>(null);
  const [retryTrigger,  setRetryTrigger] = useState(0);
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
    sinceRef.current = undefined;

    const poll = async (): Promise<void> => {
      try {
        const { logs: newLogs } = await getLogs(sinceRef.current);
        if (!active) return;
        if (newLogs.length > 0) {
          sinceRef.current = newLogs[newLogs.length - 1]?.ts;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryTrigger]);

  // FIX 3: auto-scroll conditionnel — scroll seulement si déjà en bas (<60px du fond)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (isAtBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col gap-3 px-4 py-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">Logs</h1>
            <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              polling 2s · max 300 lignes
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {errorCount > 0 && (
            <span className="rounded-full border border-red-700/60 bg-red-950/40 px-2 py-0.5 text-[11px] font-bold text-red-300">
              {errorCount} err
            </span>
          )}
          <button
            type="button"
            onClick={() => { setLogs([]); sinceRef.current = new Date().toISOString(); }}
            className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            aria-label="Effacer l'affichage des logs"
            title="Efface uniquement l'affichage local"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* RES.7: API error banner with retry */}
      {apiError ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-red-900/60 bg-red-950/20 px-3 py-2">
          <span className="text-xs text-red-300">{apiError}</span>
          <button
            type="button"
            onClick={() => { setApiError(null); setRetryTrigger(t => t + 1); }}
            className="shrink-0 rounded-lg border border-red-700/40 px-2 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-900/30"
          >
            Réessayer
          </button>
        </div>
      ) : null}

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="no-scrollbar flex-1 overflow-y-auto rounded-xl border border-zinc-800/60 bg-zinc-950/90 px-2 py-2 font-mono text-[11px] leading-5 backdrop-blur-sm"
        role="log"
        aria-live="polite"
        aria-label="Logs système"
      >
        {logs.length === 0 ? (
          <span className="text-muted-foreground">En attente de logs…</span>
        ) : (
          logs.map(log => {
            const { tag, tagClass, rowClass, msgClass } = levelTag(log.level);
            return (
              <div
                key={log._seq}
                className={`flex gap-1.5 whitespace-pre-wrap break-words py-0.5 ${rowClass}`}
              >
                <span className="shrink-0 text-zinc-600">[{fmtTime(log.ts)}]</span>
                <span className={`shrink-0 font-bold tracking-wider ${tagClass}`}>{tag}</span>
                <span className={msgClass}>{log.msg}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
