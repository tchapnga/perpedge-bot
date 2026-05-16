// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _env = (import.meta as any).env as Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _isProd = Boolean((import.meta as any).env?.PROD);

export const BASE_URL: string = _env["VITE_API_BASE"] ?? "http://localhost:3002";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
        enableClosingConfirmation?: () => void;
        colorScheme?: "light" | "dark";
        setHeaderColor?: (color: string) => void;
        setBackgroundColor?: (color: string) => void;
        themeParams?: {
          bg_color?: string;
          text_color?: string;
          hint_color?: string;
          link_color?: string;
          button_color?: string;
          button_text_color?: string;
          secondary_bg_color?: string;
        };
        HapticFeedback?: {
          notificationOccurred: (type: "error" | "success" | "warning") => void;
          impactOccurred: (style: "light" | "medium" | "heavy") => void;
        };
      };
    };
  }
}

export type BotMode = "LIVE" | "SHADOW" | "DRY_RUN";
export type NetworkEnv = "TESTNET" | "MAINNET";

export interface NetworkStatus {
  network: NetworkEnv;
  binanceTestnet: boolean;
}
export type PositionSide = "LONG" | "SHORT";
export type SignalSide = "LONG" | "SHORT" | "NO_TRADE";

// FIX: actual command names from admin-api.js
export type Command =
  | "PAUSE_NEW_ENTRIES"
  | "PAUSE_ALL"
  | "RESUME"
  | "EMERGENCY_STOP"
  | "RESET_EMERGENCY";

export interface BotStatus {
  mode: BotMode;
  isPaused: boolean;
  emergencyStopped: boolean;
  cycleCount: number;
  signalsToday: number;
  tradesExecuted: number;
  openPositions: number;
  unrealizedPnl: number;
  modules?: Record<string, boolean>;
  lastCycleAt?: string | null;
  startedAt?: string;
  lastSignal?: {
    time: string;
    symbol: string;
    signal: string;
    total: number;
  } | null;
}

export interface Position {
  symbol: string;
  side: PositionSide;
  entry: number;
  unrealizedPnl?: number;
  markPrice?: number;
  qty?: number;
}

export interface Signal {
  time: string;
  symbol: string;
  signal: string;
  total: number;
  llm_validation?: { decision: string; reasoning?: string };
}

export interface AnalyzeResult {
  symbol: string;
  signal: SignalSide;
  total: number;
  llm?: { decision: string; reasoning?: string };
  result?: Record<string, unknown>;
}

export interface CommandResult {
  ok: boolean;
  command: Command;
  state?: BotStatus;
}

type HttpMethod = "GET" | "POST" | "PATCH";

export function getAuthHeaders(): Record<string, string> {
  const initData = window.Telegram?.WebApp?.initData;
  if (initData && initData.trim().length > 0) {
    return { "X-Telegram-Init-Data": initData };
  }
  if (!_isProd && _env["VITE_DEV_ADMIN_ID"]) {
    return { "X-Admin-Id": _env["VITE_DEV_ADMIN_ID"] };
  }
  return {};
}

async function request<T>(
  path: string,
  options: { method?: HttpMethod; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const { method = "GET", body, signal } = options;
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    signal,
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `API ${method} ${path} failed: ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody}` : ""}`
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getStatus(): Promise<BotStatus> {
  return request<BotStatus>("/admin/status");
}

// FIX: endpoint returns { positions: [], scalp: [] }
export async function getPositions(): Promise<Position[]> {
  const res = await request<{ positions: Position[]; scalp: Position[] }>("/admin/positions");
  return [...(res.positions ?? []), ...(res.scalp ?? [])];
}

// FIX: endpoint returns { signals: [] }
export async function getSignals(): Promise<Signal[]> {
  const res = await request<{ signals: Signal[] }>("/admin/signals");
  return res.signals ?? [];
}

// FIX: endpoint is /admin/commands (plural)
export function postCommand(cmd: Command): Promise<CommandResult> {
  return request<CommandResult>("/admin/commands", {
    method: "POST",
    body: { command: cmd },
  });
}

export function analyzeSymbol(symbol: string, timeoutMs = 30000): Promise<AnalyzeResult> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  return request<AnalyzeResult>("/admin/analyze", {
    method: "POST",
    body: { symbol },
    signal: controller.signal,
  }).finally(() => window.clearTimeout(timeoutId));
}

export function patchConfig(body: { mode?: BotMode }): Promise<{ ok: boolean; state: BotStatus }> {
  return request<{ ok: boolean; state: BotStatus }>("/admin/config", {
    method: "PATCH",
    body,
  });
}

// FIX: endpoint is POST /admin/modules with body { module, enabled }
export function toggleModule(
  name: string,
  enabled: boolean
): Promise<{ ok: boolean; modules: Record<string, boolean> }> {
  return request<{ ok: boolean; modules: Record<string, boolean> }>("/admin/modules", {
    method: "POST",
    body: { module: name, enabled },
  });
}

// FIX: endpoint returns { symbols: string[] }
export async function searchSymbols(query: string): Promise<string[]> {
  const q = encodeURIComponent(query.trim());
  const res = await request<{ symbols: string[] }>(`/admin/symbols?q=${q}`);
  return res.symbols ?? [];
}

// ── P8D types ─────────────────────────────────────────────────────────────────
export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
}

export interface EquityPoint {
  date: string;
  pnl: number;
  cumPnl: number;
}

export interface RiskData {
  openPositions: number;
  totalExposure: number;
  totalMargin: number;
  unrealizedPnl: number;
  winRate: number | null;
  totalTrades: number;
  wins: number;
  losses: number;
  maxDrawdown: number;
  totalPnl: number;
}

// ── P8D API calls ─────────────────────────────────────────────────────────────
export async function getLogs(since?: string): Promise<{ logs: LogEntry[] }> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  return request<{ logs: LogEntry[] }>(`/admin/logs${qs}`);
}

export function getEquity(): Promise<{ series: EquityPoint[] }> {
  return request<{ series: EquityPoint[] }>("/admin/equity");
}

export function getRisk(): Promise<RiskData> {
  return request<RiskData>("/admin/risk");
}

// ── P8E types ─────────────────────────────────────────────────────────────────
export interface MyRole {
  userId: string;
  role: string;
}

export interface ReconcileResult {
  ok: boolean;
  binancePositions?: unknown[];
  botOnly?: { symbol: string }[];
  binanceOnly?: { symbol: string }[];
  mismatch?: {
    symbol: string;
    botDirection: string;
    botQty: number;
    binanceDirection: string;
    binanceQty: number;
  }[];
  error?: string;
}

// ── P8E API calls ─────────────────────────────────────────────────────────────
export function getMyRole(): Promise<MyRole> {
  return request<MyRole>("/admin/me");
}

export function getNetwork(): Promise<NetworkStatus> {
  return request<NetworkStatus>("/admin/network");
}

export function switchNetwork(
  network: NetworkEnv
): Promise<{ ok: boolean; network: NetworkEnv; restarting: boolean }> {
  return request<{ ok: boolean; network: NetworkEnv; restarting: boolean }>("/admin/network", {
    method: "POST",
    body: { network },
  });
}

export function getReconcile(): Promise<ReconcileResult> {
  return request<ReconcileResult>("/admin/reconcile");
}

export async function downloadExport(): Promise<void> {
  const res = await fetch(`${BASE_URL}/admin/export`, {
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
  });
  if (res.status === 404) throw new Error("Aucun trade disponible pour l'export.");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Export échoué: ${res.status}${body ? ` — ${body}` : ""}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  const cd = res.headers.get("content-disposition");
  let filename = `trades_${new Date().toISOString().split("T")[0]}.csv`;
  if (cd) {
    const m = cd.match(/filename="?([^"]+)"?/);
    if (m?.[1]) filename = m[1];
  }
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}
