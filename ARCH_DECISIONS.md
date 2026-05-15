# Décisions d'architecture à trancher — PerpEdge v2

3 points de désaccord entre Claude et Gemini sur l'implémentation des améliorations.
Chaque point expose les deux positions avec leurs arguments. L'architecte tranche.

---

## ADR-1 : Basis Premium — Proxy de mesure du "momentum sain"

### Contexte
Le basis premium pénalise actuellement tout LONG avec -1.5 de manière systématique.
Claude et Gemini s'accordent sur le fait qu'il faut le rendre contextuel.
**Le désaccord porte sur la donnée à utiliser pour distinguer premium sain vs toxique.**

### Position Gemini
Utiliser le **CVD Spot** comme signal de conviction :
```
Premium sain   : Basis premium + CVD spot en hausse + OI en hausse → +1.0
Premium toxique: Basis premium + CVD spot flat/baisse + OI flat    → -1.5
```
**Argument :** Le CVD spot représente les flux d'achat réels sur le marché physique.
Si le spot est acheté agressivement, le premium basis est justifié.

### Position Claude
Le CVD spot n'est **pas disponible** dans le pipeline actuel.
Le `cvd_divergence` du scorer vient des klines **perp** Binance (takerBuyQuote/totalQuote).
Utiliser le **funding rate delta** comme proxy :
```
Premium sain   : Basis premium + funding_rate augmente sur 2 périodes consécutives
                 + oi_change_pct_1h > 0 → momentum réel → +1.0
Premium toxique: Basis premium + funding_rate stable/baisse
                 + oi_change_pct_1h <= 0 → levier stagnant → -1.5
```
**Argument :** Le funding delta est déjà dans le pipeline (funding-history + perp-snapshot).
Ajouter le CVD spot nécessite un endpoint TA spot séparé (+1 appel API par cycle).

### Question pour l'architecte
> Faut-il ajouter un appel TA spot dédié (`/ta-analysis?symbol=X&market=spot`) pour avoir le vrai CVD spot, ou le funding delta est-il un proxy suffisant pour qualifier un premium comme "momentum sain" vs "levier exhausted" ?

### Implications
- **Gemini** : +1 appel API par cycle (latence +300-500ms), données plus précises
- **Claude** : 0 appel supplémentaire, proxy moins précis mais immédiatement implémentable

---

## ADR-2 : Détection précoce OI — REST polling vs WebSocket

### Contexte
Le scanner OI actuel (`period=1h, min_oi_change_pct=10`) détecte les explosions OI trop tard.
SAGAUSDT (+45.9% OI sur 4h) n'a pas été capturé avant que le move soit terminé.
**Le désaccord porte sur l'architecture de collecte des données OI en temps réel.**

### Position Gemini
Garder REST mais sur des fenêtres plus courtes :
```python
oi_5m_change  = (current_oi - oi_5m_ago)  / oi_5m_ago   # >2%  → trigger
oi_15m_change = (current_oi - oi_15m_ago) / oi_15m_ago  # >5%  → trigger
```
Appeler `/scan/oi-movers` toutes les 5 minutes avec `period=5m`.
**Argument :** Architectural continuité — reste dans le modèle REST actuel, simple à implémenter.

### Position Claude
Le polling REST toutes les 5min sur 30 tokens = 6 appels/min × 30 tokens = risque rate limit.
Binance expose un WebSocket stream OI :
```
wss://fstream.binance.com/stream?streams=btcusdt@openInterest/ethusdt@openInterest/...
```
Un seul socket sur les 20-30 tokens prioritaires, callback déclenche Phase 2+3 à la demande.
**Argument :** Latence réelle <1s vs 5min, zéro polling, pas de rate limit.

### Question pour l'architecte
> L'architecture perp-mcp-server supporte-t-elle des WebSockets clients sortants vers Binance, et est-il préférable de gérer le stream OI côté serveur MCP (qui expose ensuite un endpoint `/oi-stream/subscribe`) ou côté perpedge-bot directement en Node.js ?

### Implications
- **Gemini (REST)** : Implémentation en 2h, mais détection à 5min minimum, risque rate limit
- **Claude (WebSocket)** : Implémentation en 1-2 jours, latence <1s, architecture plus complexe, choix d'où placer le socket (MCP server vs bot)

### Contrainte à clarifier
Binance limite les WebSocket connections à 300 streams par connexion et 1024 connexions.
Avec 20-30 tokens surveillés, on reste bien dans les limites. Mais le MCP server est sur VPS
(83-228-242-106) — le bot est en local Windows. Où doit vivre le WebSocket ?

---

## ADR-3 : Remplacement du hardFloor — Définition des signaux DER "toxiques"

### Contexte
`hardFloor = derResult.score < 2.5` rejette automatiquement tout trade avec DER faible,
même si le TA est solide. GUAUSDT : DER=-1.5 (basis premium -1.5 + OI indispo -0.5),
TA=3.0, MSB bullish → rejeté. Il a fait +31.5%.
Claude et Gemini s'accordent pour remplacer le hardFloor par une logique de veto ciblée.
**Le désaccord porte sur la définition précise des critères de veto.**

### Position Gemini
Logique ouverte :
```
if TA >= 3.0 and not has_toxic_der_signal(token): proceed
```
"Toxic signal" défini par exemple comme :
> "Long setup, mais 80% des liquidations côté short dans les 5 prochaines minutes"
**Argument :** Flexibilité maximale, à affiner par l'expérience.
**Problème :** Non implémentable en l'état — "prochaines minutes" est prospectif,
les liquidations futures sont inconnues.

### Position Claude
3 vetos durs précisément définis, tous sur données disponibles maintenant :

```javascript
function hasToxicDerSignal(der, direction) {
  // Veto 1 : Capitulation déjà faite — OI s'effondre dans le sens du trade
  const oiCrash = direction === 'long'
    ? (der.oi1h?.oi_change_pct ?? 0) < -15
    : (der.oi1h?.oi_change_pct ?? 0) >  15;
  if (oiCrash) return 'OI capitulation confirmée — move épuisé';

  // Veto 2 : Incohérence inter-exchange — signal non fiable
  const meRates = (der.meFunding?.exchanges ?? []).map(e => e.funding_rate).filter(r => r != null);
  const spread  = meRates.length >= 2 ? Math.max(...meRates) - Math.min(...meRates) : 0;
  if (spread > 0.001) return 'Funding inter-exchange divergent >0.10% — signal contradictoire';

  // Veto 3 : CVD contredit la direction — flux réel opposé au trade
  const cvdDiv = der.snapshot?.cvd_divergence ?? 'none';
  if ((direction === 'long'  && cvdDiv === 'bearish') ||
      (direction === 'short' && cvdDiv === 'bullish'))
    return 'CVD divergence opposée — takers vendent contre le setup';

  return null;
}

// Remplacement du hardFloor
const hardFloor = taResult.score >= 3.0
  ? hasToxicDerSignal(der, taResult.direction)  // null = pas de veto
  : derResult.score < 2.5;                       // TA faible → ancien hardFloor maintenu
```

**Argument :** Chaque veto est testable, basé sur des données existantes, et correspond
à un scénario de marché précis. Aucune donnée prospective.

### Question pour l'architecte
> Les 3 vetos proposés par Claude couvrent-ils les cas dangereux réels, ou manque-t-il un 4ème veto (ex: RV extreme + direction contre-tendance 1D) ? Et faut-il maintenir l'ancien hardFloor comme filet de sécurité quand TA < 3.0, ou le supprimer complètement ?

### Implications
- **Gemini** : Nécessite une définition future des "toxic signals" — non implémentable aujourd'hui
- **Claude** : Implémentable maintenant, les 3 vetos couvrent les cas connus. Risque : sous-spécification si un nouveau cas toxique émerge en live

---

## Résumé des décisions à rendre

| # | Question | Gemini préconise | Claude préconise |
|---|---|---|---|
| ADR-1 | Proxy du momentum sain | CVD spot (nouvel appel API) | Funding delta (données existantes) |
| ADR-2 | Détection OI précoce | REST 5min polling | WebSocket stream, côté MCP ou bot ? |
| ADR-3 | Définition veto DER | Logique ouverte (à affiner) | 3 vetos précis implémentables maintenant |
