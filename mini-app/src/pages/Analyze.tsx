import { useMemo, useState } from "react";
import useSWR from "swr";
import { Loader2, Search, Sparkles } from "lucide-react";
import { analyzeSymbol, searchSymbols, type AnalyzeResult } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface ResultDetail {
  ta_score?: number;
  der_score?: number;
  ta_detail?: string[];
  der_detail?: string[];
  gate_block?: boolean;
  gate_reason?: string;
  veto_reason?: string;
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

export default function Analyze(): JSX.Element {
  const [symbol, setSymbol] = useState("");
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const normalizedSymbol = useMemo(() => normalizeSymbol(symbol), [symbol]);

  // FIX: searchSymbols returns string[] not SymbolOption[]
  const { data: symbols } = useSWR(
    normalizedSymbol.length >= 1 ? ["symbols", normalizedSymbol] : null,
    () => searchSymbols(normalizedSymbol),
    { keepPreviousData: true, dedupingInterval: 500 }
  );

  const runAnalysis = async (): Promise<void> => {
    if (!normalizedSymbol) return;
    try {
      setIsAnalyzing(true);
      setError(null);
      setResult(null);
      const response = await analyzeSymbol(normalizedSymbol, 30000);
      setResult(response);
    } catch (unknownError) {
      if (unknownError instanceof DOMException && unknownError.name === "AbortError") {
        setError("Timeout : l'analyse a dépassé 30 secondes.");
      } else if (unknownError instanceof Error) {
        setError(unknownError.message);
      } else {
        setError("Erreur inconnue pendant l'analyse.");
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Analyse manuelle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runAnalysis()}
              placeholder="BTCUSDT, ETHUSDT, SOLUSDT..."
              className="pl-9"
              list="symbols-autocomplete"
              autoComplete="off"
            />
            <datalist id="symbols-autocomplete">
              {symbols?.map((sym) => (
                <option key={sym} value={sym} />
              ))}
            </datalist>
          </div>
          <Button
            onClick={runAnalysis}
            disabled={!normalizedSymbol || isAnalyzing}
            className="w-full sm:w-auto"
          >
            {isAnalyzing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Analyser
          </Button>
          {error ? (
            <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Résultat {result.symbol}
              <Badge
                variant={
                  result.signal === "LONG"
                    ? "success"
                    : result.signal === "SHORT"
                    ? "destructive"
                    : "secondary"
                }
              >
                {result.signal}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(() => {
              const detail = result.result as ResultDetail;
              const taDetail  = Array.isArray(detail?.ta_detail)  && detail.ta_detail!.length  > 0 ? detail.ta_detail  : null;
              const derDetail = Array.isArray(detail?.der_detail) && detail.der_detail!.length > 0 ? detail.der_detail : null;
              const isBlocked = Boolean(detail?.gate_block || detail?.veto_reason);
              return (
                <>
                  {/* Score global */}
                  <div className="flex items-end gap-4">
                    <div>
                      <div className="text-xs text-muted-foreground">Score global</div>
                      <div className="text-3xl font-semibold">
                        {(result.total ?? (detail as Record<string,unknown>)?.total as number ?? 0)}/10
                      </div>
                    </div>
                    {detail?.ta_score !== undefined ? (
                      <>
                        <div>
                          <div className="text-xs text-muted-foreground">TA</div>
                          <div className="text-xl font-semibold text-emerald-400">{String(detail.ta_score)}/5</div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">DER</div>
                          <div className="text-xl font-semibold text-sky-400">{String(detail.der_score)}/5</div>
                        </div>
                      </>
                    ) : null}
                  </div>

                  {/* Gate / Veto warnings */}
                  {detail?.gate_block ? (
                    <div className="rounded-xl border border-orange-900/60 bg-orange-950/30 px-3 py-2 text-xs text-orange-300">
                      GATE bloqué — {String(detail.gate_reason ?? "")}
                    </div>
                  ) : null}
                  {detail?.veto_reason ? (
                    <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                      VETO DER — {String(detail.veto_reason)}
                    </div>
                  ) : null}

                  {/* TA details — masqué si vide */}
                  {taDetail ? (
                    <div>
                      <div className="mb-1 text-xs text-muted-foreground">Signaux TA</div>
                      <div className="flex flex-wrap gap-1.5">
                        {taDetail.map((d, i) => (
                          <span key={i} className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-mono">{d}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* DER details — masqué si vide (BUG #1 fix) */}
                  {derDetail ? (
                    <div>
                      <div className="mb-1 text-xs text-muted-foreground">Signaux Derivatives</div>
                      <div className="flex flex-wrap gap-1.5">
                        {derDetail.map((d, i) => (
                          <span key={i} className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-mono">{d}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* LLM decision — avec indication si non consulté (BUG #3 fix) */}
                  {result.llm ? (
                    <div>
                      <div className="text-xs text-muted-foreground">Décision LLM</div>
                      <p className="mt-1 rounded-xl border border-border bg-muted/30 p-3 text-sm leading-6">
                        {result.llm.decision}
                      </p>
                      {result.llm.reasoning ? (
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">{result.llm.reasoning}</p>
                      ) : null}
                    </div>
                  ) : isBlocked ? (
                    <div className="text-xs italic text-destructive/80">LLM non consulté — signal bloqué</div>
                  ) : (
                    <div className="text-xs italic text-muted-foreground">État LLM inconnu</div>
                  )}
                </>
              );
            })()}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
