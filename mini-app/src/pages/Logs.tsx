import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { type LogEntry, getLogs } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

function levelClass(level: LogEntry["level"]): string {
  if (level === "error") return "text-red-400";
  if (level === "warn")  return "text-yellow-400";
  return "text-gray-300";
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(11, 19) || ts;
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function Logs(): JSX.Element {
  const [logs,     setLogs]     = useState<LogEntry[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);
  const sinceRef  = useRef<string | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const errorCount = useMemo(() => logs.filter((l) => l.level === "error").length, [logs]);

  useEffect(() => {
    let active = true;

    const poll = async (): Promise<void> => {
      try {
        const { logs: newLogs } = await getLogs(sinceRef.current);
        if (!active) return;
        if (newLogs.length > 0) {
          sinceRef.current = newLogs[newLogs.length - 1]?.ts;
          setLogs((prev) => [...prev, ...newLogs].slice(-300));
        }
        setApiError(null);
      } catch (err) {
        if (!active) return;
        setApiError(err instanceof Error ? err.message : "Erreur réseau");
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), 2_000);
    return () => { active = false; window.clearInterval(id); };
  }, []);

  // Auto-scroll au dernier log
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [logs]);

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col gap-3 px-4 py-5">
      {/* Header */}
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
            aria-label="Vider les logs"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Erreur API */}
      {apiError ? (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {apiError}
        </div>
      ) : null}

      {/* Terminal */}
      <div className="no-scrollbar flex-1 overflow-y-auto rounded-2xl border border-border bg-black px-3 py-3 font-mono text-xs leading-relaxed">
        {logs.length === 0 ? (
          <span className="text-muted-foreground">En attente de logs…</span>
        ) : (
          <>
            {logs.map((log, i) => (
              <div key={`${log.ts}-${i}`} className="flex gap-1.5 whitespace-pre-wrap break-words py-0.5">
                <span className="shrink-0 text-muted-foreground">[{fmtTime(log.ts)}]</span>
                <span className={`shrink-0 font-semibold ${levelClass(log.level)}`}>
                  {log.level.toUpperCase()}
                </span>
                <span className="text-gray-300">{log.msg}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>
    </div>
  );
}
