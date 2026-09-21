const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Configuration presets are stored as JSON files under <project>/presets/.
// Each file holds the full set of run settings (LLM provider, auth, advanced
// options, healing, app context) so users don't have to re-enter everything
// on every run.  Storage is server-side (on disk) so presets survive browser
// restarts, cache clears, and work regardless of which URL is used to access
// the app.
const PRESETS_DIR = path.join(__dirname, '..', '..', 'presets');
fs.mkdirSync(PRESETS_DIR, { recursive: true });

/**
 * Sanitize a user-provided preset name into a safe filename.
 * Allows letters, digits, dash, underscore, dot. Anything else is replaced.
 * Prevents path traversal (no slashes, no leading dots).
 */
function sanitizeName(name) {
  const base = String(name || '').trim().replace(/[^a-zA-Z0-9_\-.]/g, '-');
  const safe = base.replace(/^\.+/, '').replace(/\.{2,}/g, '.');
  return safe || 'preset';
}

function presetPath(name) {
  return path.join(PRESETS_DIR, `${sanitizeName(name)}.json`);
}

// GET /api/presets — list all saved presets (names + metadata only)
router.get('/', (req, res) => {
  const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
  const presets = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf-8'));
      return {
        name: data.name || f.replace(/\.json$/, ''),
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
  res.json({ presets });
});

// GET /api/presets/:name — load a specific preset (full settings)
router.get('/:name', (req, res) => {
  const file = presetPath(req.params.name);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'Preset not found' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read preset: ' + err.message });
  }
});

// POST /api/presets — save (create or overwrite) a preset
router.post('/', (req, res) => {
  const { name, settings } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Preset name is required' });
  }
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'Preset settings are required' });
  }
  const file = presetPath(name);
  const exists = fs.existsSync(file);
  const existing = exists ? safeRead(file) : null;
  const data = {
    name: name.trim(),
    settings,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    res.json({ ok: true, name: data.name, created: !exists, updatedAt: data.updatedAt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save preset: ' + err.message });
  }
});

// DELETE /api/presets/:name — delete a preset
router.delete('/:name', (req, res) => {
  const file = presetPath(req.params.name);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'Preset not found' });
  }
  try {
    fs.unlinkSync(file);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete preset: ' + err.message });
  }
});

function safeRead(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

module.exports = router;
