import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type ReconcileResult, getReconcile } from "@/lib/api";

export function ReconcilePanel(): JSX.Element {
  const [loading, setLoading]  = useState(false);
  const [result, setResult]    = useState<ReconcileResult | null>(null);
  const [error, setError]      = useState<string | null>(null);

  const handleReconcile = async (): Promise<void> => {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      setResult(await getReconcile());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur réseau");
    } finally {
      setLoading(false);
    }
  };

  const hasDesync = result && (
    (result.botOnly?.length ?? 0) > 0 ||
    (result.binanceOnly?.length ?? 0) > 0 ||
    (result.mismatch?.length ?? 0) > 0
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base font-medium">Réconciliation</CardTitle>
        <Button
          size="sm"
          variant="secondary"
          onClick={handleReconcile}
          disabled={loading}
        >
          {loading ? "🔄 Analyse..." : "🔄 Réconcilier"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {result?.ok && !hasDesync && (
          <div className="flex items-center gap-2">
            <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
              ✅ {result.binancePositions?.length ?? 0} positions sync
            </Badge>
          </div>
        )}
        {result && (hasDesync || !result.ok) && (
          <div className="space-y-2">
            {result.error && (
              <p className="text-sm text-red-400">{result.error}</p>
            )}
            {(result.botOnly?.length ?? 0) > 0 && (
              <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-3">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-red-400">
                  Bot uniquement ({result.botOnly!.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {result.botOnly!.map((p) => (
                    <Badge key={p.symbol} variant="destructive">{p.symbol}</Badge>
                  ))}
                </div>
              </div>
            )}
            {(result.binanceOnly?.length ?? 0) > 0 && (
              <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-3">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-red-400">
                  Binance uniquement ({result.binanceOnly!.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {result.binanceOnly!.map((p) => (
                    <Badge key={p.symbol} variant="destructive">{p.symbol}</Badge>
                  ))}
                </div>
              </div>
            )}
            {(result.mismatch?.length ?? 0) > 0 && (
              <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-3">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-red-400">
                  Désalignements ({result.mismatch!.length})
                </p>
                <div className="space-y-1">
                  {result.mismatch!.map((m) => (
                    <div key={m.symbol} className="flex justify-between text-xs text-muted-foreground">
                      <span className="font-mono font-semibold text-foreground">{m.symbol}</span>
                      <span>Bot: {m.botDirection} ({m.botQty}) ≠ Binance: {m.binanceDirection} ({m.binanceQty})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
