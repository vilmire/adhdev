/**
 * DevServer — CDP & DOM Handlers
 *
 * Extracted from dev-server.ts for maintainability.
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as http from 'http';
import type { DevServerContext } from './dev-server-types.js';
import { LOG } from '../logging/logger.js';

export async function handleCdpEvaluate(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { expression, timeout, ideType } = body;
  if (!expression) {
    ctx.json(res, 400, { error: 'expression required' });
    return;
  }

  const cdp = ctx.getCdp(ideType);
  if (!cdp && !ideType) {
    LOG.warn('DevServer', 'CDP evaluate without ideType — picked first connected manager');
  }
  if (!cdp?.isConnected) {
    ctx.json(res, 503, { error: 'No CDP connection available' });
    return;
  }

  try {
    const raw = await cdp.evaluate(expression, timeout || 30000);
    let result = raw;
    if (typeof raw === 'string') {
      try { result = JSON.parse(raw); } catch { /* keep */ }
    }
    ctx.json(res, 200, { result });
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleCdpClick(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { ideType, x, y } = body;
  if (x == null || y == null) {
    ctx.json(res, 400, { error: 'x and y coordinates required' });
    return;
  }

  const cdp = ctx.getCdp(ideType);
  if (!cdp?.isConnected) {
    ctx.json(res, 503, { error: 'No CDP connection available' });
    return;
  }

  try {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    ctx.json(res, 200, { success: true, clicked: true, x, y });
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleCdpDomQuery(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { selector, limit = 10, ideType } = body;
  if (!selector) {
    ctx.json(res, 400, { error: 'selector required' });
    return;
  }

  const cdp = ctx.getCdp(ideType as string);
  if (!cdp) {
    ctx.json(res, 503, { error: 'No CDP connection available' });
    return;
  }

  const expr = `(() => {
    try {
      const els = document.querySelectorAll('${selector.replace(/'/g, "\\'")}');
      const results = [];
      for (let i = 0; i < Math.min(els.length, ${limit}); i++) {
        const el = els[i];
        results.push({
          index: i,
          tag: el.tagName?.toLowerCase(),
          id: el.id || null,
          class: el.className && typeof el.className === 'string' ? el.className.trim().slice(0, 200) : null,
          role: el.getAttribute?.('role') || null,
          text: (el.textContent || '').trim().slice(0, 100),
          visible: el.offsetParent !== null || el.offsetWidth > 0,
          rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })()
        });
      }
      return JSON.stringify({ total: els.length, results });
    } catch (e) { return JSON.stringify({ error: e.message }); }
  })()`;

  try {
    const raw = await cdp.evaluate(expr, 10000);
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    ctx.json(res, 200, result);
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleScreenshot(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const ideType = url.searchParams.get('ideType') || undefined;
  const cdp = ctx.getCdp(ideType);
  if (!cdp) {
    ctx.json(res, 503, { error: 'No CDP connection available' });
    return;
  }

  try {
    // Get viewport metrics before capturing
    let vpW = 0, vpH = 0;
    try {
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, 3000);
      const vp = metrics?.cssVisualViewport || metrics?.visualViewport;
      if (vp) {
        vpW = Math.round(vp.clientWidth || vp.width || 0);
        vpH = Math.round(vp.clientHeight || vp.height || 0);
      }
    } catch { /* ignore */ }

    const buf = await cdp.captureScreenshot();
    if (buf) {
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'X-Viewport-Width': String(vpW),
        'X-Viewport-Height': String(vpH),
      });
      res.end(buf);
    } else {
      ctx.json(res, 500, { error: 'Screenshot failed' });
    }
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleScriptsRun(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { type, script: scriptName, params } = body;
  if (!type || !scriptName) {
    ctx.json(res, 400, { error: 'type and script required' });
    return;
  }
  // Delegate to handleRunScript
  await ctx.handleRunScript(type, req, res, body);
}

export async function handleTypeAndSend(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { selector, text } = body;
  if (!selector || typeof selector !== 'string' || !text || typeof text !== 'string') {
    ctx.json(res, 400, { error: 'selector and text strings required' }); return;
  }
  const cdp = ctx.getCdp(type);
  if (!cdp) {
    ctx.json(res, 503, { error: `CDP not connected for '${type}'` }); return;
  }
  try {
    const sent = await cdp.typeAndSend(selector, text);
    ctx.json(res, 200, { sent });
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleTypeAndSendAt(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { x, y, text } = body;
  if (typeof x !== 'number' || typeof y !== 'number' || !text || typeof text !== 'string') {
    ctx.json(res, 400, { error: 'x, y numbers and text string required' }); return;
  }
  const cdp = ctx.getCdp(type);
  if (!cdp) {
    ctx.json(res, 503, { error: `CDP not connected for '${type}'` }); return;
  }
  try {
    const sent = await cdp.typeAndSendAt(x, y, text);
    ctx.json(res, 200, { sent });
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleScriptHints(ctx: DevServerContext, type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const dir = ctx.findProviderDir(type);
  if (!dir) { ctx.json(res, 404, { error: `Provider not found: ${type}` }); return; }

  // Find scripts.js in the provider dir (may be versioned)
  let scriptsPath = '';
  const directScripts = path.join(dir, 'scripts.js');
  if (fs.existsSync(directScripts)) {
    scriptsPath = directScripts;
  } else {
    // Check versioned scripts dirs
    const scriptsDir = path.join(dir, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      const versions = fs.readdirSync(scriptsDir).filter(d => {
        return fs.statSync(path.join(scriptsDir, d)).isDirectory();
      }).sort().reverse();
      for (const ver of versions) {
        const p = path.join(scriptsDir, ver, 'scripts.js');
        if (fs.existsSync(p)) { scriptsPath = p; break; }
      }
    }
  }

  if (!scriptsPath) {
    ctx.json(res, 200, { hints: {} });
    return;
  }

  try {
    const source = fs.readFileSync(scriptsPath, 'utf-8');
    const hints: Record<string, { template: Record<string, any>; description: string }> = {};

    // Parse exported functions and extract param usage
    const funcRegex = /module\.exports\.(\w+)\s*=\s*function\s+\w+\s*\(params\)/g;
    let match;
    while ((match = funcRegex.exec(source)) !== null) {
      const name = match[1];
      // Find the function body (rough: from match to next module.exports or end)
      const startIdx = match.index;
      const nextFunc = source.indexOf('module.exports.', startIdx + 1);
      const funcBody = source.substring(startIdx, nextFunc > 0 ? nextFunc : source.length);

      const paramFields: Record<string, any> = {};

      // Pattern 1: params?.xxx or params.xxx
      const dotRegex = /params\?\.([a-zA-Z_]+)|params\.([a-zA-Z_]+)/g;
      let dm;
      while ((dm = dotRegex.exec(funcBody)) !== null) {
        const field = dm[1] || dm[2];
        if (field === 'length') continue;
        if (!(field in paramFields)) {
          // Infer type from context
          if (/index|count|port|timeout/i.test(field)) paramFields[field] = 0;
          else if (/action|text|title|message|model|mode|button|name|filter/i.test(field)) paramFields[field] = '';
          else paramFields[field] = '';
        }
      }

      // Pattern 2: typeof params === 'string' ? params : params?.xxx
      const typeofRegex = /typeof params === 'string' \? params : params\?\.([a-zA-Z_]+)/g;
      let tm;
      while ((tm = typeofRegex.exec(funcBody)) !== null) {
        const field = tm[1];
        if (!(field in paramFields)) paramFields[field] = '';
      }

      // Pattern 3: typeof params === 'number' ? params : params?.xxx
      const numRegex = /typeof params === 'number' \? params : params\?\.([a-zA-Z_]+)/g;
      let nm;
      while ((nm = numRegex.exec(funcBody)) !== null) {
        const field = nm[1];
        if (!(field in paramFields)) paramFields[field] = 0;
      }

      // Determine description from function name
      const descriptions: Record<string, string> = {
        readChat: 'No params required',
        sendMessage: 'Text to send to the chat',
        listSessions: 'No params required',
        switchSession: 'Switch by index or title',
        newSession: 'No params required',
        focusEditor: 'No params required',
        openPanel: 'No params required',
        resolveAction: 'Approve/reject action buttons',
        listNotifications: 'Optional message filter',
        dismissNotification: 'Dismiss by index, message, or button',
        listModels: 'No params required',
        setModel: 'Model name to select',
        listModes: 'No params required',
        setMode: 'Mode name to select',
      };

      hints[name] = {
        template: Object.keys(paramFields).length > 0 ? paramFields : {},
        description: descriptions[name] || (Object.keys(paramFields).length > 0 ? 'Params: ' + Object.keys(paramFields).join(', ') : 'No params'),
      };
    }

    ctx.json(res, 200, { hints });
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleCdpTargets(ctx: DevServerContext, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const targets: { ide: string; connected: boolean; port: number }[] = [];
  for (const [ide, cdp] of ctx.cdpManagers.entries()) {
    targets.push({ ide, connected: cdp.isConnected, port: cdp.getPort() });
  }
  ctx.json(res, 200, { targets });
}

export async function handleDomInspect(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { x, y, selector, ideType } = body;
  const cdp = ctx.getCdp(ideType);
  if (!cdp) { ctx.json(res, 503, { error: 'No CDP connection' }); return; }

  const selectorArg = selector ? JSON.stringify(selector) : 'null';
  const inspectScript = `(() => {
    function gs(el) {
      if (!el || el === document.body) return 'body';
      if (el.id) return '#' + CSS.escape(el.id);
      let s = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
        if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
      }
      const p = el.parentElement;
      if (p) {
        const sibs = [...p.children].filter(c => c.tagName === el.tagName);
        if (sibs.length > 1) s += ':nth-child(' + ([...p.children].indexOf(el) + 1) + ')';
      }
      return s;
    }
    function gp(el) {
      const parts = [];
      let c = el;
      while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
      return parts;
    }
    function ni(el) {
      if (!el) return null;
      const tag = el.tagName?.toLowerCase() || '#text';
      const attrs = {};
      if (el.attributes) for (const a of el.attributes) if (a.name !== 'class' && a.name !== 'style') attrs[a.name] = a.value?.substring(0, 200);
      const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 10) : [];
      const text = el.textContent?.trim().substring(0, 150) || '';
      const dt = [...(el.childNodes||[])].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).filter(Boolean).join(' ').substring(0,100);
      const cc = el.children?.length || 0;
      const r = el.getBoundingClientRect?.();
      return { tag, cls, attrs, text, directText: dt, childCount: cc, selector: gs(el), fullSelector: gp(el).join(' > '), rect: r ? {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)} : null };
    }
    const sel = ${selectorArg};
    let el = sel ? document.querySelector(sel) : document.elementFromPoint(${x || 0}, ${y || 0});
    if (!el) return JSON.stringify({ error: 'No element found' });
    const info = ni(el);
    const ancestors = [];
    let pp = el.parentElement;
    while (pp && pp !== document.documentElement) {
      ancestors.push({ tag: pp.tagName.toLowerCase(), selector: gs(pp), cls: (pp.className && typeof pp.className === 'string') ? pp.className.trim().split(/\\s+/).slice(0,3) : [] });
      pp = pp.parentElement;
    }
    const children = [...(el.children||[])].slice(0,50).map(c => ni(c));
    return JSON.stringify({ element: info, ancestors: ancestors.reverse(), children });
  })()`;

  try {
    const raw = await cdp.evaluate(inspectScript, 10000);
    let result = raw;
    if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
    ctx.json(res, 200, result as Record<string, unknown>);
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleDomChildren(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { selector, ideType } = body;
  const cdp = ctx.getCdp(ideType);
  if (!cdp) { ctx.json(res, 503, { error: 'No CDP connection' }); return; }
  if (!selector) { ctx.json(res, 400, { error: 'selector required' }); return; }

  const script = `(() => {
    function gs(el) {
      if (!el || el === document.body) return 'body';
      if (el.id) return '#' + CSS.escape(el.id);
      let s = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
        if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
      }
      const p = el.parentElement;
      if (p) {
        const sibs = [...p.children].filter(c => c.tagName === el.tagName);
        if (sibs.length > 1) s += ':nth-child(' + ([...p.children].indexOf(el) + 1) + ')';
      }
      return s;
    }
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ error: 'Element not found' });
    const children = [...(el.children||[])].slice(0,100).map(c => {
      const tag = c.tagName?.toLowerCase();
      const cls = (c.className && typeof c.className === 'string') ? c.className.trim().split(/\\s+/).filter(Boolean).slice(0,10) : [];
      const attrs = {};
      for (const a of c.attributes) if (a.name!=='class'&&a.name!=='style') attrs[a.name] = a.value?.substring(0,200);
      const text = c.textContent?.trim().substring(0,150)||'';
      const dt = [...c.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).filter(Boolean).join(' ').substring(0,100);
      return { tag, cls, attrs, text, directText: dt, childCount: c.children?.length||0, selector: gs(c) };
    });
    return JSON.stringify({ selector: ${JSON.stringify(selector)}, childCount: el.children?.length||0, children });
  })()`;

  try {
    const raw = await cdp.evaluate(script, 10000);
    let result = raw;
    if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
    ctx.json(res, 200, result as Record<string, unknown>);
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleDomAnalyze(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { ideType, selector, x, y } = body;
  const cdp = ctx.getCdp(ideType);
  if (!cdp) { ctx.json(res, 503, { error: 'No CDP connection' }); return; }

  const selectorArg = selector ? JSON.stringify(selector) : 'null';
  const analyzeScript = `(() => {
    function gs(el) {
      if (!el || el === document.body) return 'body';
      if (el.id) return '#' + CSS.escape(el.id);
      let s = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
        if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
      }
      return s;
    }
    function fp(el) {
      const parts = [];
      let c = el;
      while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
      return parts.join(' > ');
    }
    function sigOf(el) {
      return el.tagName + '|' + ((el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).sort().join('.') : '');
    }

    // Find target element
    const sel = ${selectorArg};
    let target = sel ? document.querySelector(sel) : document.elementFromPoint(${x || 0}, ${y || 0});
    if (!target) return JSON.stringify({ error: 'Element not found' });

    const result = {
      target: { tag: target.tagName.toLowerCase(), selector: fp(target), text: (target.textContent||'').trim().substring(0, 200) },
      siblingPattern: null,
      ancestorAnalysis: [],
      subtreeTexts: [],
    };

    // 1. Walk UP parents — at each level, find sibling patterns
    let el = target;
    let depth = 0;
    while (el && el !== document.body && depth < 15) {
      const parent = el.parentElement;
      if (!parent) break;

      const mySig = sigOf(el);
      const siblings = [...parent.children].filter(c => sigOf(c) === mySig);
      const totalChildren = parent.children.length;
      const childSel = gs(el).replace(/:nth-child\\(\\d+\\)/, '');
      const parentSel = fp(parent);

      result.ancestorAnalysis.push({
        depth,
        parentTag: parent.tagName.toLowerCase(),
        parentSelector: parentSel,
        totalChildren,
        matchingSiblings: siblings.length,
        childSelector: childSel,
        fullSelector: parentSel + ' > ' + childSel,
      });

      // Best sibling pattern: 3+ matching siblings with text
      if (!result.siblingPattern && siblings.length >= 3) {
        const siblingData = siblings.map((s, i) => {
          const directText = [...s.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' ').substring(0, 120);
          const allText = (s.textContent || '').trim().substring(0, 200);
          const childCount = s.children?.length || 0;
          const cls = (s.className && typeof s.className === 'string') ? s.className.trim().split(/\\s+/).filter(Boolean) : [];
          const attrs = {};
          if (s.attributes) for (const a of s.attributes) {
            if (a.name !== 'class' && a.name !== 'style' && a.value) attrs[a.name] = a.value.substring(0, 100);
          }
          return { index: i, directText, allText, childCount, cls, attrs, tag: s.tagName.toLowerCase() };
        });

        // Find common attributes across siblings
        const allAttrs = siblingData.map(s => Object.keys(s.attrs));
        const commonAttrs = allAttrs[0]?.filter(attr => allAttrs.every(a => a.includes(attr))) || [];
        // Find varying attributes (data-*, role, etc)
        const varyingAttrs = {};
        for (const attr of commonAttrs) {
          const values = siblingData.map(s => s.attrs[attr]);
          const unique = [...new Set(values)];
          if (unique.length > 1) varyingAttrs[attr] = unique.slice(0, 5);
        }

        result.siblingPattern = {
          count: siblings.length,
          selector: parentSel + ' > ' + childSel,
          parentSelector: parentSel,
          depthFromTarget: depth,
          siblings: siblingData.slice(0, 30),
          commonAttrs,
          varyingAttrs,
        };
      }

      el = parent;
      depth++;
    }

    // 2. Collect subtree text nodes from target
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode()) && result.subtreeTexts.length < 30) {
      const text = node.textContent.trim();
      if (text.length > 2) {
        const parentTag = node.parentElement?.tagName?.toLowerCase() || '';
        const parentCls = (node.parentElement?.className && typeof node.parentElement.className === 'string')
          ? node.parentElement.className.trim().split(/\\s+/).filter(Boolean).slice(0,3).join('.') : '';
        result.subtreeTexts.push({
          text: text.substring(0, 150),
          parentTag,
          parentCls,
          parentSelector: gs(node.parentElement),
        });
      }
    }

    return JSON.stringify(result);
  })()`;

  try {
    const raw = await cdp.evaluate(analyzeScript, 15000);
    let result = raw;
    if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
    ctx.json(res, 200, result as Record<string, unknown>);
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleFindCommon(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { include, exclude, ideType } = body;
  if (!Array.isArray(include) || include.length === 0) { ctx.json(res, 400, { error: 'include[] is required' }); return; }
  const cdp = ctx.getCdp(ideType);
  if (!cdp) { ctx.json(res, 503, { error: 'No CDP connection' }); return; }

  const script = `(() => {
    const includes = ${JSON.stringify(include)};
    const excludes = ${JSON.stringify(exclude || [])};

    function gs(el) {
      if (!el || el === document.body) return 'body';
      if (el.id) return '#' + CSS.escape(el.id);
      let s = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
        if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
      }
      return s;
    }
    function fp(el) {
      const parts = [];
      let c = el;
      while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
      return parts.join(' > ');
    }
    function sig(el) {
      return el.tagName + '|' + ((el.className && typeof el.className === 'string') ? el.className.trim() : '');
    }

    // Step 1: For each include, find all matching leaf elements
    const includeMatches = includes.map(text => {
      const lower = text.toLowerCase();
      const found = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.textContent.toLowerCase().includes(lower) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      });
      let node;
      while ((node = walker.nextNode()) && found.length < 5) {
        if (node.parentElement) found.push(node.parentElement);
      }
      return found;
    });

    if (includeMatches.some(m => m.length === 0)) {
      const missing = includes.filter((_, i) => includeMatches[i].length === 0);
      return JSON.stringify({ results: [], message: 'Text not found: ' + missing.join(', ') });
    }

    // Step 2: Find LCA for each combination of include elements
    // For each pair of include[0] element and include[1] element, find their LCA
    // Then within the LCA, find the direct-child subtree branch for each
    const containers = [];
    const seen = new Set();

    function findLCA(el1, el2) {
      const ancestors1 = new Set();
      let c = el1;
      while (c) { ancestors1.add(c); c = c.parentElement; }
      c = el2;
      while (c) { if (ancestors1.has(c)) return c; c = c.parentElement; }
      return document.body;
    }

    function findDirectChildContaining(parent, descendant) {
      let c = descendant;
      while (c && c.parentElement !== parent) c = c.parentElement;
      return c;
    }

    // Try all combinations (first 3 matches per include)
    for (const el1 of includeMatches[0].slice(0, 3)) {
      for (let ii = 1; ii < includeMatches.length; ii++) {
        for (const el2 of includeMatches[ii].slice(0, 3)) {
          if (el1 === el2) continue;
          const lca = findLCA(el1, el2);
          if (!lca || lca === document.body || lca === document.documentElement) continue;

          // Find which direct child of LCA contains each include element
          const child1 = findDirectChildContaining(lca, el1);
          const child2 = findDirectChildContaining(lca, el2);
          if (!child1 || !child2 || child1 === child2) continue;

          const lcaSel = fp(lca);
          if (seen.has(lcaSel)) continue;
          seen.add(lcaSel);

          // Check exclude
          if (excludes.length > 0) {
            const lcaText = (lca.textContent || '').toLowerCase();
            if (excludes.some(ex => lcaText.includes(ex.toLowerCase()))) continue;
          }

          // Are child1 and child2 same tag? (relaxed — ignore classes)
          const tag1 = child1.tagName;
          const tag2 = child2.tagName;

          // Bubble up: walk up from LCA, find the best list container
          // (the one with most repeating same-tag children)
          let container = lca;
          let bestContainer = lca;
          let bestListCount = 0;
          for (let up = 0; up < 10; up++) {
            const p = container.parentElement;
            if (!p || p === document.body || p === document.documentElement) break;
            // Check how many same-tag siblings 'container' has in parent
            const myTag = container.tagName;
            const sibCount = [...p.children].filter(c => c.tagName === myTag).length;
            if (sibCount > bestListCount) {
              bestListCount = sibCount;
              bestContainer = p;
            }
            container = p;
          }
          container = bestListCount >= 3 ? bestContainer : lca;

          const allChildren = [...container.children];
          const childTag = tag1 === tag2 ? tag1 : (allChildren.length > 0 ? allChildren[0].tagName : '');
          const sameTagCount = allChildren.filter(c => c.tagName === childTag).length;
          const isList = sameTagCount >= 3 && sameTagCount >= allChildren.length * 0.4;

          // Gather all same-tag children as list items
          const listItems = isList 
            ? allChildren.filter(c => c.tagName === childTag)
            : allChildren;

          // Filter rendered items (skip virtual scroll placeholders)
          const rendered = listItems.filter(c => (c.innerText || '').trim().length > 0);
          const placeholderCount = listItems.length - rendered.length;

          const containerSel = fp(container);
          if (seen.has(containerSel)) continue;
          seen.add(containerSel);

          const r = container.getBoundingClientRect();
          containers.push({
            selector: containerSel,
            tag: container.tagName.toLowerCase(),
            childCount: allChildren.length,
            listItemCount: listItems.length,
            renderedCount: rendered.length,
            placeholderCount,
            isList,
            rect: { w: Math.round(r.width), h: Math.round(r.height) },
            depth: containerSel.split(' > ').length,
            items: rendered.slice(0, 30).map((el, i) => {
              const fullText = (el.innerText || el.textContent || '').trim();
              // Find snippet around first matched include text
              let text = fullText.substring(0, 200);
              const matched = [];
              for (const inc of includes) {
                const idx = fullText.toLowerCase().indexOf(inc.toLowerCase());
                if (idx >= 0) {
                  matched.push(inc);
                  if (matched.length === 1) {
                    // Show snippet around first match
                    const start = Math.max(0, idx - 30);
                    const end = Math.min(fullText.length, idx + inc.length + 80);
                    text = (start > 0 ? '...' : '') + fullText.substring(start, end) + (end < fullText.length ? '...' : '');
                  }
                }
              }
              return {
                index: i,
                tag: el.tagName.toLowerCase(),
                cls: (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0, 2).join(' ') : '',
                text,
                matchedIncludes: matched,
                childCount: el.children.length,
                h: Math.round(el.getBoundingClientRect().height),
              };
            }),
          });
        }
      }
    }

    // Sort: list containers first (more items = better), then by depth
    containers.sort((a, b) => {
      if (a.isList !== b.isList) return a.isList ? -1 : 1;
      return b.listItemCount - a.listItemCount || b.depth - a.depth;
    });

    return JSON.stringify({
      results: containers.slice(0, 10),
      includeCount: includes.length,
      excludeCount: excludes.length,
    });
  })()`;

  try {
    const raw = await cdp.evaluate(script, 10000);
    let result = raw;
    if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
    ctx.json(res, 200, result as Record<string, unknown>);
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleFindByText(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { text, ideType, containerSelector } = body;
  if (!text || typeof text !== 'string') { ctx.json(res, 400, { error: 'text is required' }); return; }
  const cdp = ctx.getCdp(ideType);
  if (!cdp) { ctx.json(res, 503, { error: 'No CDP connection' }); return; }

  const containerArg = containerSelector ? JSON.stringify(containerSelector) : 'null';
  const script = `(() => {
    function gs(el) {
      if (!el || el === document.body) return 'body';
      if (el.id) return '#' + CSS.escape(el.id);
      let s = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
        if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
      }
      return s;
    }
    function fp(el) {
      const parts = [];
      let c = el;
      while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
      return parts.join(' > ');
    }
    function parentSig(el) {
      // Signature: tag+class chain up 3 levels
      const parts = [];
      let c = el;
      for (let i = 0; i < 3 && c; i++) { parts.push(gs(c)); c = c.parentElement; }
      return parts.join(' < ');
    }

    const searchText = ${JSON.stringify(text)}.toLowerCase();
    const container = ${containerArg} ? document.querySelector(${containerArg}) : document.body;
    if (!container) return JSON.stringify({ error: 'Container not found' });

    const matches = [];
    const seen = new Set();

    // Find all text nodes containing the search text
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.textContent.toLowerCase().includes(searchText) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    let node;
    while ((node = walker.nextNode()) && matches.length < 50) {
      // Walk up to find the most specific visible element
      let el = node.parentElement;
      if (!el) continue;

      // Skip hidden elements
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;

      const selector = fp(el);
      if (seen.has(selector)) continue;
      seen.add(selector);

      // Walk up parent chain — record each level's selector + sibling count
      const ancestors = [];
      let cur = el;
      let pLvl = cur.parentElement;
      for (let lvl = 0; lvl < 10 && pLvl && pLvl !== document.body; lvl++) {
        const mySig = cur.tagName + '|' + ((cur.className && typeof cur.className === 'string') ? cur.className.trim().split(/\\s+/).sort().join('.') : '');
        const sibs = [...pLvl.children].filter(c => {
          const sig = c.tagName + '|' + ((c.className && typeof c.className === 'string') ? c.className.trim().split(/\\s+/).sort().join('.') : '');
          return sig === mySig;
        });
        const childSel = gs(cur).replace(/:nth-child\\(\\d+\\)/, '');
        ancestors.push({
          parentSelector: fp(pLvl),
          childSelector: childSel,
          fullSelector: fp(pLvl) + ' > ' + childSel,
          siblingCount: sibs.length,
          parentTag: pLvl.tagName.toLowerCase(),
        });
        cur = pLvl;
        pLvl = pLvl.parentElement;
      }

      const directText = (node.textContent || '').trim().substring(0, 200);
      const allText = (node.parentElement.textContent || '').trim().substring(0, 300);
      const tag = node.parentElement.tagName.toLowerCase();
      const cls = (node.parentElement.className && typeof node.parentElement.className === 'string')
        ? node.parentElement.className.trim().split(/\\s+/).filter(Boolean) : [];

      matches.push({
        selector,
        tag,
        cls,
        directText,
        allText,
        ancestors,
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        depth: selector.split(' > ').length,
      });
    }

    // Sort: prefer elements with more siblings in ancestry, then fewer depth
    matches.sort((a, b) => {
      const aMax = Math.max(1, ...a.ancestors.map(x => x.siblingCount));
      const bMax = Math.max(1, ...b.ancestors.map(x => x.siblingCount));
      return (bMax - aMax) || (a.depth - b.depth);
    });

    return JSON.stringify({ query: ${JSON.stringify(text)}, matches, total: matches.length });
  })()`;

  try {
    const raw = await cdp.evaluate(script, 10000);
    let result = raw;
    if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
    ctx.json(res, 200, result as Record<string, unknown>);
  } catch (e: any) {
    ctx.json(res, 500, { error: e.message });
  }
}

export async function handleDomContext(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { ideType } = body;
  const provider = ctx.providerLoader.resolve(type);
  if (!provider) { ctx.json(res, 404, { error: `Provider not found: ${type}` }); return; }

  const cdp = ctx.getCdp(ideType || type);
  if (!cdp) { ctx.json(res, 503, { error: 'No CDP connection available. Target IDE must be running with CDP enabled.' }); return; }

  try {
    // 1. Capture screenshot
    let screenshot: string | null = null;
    try {
      const buf = await cdp.captureScreenshot();
      if (buf) screenshot = buf.toString('base64');
    } catch { /* screenshot optional */ }

    // 2. Collect DOM snapshot
    const domScript = `(() => {
      function gs(el) {
        if (!el || el === document.body) return 'body';
        if (el.id) return '#' + CSS.escape(el.id);
        let s = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
          if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
        }
        return s;
      }
      function fp(el) {
        const parts = [];
        let c = el;
        while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
        return parts.join(' > ');
      }
      function rect(el) {
        try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }
        catch { return null; }
      }

      const result = { contentEditables: [], chatContainers: [], buttons: [], sidebars: [], dropdowns: [], inputs: [] };

      // Content editables + textareas + inputs
      document.querySelectorAll('[contenteditable], textarea, input[type="text"], input:not([type])').forEach(el => {
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
        result.contentEditables.push({
          selector: fp(el),
          tag: el.tagName.toLowerCase(),
          contenteditable: el.getAttribute('contenteditable'),
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          placeholder: el.getAttribute('placeholder'),
          rect: rect(el),
          visible: el.offsetParent !== null || el.offsetWidth > 0,
        });
      });

      // Chat containers — large divs with scroll
      document.querySelectorAll('div, section, main').forEach(el => {
        const style = getComputedStyle(el);
        const isScrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';
        const r = el.getBoundingClientRect();
        if (!isScrollable || r.height < 200 || r.width < 200) return;
        const childCount = el.children.length;
        if (childCount < 2) return;
        result.chatContainers.push({
          selector: fp(el),
          childCount,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          hasScrollable: true,
          scrollTop: Math.round(el.scrollTop),
          scrollHeight: Math.round(el.scrollHeight),
        });
      });

      // Buttons
      document.querySelectorAll('button, [role="button"]').forEach(el => {
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
        const text = (el.textContent || '').trim().substring(0, 80);
        if (!text && !el.getAttribute('aria-label')) return;
        result.buttons.push({
          text,
          ariaLabel: el.getAttribute('aria-label'),
          selector: fp(el),
          rect: rect(el),
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        });
      });

      // Sidebars — panels on left/right edges
      document.querySelectorAll('[class*="sidebar"], [class*="side-bar"], [class*="panel"], [role="complementary"], [role="navigation"], aside').forEach(el => {
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.height < 200) return;
        result.sidebars.push({
          selector: fp(el),
          position: r.x < window.innerWidth / 3 ? 'left' : r.x > window.innerWidth * 2 / 3 ? 'right' : 'center',
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          childCount: el.children.length,
        });
      });

      // Dropdowns — select, popover, menu patterns
      document.querySelectorAll('select, [role="listbox"], [role="menu"], [role="combobox"], [class*="dropdown"], [class*="popover"]').forEach(el => {
        result.dropdowns.push({
          selector: fp(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          visible: el.offsetParent !== null || el.offsetWidth > 0,
          rect: rect(el),
        });
      });

      return JSON.stringify(result);
    })()`;

    const raw = await cdp.evaluate(domScript, 15000);
    let domSnapshot: any = {};
    if (typeof raw === 'string') { try { domSnapshot = JSON.parse(raw); } catch { domSnapshot = { raw }; } }
    else domSnapshot = raw;

    ctx.json(res, 200, {
      screenshot: screenshot ? `base64:${screenshot}` : null,
      domSnapshot,
      pageTitle: await cdp.evaluate('document.title', 3000).catch(() => ''),
      pageUrl: await cdp.evaluate('window.location.href', 3000).catch(() => ''),
      providerType: type,
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    ctx.json(res, 500, { error: `DOM context collection failed: ${e.message}` });
  }
}
