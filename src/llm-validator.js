import Anthropic from '@anthropic-ai/sdk';

// ─── Shared ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = "Tu es le Validateur Final d'Execution du bot PerpEdge-Bot. Tu recois le resultat JSON de scoreSymbol() et tu dois decider si le signal doit etre execute. Principe: preservation du capital par defaut. Reponse UNIQUEMENT JSON: { decision: APPROVE|REJECT|CONTRARIAN_FLIP|PENDING, confidence: 0.0-1.0, reasoning: string max 200 chars, warnings: [] }. REGLES ABSOLUES (REJECT confidence 0.98): gate_block=true, signal=NO_TRADE, veto_reason non-null. REJET FORT: force=FAIBLE+total<6, ta_score<3, der_score<2+no contrarian, btc_corr>0.7+ta<3+msb oppose, msb oppose+rv high/extreme. CLIMAX RULE: si rv_regime extreme/climax - identifier crowded_side via crowded_trigger+contrarian_signal - si direction=crowded_side: CONTRARIAN_FLIP(der>=2) sinon REJECT - ne pas rejeter climax+LONG sans verifier crowded_side. APPROVE(toutes): gate_block false, non NO_TRADE, veto null, FORT/MODERE, total>=6, ta>=3, der>=2 ou contrarian, non-climax ou oppose crowded. confidence 0.80 +0.05 si der>=4 -0.10 si mixte. CONTRARIAN_FLIP(toutes): gate false, contrarian_signal, rv extreme/climax ou crowded_trigger, direction vulnerable, der>=2. confidence 0.92-0.94. PENDING: rv high, ta fort+der faible, total 5-6. confidence 0.55-0.74.";

// Prompt envoyé aux LLMs externes — sans aucune clé API ni secret
const LOCAL_PROMPT_HEADER = `Tu es un validateur de signal de trading crypto. Réponds UNIQUEMENT avec du JSON brut (aucun markdown, aucun texte avant ou après, juste le JSON):
{"decision":"APPROVE","confidence":0.85,"reasoning":"explication courte","warnings":[]}

Valeurs valides pour "decision": APPROVE, REJECT, CONTRARIAN_FLIP, PENDING
RÈGLES ABSOLUES:
- gate_block=true OU signal=NO_TRADE OU veto_reason non-null → REJECT confidence=0.98
- force=FAIBLE ET total<6 → REJECT confidence=0.80
- gate_block=false ET force=FORT/MODERE ET total>=6 ET ta_score>=3 → APPROVE confidence>=0.80
- contrarian_signal=true ET direction vulnérable (crowded_trigger ou rv extreme) → CONTRARIAN_FLIP
- conditions mixtes ou incertaines → PENDING confidence=0.55-0.74

Signal JSON à valider:
`;

const CHROME_PROFILE      = 'C:\\tools\\chrome-playwright-profile';
const MODEL               = 'claude-sonnet-4-6';
const TIMEOUT_MS          = 8000;
const LOCAL_MIN_RESPONSES = 2;   // Minimum LLMs valides requis pour accepter le consensus local
const VALID_DECISIONS     = new Set(['APPROVE', 'REJECT', 'CONTRARIAN_FLIP', 'PENDING']);

const LLM_CONFIGS = {
  deepseek: {
    url:              'https://chat.deepseek.com',
    inputSelector:    'textarea',
    responseSelector: '.ds-markdown',
    waitUntil:        'networkidle',
    selectorTimeout:  20000,
    waitMs:           16000,
  },
  chatgpt: {
    url:              'https://chatgpt.com',
    inputSelector:    '[role="textbox"]',
    responseSelector: '[data-message-author-role="assistant"]',
    waitUntil:        'domcontentloaded',
    selectorTimeout:  10000,
    waitMs:           12000,
  },
  gemini: {
    url:              'https://gemini.google.com/app',
    inputSelector:    '[role="textbox"]',
    responseSelector: '.model-response-text',
    waitUntil:        'domcontentloaded',
    selectorTimeout:  10000,
    waitMs:           16000,
  },
};

// ─── Logging horodaté ─────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }

function logLocal(level, llmName, msg) {
  const prefix = `[${ts()}][llm-validator:local]`;
  if (level === 'ok')   console.log( `${prefix} ✓ ${llmName} → ${msg}`);
  if (level === 'err')  console.error(`${prefix} ✗ ${llmName} → ${msg}`);
  if (level === 'warn') console.warn( `${prefix} ⚠  ${msg}`);
  if (level === 'info') console.log( `${prefix} ℹ  ${msg}`);
}

// ─── Alerte Telegram (mode local KO) ─────────────────────────────────────────

async function sendTelegramFallbackAlert(symbol, failedLLMs, validCount) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    logLocal('warn', '', 'Telegram non configuré — alerte KO non envoyée');
    return;
  }
  const failStr = failedLLMs.length ? failedLLMs.join(', ') : 'aucun';
  const text = [
    '⚠️ <b>PerpEdge — LLM Local KO</b>',
    '',
    `📊 Signal: <b>${symbol}</b>`,
    `❌ LLMs échoués: <b>${failStr}</b>`,
    `✅ Réponses valides: <b>${validCount}/3</b> (minimum requis: ${LOCAL_MIN_RESPONSES})`,
    '',
    '🔄 <b>Fallback Claude API activé</b> le temps de réparer.',
    '',
    '🔧 Causes possibles:',
    '  • Chrome ouvert avant le démarrage du bot',
    '  • Session expirée (ChatGPT / DeepSeek / Gemini)',
    '  • Playwright non installé ou navigateur manquant',
  ].join('\n');

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (res.ok) {
      logLocal('info', '', '✉️  Alerte Telegram envoyée — LLMs locaux KO');
    } else {
      logLocal('warn', '', `Alerte Telegram HTTP ${res.status}`);
    }
  } catch (e) {
    logLocal('warn', '', `Alerte Telegram échouée: ${e.message}`);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function extractTextContent(message) {
  if (!message?.content || !Array.isArray(message.content)) return '';
  return message.content
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
}

function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('Empty LLM response');
  try { return JSON.parse(s); } catch {}
  const codeBlock = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) { try { return JSON.parse(codeBlock[1].trim()); } catch {} }
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in LLM response');
  return JSON.parse(match[0]);
}

function normalizeDecision(raw) {
  const decision = String(raw?.decision || '').trim().toUpperCase();
  if (!VALID_DECISIONS.has(decision)) throw new Error(`Invalid validator decision: ${raw?.decision}`);
  const confidence = Number(raw?.confidence);
  if (!Number.isFinite(confidence)) throw new Error(`Invalid validator confidence: ${raw?.confidence}`);
  const reasoning = typeof raw?.reasoning === 'string'
    ? raw.reasoning.slice(0, 200)
    : String(raw?.reasoning ?? '').slice(0, 200);
  const warnings = Array.isArray(raw?.warnings) ? raw.warnings.map(w => String(w)) : [];
  return { decision, confidence: Math.max(0, Math.min(1, confidence)), reasoning, warnings };
}

function getSymbol(r) { return r?.symbol || r?.pair || r?.ticker || 'UNKNOWN'; }
function getTotal(r) {
  const t = r?.total ?? r?.total_score ?? r?.score ?? r?.final_score;
  return Number.isFinite(Number(t)) ? Number(t) : null;
}

function logDecision(scoreResult, v, mode = 'claude') {
  const total = getTotal(scoreResult);
  console.log(`[${ts()}][llm-validator:${mode}] ${v.decision} ${getSymbol(scoreResult)} ${total ?? '?'}/10 confidence=${Number(v.confidence ?? 0).toFixed(2)}`);
  if (v.warnings?.length) console.log(`  [llm-validator:${mode}] warnings: ${v.warnings.join(' | ')}`);
}

function failOpen(reason = 'validator_timeout') {
  return { decision: 'PENDING', confidence: 0.5, reasoning: reason, warnings: [] };
}

// ─── VPS mode — Anthropic API ─────────────────────────────────────────────────

let anthropic;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function callValidatorClaude(scoreResult) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY absent');
  const msg = await anthropic.messages.create(
    { model: MODEL, temperature: 0.1, max_tokens: 300, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(scoreResult) }] },
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  return normalizeDecision(extractJson(extractTextContent(msg)));
}

// ─── Local mode — Playwright multi-LLM ───────────────────────────────────────

async function queryLLMPage(browser, llmName, prompt) {
  const cfg  = LLM_CONFIGS[llmName];
  const page = await browser.newPage();
  try {
    await page.goto(cfg.url, { waitUntil: cfg.waitUntil, timeout: 20000 });
    await page.bringToFront();
    await page.waitForSelector(cfg.inputSelector, { timeout: cfg.selectorTimeout });
    await page.locator(cfg.inputSelector).fill(prompt);
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(cfg.waitMs);

    const el = page.locator(cfg.responseSelector).last();
    let text  = await el.innerText({ timeout: 8000 }).catch(() => '');
    if (!text.includes('{')) {
      await page.waitForTimeout(6000);
      text = await el.innerText({ timeout: 8000 }).catch(() => '');
    }
    if (!text) throw new Error('Empty LLM response');
    return normalizeDecision(extractJson(text));
  } finally {
    await page.close().catch(() => {});
  }
}

async function runLocalLLMs(browser, llmNames, prompt) {
  const results = [];
  for (const name of llmNames) {
    const t0     = Date.now();
    const result = await queryLLMPage(browser, name, prompt)
      .then(v => {
        logLocal('ok', name, `${v.decision} ${v.confidence.toFixed(2)} (${Date.now() - t0}ms) — ${v.reasoning}`);
        return { status: 'fulfilled', value: v };
      })
      .catch(e => {
        logLocal('err', name, `${e.message} (${Date.now() - t0}ms)`);
        return { status: 'rejected', reason: e };
      });
    results.push({ name, result });
  }
  return results;
}

function buildConsensus(entries) {
  const counts  = { APPROVE: 0, REJECT: 0, CONTRARIAN_FLIP: 0, PENDING: 0 };
  const details = [];
  const failed  = [];
  let totalConf  = 0;
  let validCount = 0;

  for (const { name, result } of entries) {
    if (result.status === 'fulfilled') {
      const v = result.value;
      counts[v.decision] = (counts[v.decision] || 0) + 1;
      totalConf += v.confidence;
      validCount++;
      details.push(`${name}:${v.decision}(${v.confidence.toFixed(2)})`);
    } else {
      failed.push(name);
      details.push(`${name}:FAIL`);
    }
  }

  return { counts, details, failed, totalConf, validCount };
}

function decideFromCounts(counts, validCount) {
  const needed = 2;
  if (counts.REJECT          >= needed) return 'REJECT';
  if (counts.APPROVE         >= needed) return 'APPROVE';
  if (counts.CONTRARIAN_FLIP >= needed) return 'CONTRARIAN_FLIP';
  return 'PENDING';
}

async function validateSignalLocal(scoreResult) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    logLocal('err', '', 'playwright non installé — run: npm install playwright && npx playwright install chromium');
    return failOpen('playwright_not_installed');
  }

  const { chromium } = playwright;
  const llmNames = ['deepseek', 'chatgpt', 'gemini'];
  const prompt   = LOCAL_PROMPT_HEADER + JSON.stringify(scoreResult);
  const symbol   = getSymbol(scoreResult);

  let browser;
  try {
    browser = await chromium.launchPersistentContext(CHROME_PROFILE, {
      headless: false,
      channel:  'chrome',
      args:     ['--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    logLocal('err', '', `Profil Chrome verrouillé (Chrome ouvert ?): ${err.message}`);
    await sendTelegramFallbackAlert(symbol, ['chrome_locked'], 0);
    return await tryClaudeFallback(scoreResult, 'chrome_profile_locked');
  }

  try {
    const entries = await runLocalLLMs(browser, llmNames, prompt);
    const { counts, details, failed, totalConf, validCount } = buildConsensus(entries);

    logLocal('info', '', `Résultat: ${validCount}/3 LLMs valides [${details.join(', ')}]`);

    // Seuil minimum non atteint → alerte Telegram + fallback Claude
    if (validCount < LOCAL_MIN_RESPONSES) {
      logLocal('warn', '', `Seulement ${validCount}/3 LLMs ont répondu (minimum: ${LOCAL_MIN_RESPONSES}) → fallback Claude API`);
      await sendTelegramFallbackAlert(symbol, failed, validCount);
      return await tryClaudeFallback(scoreResult, `local_only_${validCount}_of_3`);
    }

    const decision  = decideFromCounts(counts, validCount);
    const avgConf   = totalConf / validCount;
    const reasoning = `Local[${details.join(', ')}]`.slice(0, 200);
    return { decision, confidence: Math.min(avgConf, 0.90), reasoning, warnings: [] };

  } finally {
    await browser.close().catch(() => {});
  }
}

async function tryClaudeFallback(scoreResult, reason) {
  if (!process.env.ANTHROPIC_API_KEY) {
    logLocal('err', '', `Pas de clé Anthropic disponible pour le fallback (raison: ${reason})`);
    return failOpen(reason);
  }
  try {
    logLocal('info', '', 'Tentative fallback Claude API...');
    const v = await callValidatorClaude(scoreResult);
    logLocal('ok', 'claude-fallback', `${v.decision} ${v.confidence.toFixed(2)} — ${v.reasoning}`);
    return { ...v, reasoning: `[fallback-claude:${reason}] ${v.reasoning}`.slice(0, 200) };
  } catch (err) {
    logLocal('err', '', `Fallback Claude échoué: ${err.message}`);
    return failOpen(`fallback_failed:${reason}`);
  }
}

// ─── Mode detection ───────────────────────────────────────────────────────────

function resolveMode() {
  const explicit = (process.env.LLM_MODE || '').toLowerCase();
  if (explicit === 'local') {
    const isHeadlessLinux = process.platform === 'linux' && !process.env.DISPLAY;
    if (isHeadlessLinux) {
      console.warn(`[${ts()}][llm-validator] ⚠️  LLM_MODE=local sur VPS Linux sans DISPLAY → fallback automatique Claude API`);
      return 'claude';
    }
    return 'local';
  }
  if (explicit === 'claude') return 'claude';
  return process.env.ANTHROPIC_API_KEY ? 'claude' : 'local';
}

// ─── Public API ───────────────────────────────────────────────────────────────

let _modePrinted = false;

export async function validateSignal(scoreResult) {
  const mode    = resolveMode();
  const isLocal = mode === 'local';
  if (!_modePrinted) {
    console.log(`[${ts()}][llm-validator] Mode ${isLocal ? 'LOCAL (DeepSeek+ChatGPT+Gemini via Playwright)' : 'VPS (Claude API)'} [LLM_MODE=${process.env.LLM_MODE || 'auto'}]`);
    _modePrinted = true;
  }

  if (isLocal) {
    try {
      const validation = await validateSignalLocal(scoreResult);
      logDecision(scoreResult, validation, 'local');
      return validation;
    } catch (err) {
      console.error(`[${ts()}][llm-validator:local] Erreur inattendue: ${err?.message ?? err}`);
      const validation = failOpen('local_mode_error');
      logDecision(scoreResult, validation, 'local');
      return validation;
    }
  }

  // VPS mode — Claude API avec retry JSON
  try {
    let validation;
    try {
      validation = await callValidatorClaude(scoreResult);
    } catch (err) {
      const msg = String(err?.message || '');
      if (
        err instanceof SyntaxError          ||
        msg.includes('JSON')                ||
        msg.includes('Invalid validator')   ||
        msg.includes('Empty LLM response')  ||
        msg.includes('No JSON object found')
      ) {
        validation = await callValidatorClaude(scoreResult);
      } else {
        throw err;
      }
    }
    logDecision(scoreResult, validation, 'claude');
    return validation;
  } catch (err) {
    console.error(`[${ts()}][llm-validator] Erreur Claude API: ${err?.message ?? err}`);
    const validation = failOpen('validator_timeout');
    logDecision(scoreResult, validation, 'claude');
    return validation;
  }
}
