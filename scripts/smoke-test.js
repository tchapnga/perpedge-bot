const HEALTH_URL = 'http://localhost:3002/admin/health';
const TIMEOUT_MS = 5000;

async function runSmokeTest() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`[FAIL] HTTP ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    const body = await response.json();

    if (body?.ok !== true) {
      console.error('[FAIL] Health check returned ok !== true:', body);
      process.exit(1);
    }

    console.log('[SUCCESS] PerpEdge Bot is healthy.');
    console.log(`  uptime : ${body.uptime}s`);
    console.log(`  ts     : ${body.ts}`);
    process.exit(0);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[FAIL] Timeout after ${TIMEOUT_MS / 1000}s`);
    } else {
      console.error('[FAIL] Network error:', err.message);
    }
    process.exit(1);
  }
}

runSmokeTest();
