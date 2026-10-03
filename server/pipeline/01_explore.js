const { chromium } = require('playwright');
const fs = require('fs');
const { captureAccessibilityTree, captureIframeAccessibilityTrees } = require('../utils/accessibility');
const { createNetworkTracker, summarizeApiCalls } = require('../utils/network-capture');
const {
  FIXED_CLOCK_TIME,
  captureAriaSnapshot,
  captureAriaBaseline,
  captureAriaElements,
  tagVisibilityFromSnapshot,
  snapshotContentHash,
} = require('../utils/aria-snapshot');

class Explorer {
  constructor(targetUrl, auth, options = {}) {
    this.targetUrl = targetUrl;
    this.auth = auth;
    this.maxDepth = options.maxDepth || 3;
    this.maxPages = options.maxPages || 20;
    this.timeout = options.timeout || 30000;
    this.storageStatePath = options.storageStatePath || null;
    // Application context — Playwright browser context options (baseURL,
    // viewport, userAgent, extraHTTPHeaders). Applied during crawl so the
    // captured snapshots reflect the same environment the generated tests
    // will execute under.
    this.appContext = options.appContext || {};
    // API patterns — URL substrings/regexes that identify the app's API calls
    // (e.g. '/api/', 'execute-api'). Used to capture which endpoints each page
    // calls, so the Generator can emit waitForResponse() instead of fixed sleeps.
    this.apiPatterns = options.apiPatterns || null;

    // Adaptive networkidle strategy — many modern sites (analytics, tracking,
    // service workers, websockets, long-polling) never reach networkidle.
    // Waiting 15s per page for something that will never happen wastes enormous
    // time on large crawls. After the first networkidle timeout, we skip it for
    // all subsequent pages and go straight to domcontentloaded + API settle.
    this.networkIdleFailed = false;

    // Targeted crawl mode — when targetScreens is a non-empty array, the
    // Explorer skips the default BFS-from-targetUrl behaviour and instead
    // captures ONLY the specified screens (with an optional light crawl of
    // `targetDepth` levels of links from each). This lets users test just the
    // screens that changed instead of randomly crawling the whole app, saving
    // LLM tokens in the analyze/plan/generate stages.
    //
    // Each entry: { url, name?, functionality? }
    //   - url: absolute URL or path resolved against targetUrl/baseURL
    //   - name: friendly screen label (optional, for display)
    //   - functionality: array of strings describing what was created/updated
    //     on this screen (optional) — forwarded to the Planner so it can focus
    //     test generation on the changed areas while still testing the page.
    this.targetScreens = Array.isArray(options.targetScreens) ? options.targetScreens : null;
    this.targetDepth = options.targetDepth != null ? parseInt(options.targetDepth, 10) : 0;

    // Light/discovery crawl mode (registry building). Skips every heavy
    // per-page capture — aria snapshots, CDP a11y tree, visibility tagging,
    // disclosure discovery, forms/CAPTCHA/API capture — and keeps only what
    // screen discovery needs: URL, title, path, and outbound links. Pages are
    // captured concurrently (crawlConcurrency). Full snapshots still run in
    // normal mode because the Planner/Generator consume them.
    this.lightCrawl = !!options.lightCrawl;
    this.crawlConcurrency = Math.max(1,
      parseInt(options.crawlConcurrency || process.env.CRAWL_CONCURRENCY || '3', 10));
  }

  async explore() {
    const browser = await chromium.launch({ headless: true });
    // Build context options from appContext, falling back to sensible defaults
    // that match prior behavior when appContext is empty.
    const contextOptions = {
      viewport: this.appContext.viewport || { width: 1280, height: 720 },
      // Flake-class killers (§8): service workers cache stale assets and CSS
      // animations race assertions — block/reduce both before they can reach
      // the Healer.
      serviceWorkers: 'block',
      reducedMotion: 'reduce',
      // Pin locale: pages format dates/numbers via toLocaleString — if the
      // capture and test browsers resolve different OS locales, the aria
      // baseline diff produces false failures (e.g. DD/MM vs MM/DD).
      locale: this.appContext.locale || 'en-US',
    };
    if (this.appContext.baseURL) contextOptions.baseURL = this.appContext.baseURL;
    if (this.appContext.userAgent) contextOptions.userAgent = this.appContext.userAgent;
    if (this.appContext.extraHTTPHeaders && Object.keys(this.appContext.extraHTTPHeaders).length > 0) {
      contextOptions.extraHTTPHeaders = this.appContext.extraHTTPHeaders;
    }
    const context = await browser.newContext(contextOptions);

    // Handle authentication
    const page = await context.newPage();

    // Freeze the page clock (§2): time-dependent labels (countdowns, clock
    // widgets, "today" pickers) render identically at capture and at test
    // execution because generated specs install the same fixed time.
    // The frozen clock exists so captured snapshots match test execution.
    // Discovery crawls don't produce snapshots — and pausing the clock can
    // actually prevent SPA timers from rendering links — so skip it there.
    if (!this.lightCrawl && process.env.DISABLE_CLOCK !== '1') {
      try {
        await page.clock.install({ time: new Date(FIXED_CLOCK_TIME) });
        await page.clock.pauseAt(new Date(FIXED_CLOCK_TIME));
      } catch (err) {
        console.warn(`clock.install failed, continuing without clock emulation: ${err.message}`);
      }
    }

    await this.authenticate(page);

    // Save storage state for reuse by Executor / generated tests
    if (this.storageStatePath) {
      try {
        const state = await context.storageState();
        fs.writeFileSync(this.storageStatePath, JSON.stringify(state, null, 2));
      } catch (err) {
        console.warn(`Failed to save storage state: ${err.message}`);
      }
    }

    const visited = new Set();
    const visitedPaths = new Set();
    const snapshots = [];
    const queue = [];

    // Build the initial crawl queue. In targeted mode we seed it with the
    // user-specified screens (resolved against targetUrl/baseURL) and bound
    // link-following by targetDepth instead of maxDepth. In default mode we
    // BFS from the target URL bounded by maxDepth.
    let maxDepthForCrawl;
    let functionalityByUrl; // url -> { name, functionality, description }
    // In targeted mode the user has explicitly chosen which screens to test,
    // so maxPages (a whole-app safety cap) does not apply — we capture all
    // selected screens plus their full light crawl up to targetDepth.
    const targetedMode = !!(this.targetScreens && this.targetScreens.length > 0);
    const pageCap = targetedMode ? Infinity : this.maxPages;
    if (targetedMode) {
      maxDepthForCrawl = this.targetDepth;
      functionalityByUrl = new Map();
      const seenSeed = new Set();
      for (const screen of this.targetScreens) {
        if (!screen || !screen.url) continue;
        const resolved = this.normalizeUrl(screen.url);
        if (seenSeed.has(resolved)) continue;
        seenSeed.add(resolved);
        functionalityByUrl.set(resolved, {
          name: screen.name || null,
          functionality: Array.isArray(screen.functionality) ? screen.functionality : null,
          description: typeof screen.description === 'string' ? screen.description : null,
        });
        // Seed queue at depth 0 so the seed screen itself is always captured
        // even when targetDepth is 0.
        queue.push({ url: resolved, depth: 0 });
      }
      // Fallback: if every target screen URL failed to resolve to something
      // crawlable, seed with the target URL so we don't return an empty set.
      if (queue.length === 0) {
        queue.push({ url: this.normalizeUrl(this.targetUrl), depth: 0 });
      }
    } else {
      maxDepthForCrawl = this.maxDepth;
      functionalityByUrl = null;
      queue.push({ url: this.normalizeUrl(this.targetUrl), depth: 0 });
    }

    const processEntry = async (pg, { url, depth }) => {
      if (visited.has(url)) return;
      if (depth > maxDepthForCrawl) return;
      visited.add(url);

      try {
        const snapshot = this.lightCrawl
          ? await this.capturePageLight(pg, url)
          : await this.capturePage(pg, url);
        if (!snapshot) return;

        // Deduplicate by path — avoid crawling /products?sort=price and /products?sort=name
        // as separate pages when they render the same content. The dedupe key
        // includes the hash when it's a client-side route (#/...): hash-router
        // SPAs serve distinct screens under one pathname, so pathname alone
        // would collapse all their routes into a single entry.
        let dedupeKey = snapshot.path;
        try {
          const h = new URL(snapshot.url).hash;
          if (/^#!?\/.+/.test(h)) dedupeKey += h;
        } catch { /* keep path */ }
        if (visitedPaths.has(dedupeKey)) {
          // Still count it as visited but don't add a duplicate snapshot
          return;
        }
        visitedPaths.add(dedupeKey);

        // In targeted mode, attach the user-provided screen label,
        // functionality hints, and free-form description to the matching
        // snapshot so downstream stages (Planner) can focus test generation
        // on the changed areas and use the extra context.
        if (functionalityByUrl) {
          const meta = functionalityByUrl.get(url) ||
            functionalityByUrl.get(this.normalizeUrl(snapshot.url));
          if (meta) {
            if (meta.name) snapshot.screenLabel = meta.name;
            if (meta.functionality) snapshot.functionality = meta.functionality;
            if (meta.description) snapshot.screenDescription = meta.description;
            snapshot.isTargetedScreen = true;
          }
        }

        snapshots.push(snapshot);
        if (this.lightCrawl) {
          console.log(`[crawl] captured ${snapshots.length}: ${snapshot.url}`);
        }

        // Discover links for BFS — filter out non-content URLs.
        // In targeted mode with targetDepth 0 we skip link discovery
        // entirely (strict capture of only the listed screens).
        if (depth < maxDepthForCrawl) {
          const newLinks = [];
          for (const link of snapshot.links) {
            const normalized = this.normalizeUrl(link);
            if (visited.has(normalized) || !this.isSameOrigin(normalized)) continue;
            if (this.isNonContentUrl(normalized)) continue;
            newLinks.push({ url: normalized, depth: depth + 1 });
          }
          // Prioritize links that are likely to have interactive content:
          // pages with form-related or action-related path segments first.
          newLinks.sort((a, b) => {
            const aPriority = this.linkPriority(a.url);
            const bPriority = this.linkPriority(b.url);
            return bPriority - aPriority;
          });
          queue.push(...newLinks);
        }
      } catch (err) {
        console.warn(`Failed to capture ${url}: ${err.message}`);
      }
    };

    if (this.lightCrawl && this.crawlConcurrency > 1) {
      // Discovery crawls capture pages concurrently — light snapshots carry
      // no shared per-page state, so a small worker pool over the shared BFS
      // queue is safe (visited/visitedPaths updates are synchronous) and
      // dramatically faster on multi-page crawls.
      const poolPages = [page];
      for (let i = 1; i < this.crawlConcurrency; i++) {
        poolPages.push(await context.newPage());
      }
      await Promise.all(poolPages.map(async (pg) => {
        while (snapshots.length < pageCap) {
          const entry = queue.shift();
          if (!entry) break;
          await processEntry(pg, entry);
        }
      }));
    } else {
      while (queue.length > 0 && snapshots.length < pageCap) {
        await processEntry(page, queue.shift());
      }
    }

    await browser.close();
    return snapshots;
  }

  async authenticate(page) {
    const { type } = this.auth;

    if (type === 'none') return;

    if (type === 'basic') {
      // Set HTTP Basic Auth header
      const { username, password } = this.auth;
      await page.context().setExtraHTTPHeaders({
        Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
      });
      return;
    }

    if (type === 'form') {
      // Navigate to login page and fill form
      const { loginUrl, usernameSelector, passwordSelector, submitSelector, username, password } = this.auth;
      const idleTimeout = parseInt(process.env.NETWORKIDLE_TIMEOUT || '10000', 10);
      try {
        await page.goto(loginUrl || this.targetUrl, { waitUntil: 'networkidle', timeout: idleTimeout });
      } catch (err) {
        console.warn(`networkidle timed out during form auth navigation, falling back to domcontentloaded: ${err.message}`);
        await page.goto(loginUrl || this.targetUrl, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      }
      await page.fill(usernameSelector || '[name="username"], [name="email"], #username, #email', username);
      await page.fill(passwordSelector || '[name="password"], #password', password);
      await page.click(submitSelector || 'button[type="submit"], input[type="submit"]');
      try {
        await page.waitForLoadState('networkidle', { timeout: idleTimeout });
      } catch (err) {
        console.warn(`networkidle timed out after form submit, continuing: ${err.message}`);
      }
      return;
    }

    if (type === 'oauth') {
      // For OAuth / Cognito / Azure AD / Google — user must provide session cookies or tokens
      const { cookies, localStorage: ls } = this.auth;
      if (cookies && cookies.length > 0) {
        await page.context().addCookies(cookies);
      }
      if (ls) {
        await page.goto(this.targetUrl, { waitUntil: 'domcontentloaded', timeout: this.timeout });
        // page.localStorage (§2) — direct WebStorage access, no evaluate bridge.
        for (const [key, value] of Object.entries(ls)) {
          await page.localStorage.setItem(key, value);
        }
      }
      return;
    }

    if (type === 'bearer') {
      const { token } = this.auth;
      await page.context().setExtraHTTPHeaders({
        Authorization: `Bearer ${token}`,
      });
      return;
    }
  }

  /**
   * Lightweight capture used by lightCrawl mode (registry building): records
   * only what screen discovery needs — final URL, title, path, and outbound
   * links. Skips the expensive captures (aria snapshots, CDP a11y tree,
   * visibility tagging, disclosure discovery, forms/API/CAPTCHA capture)
   * that the test pipeline needs but the registry discards.
   */
  async capturePageLight(page, url) {
    // Same adaptive networkidle strategy as capturePage, with a shorter
    // timeout — discovery only needs links rendered, not full network quiet.
    const idleTimeout = parseInt(process.env.LIGHT_NETWORKIDLE_TIMEOUT || '5000', 10);
    let navigated = false;
    if (!this.networkIdleFailed) {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: idleTimeout });
        navigated = true;
      } catch (err) {
        this.networkIdleFailed = true;
        console.warn(`networkidle timed out for ${url} — using domcontentloaded for remaining pages`);
      }
    }
    if (!navigated) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      } catch (err) {
        // Last resort: some apps abort or replace navigation mid-load (SPA
        // redirects, download handoffs). 'commit' succeeds once the response
        // starts arriving, then the link-settle wait below gives client JS
        // time to render.
        console.warn(`domcontentloaded timed out for ${url}, retrying with commit: ${err.message.split('\n')[0]}`);
        await page.goto(url, { waitUntil: 'commit', timeout: this.timeout });
      }
    }

    // Wait for client-rendered anchors. SPAs attach links after DOM ready —
    // first wait for at least one anchor, then poll until the link count is
    // stable so late-hydrating navs/menus aren't missed (bounded so a
    // continuously-re-rendering page can't stall the crawl).
    await page.waitForSelector('a[href]', {
      state: 'attached',
      timeout: parseInt(process.env.LIGHT_LINK_WAIT || '4000', 10),
    }).catch(() => {});
    const settleCap = parseInt(process.env.LIGHT_LINK_SETTLE || '1500', 10);
    const settleStart = Date.now();
    let lastCount = -1;
    while (Date.now() - settleStart < settleCap) {
      const count = await page
        .evaluate(() => document.querySelectorAll('a[href]').length)
        .catch(() => -1);
      if (count < 0 || count === lastCount) break;
      lastCount = count;
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(150);

    const title = await page.title();
    const currentUrl = page.url();
    const path = new URL(currentUrl).pathname;
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(href => href.startsWith('http'))
    );
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameLinks = await frame.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(href => href.startsWith('http'))
        );
        links.push(...frameLinks);
      } catch { /* frame detached — skip */ }
    }

    return { url: currentUrl, path, title, links };
  }

  async capturePage(page, url) {
    // Attach a network tracker to capture API calls (XHR/fetch) made during
    // page load. This is critical for SPA apps where the page content is
    // fetched asynchronously after DOM ready (any framework + any backend).
    const tracker = createNetworkTracker(page, { apiPatterns: this.apiPatterns });
    tracker.reset();

    // Smart wait strategy for SPAs:
    // 1. Try networkidle first (best for static + simple async pages)
    // 2. Fall back to domcontentloaded + wait for API responses to settle
    //    (handles polling apps that never reach networkidle)
    //
    // Adaptive: if networkidle has already failed on a previous page in this
    // crawl, skip it entirely — the site likely has persistent connections
    // (analytics, tracking, service workers) that never go idle. This avoids
    // wasting 15s per page on large crawls.
    const idleTimeout = parseInt(process.env.NETWORKIDLE_TIMEOUT || '10000', 10);
    let usedFallback = false;
    if (this.networkIdleFailed) {
      // Skip networkidle — it already failed on a previous page
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      usedFallback = true;
    } else {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: idleTimeout });
      } catch (err) {
        console.warn(`networkidle timed out for ${url} (${idleTimeout}ms) — switching to domcontentloaded for remaining pages: ${err.message.split('\n')[0]}`);
        this.networkIdleFailed = true;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
        usedFallback = true;
      }
    }

    if (usedFallback) {
      // For SPAs that never reach networkidle (polling, analytics), wait for
      // the app's API calls to complete, then a short settle period.
      //
      // Optimized smart wait:
      // 1. Wait a brief initial moment (up to 600ms) to see if any API calls are triggered/pending.
      // 2. If no calls are completed and none are pending, break early (standard content page).
      // 3. Otherwise, if there are pending API calls, wait for them to finish (pending count goes to 0).
      const apiSettleTimeout = parseInt(process.env.API_SETTLE_TIMEOUT || '8000', 10);
      const start = Date.now();
      let hasSeenCalls = false;

      while (Date.now() - start < apiSettleTimeout) {
        const callsCount = tracker.getCalls().length;
        const pendingCount = tracker.getPendingCount ? tracker.getPendingCount() : 0;

        if (callsCount > 0 || pendingCount > 0) {
          hasSeenCalls = true;
        }

        // After 600ms, if we have seen no API calls and none are pending,
        // we can confidently assume this page does not make API calls on load.
        if (!hasSeenCalls && (Date.now() - start > 600)) {
          break;
        }

        // If we have seen calls but they have all completed (pending count is 0),
        // we can stop waiting!
        if (hasSeenCalls && pendingCount === 0) {
          break;
        }

        await page.waitForTimeout(100);
      }
      // Give the SPA a brief moment to render the API response data (300ms is plenty for VDOM)
      await page.waitForTimeout(300);
    } else {
      // networkidle succeeded — very brief settle for late hydration
      await page.waitForTimeout(300);
    }

    // Capture AI-mode aria snapshot (§1) — YAML with stable [ref=eN] element
    // references and [box=x,y,w,h] bounding boxes. This feeds LLM prompts
    // instead of the flattened role+name lists (40–70% fewer input tokens),
    // and provides deterministic visibility tagging without a per-element
    // locator pass.
    const ariaDepth = parseInt(process.env.ARIA_SNAPSHOT_DEPTH || '0', 10);
    const ariaYaml = await captureAriaSnapshot(page, ariaDepth > 0 ? { depth: ariaDepth } : {});
    // PW 1.63: structured JSON capture (refs/boxes/link urls) with YAML-parse
    // fallback on older Playwright.
    const ariaRefs = await captureAriaElements(page, ariaYaml);
    // Default-mode snapshot — used as the toMatchAriaSnapshot() baseline in
    // the deterministic Accessibility spec (no ref/box annotations).
    const ariaBaseline = ariaYaml ? await captureAriaBaseline(page) : null;

    // Capture accessibility snapshot via CDP (page.accessibility was removed in newer Playwright)
    const accessibilityTree = await captureAccessibilityTree(page);

    // Capture accessibility trees from iframes (for apps with embedded content).
    // The ai-mode ariaSnapshot does traverse same-origin iframes, but we keep
    // the CDP capture as a fallback for any it misses.
    const iframeTrees = await captureIframeAccessibilityTrees(page);

    // Capture all visible role-name pairs from the main page
    const roleNamePairs = this.extractRoleNamePairs(accessibilityTree);

    // Merge in iframe elements with iframe metadata so the Generator can
    // use page.frameLocator() for these elements
    for (const iframe of iframeTrees) {
      const iframePairs = this.extractRoleNamePairs(iframe.tree);
      for (const pair of iframePairs) {
        pair.iframeSelector = iframe.frameSelector;
        pair.iframeTitle = iframe.frameTitle;
      }
      roleNamePairs.push(...iframePairs);
    }

    // Tag each role-name pair with a visibility flag. The accessibility tree
    // captures ALL elements in the DOM regardless of whether they're visible
    // (e.g. spinbuttons inside a collapsed date/time picker). Without this
    // flag, the Planner generates tests that assert hidden elements as
    // visible, causing false failures.
    //
    // Prefer the deterministic signal from aria-snapshot bounding boxes:
    // a zero-size box = not rendered. For elements the snapshot didn't cover
    // (or when the snapshot capture failed), fall back to the per-element
    // locator check — the same mechanism generated tests use.
    let visibilityChecked = new Set();
    if (ariaRefs.length > 0) {
      visibilityChecked = tagVisibilityFromSnapshot(ariaRefs, roleNamePairs);
    }
    const unchecked = roleNamePairs.filter(p => !visibilityChecked.has(p));
    if (unchecked.length > 0) {
      await this.tagVisibility(page, unchecked);
    }

    // Capture page metadata
    const title = await page.title();
    const currentUrl = page.url();
    const path = new URL(currentUrl).pathname;

    // Capture API calls made during page load — stored with the snapshot so
    // the Generator and Planner know which endpoints this page depends on.
    const apiCalls = tracker.getCalls();
    const apiSummary = summarizeApiCalls(apiCalls);
    tracker.detach();

    // Deterministic failure signals (§2): JS page errors and console errors
    // observed during this page's load. The Planner/Healer uses these instead
    // of letting the LLM infer failure modes.
    const pageErrors = await page.pageErrors({ filter: 'since-navigation' })
      .catch(() => []);
    const consoleErrors = await page.consoleMessages({ filter: 'since-navigation' })
      .then(msgs => msgs.filter(m => m.type() === 'error').map(m => m.text()))
      .catch(() => []);

    // Discover links on the page (including links inside iframes).
    // frame.evaluate() pierces the same-origin policy — it works in
    // cross-origin frames where iframe.contentDocument returns null.
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(href => href.startsWith('http'))
    );
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameLinks = await frame.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(href => href.startsWith('http'))
        );
        links.push(...frameLinks);
      } catch { /* frame detached — skip */ }
    }

    // Capture forms — including inside cross-origin iframes. frame.evaluate
    // works in any frame (unlike iframe.contentDocument which is null for
    // cross-origin), so embedded payment/booking widgets are captured too.
    const captureFormsScript = () => {
      const captureForm = (form) => ({
        action: form.action,
        method: form.method,
        fields: Array.from(form.querySelectorAll('input, select, textarea')).map(el => ({
          type: el.type || el.tagName.toLowerCase(),
          name: el.name || el.id,
          placeholder: el.placeholder,
          required: el.required,
          ariaLabel: el.getAttribute('aria-label'),
        })),
      });
      return Array.from(document.querySelectorAll('form')).map(captureForm);
    };
    const forms = await page.evaluate(captureFormsScript);
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameForms = await frame.evaluate(captureFormsScript);
        forms.push(...frameForms);
      } catch { /* frame detached — skip */ }
    }

    // CAPTCHA detection — cannot be automated (by design), but must be
    // surfaced honestly: generated specs mark affected flows test.fixme
    // rather than producing flaky failures or silent gaps.
    const captchaDetected = await page.evaluate(() =>
      !!document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], ' +
        'iframe[src*="challenges.cloudflare"], iframe[src*="arkoselabs"], ' +
        '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]'
      )
    ).catch(() => false);

    // Interactive disclosure discovery (§2): expand collapsed menus, popups,
    // and accordions so elements that only exist inside them enter the page
    // model. Without this, submenu items and popup-only components are
    // invisible to the Planner — a significant coverage gap on apps with
    // dropdown navigation, expandable filters, or disclosure widgets.
    // Runs AFTER links/forms capture (rest state) so open menus don't
    // pollute them; runs before interactiveElements so revealed menuitems
    // are included. Revealed elements are tagged `revealedBy` +
    // visible:false (hidden at rest) so deterministic suites ignore them
    // while the Functional planner can plan trigger→item sequences.
    await this.discoverDisclosureContent(page, roleNamePairs);

    // Capture interactive elements via accessibility tree
    // Include spinbutton (date/time picker inputs) so the Planner can generate
    // tests for them — but the visibility flag (set by tagVisibility) lets the
    // Planner know which ones are actually visible vs hidden inside collapsed
    // widgets.
    const interactiveElements = roleNamePairs.filter(e =>
      ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'searchbox', 'tab', 'menuitem', 'switch', 'spinbutton'].includes(e.role)
    );

    const snapshot = {
      url: currentUrl,
      path,
      title,
      accessibilityTree,
      iframeTrees,
      ariaYaml,
      ariaBaseline,
      ariaRefs,
      pageErrors: pageErrors.map(e => String(e && e.message || e)).slice(0, 20),
      consoleErrors: consoleErrors.slice(0, 20),
      roleNamePairs,
      interactiveElements,
      links,
      forms,
      // API calls captured during page load — used by Generator to emit
      // waitForResponse() instead of fixed sleeps for SPA/API-Gateway apps.
      apiCalls,
      apiSummary,
      captchaDetected,
      isSpa: usedFallback || apiCalls.length > 0,
      timestamp: new Date().toISOString(),
    };
    // Content hash of the page structure — used for cross-run spec caching
    // (§9). Unchanged pages can reuse previously generated specs at ~0 tokens.
    snapshot.ariaHash = snapshotContentHash(snapshot);
    return snapshot;
  }

  extractRoleNamePairs(node, pairs = []) {
    if (!node) return pairs;
    if (node.role && node.role !== 'none' && node.role !== 'generic') {
      pairs.push({
        role: node.role,
        name: node.name || '',
        focused: node.focused || false,
        disabled: node.disabled || false,
        checked: node.checked,
        value: node.value,
        // visible is set later by tagVisibility() — default to true so
        // elements that can't be checked (e.g. inside cross-origin iframes)
        // are not falsely filtered out.
        visible: true,
      });
    }
    if (node.children) {
      for (const child of node.children) {
        this.extractRoleNamePairs(child, pairs);
      }
    }
    return pairs;
  }

  /**
   * Tag each role-name pair with a `visible` boolean reflecting whether the
   * element is actually visible on the page at crawl time. This prevents the
   * Planner from generating tests that assert hidden elements (e.g.
   * spinbuttons inside a collapsed date/time picker) as visible.
   *
   * Uses Playwright locators (getByRole) — the same mechanism generated tests
   * use — so the visibility flag matches what tests will see at runtime.
   * Elements that can't be located (cross-origin iframe, stale DOM) keep
   * their default `visible: true` to avoid false filtering.
   */
  async tagVisibility(page, roleNamePairs) {
    // Only check interactive elements that have a name — we don't need to check
    // visibility for static headings, paragraphs, or lists since we never
    // interact with them. This saves hundreds of CDP roundtrips per page.
    const INTERACTIVE_ROLES = [
      'button', 'link', 'textbox', 'combobox', 'spinbutton',
      'checkbox', 'radio', 'searchbox', 'tab', 'menuitem',
      'option', 'switch'
    ];
    const checkable = roleNamePairs.filter(p =>
      p.name && p.name.trim() &&
      !p.iframeSelector &&
      INTERACTIVE_ROLES.includes(p.role)
    );
    // Check in batches to avoid too many concurrent locator evaluations.
    const BATCH = 30;
    for (let i = 0; i < checkable.length; i += BATCH) {
      const batch = checkable.slice(i, i + BATCH);
      await Promise.all(batch.map(async (pair) => {
        try {
          const locator = page.getByRole(pair.role, { name: pair.name, exact: true }).first();
          // isVisible() is fast and non-blocking in Playwright.
          pair.visible = await locator.isVisible().catch(() => false);
        } catch {
          // If we can't check (e.g. role not supported by getByRole), leave
          // the default visible: true — don't filter out elements we can't
          // verify, as that would cause false negatives.
        }
      }));
    }
  }

  /**
   * Expand collapsed disclosure widgets (menus, popups, accordions) and
   * merge newly-revealed elements into `roleNamePairs`, tagged with
   * `revealedBy` (trigger label) and `visible: false` (hidden at rest —
   * deterministic suites ignore them; the Functional planner plans
   * trigger→item sequences).
   *
   * The page clock is resumed during discovery because menu/popup open
   * handlers are frequently driven by setTimeout/requestAnimationFrame,
   * which never fire while the clock is paused — then re-paused at the
   * fixed instant so subsequent captures stay deterministic.
   */
  async discoverDisclosureContent(page, roleNamePairs) {
    const MAX_TRIGGERS = parseInt(process.env.MAX_DISCLOSURE_TRIGGERS || '10', 10);
    const MAX_REVEALED = 60;
    const urlBefore = page.url();
    const known = new Set(roleNamePairs.map(p => `${p.role}|${p.name}`));
    let added = 0;

    // Resume the clock so timer-driven reveal handlers can run.
    try { await page.clock.resume(); } catch { /* clock not installed */ }

    try {
      const triggers = await page.$$(
        '[aria-expanded="false"], [aria-haspopup]:not([aria-expanded="true"]), details:not([open]) > summary'
      );
      for (const trigger of triggers.slice(0, MAX_TRIGGERS)) {
        if (added >= MAX_REVEALED) break;
        try {
          if (!(await trigger.isVisible().catch(() => false))) continue;
          const label = (
            (await trigger.getAttribute('aria-label').catch(() => null)) ||
            (await trigger.innerText().catch(() => '')).trim() ||
            'disclosure'
          ).slice(0, 60);
          // Hover first with a dwell — hover-intent menus open after a
          // ~300-500ms delay. Capture after hover (covers menus that a
          // click would close again), then click for click-disclosure
          // widgets and capture a second time.
          const mergeFresh = async () => {
            const fresh = await captureAriaElements(page, null);
            for (const p of fresh) {
              if (!p.name || added >= MAX_REVEALED) break;
              const key = `${p.role}|${p.name}`;
              if (known.has(key)) continue;
              known.add(key);
              roleNamePairs.push({
                role: p.role,
                name: p.name,
                focused: false,
                disabled: false,
                // Truthful at REST: the element is not rendered until its
                // trigger opens the disclosure. Deterministic suites filter
                // on visible===false; functional steps get the catch-wrap
                // treatment (waitFor-visible then click) which still works
                // once the trigger step has opened the menu.
                visible: false,
                revealedBy: label,
              });
              added++;
            }
          };
          await trigger.hover({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(500);
          await mergeFresh();
          await trigger.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(400);
          // A trigger that navigated (plain link styled as a menu) poisons
          // discovery — go back and stop.
          if (page.url() !== urlBefore) {
            await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForTimeout(500);
            break;
          }
          await mergeFresh();
          // Close the disclosure before probing the next trigger.
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(150);
        } catch { /* non-fatal — continue with the next trigger */ }
      }
    } finally {
      // Restore the frozen clock so later captures stay deterministic.
      try { await page.clock.pauseAt(new Date(FIXED_CLOCK_TIME)); } catch { /* not installed */ }
    }
    return added;
  }

  normalizeUrl(url) {
    try {
      const u = new URL(url, this.targetUrl);
      // Keep hash-router routes (#/path, #!/path) — they are distinct screens
      // in hash-based SPAs. Strip plain anchor fragments and the bare home
      // route (#, #/) which only scroll or alias the root page.
      if (!/^#!?\/.+/.test(u.hash)) u.hash = '';
      return u.toString().replace(/\/+$/, '');
    } catch {
      return url;
    }
  }

  isSameOrigin(url) {
    try {
      const target = new URL(this.targetUrl);
      const check = new URL(url);
      return target.origin === check.origin;
    } catch {
      return false;
    }
  }

  /**
   * Filter out URLs that are not crawlable web pages.
   * Removes social media links, download files, mailto/tel schemes,
   * and common non-content paths (privacy policy, terms, etc.).
   */
  isNonContentUrl(url) {
    try {
      const u = new URL(url);
      // Non-http(s) schemes
      if (!['http:', 'https:'].includes(u.protocol)) return true;
      // File downloads
      if (/\.(pdf|zip|doc|docx|xls|xlsx|ppt|pptx|csv|jpg|jpeg|png|gif|svg|mp4|mp3|webp|ico|woff|woff2)$/i.test(u.pathname)) return true;
      // Social media and external platforms
      if (/(facebook|twitter|x\.com|linkedin|instagram|youtube|tiktok|pinterest|github\.com|mailto:|tel:)/i.test(url)) return true;
      // Common non-interactive legal/help pages (low test value)
      if (/(privacy-policy|terms-of-service|terms-and-conditions|cookie-policy|accessibility-statement|help-center|faq)$/i.test(u.pathname)) return true;
      // Anchors with no path change — but keep hash-router routes (#/...),
      // which are real screens in hash-based SPAs despite living on '/'.
      if (u.pathname === '/' && u.hash && !/^#!?\/.+/.test(u.hash)) return true;
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Score a URL by how likely it is to contain interactive, testable content.
   * Higher score = higher priority for crawling.
   */
  linkPriority(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.toLowerCase();
      let score = 0;
      // Form-heavy pages — highest priority
      if (/(login|signin|register|signup|create-account|contact|checkout|cart|search|filter|book|reserve|order|submit|apply|enroll|subscribe)/.test(path)) score += 10;
      // Product/content pages — likely to have dropdowns, tabs, interactive elements
      if (/(product|catalog|browse|shop|store|category|collection|detail|view|item|article|post|page|dashboard|account|profile|settings|preferences)/.test(path)) score += 5;
      // Pages with query params often have search/filter functionality
      if (u.search && u.search.length > 3) score += 2;
      // Root page
      if (path === '/' || path === '') score += 1;
      return score;
    } catch {
      return 0;
    }
  }

  /**
   * Derive a friendly, human-readable screen name from a snapshot.
   * Prefers the page <title>, falling back to the URL path. Used by the
   * registry builder so users can pick screens by name instead of URL.
   */
  static deriveScreenName(snapshot) {
    const title = (snapshot.title || '').trim();
    if (title) {
      // Strip common suffixes like " | MyApp" / " - MyApp" / " :: MyApp"
      const cleaned = title.replace(/\s*[|·\-–—:»]\s*.*$/,'').trim();
      if (cleaned) return cleaned;
      return title;
    }
    try {
      const u = new URL(snapshot.url, snapshot.url);
      const seg = u.pathname.split('/').filter(Boolean).pop();
      if (seg) {
        return seg.charAt(0).toUpperCase() + seg.slice(1);
      }
    } catch { /* fall through */ }
    return 'Home';
  }
}

module.exports = { Explorer };
