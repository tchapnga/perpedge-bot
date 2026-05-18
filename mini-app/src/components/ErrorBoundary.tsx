import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info);
  }

  resetErrorBoundary(): void {
    this.setState({ hasError: false, error: undefined });
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="m-4 rounded-xl border border-red-900/60 bg-red-950/20 p-4 text-sm">
          <div className="font-semibold text-red-300">Erreur d'affichage</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {this.state.error?.message ?? "Erreur inattendue"}
          </p>
          <button
            className="mt-3 rounded-lg bg-red-700/40 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-700/60"
            onClick={() => this.resetErrorBoundary()}
          >
            Réessayer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
