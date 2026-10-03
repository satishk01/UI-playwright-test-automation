const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_CLOCK_TIME,
  parseAriaRefs,
  captureAriaElements,
  tagVisibilityFromSnapshot,
  snapshotContentHash,
  describeElementsForPrompt,
} = require('../server/utils/aria-snapshot');

const YAML = `- navigation:
  - link "Home" [ref=e2] [box=10,10,50,20]
  - link "Cart" [ref=e3] [box=70,10,50,20]
- main:
  - heading "Products" [ref=e5] [box=10,50,200,30]
  - textbox "Search" [ref=e8] [disabled] [box=10,90,300,30]
  - link "Hidden deal" [ref=e9] [box=0,0,0,0]
  - button "Buy \\"now\\"" [ref=e10] [box=10,140,80,30]`;

// ── parseAriaRefs ──

test('parseAriaRefs: extracts role/name/ref/box from ai-mode YAML', () => {
  const els = parseAriaRefs(YAML);
  const link = els.find(e => e.ref === 'e2');
  assert.equal(link.role, 'link');
  assert.equal(link.name, 'Home');
  assert.deepEqual(link.box, { x: 10, y: 10, w: 50, h: 20 });
});

test('parseAriaRefs: includes container nodes without refs', () => {
  const els = parseAriaRefs(YAML);
  assert.ok(els.some(e => e.role === 'navigation' && e.ref === null));
});

test('parseAriaRefs: unescapes quoted names', () => {
  const els = parseAriaRefs(YAML);
  const btn = els.find(e => e.ref === 'e10');
  assert.equal(btn.name, 'Buy "now"');
});

test('parseAriaRefs: empty input yields empty list', () => {
  assert.deepEqual(parseAriaRefs(null), []);
  assert.deepEqual(parseAriaRefs(''), []);
});

// ── captureAriaElements (PW 1.63 ariaSnapshotJSON) ──

test('captureAriaElements: prefers ariaSnapshotJSON and flattens the tree', async () => {
  const fakePage = {
    ariaSnapshotJSON: async () => ([
      { role: 'navigation', children: [
        { role: 'link', name: 'Home', ref: 'e2', url: '/', box: { x: 1, y: 2, width: 3, height: 4 }, cursor: 'pointer' },
      ] },
      { role: 'textbox', name: 'Search', ref: 'e8' },
    ]),
  };
  const els = await captureAriaElements(fakePage, null);
  const link = els.find(e => e.ref === 'e2');
  assert.equal(link.role, 'link');
  assert.equal(link.name, 'Home');
  assert.equal(link.url, '/');
  assert.equal(link.cursor, 'pointer');
  assert.deepEqual(link.box, { x: 1, y: 2, w: 3, h: 4 });
  assert.ok(els.some(e => e.role === 'navigation'));
});

test('captureAriaElements: falls back to YAML parse when JSON API missing', async () => {
  const fakePage = {}; // no ariaSnapshotJSON (pre-1.63)
  const els = await captureAriaElements(fakePage, YAML);
  assert.ok(els.some(e => e.ref === 'e2' && e.name === 'Home'));
});

test('captureAriaElements: falls back to YAML parse when JSON call throws', async () => {
  const fakePage = { ariaSnapshotJSON: async () => { throw new Error('boom'); } };
  const els = await captureAriaElements(fakePage, YAML);
  assert.ok(els.some(e => e.ref === 'e9'));
});

// ── tagVisibilityFromSnapshot ──

test('tagVisibilityFromSnapshot: marks zero-size-box elements hidden and tags refs', () => {
  const refs = parseAriaRefs(YAML);
  const pairs = [
    { role: 'link', name: 'Home' },
    { role: 'link', name: 'Hidden deal' },
    { role: 'link', name: 'Not in snapshot' },
  ];
  const matched = tagVisibilityFromSnapshot(refs, pairs);
  assert.equal(pairs[0].ref, 'e2');
  assert.notEqual(pairs[0].visible, false);
  assert.equal(pairs[1].visible, false);
  assert.equal(matched.size, 2); // unmatched pair left for locator fallback
  assert.equal(pairs[2].ref, undefined);
});

test('tagVisibilityFromSnapshot: duplicate names consume distinct refs', () => {
  const refs = [
    { role: 'link', name: 'Shop', ref: 'e1', box: null },
    { role: 'link', name: 'Shop', ref: 'e2', box: null },
  ];
  const pairs = [{ role: 'link', name: 'Shop' }, { role: 'link', name: 'Shop' }];
  tagVisibilityFromSnapshot(refs, pairs);
  assert.equal(pairs[0].ref, 'e1');
  assert.equal(pairs[1].ref, 'e2');
});

// ── snapshotContentHash (§9 cross-run caching) ──

test('snapshotContentHash: stable across ref/box churn', () => {
  const a = { ariaYaml: '- link "Home" [ref=e2] [box=1,2,3,4]' };
  const b = { ariaYaml: '- link "Home" [ref=e9] [box=5,6,7,8]' };
  assert.equal(snapshotContentHash(a), snapshotContentHash(b));
});

test('snapshotContentHash: changes when page content changes', () => {
  const a = { ariaYaml: '- link "Home" [ref=e2]' };
  const b = { ariaYaml: '- link "Store" [ref=e2]' };
  assert.notEqual(snapshotContentHash(a), snapshotContentHash(b));
});

test('snapshotContentHash: falls back to roleNamePairs when no YAML', () => {
  const a = { roleNamePairs: [{ role: 'link', name: 'Home' }], forms: [] };
  const b = { roleNamePairs: [{ role: 'link', name: 'Home' }], forms: [] };
  assert.equal(snapshotContentHash(a), snapshotContentHash(b));
});

// ── describeElementsForPrompt ──

test('describeElementsForPrompt: prefers the aria YAML', () => {
  const out = describeElementsForPrompt({ ariaYaml: YAML, roleNamePairs: [] });
  assert.ok(out.includes('ref=eN'));
  assert.ok(out.includes(YAML));
});

test('describeElementsForPrompt: falls back to role/name list with iframe + hidden flags', () => {
  const out = describeElementsForPrompt({
    roleNamePairs: [
      { role: 'link', name: 'A', iframeSelector: '#f1' },
      { role: 'textbox', name: 'B', visible: false },
    ],
  }, { includeHidden: true });
  assert.ok(out.includes("[link] 'A' (inside iframe: #f1)"));
  assert.ok(out.includes("[textbox] 'B' (hidden)"));
});

// ── FIXED_CLOCK_TIME ──

test('FIXED_CLOCK_TIME: is a fixed parseable instant', () => {
  assert.ok(Number.isFinite(Date.parse(FIXED_CLOCK_TIME)));
});
