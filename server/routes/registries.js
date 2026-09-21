const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { Explorer } = require('../pipeline/01_explore');
const { validateAppContext } = require('../utils/app-context');

// Registries are stored as JSON files under <project>/registries/.
// Each file is a self-contained screen registry for one app/environment so
// users can keep several (e.g. myapp-prod, myapp-staging) and pick the right
// one at test-run time.
const REGISTRIES_DIR = path.join(__dirname, '..', '..', 'registries');
fs.mkdirSync(REGISTRIES_DIR, { recursive: true });

/**
 * Sanitize a user-provided registry name into a safe filename.
 * Allows letters, digits, dash, underscore, dot. Anything else is replaced.
 * Prevents path traversal (no slashes, no leading dots).
 */
function sanitizeName(name) {
  const base = String(name || '').trim().replace(/[^a-zA-Z0-9_\-.]/g, '-');
  const safe = base.replace(/^\.+/, '').replace(/\.{2,}/g, '.');
  return safe || 'registry';
}

function registryPath(name) {
  return path.join(REGISTRIES_DIR, `${sanitizeName(name)}.json`);
}

/**
 * Build a screen registry by crawling the app once with the Explorer and
 * recording one entry per discovered screen (friendly name + URL + path +
 * title). The registry is saved to disk so it can be reused across runs and
 * updated later when the UI changes.
 *
 * Body: { name, targetUrl, auth?, appContext?, maxDepth?, maxPages? }
 */
router.post('/build', async (req, res) => {
  const { name, targetUrl, auth, appContext, maxDepth, maxPages } = req.body || {};

  if (!targetUrl) return res.status(400).json({ error: 'targetUrl is required' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  let cleanAppContext;
  try {
    cleanAppContext = validateAppContext(appContext);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code });
  }

  const safeName = sanitizeName(name);
  const filePath = registryPath(safeName);

  // Preserve createdAt if updating an existing registry; bump updatedAt.
  let createdAt = new Date().toISOString();
  let existingNamesMap = new Map(); // url -> name
  if (fs.existsSync(filePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (existing.createdAt) createdAt = existing.createdAt;
      if (Array.isArray(existing.screens)) {
        for (const s of existing.screens) {
          if (s.url && s.name) {
            existingNamesMap.set(s.url, s.name);
          }
        }
      }
    } catch { /* ignore corrupt file */ }
  }

  try {
    const explorer = new Explorer(targetUrl, auth || { type: 'none' }, {
      maxDepth: parseInt(maxDepth, 10) || 3,
      maxPages: parseInt(maxPages, 10) || 30,
      timeout: parseInt(process.env.PLAYWRIGHT_TIMEOUT || '30000', 10),
      storageStatePath: null,
      appContext: cleanAppContext,
      apiPatterns: cleanAppContext.apiPatterns || null,
    });

    const snapshots = await explorer.explore();

    if (snapshots.length === 0) {
      return res.status(400).json({
        error: `Crawl captured 0 pages for ${targetUrl}. Check that the URL is reachable and auth (if any) is correct.`,
      });
    }

    // Build registry entries, preserving existing names or deriving new ones and de-duplicating
    const usedNames = new Set();
    const screens = snapshots.map(snap => {
      let friendly = existingNamesMap.get(snap.url);
      if (!friendly) {
        friendly = Explorer.deriveScreenName(snap);
      }
      // Ensure uniqueness — append " (2)", " (3)", ... on collision
      if (usedNames.has(friendly)) {
        let i = 2;
        while (usedNames.has(`${friendly} (${i})`)) i++;
        friendly = `${friendly} (${i})`;
      }
      usedNames.add(friendly);
      return {
        name: friendly,
        url: snap.url,
        path: snap.path,
        title: snap.title || '',
      };
    });

    const registry = {
      name: safeName,
      targetUrl,
      createdAt,
      updatedAt: new Date().toISOString(),
      crawlSettings: {
        maxDepth: parseInt(maxDepth, 10) || 3,
        maxPages: parseInt(maxPages, 10) || 30,
      },
      screens,
    };

    fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
    res.json(registry);
  } catch (err) {
    console.error(`Failed to build registry ${safeName}:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Save user edits to a registry (renamed screens, removed screens, added
 * manual entries). The full screens array is replaced with the submitted one.
 *
 * Body: { screens: [{ name, url, path?, title? }], targetUrl? }
 */
router.put('/:name', (req, res) => {
  const safeName = sanitizeName(req.params.name);
  const filePath = registryPath(safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Registry not found' });

  const { screens, targetUrl } = req.body || {};
  if (!Array.isArray(screens)) return res.status(400).json({ error: 'screens must be an array' });

  // Validate each entry has a name + url
  const clean = [];
  const seen = new Set();
  for (const s of screens) {
    if (!s || !s.url || !s.name) continue;
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    clean.push({
      name: String(s.name).trim(),
      url: String(s.url).trim(),
      path: s.path || '',
      title: s.title || '',
    });
  }

  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    existing.screens = clean;
    if (targetUrl) existing.targetUrl = targetUrl;
    existing.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    res.json(existing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * List all saved registries with a summary (screen count, target URL, dates).
 */
router.get('/', (req, res) => {
  const files = fs.readdirSync(REGISTRIES_DIR).filter(f => f.endsWith('.json'));
  const list = [];
  for (const f of files) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(REGISTRIES_DIR, f), 'utf-8'));
      list.push({
        name: reg.name || f.replace(/\.json$/, ''),
        targetUrl: reg.targetUrl || '',
        screenCount: Array.isArray(reg.screens) ? reg.screens.length : 0,
        createdAt: reg.createdAt || null,
        updatedAt: reg.updatedAt || null,
      });
    } catch { /* skip corrupt */ }
  }
  // Newest updates first
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  res.json({ registries: list });
});

/**
 * Fetch a full registry by name.
 */
router.get('/:name', (req, res) => {
  const filePath = registryPath(req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Registry not found' });
  try {
    const reg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json(reg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete a registry.
 */
router.delete('/:name', (req, res) => {
  const filePath = registryPath(req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Registry not found' });
  try {
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
