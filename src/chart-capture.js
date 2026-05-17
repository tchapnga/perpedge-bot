import { join }      from 'path';
import { tmpdir }    from 'os';
import { unlink }    from 'fs/promises';
import { randomUUID } from 'crypto';

// HTML-escape for text nodes (symbol injected into <div> content)
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Safe JSON for <script> context: prevent HTML parser from breaking on </script>
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
}

const TF_MAP = {
  '1m':'1m', '3m':'3m', '5m':'5m', '15m':'15m', '30m':'30m',
  '1h':'1h', '2h':'2h', '4h':'4h', '1d':'1d', '1w':'1w',
};

// ── Fetch OHLCV depuis Binance Futures ────────────────────────────────────────
async function fetchKlines(symbol, interval, limit = 120) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  const raw  = await res.json();
  return raw.map(k => ({
    time:   Math.floor(k[0] / 1000),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ── Calcul EMA ────────────────────────────────────────────────────────────────
function calcEMA(candles, period) {
  const k   = 2 / (period + 1);
  let ema   = candles[0].close;
  return candles.map((c, i) => {
    if (i === 0) { ema = c.close; return { time: c.time, value: +ema.toFixed(8) }; }
    ema = c.close * k + ema * (1 - k);
    return { time: c.time, value: +ema.toFixed(8) };
  });
}

function fmtPrice(p) {
  if (!p) return '';
  return p < 1 ? p.toPrecision(4) : p.toFixed(2);
}

// ── Génération HTML avec TradingView Lightweight Charts ───────────────────────
function buildChartHTML(symbol, timeframe, candles, levels) {
  const ema21      = calcEMA(candles, 21);
  const ema50      = calcEMA(candles, 50);
  const lastCandle = candles[candles.length - 1];
  const isShort    = levels?.signal?.toUpperCase().includes('SHORT');
  const dir        = levels?.signal ? (isShort ? 'SHORT' : 'LONG') : '';

  // Lignes de niveaux
  const levelLines = [];
  if (Number.isFinite(levels?.entry)) levelLines.push({ price: levels.entry, color: '#3b82f6', title: `ENTRY $${fmtPrice(levels.entry)}`, width: 2 });
  if (Number.isFinite(levels?.tp))    levelLines.push({ price: levels.tp,    color: '#22c55e', title: `TP    $${fmtPrice(levels.tp)}`,    width: 2 });
  if (Number.isFinite(levels?.sl))    levelLines.push({ price: levels.sl,    color: '#ef4444', title: `SL    $${fmtPrice(levels.sl)}`,    width: 2 });

  // Plage de prix incluant TOUS les niveaux (pour autoscaleInfoProvider)
  const allPrices = [
    ...candles.map(c => c.high),
    ...candles.map(c => c.low),
    ...levelLines.map(l => l.price),
  ];
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);
  const pad  = (maxP - minP) * 0.10;

  // Bannière niveaux (header bas)
  const levelsBar = levelLines.length > 0
    ? levelLines.map(l => {
        const c = l.color;
        return `<span style="color:${c}">${l.title}</span>`;
      }).join('&nbsp;&nbsp;&nbsp;')
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#131722; font-family:'Inter',sans-serif; color:#d1d4dc; }
  #h1 {
    display:flex; justify-content:space-between; align-items:center;
    padding:7px 12px; background:#1e2230; border-bottom:1px solid #2a2e39;
    font-size:14px;
  }
  #h1 .sym { font-weight:700; font-size:15px; }
  .badge {
    font-size:12px; font-weight:700; padding:2px 8px; border-radius:4px;
    margin-left:8px;
    background:${isShort ? '#3a1a1a' : '#1a3a2a'};
    color:${isShort ? '#f87171' : '#4ade80'};
  }
  #h2 {
    padding:5px 12px; background:#181d2b; border-bottom:1px solid #2a2e39;
    font-size:12px; color:#9598a1;
    display:flex; gap:24px; align-items:center;
  }
  #h2 b { color:#d1d4dc; }
  #h3 {
    padding:5px 12px; background:#141824; border-bottom:1px solid #2a2e39;
    font-size:12.5px; font-weight:600;
    display:flex; gap:28px;
  }
  #chart-main { width:960px; height:400px; }
  #chart-vol  { width:960px; height:90px; }
  #legend {
    position:absolute; top:${levelsBar ? 82 : 36}px; left:12px;
    font-size:11px; display:flex; gap:14px; z-index:10;
  }
  #legend span { display:flex; align-items:center; gap:4px; }
  .dot { width:12px; height:3px; border-radius:2px; }
  #container { position:relative; }
</style>
</head>
<body>

<!-- Ligne 1 : symbole + direction -->
<div id="h1">
  <div class="sym">
    ${esc(symbol)} · ${esc(timeframe.toUpperCase())} · Binance Perpetual
    ${dir ? `<span class="badge">${dir === 'SHORT' ? '🔴' : '🟢'} ${esc(dir)}</span>` : ''}
  </div>
  <div style="font-size:13px; color:#9598a1">
    O <b style="color:#d1d4dc">${fmtPrice(lastCandle.open)}</b>&nbsp;
    H <b style="color:#26a69a">${fmtPrice(lastCandle.high)}</b>&nbsp;
    L <b style="color:#ef5350">${fmtPrice(lastCandle.low)}</b>&nbsp;
    C <b style="color:#d1d4dc">${fmtPrice(lastCandle.close)}</b>
  </div>
</div>

<!-- Ligne 2 : niveaux ENTRY / TP / SL -->
${levelsBar ? `<div id="h3">${levelsBar}</div>` : ''}

<div id="container">
  <div id="legend">
    <span><div class="dot" style="background:#29b6f6"></div> EMA 21</span>
    <span><div class="dot" style="background:#ff9800"></div> EMA 50</span>
    ${levelLines.map(l => `<span><div class="dot" style="background:${l.color}"></div>${l.title.split(' ')[0]}</span>`).join('')}
  </div>
  <div id="chart-main"></div>
  <div id="chart-vol"></div>
</div>

<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<script>
const candles    = ${safeJson(candles)};
const ema21data  = ${safeJson(ema21)};
const ema50data  = ${safeJson(ema50)};
const levelLines = ${safeJson(levelLines)};
const minP       = ${minP - pad};
const maxP       = ${maxP + pad};

// ── Chart principal ──────────────────────────────────────────────────────────
const chart = LightweightCharts.createChart(document.getElementById('chart-main'), {
  width: 960, height: 400,
  layout:    { background: { color: '#131722' }, textColor: '#9598a1' },
  grid:      { vertLines: { color: '#1e2230' }, horzLines: { color: '#1e2230' } },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#2a2e39', scaleMargins: { top: 0.05, bottom: 0.05 } },
  timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
});

const candleSeries = chart.addCandlestickSeries({
  upColor: '#26a69a', downColor: '#ef5350',
  borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
});
candleSeries.setData(candles);

// Forcer l'axe Y à inclure TOUS les niveaux (entry/SL/TP peuvent être hors des bougies)
if (levelLines.length > 0) {
  candleSeries.applyOptions({
    autoscaleInfoProvider: () => ({
      priceRange: { minValue: minP, maxValue: maxP },
      margins: { above: 0.12, below: 0.12 },
    }),
  });
}

const ema21Series = chart.addLineSeries({
  color: '#29b6f6', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false,
});
ema21Series.setData(ema21data);

const ema50Series = chart.addLineSeries({
  color: '#ff9800', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false,
});
ema50Series.setData(ema50data);

// Tracer les lignes horizontales entry/TP/SL avec label sur l'axe des prix
levelLines.forEach(({ price, color, title, width }) => {
  candleSeries.createPriceLine({
    price, color, lineWidth: width,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title,
  });
});

chart.timeScale().fitContent();

// ── Volume ───────────────────────────────────────────────────────────────────
const volChart = LightweightCharts.createChart(document.getElementById('chart-vol'), {
  width: 960, height: 90,
  layout: { background: { color: '#131722' }, textColor: '#9598a1' },
  grid:   { vertLines: { color: '#1e2230' }, horzLines: { color: 'transparent' } },
  rightPriceScale: {
    borderColor: '#2a2e39', scaleMargins: { top: 0.05, bottom: 0 }, drawTicks: false,
  },
  timeScale: { visible: false },
  crosshair: { mode: LightweightCharts.CrosshairMode.Hidden },
});
const volSeries = volChart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
volSeries.setData(candles.map(c => ({
  time: c.time, value: c.volume,
  color: c.close >= c.open ? '#26a69a55' : '#ef535055',
})));
volChart.timeScale().fitContent();
</script>
</body>
</html>`;
}

// ── Export principal ──────────────────────────────────────────────────────────
export async function captureChart(symbol, timeframe = '1h', levels = null) {
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    console.warn('[chart-capture] playwright non disponible — chart ignoré');
    return null;
  }

  // Strict local validation — defense-in-depth even though symbol comes from internal code
  if (!/^[A-Z0-9._:-]{1,30}$/.test(symbol)) {
    console.warn(`[chart-capture] symbole invalide ignoré: ${symbol}`);
    return null;
  }

  const interval  = TF_MAP[timeframe] ?? '1h';
  const safeFile  = symbol.replace(/[^A-Z0-9]/g, '_');
  // randomUUID avoids filename collisions on concurrent captures
  const outPath   = join(tmpdir(), `perpedge_${safeFile}_${randomUUID()}.png`);

  let browser;
  try {
    const candles = await fetchKlines(symbol, interval, 120);
    if (!candles.length) throw new Error('No klines data');

    const html = buildChartHTML(symbol, timeframe, candles, levels);

    browser = await pw.chromium.launch({
      headless: true,
      // --no-sandbox required on VPS kernels without unprivileged user namespaces;
      // acceptable here because HTML content is fully under our control (no user input rendered).
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx  = await browser.newContext({ viewport: { width: 960, height: 560 } });
    const page = await ctx.newPage();

    await page.setContent(html, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(2500);

    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 960, height: 560 } });
    await ctx.close();

    console.log(`[chart-capture] ✓ ${symbol} ${timeframe} → ${outPath}`);
    return outPath;
  } catch (err) {
    console.warn(`[chart-capture] ${symbol} ${timeframe}: ${err.message.slice(0, 120)}`);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function cleanChart(path) {
  if (path) await unlink(path).catch(() => {});
}
