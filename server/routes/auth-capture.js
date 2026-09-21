const express = require('express');
const router = express.Router();
const { chromium } = require('playwright');

/**
 * Interactive Login Capture
 *
 * Launches a headed (visible) browser so the user can log in manually
 * to their OAuth/SSO provider. Once they click "Capture Session",
 * we extract all cookies and localStorage and return them.
 *
 * Flow:
 *   1. POST /api/auth-capture/start  → launches browser, returns sessionId
 *   2. GET  /api/auth-capture/:id/status  → check if browser is still open
 *   3. POST /api/auth-capture/:id/capture → grab cookies + localStorage, close browser
 *   4. POST /api/auth-capture/:id/cancel  → close browser without capturing
 */

const activeSessions = new Map();

/**
 * Extract a clean domain for display purposes.
 */
function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// POST /api/auth-capture/start
// Body: { targetUrl: "https://app.example.com" }
router.post('/start', async (req, res) => {
  const { targetUrl } = req.body;
  if (!targetUrl) {
    return res.status(400).json({ error: 'targetUrl is required' });
  }

  const sessionId = `capture-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  try {
    // Launch a HEADED browser so the user can interact with it
    const browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // Navigate to the target URL so the user can log in
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
      // If the initial navigation fails, still let the user navigate manually
    });

    // Set a title so the user knows this is the capture browser
    await page.evaluate(() => {
      document.title = '[AutoTest] Login here, then click "Capture Session" in the app';
    }).catch(() => {});

    activeSessions.set(sessionId, {
      browser,
      context,
      page,
      targetUrl,
      createdAt: new Date().toISOString(),
      status: 'waiting', // waiting | captured | cancelled | closed
      result: null,
    });

    // Auto-close after 5 minutes to avoid orphan browsers
    setTimeout(() => {
      const session = activeSessions.get(sessionId);
      if (session && session.status === 'waiting') {
        session.status = 'closed';
        session.browser.close().catch(() => {});
        activeSessions.delete(sessionId);
      }
    }, 5 * 60 * 1000);

    res.json({ sessionId, status: 'waiting', message: 'Browser launched. Log in to your application, then call /capture.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to launch browser: ' + err.message });
  }
});

// GET /api/auth-capture/:id/status
router.get('/:id/status', (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  res.json({
    sessionId: req.params.id,
    status: session.status,
    targetUrl: session.targetUrl,
    createdAt: session.createdAt,
  });
});

// POST /api/auth-capture/:id/capture
// Grabs all cookies and localStorage from the browser, then closes it.
router.post('/:id/capture', async (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  if (session.status !== 'waiting') {
    return res.status(400).json({ error: `Session is not in waiting state (current: ${session.status})` });
  }

  const { context, page, targetUrl } = session;

  try {
    // Capture all cookies from the browser context
    const cookies = await context.cookies();

    // Capture localStorage from the current page
    let localStorageEntries = {};
    try {
      localStorageEntries = await page.evaluate(() => {
        const entries = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          entries[key] = window.localStorage.getItem(key);
        }
        return entries;
      });
    } catch {
      // localStorage might not be accessible if page navigated away
    }

    // Capture current URL for reference
    const currentUrl = page.url();

    // Filter cookies to only include relevant domains (the target domain and its parents)
    const targetDomain = getDomain(targetUrl);
    const relevantCookies = cookies.filter(c => {
      // Include cookies for the target domain or any parent domain
      return targetDomain === c.domain ||
        targetDomain.endsWith('.' + c.domain.replace(/^\./, '')) ||
        c.domain.replace(/^\./, '').endsWith(targetDomain);
    });

    // Also capture sessionStorage (useful for some SSO flows)
    let sessionStorageEntries = {};
    try {
      sessionStorageEntries = await page.evaluate(() => {
        const entries = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          entries[key] = window.sessionStorage.getItem(key);
        }
        return entries;
      });
    } catch {}

    session.status = 'captured';
    session.result = {
      cookies: relevantCookies,
      allCookies: cookies,
      localStorage: localStorageEntries,
      sessionStorage: sessionStorageEntries,
      currentUrl,
      capturedAt: new Date().toISOString(),
    };

    // Close the browser
    await session.browser.close().catch(() => {});
    activeSessions.delete(req.params.id);

    res.json({
      sessionId: req.params.id,
      status: 'captured',
      ...session.result,
      summary: {
        cookieCount: relevantCookies.length,
        localStorageCount: Object.keys(localStorageEntries).length,
        sessionStorageCount: Object.keys(sessionStorageEntries).length,
        currentUrl,
      },
    });
  } catch (err) {
    session.status = 'error';
    await session.browser.close().catch(() => {});
    activeSessions.delete(req.params.id);
    res.status(500).json({ error: 'Failed to capture session: ' + err.message });
  }
});

// POST /api/auth-capture/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  session.status = 'cancelled';
  await session.browser.close().catch(() => {});
  activeSessions.delete(req.params.id);

  res.json({ sessionId: req.params.id, status: 'cancelled' });
});

module.exports = router;
