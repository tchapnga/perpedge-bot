# PerpEdge Bot — Contexte complet pour analyse critique

## Objectif de l'analyse

Le bot n'a capturé aucun des top movers du 12 mai 2026 (gainers +20% à +49%, losers -9% à -14%).
L'objectif est de diagnostiquer pourquoi et de proposer des améliorations concrètes.
Analyse demandée : sans biais, avec arguments contradictoires si nécessaire.

---

## 1. Architecture du système

```
Binance Futures USDT-M
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ PHASE 1 — Scanner (5 scanners en parallèle)         │
│ Sélection : token apparaissant dans ≥ 2 scans       │
│ Output : 1 token (le plus présent)                  │
└───────────────────┬─────────────────────────────────┘
                    │
        ┌───────────▼───────────┐
        │ PHASE 2 — TA Engine   │
        │ RSI, MACD, EMA, VWAP, │
        │ BB, S/R, MSB 4h       │
        └───────────┬───────────┘
                    │
        ┌───────────▼───────────┐
        │ PHASE 3 — Derivatives │
        │ Funding, OI, Orderbook│
        │ Liquidations, Multi-X │
        └───────────┬───────────┘
                    │
        ┌───────────▼───────────┐
        │ SCORER — Score 0-10   │
        │ TA (0-5) + DER (0-5)  │
        │ Hard gates → bloquer  │
        └───────────┬───────────┘
                    │
        Signal : MARKET_LONG / MARKET_SHORT / PENDING_LIMIT / NO_TRADE
```

Le bot tourne toutes les **15 minutes** (`*/15 * * * *`).
Un squeeze watcher tourne toutes les **5 minutes** (séparé).

---

## 2. Phase 1 — Les 5 scanners et leurs paramètres

```javascript
scan.fundingExtremes()   → /scan/funding-extremes   { min_abs_rate: 0.0003, limit: 30 }
scan.oiMovers()          → /scan/oi-movers          { period: '1h', lookback: 4, min_oi_change_pct: 10, limit: 30 }
scan.fundingDivergence() → /scan/funding-divergence { limit: 30 }
scan.volatility()        → /scan/volatility         { min_volume_usd: 3_000_000, min_range_pct: 4, limit: 30 }
scan.crossExchange()     → /scan/cross-exchange-diff{ min_diff_pct: 0.05, limit: 20 }
```

**Règle de sélection :**
- Chaque scanner retourne une liste de symboles.
- On compte combien de fois chaque symbole apparaît dans les 5 scanners.
- Seuls les tokens avec **≥ 2 présences** sont candidats.
- Le bot sélectionne **le token avec le plus de présences** (en cas d'égalité : premier trié).
- Si aucun token ne passe le seuil ≥ 2 → `NO_TRADE` immédiat.

**Catégories pour bonus orthogonalité :**
```
funding_extremes   → FLUX
funding_divergence → FLUX
cross_exchange     → FLUX
oi_movers          → ENGAGEMENT
volatility         → MICROSTRUCTURE
```
→ Bonus +0.5 DER si Phase 1 a capturé ≥ 2 catégories distinctes.

---

## 3. Phase 2 — Score TA (0 à 5, non clampé)

### Base score depuis `ta_score_1h` (calculé par le serveur TA)
| ta_score_1h | Score base |
|---|---|
| 5 | 3.0 |
| 4 | 2.5 |
| 3 | 2.0 |
| 2 | 1.5 |
| 1 | 1.0 |
| 0 | 0.0 |

### Bonus
| Condition | Bonus |
|---|---|
| `trend_alignment === 'total'` (1D+4H+1H alignés) | +1.0 |
| Prix sur S/R (at_support ou at_resistance, ≤1%) | +0.5 |
| VWAP confirme la direction | +0.5 |
| MSB 4h dans le sens du trade | +1.0 |

### Malus
| Condition | Malus |
|---|---|
| Prix en zone de vide ET support+résistance à >3% | -0.5 |
| 1D et 4H contradictoires (bullish vs bearish) | -0.5 |
| MSB 4h contre-signal | -1.0 |

---

## 4. Phase 3 — Score DER (0 à 5, non clampé)

### Composantes positives
| Signal | Valeur |
|---|---|
| Funding extrême dans le sens du trade (seuil hybride : max(fixe, avg14j+delta)) | +1.5 |
| OI matrix confirme (OI+prix mouvement cohérent avec direction) | +1.5 |
| CVD divergence confirme | +0.5 |
| Multi-exchange funding convergence (OI-pondéré) | +0.5 |
| Liquidations favorables (dominant_side dans le sens du trade) | +0.5 |
| Orthogonalité Phase 1 (≥2 catégories distinctes) | +0.5 |

### Malus
| Condition | Malus |
|---|---|
| Spread funding inter-exchange > 0.10% | -0.5 |
| OI multi-exchange indisponible (<2 exchanges) | -0.5 |

### Basis modifier (Gemini Option A — direction-aware)
```
Direction LONG :
  basis = 'discount' ou 'neutral' → +1.0 (spot-driven, breakout valide)
  basis = 'premium'               → -1.5 (longs levier dominant, risque fakeout)

Direction SHORT :
  basis = 'premium'               → +1.0 (longs surendettés, squeeze potentiel)
  basis = 'discount'              → -0.5 (spot mène déjà la baisse)
  basis = 'neutral'               → 0
```

---

## 5. Gates — Bloqueurs durs avant signal

```javascript
// Gate 1 : RV climax (P95+) → Hard Block complet
if (rv.regime === 'climax') → gate_block = true

// Gate 2 : RV extreme (P80-P95) → reduce_size flag (trade possible, taille -50%)
if (rv.regime === 'extreme') → reduce_size = true

// Gate 3 : BTC corrélation forte + S/R contradictoire
// Direction-aware : LONG+BTC@support = OK, LONG+BTC@resistance = BLOQUÉ
if (corr.btc_corr_macro > 0.80 && BTC contradictoire) → gate_block = true
```

### Hard floors (rejet sans gate)
```javascript
// DER score < 2.5 → rejet automatique
hardFloor = derResult.score < 2.5

// TA très faible (≤1.0) sans DER exceptionnel
taLowFloor = taResult.score <= 1.0 && (derResult.score < 4.0 || oi1h_pct >= 0)
```

### Décision finale
```javascript
total = ta_score + der_score
force = total >= 7.0 ? 'FORT' : total >= 5.0 ? 'MODÉRÉ' : 'REJETÉ'

signal = rejected            ? 'NO_TRADE'
       : prix en void zone   ? 'PENDING_LIMIT'
       : direction === 'long' ? 'MARKET_LONG'
       : direction === 'short'? 'MARKET_SHORT'

// Notification Telegram uniquement si total >= 5.0 (MIN_SCORE)
```

---

## 6. Données marché du 12 mai 2026 (aujourd'hui)

### Top Gainers 24h — Binance USDT Perps
| Symbol | +% | Volume 24h | Funding 8h | OI Δ4h |
|---|---|---|---|---|
| SAGAUSDT | **+49.7%** | $406M | N/A | **+45.9% (EXPLOSIVE_BUILD)** |
| USELESSUSDT | **+42.3%** | $92M | +0.0377% | **+41.3% (EXPLOSIVE_BUILD)** |
| BUSDT | **+39.2%** | $531M | +0.0742% | +17.6% (STRONG_BUILD) |
| SKYAIUSDT | **+31.6%** | $242M | N/A | N/A |
| GUAUSDT | **+31.5%** | $29M | +0.0907% | N/A |
| IRYSUSDT | **+28.7%** | $57M | N/A | **+36.7% (EXPLOSIVE_BUILD)** |
| ESPORTSUSDT | **+26.5%** | $47M | +0.0501% | N/A |
| HUSDT | **+21.4%** | $154M | +0.0402% | N/A |

### Top Losers 24h — Binance USDT Perps
| Symbol | -% | Volume 24h | Funding 8h | OI Δ4h |
|---|---|---|---|---|
| USUSDT | **-14.4%** | $40M | N/A | **-27.1% (UNWINDING)** |
| AIGENSYNUSDT | **-13.4%** | $14M | +0.0436% (longs overcrowded) | N/A |
| LDOUSDT | **-9.7%** | $96M | N/A | **-19.3% (UNWINDING)** |
| VVVUSDT | **-7.6%** | $258M | -0.0346% | -15.1% (UNWINDING) |
| MEGAUSDT | **-8.7%** | $23M | -0.0453% | N/A |

---

## 7. Ce que le bot a réellement fait aujourd'hui

### Cycle observé (13h01 UTC)
```
[scanner] 6 candidate(s). Best: GUAUSDT (2 scans: funding_divergence, volatility)
[result]  NO_TRADE GUAUSDT — 1.5/10 (TA: 3.0 | DER: -1.5) — REJETÉ

TA detail  : +2.0 base (TA Score 3/5) | +0.5 VWAP confirme | -0.5 zone de vide
             | +1.0 MSB 4h bullish confirme long
DER detail : -0.5 OI multi-exchange indisponible | -1.5 basis premium
             | +0.5 confluence orthogonale (FLUX+MICROSTRUCTURE)

CTX : RV=normal | MSB=bullish | Basis=premium | BTCcorr=N/A
GATE : non bloqué (RV=normal) mais DER=-1.5 → hardFloor (DER < 2.5)
```

**GUAUSDT a fait +31.5% ce jour.**

### Cycles précédents
- HUSDT sélectionné plusieurs fois → NO_TRADE (RV elevated/extreme, basis premium)
- BUSDT sélectionné plusieurs fois → NO_TRADE (même raison)
- Squeeze watcher : 9-11 candidats LOW uniquement, aucun MEDIUM/HIGH déclenché

---

## 8. Analyse des causes identifiées

### Cause A : basis premium = hard block systématique sur les gros mouvements
Le basis premium applique -1.5 sur le DER score pour les LONG. Or les tokens qui font +30% en momentum ont **toujours** un basis premium — le perp se négocie avec une prime sur le spot parce que les acheteurs sont pressés. Le scorer interprète ça comme "risque fakeout" sans distinguer entre un premium dû à un levier excessif et un premium dû à de l'achat agressif au spot.

Résultat : **tout momentum LONG fort → pénalisé → rejeté**.

### Cause B : sélection single-token
Le bot choisit **1 seul token** par cycle. Aujourd'hui 6+ tokens ont fait >20% simultanément. Le bot ne peut structurellement pas capturer des mouvements parallèles.

### Cause C : OI explosions détectées trop tard
SAGAUSDT (+49.7%, OI +45.9%) : le mouvement démarre par un spike de prix, l'OI construit ensuite. Le scanner voit l'OI trop tard quand le move est déjà à +20-30%.

### Cause D : les losers auraient dû être catchés mais ne l'ont pas été
- AIGENSYNUSDT : funding +0.0436% (longs overcrowded) + chute -13.4% = SHORT évident. Volume $14M → probablement filtré en Phase 1 (min_volume_usd).
- LDOUSDT : OI -19.3% + prix -9.7% = capitulation longs. Volume $96M = OK. Pourquoi absent ?
- VVVUSDT : squeeze LOW -7.6% — le bot a vu mais ignoré (1/5 signaux squeeze).

### Cause E : timing (structurel)
Un cycle `*/15 min` avec analyse complète (7 appels API parallèles par token) arrive toujours après le déclenchement initial. Les moves de +20% intraday se font en 2-3 heures, souvent avec une chandelle initiale de +5-8% en 15 minutes.

---

## 9. Questions ouvertes pour le débat

1. **Le basis premium doit-il être un hard modifier (-1.5) ou contextuel ?**
   Doit-on distinguer premium dans un marché haussier (normal) vs premium excessif (>0.5% spot-perp spread) ?

2. **Les losers étaient-ils catchables ?**
   AIGENSYNUSDT (volume $14M) est sous le seuil du scanner volatility (min_volume_usd: $3M — donc il passe en théorie). Pourquoi le scanner ne l'a-t-il pas inclus ?

3. **Faut-il passer à un système multi-token ?**
   Sélectionner le top 3 candidats et scorer les 3, envoyer le meilleur trade actionable. Impact : 3x les API calls.

4. **Le seuil `min_oi_change_pct: 10` pour le scanner OI est-il suffisant pour détecter les explosions early ?**
   SAGAUSDT avait +45.9% sur 4h — mais quel était son OI change à 1h ou 2h avant le move ?

5. **Le cron `*/15 min` est-il trop lent ?**
   Passer à `*/5 min` pour la détection (Phase 1 seule), puis lancer la Phase 2+3 uniquement si signal Phase 1 détecté.

6. **La logique de rejection hardFloor (DER < 2.5) est-elle trop agressive ?**
   Aujourd'hui DER = -1.5 à cause d'un seul critère (basis premium -1.5). Un seul signal négatif fort peut tuer un setup TA solide (TA=3.0, MSB bullish confirmé).

---

## 10. Code complet du scorer (pour référence)

### scorer.js — scoreTa()
```javascript
function scoreTa(ta, msb) {
  const tf1h = ta.tf_1h;
  const direction = tf1h.ta_direction; // "long" | "short" | "neutral"
  const BASE_MAP = { 5: 3.0, 4: 2.5, 3: 2.0, 2: 1.5, 1: 1.0, 0: 0.0 };
  let score = BASE_MAP[ta.ta_score_1h] ?? 0.0;

  if (ta.trend_alignment === 'total') score += 1.0;
  const atSr = ta.sr.price_vs_sr === 'at_support' || ta.sr.price_vs_sr === 'at_resistance';
  if (atSr) score += 0.5;
  const vwapOk = (direction === 'long' && tf1h.vwap_position === 'above') ||
                 (direction === 'short' && tf1h.vwap_position === 'below');
  if (vwapOk) score += 0.5;
  const inVoid = ta.sr.price_vs_sr === 'in_void' && (nearestSupPct > 3) && (nearestResPct > 3);
  if (inVoid) score -= 0.5;
  const contradiction = (ta.tf_1d.trend === 'bullish' && ta.tf_4h.trend === 'bearish') ||
                        (ta.tf_1d.trend === 'bearish' && ta.tf_4h.trend === 'bullish');
  if (contradiction) score -= 0.5;
  if (msb?.last_msb === direction_word) score += 1.0;
  else if (msb?.last_msb === opposite_direction) score -= 1.0;

  return { score, detail, direction };
}
```

### scorer.js — scoreDer() — partie basis
```javascript
if (basis?.signal) {
  const sig = basis.signal; // 'premium' | 'neutral' | 'discount'
  if (direction === 'long') {
    if (sig === 'discount' || sig === 'neutral') score += 1.0;
    else score -= 1.5;  // premium → pénalité forte
  } else { // short
    if (sig === 'premium') score += 1.0;
    else if (sig === 'discount') score -= 0.5;
  }
}
```

### scorer.js — gates
```javascript
// Gate 1 : RV climax
if (rv?.regime === 'climax') { gateBlock = true; gateReason = 'RV climax...'; }

// Gate 2 : RV extreme → reduce size
if (!gateBlock && rv?.regime === 'extreme') reduceSize = true;

// Gate 3 : BTC correlation + S/R contradictoire
if (!gateBlock && corr?.btc_corr_macro > 0.80) {
  const btcState = btcTa?.sr?.price_vs_sr;
  const isBlockedLong  = direction === 'long'  && btcState === 'at_resistance';
  const isBlockedShort = direction === 'short' && btcState === 'at_support';
  if (isBlockedLong || isBlockedShort) gateBlock = true;
}

// Hard floor
const hardFloor = derResult.score < 2.5;
const rejected  = hardFloor || taLowFloor || gateBlock;
```
