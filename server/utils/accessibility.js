/**
 * Shared accessibility tree capture utility.
 *
 * `page.accessibility.snapshot()` was removed in newer Playwright versions.
 * This module uses the CDP `Accessibility.getFullAXTree` command to build
 * a tree in the same shape that the old API returned:
 *   { role, name, focused, disabled, checked, value, children: [...] }
 *
 * Also supports capturing accessibility trees from within iframes by
 * creating CDP sessions for each child frame.
 */

/**
 * Capture the accessibility tree for a Playwright page via CDP.
 * Includes shadow DOM elements (the CDP Accessibility domain traverses
 * shadow roots automatically when using getFullAXTree).
 * @param {import('playwright').Page} page
 * @returns {Promise<object|null>} Tree root node, or null if empty.
 */
async function captureAccessibilityTree(page) {
  const client = await page.context().newCDPSession(page);
  const { nodes } = await client.send('Accessibility.getFullAXTree');
  await client.detach();

  // Build a map of nodeId -> raw node data (keep ignored nodes so we can
  // traverse through them to reach their non-ignored descendants)
  const nodeMap = new Map();
  for (const n of nodes) {
    const props = {};
    if (n.properties) {
      for (const p of n.properties) {
        props[p.name] = p.value && p.value.value !== undefined ? p.value.value : p.value;
      }
    }
    nodeMap.set(n.nodeId, {
      role: n.role ? n.role.value : 'none',
      name: n.name ? n.name.value : '',
      focused: props.focused || false,
      disabled: props.disabled || false,
      checked: props.checked,
      value: n.value ? n.value.value : undefined,
      childIds: n.childIds || [],
      ignored: !!n.ignored,
      children: [],
      // CSS selector path for iframe/shadow DOM element identification
      cssPath: props.cssPath || null,
    });
  }

  // Find root node(s) — nodes whose parentId is missing or not in the map
  const nodeIds = new Set(nodeMap.keys());
  const roots = nodes.filter(n => !n.parentId || !nodeIds.has(n.parentId));

  // Recursively build a tree, skipping ignored nodes but still traversing
  // into their children to find non-ignored descendants.
  const buildTree = (nodeId) => {
    const node = nodeMap.get(nodeId);
    if (!node) return { node: null, children: [] };
    const collected = [];
    for (const childId of node.childIds) {
      const { node: childNode, children: childChildren } = buildTree(childId);
      if (childNode) {
        collected.push(childNode);
      } else {
        collected.push(...childChildren);
      }
    }
    node.children = collected;
    return { node: node.ignored ? null : node, children: collected };
  };

  let root = null;
  if (roots.length > 0) {
    const result = buildTree(roots[0].nodeId);
    root = result.node || (result.children.length > 0 ? result.children[0] : null);
  }
  return root;
}

/**
 * Capture accessibility trees from all iframes on a page.
 * Returns an array of { frameUrl, frameName, selector, tree } objects.
 * The `selector` is a CSS selector that can be used with page.frameLocator()
 * to target the iframe in generated tests.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array>}
 */
async function captureIframeAccessibilityTrees(page) {
  const iframeData = [];

  // Get all iframe elements on the page with their selectors
  const iframes = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe')).map((iframe, index) => {
      // Build a CSS selector for this iframe
      let selector = '';
      if (iframe.id) {
        selector = `#${iframe.id}`;
      } else if (iframe.name) {
        selector = `iframe[name="${iframe.name}"]`;
      } else if (iframe.src) {
        selector = `iframe[src="${iframe.src}"]`;
      } else {
        // Fallback: nth-of-type selector
        const allIframes = Array.from(document.querySelectorAll('iframe'));
        const idx = allIframes.indexOf(iframe);
        selector = `iframe:nth-of-type(${idx + 1})`;
      }
      return {
        selector,
        src: iframe.src,
        name: iframe.name || '',
        id: iframe.id || '',
        title: iframe.title || '',
      };
    });
  }).catch(() => []);

  const TRACKING_PATTERNS = [
    'doubleclick', 'google-analytics', 'googletagmanager', 'facebook',
    'optimizely', 'hotjar', 'recaptcha', 'youtube', 'vimeo', 'ads',
    'marketing', 'pixel', 'chat', 'feedback', 'xdremote', 'livechat',
    'hubspot', 'salesforce', 'drift', 'intercom'
  ];

  for (const iframe of iframes) {
    const isTracker = [iframe.src, iframe.id, iframe.name].some(val => {
      if (!val) return false;
      const lower = val.toLowerCase();
      return TRACKING_PATTERNS.some(p => lower.includes(p));
    });
    if (isTracker) {
      // Skip third-party trackers, widgets, and ads silently to avoid CDP overhead
      continue;
    }
    try {
      // Find the frame object
      const frame = page.frames().find(f =>
        f.url() === iframe.src || (iframe.name && f.name() === iframe.name)
      );

      if (frame) {
        let tree = null;
        try {
          // Capture the accessibility tree from within the iframe
          const iframeClient = await page.context().newCDPSession(frame);
          const { nodes } = await iframeClient.send('Accessibility.getFullAXTree');
          await iframeClient.detach();

          // Build tree from iframe nodes (same logic as main tree)
          tree = buildTreeFromNodes(nodes);
        } catch (cdpErr) {
          // Cross-origin frames reject CDP sessions — but Playwright CAN
          // evaluate inside them. Fall back to an aria snapshot of the
          // frame's body so embedded widgets (payment fields, embedded
          // apps) still contribute elements to the page model. The tree
          // is flattened (no nesting), which is sufficient for the
          // role+name element list consumers use.
          try {
            const yaml = await frame.locator('body').ariaSnapshot({ timeout: 8000 });
            tree = treeFromAriaYaml(yaml, iframe.title || iframe.src || 'iframe');
          } catch { /* frame gone or empty — skip */ }
        }
        if (tree) {
          iframeData.push({
            frameUrl: iframe.src,
            frameName: iframe.name,
            frameSelector: iframe.selector,
            frameTitle: iframe.title,
            tree,
          });
        }
      }
    } catch (err) {
      // Cross-origin iframes (e.g. analytics, tracking, social widgets) don't
      // have a separate CDP session — this is expected and not actionable.
      // Only log unexpected errors.
      if (!err.message.includes('does not have a separate CDP session')) {
        console.warn(`Could not capture iframe ${iframe.selector}: ${err.message}`);
      }
    }
  }

  return iframeData;
}

/**
 * Build a tree from CDP accessibility nodes (shared helper).
 */
function buildTreeFromNodes(nodes) {
  const nodeMap = new Map();
  for (const n of nodes) {
    const props = {};
    if (n.properties) {
      for (const p of n.properties) {
        props[p.name] = p.value && p.value.value !== undefined ? p.value.value : p.value;
      }
    }
    nodeMap.set(n.nodeId, {
      role: n.role ? n.role.value : 'none',
      name: n.name ? n.name.value : '',
      focused: props.focused || false,
      disabled: props.disabled || false,
      checked: props.checked,
      value: n.value ? n.value.value : undefined,
      childIds: n.childIds || [],
      ignored: !!n.ignored,
      children: [],
    });
  }

  const nodeIds = new Set(nodeMap.keys());
  const roots = nodes.filter(n => !n.parentId || !nodeIds.has(n.parentId));

  const buildTree = (nodeId) => {
    const node = nodeMap.get(nodeId);
    if (!node) return { node: null, children: [] };
    const collected = [];
    for (const childId of node.childIds) {
      const { node: childNode, children: childChildren } = buildTree(childId);
      if (childNode) {
        collected.push(childNode);
      } else {
        collected.push(...childChildren);
      }
    }
    node.children = collected;
    return { node: node.ignored ? null : node, children: collected };
  };

  if (roots.length === 0) return null;
  const result = buildTree(roots[0].nodeId);
  return result.node || (result.children.length > 0 ? result.children[0] : null);
}

/**
 * Build a synthetic accessibility tree from an ai-mode aria snapshot YAML.
 * Used as the cross-origin iframe fallback: frames reject CDP sessions, but
 * `frame.locator('body').ariaSnapshot()` pierces the origin boundary.
 * Produces a flat tree — root WebArea with element children — sufficient
 * for the role+name pair extraction consumers perform.
 * @param {string} yaml
 * @param {string} frameName
 * @returns {object|null}
 */
function treeFromAriaYaml(yaml, frameName) {
  if (!yaml) return null;
  const { parseAriaRefs } = require('./aria-snapshot');
  const elements = parseAriaRefs(yaml).filter(e => e.name);
  if (elements.length === 0) return null;
  return {
    role: 'WebArea',
    name: frameName,
    focused: false,
    children: elements.map(e => ({
      role: e.role,
      name: e.name,
      focused: false,
      disabled: false,
      children: [],
    })),
  };
}

module.exports = { captureAccessibilityTree, captureIframeAccessibilityTrees };
