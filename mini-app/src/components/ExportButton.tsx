import { useState } from "react";
import { Button } from "@/components/ui/button";
import { downloadExport } from "@/lib/api";

interface ExportButtonProps {
  isOperator: boolean;
}

export function ExportButton({ isOperator }: ExportButtonProps): JSX.Element | null {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  if (!isOperator) return null;

  const handleExport = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await downloadExport();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur export";
      setError(msg);
      window.setTimeout(() => setError(null), 5000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant="secondary"
        onClick={handleExport}
        disabled={loading}
      >
        {loading ? "📤 Export..." : "📥 Export CSV"}
      </Button>
      {error && (
        <span className="text-[11px] text-red-400 px-1">{error}</span>
      )}
    </div>
  );
}
