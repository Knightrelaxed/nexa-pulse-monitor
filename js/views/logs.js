'use strict';
/**
 * N.E.X.A Pulse Monitor — Full-Bleed Pure Monochrome White Logs Console
 *
 * Strictly monochrome typography per operator specification:
 * - Uniform crisp white text for ALL log lines (INFO, WARN, ERROR, stack traces)
 * - Muted neutral gray for timestamps & plain unboxed unit names
 * - ZERO color coding inside the log output
 */

import { escapeHtml, fmtWibLogTimestamp } from '../api.js';
import { LogsStreamClient } from '../logs_client.js';

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'errors', label: 'Errors' },
  { id: 'core', label: 'Core' },
  { id: 'bridge', label: 'Bridge' },
  { id: 'finance', label: 'Finance' },
  { id: 'auth', label: 'Auth' }
];

export function createLogsView(ctx) {
  let rootEl = null;
  let client = null;
  let activeCategory = 'all';
  let activeUnit = 'all';
  let activeTail = 200;
  let searchQuery = '';
  let wrapLines = true;
  let stickToBottom = true;
  let unseenCount = 0;
  let renderQueued = false;

  function filteredEntries() {
    if (!client) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return client.entries;
    return client.entries.filter(e =>
      e.message.toLowerCase().includes(q) ||
      e.unit.toLowerCase().includes(q) ||
      e.stackFrames.some(f => f.toLowerCase().includes(q))
    );
  }

  function drawMinimap(list) {
    const canvas = rootEl && rootEl.querySelector('#logs-minimap');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(10, Math.floor(rect.width || 12));
    const h = Math.max(80, Math.floor(rect.height || 400));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    if (!list || list.length === 0) return;

    // Purely neutral monochrome ticks showing log density / stack clusters
    const tickColor = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#6b7280';
    c.fillStyle = tickColor;
    const total = list.length;
    for (let i = 0; i < total; i++) {
      const e = list[i];
      const y = Math.floor((i / total) * h);
      if (e.stackFrames.length > 0 || e.prio <= 4) {
        c.globalAlpha = 0.55;
        c.fillRect(2, y, w - 4, 2);
      } else if (i % 6 === 0) {
        c.globalAlpha = 0.16;
        c.fillRect(3, y, w - 6, 1);
      }
    }
    c.globalAlpha = 1;
  }

  function renderEntriesNow() {
    renderQueued = false;
    if (!rootEl || !client) return;
    const viewport = rootEl.querySelector('#logs-viewport');
    const counter = rootEl.querySelector('#logs-counter');
    const latestPill = rootEl.querySelector('#logs-latest-pill');
    if (!viewport) return;

    const list = filteredEntries();
    if (counter) counter.textContent = `${list.length} / 2,000`;

    if (list.length === 0) {
      viewport.innerHTML = `<div class="logs-empty mono">${client.state === 'connecting' ? 'Connecting to /io/logs...' : 'No log entries matching current filter.'}</div>`;
      drawMinimap(list);
      return;
    }

    const htmlParts = [];
    for (const e of list) {
      const ts = fmtWibLogTimestamp(e.tsMs);
      const hasStack = e.stackFrames.length > 0;
      const stackToggle = hasStack
        ? `<button type="button" class="log-stack-toggle mono" data-toggle-stack="${e.id}">${e.expanded ? '▾' : '▸'} ${e.stackFrames.length} frames</button>`
        : '';
      htmlParts.push(
        `<div class="log-row mono" data-log-id="${e.id}">` +
          `<span class="log-ts">${escapeHtml(ts)}</span>` +
          `<span class="log-unit">${escapeHtml(e.unit)}</span>` +
          `<span class="log-msg">${escapeHtml(e.message)}${stackToggle}</span>` +
          `<button type="button" class="log-copy-btn mono" data-copy-log="${e.id}" title="Copy log line">Copy</button>` +
        `</div>`
      );
      if (hasStack && e.expanded) {
        htmlParts.push(`<div class="log-stack-box mono">${escapeHtml(e.stackFrames.join('\n'))}</div>`);
      }
    }

    viewport.innerHTML = htmlParts.join('');
    drawMinimap(list);

    if (stickToBottom) {
      viewport.scrollTop = viewport.scrollHeight;
      unseenCount = 0;
    }

    if (latestPill) {
      if (!stickToBottom) {
        latestPill.classList.remove('hidden');
        const label = unseenCount > 0 ? `Latest ↓ · +${unseenCount} new` : 'Latest ↓';
        latestPill.textContent = label;
      } else {
        latestPill.classList.add('hidden');
      }
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderEntriesNow);
  }

  function updateStatusBadge(state, detail) {
    if (!rootEl) return;
    const dot = rootEl.querySelector('#logs-status-dot');
    const txt = rootEl.querySelector('#logs-status-text');
    const pauseBtn = rootEl.querySelector('#logs-pause-btn');
    if (dot) {
      dot.className = 'dot ' + (state === 'live' ? 'dot-emerald' : state === 'paused' ? 'dot-amber' : state === 'error' ? 'dot-rose' : 'dot-muted');
    }
    if (txt) {
      txt.textContent = state === 'live'
        ? 'Live · /io/logs'
        : state === 'paused'
          ? 'Paused'
          : state === 'connecting'
            ? 'Connecting...'
            : (detail || 'Disconnected');
    }
    if (pauseBtn) {
      pauseBtn.textContent = client && client.paused ? 'Resume' : 'Pause';
    }
  }

  function renderShell() {
    if (!rootEl) return;
    rootEl.innerHTML = `
      <div class="logs-shell">
        <div class="logs-toolbar">
          <div class="logs-toolbar-group">
            <span class="pill mono">
              <span id="logs-status-dot" class="dot dot-muted"></span>
              <span id="logs-status-text">Connecting...</span>
            </span>
            ${CATEGORIES.map(c => `
              <button type="button" class="filter-pill ${activeCategory === c.id ? 'active' : ''}" data-cat="${c.id}">${c.label}</button>
            `).join('')}
            <select id="logs-unit-select" class="toolbar-select mono" aria-label="Filter systemd unit">
              <option value="all" ${activeUnit === 'all' ? 'selected' : ''}>All Units</option>
              <option value="nexa-server" ${activeUnit === 'nexa-server' ? 'selected' : ''}>nexa-server</option>
              <option value="caddy" ${activeUnit === 'caddy' ? 'selected' : ''}>caddy</option>
              <option value="nexa-io" ${activeUnit === 'nexa-io' ? 'selected' : ''}>nexa-io</option>
              <option value="systemd" ${activeUnit === 'systemd' ? 'selected' : ''}>systemd</option>
            </select>
          </div>

          <div class="logs-toolbar-group">
            <input id="logs-search-input" type="search" class="toolbar-search mono" placeholder="Filter logs... (/)" value="${escapeHtml(searchQuery)}">
            <select id="logs-tail-select" class="toolbar-select mono" aria-label="Initial tail lines" title="Tail lines">
              <option value="100" ${activeTail === 100 ? 'selected' : ''}>Tail 100</option>
              <option value="200" ${activeTail === 200 ? 'selected' : ''}>Tail 200</option>
              <option value="500" ${activeTail === 500 ? 'selected' : ''}>Tail 500</option>
            </select>
            <button id="logs-pause-btn" type="button" class="btn btn-sm">Pause</button>
            <button id="logs-wrap-btn" type="button" class="btn btn-sm ${wrapLines ? 'btn-cyan' : ''}">Wrap</button>
            <button id="logs-download-btn" type="button" class="btn btn-sm" title="Download visible logs locally">Export</button>
            <button id="logs-clear-btn" type="button" class="btn btn-sm">Clear</button>
            <span id="logs-counter" class="pill mono">0 / 2,000</span>
          </div>
        </div>

        <div class="logs-body">
          <div id="logs-viewport" class="logs-viewport ${wrapLines ? 'wrap-lines' : ''}" tabindex="0"></div>
          <canvas id="logs-minimap" class="logs-minimap" title="Click to jump in buffer"></canvas>
          <button id="logs-latest-pill" type="button" class="latest-pill mono hidden">Latest ↓</button>
        </div>
      </div>
    `;

    const viewport = rootEl.querySelector('#logs-viewport');
    viewport.addEventListener('scroll', () => {
      const distFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      stickToBottom = distFromBottom <= 28;
      const pill = rootEl && rootEl.querySelector('#logs-latest-pill');
      if (pill) {
        if (stickToBottom) {
          unseenCount = 0;
          pill.classList.add('hidden');
        } else {
          pill.classList.remove('hidden');
          pill.textContent = unseenCount > 0 ? `Latest ↓ · +${unseenCount} new` : 'Latest ↓';
        }
      }
    });

    rootEl.querySelector('#logs-unit-select').addEventListener('change', (ev) => {
      activeUnit = ev.target.value;
      if (client) {
        client.clearBuffer();
        client.applyFilter({ category: activeCategory, unit: activeUnit, tailLines: activeTail });
      }
    });

    rootEl.querySelector('#logs-tail-select').addEventListener('change', (ev) => {
      activeTail = Number(ev.target.value) || 200;
      if (ctx.updatePrefs) ctx.updatePrefs({ logsTail: activeTail });
      if (client) {
        client.clearBuffer();
        client.applyFilter({ category: activeCategory, unit: activeUnit, tailLines: activeTail });
      }
    });

    rootEl.querySelector('#logs-search-input').addEventListener('input', (ev) => {
      searchQuery = ev.target.value;
      scheduleRender();
    });

    rootEl.querySelector('#logs-minimap').addEventListener('click', (ev) => {
      const rect = ev.currentTarget.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ev.clientY - rect.top) / Math.max(1, rect.height)));
      viewport.scrollTop = frac * (viewport.scrollHeight - viewport.clientHeight);
    });
  }

  function handleClick(ev) {
    const catBtn = ev.target.closest('[data-cat]');
    if (catBtn) {
      activeCategory = catBtn.dataset.cat;
      rootEl.querySelectorAll('[data-cat]').forEach(b => b.classList.toggle('active', b.dataset.cat === activeCategory));
      if (client) {
        client.clearBuffer();
        client.applyFilter({ category: activeCategory, unit: activeUnit });
      }
      return;
    }

    const stackBtn = ev.target.closest('[data-toggle-stack]');
    if (stackBtn && client) {
      const id = Number(stackBtn.dataset.toggleStack);
      const entry = client.entries.find(e => e.id === id);
      if (entry) {
        entry.expanded = !entry.expanded;
        scheduleRender();
      }
      return;
    }

    if (ev.target.id === 'logs-pause-btn' && client) {
      client.setPaused(!client.paused);
      return;
    }

    if (ev.target.id === 'logs-wrap-btn') {
      wrapLines = !wrapLines;
      ev.target.classList.toggle('btn-cyan', wrapLines);
      const vp = rootEl.querySelector('#logs-viewport');
      if (vp) vp.classList.toggle('wrap-lines', wrapLines);
      return;
    }

    const copyBtn = ev.target.closest('[data-copy-log]');
    if (copyBtn && client) {
      const id = Number(copyBtn.dataset.copyLog);
      const entry = client.entries.find(e => e.id === id);
      if (entry) {
        const lines = [`[${fmtWibLogTimestamp(entry.tsMs)}] [${entry.unit}] ${entry.message}`, ...entry.stackFrames];
        const text = lines.join('\n');
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(() => ctx.toast('Log entry copied to clipboard.')).catch(() => ctx.toast('Clipboard write blocked.'));
        }
      }
      return;
    }

    if (ev.target.id === 'logs-download-btn' && client) {
      const list = filteredEntries();
      if (list.length === 0) {
        ctx.toast('No log lines to export.');
        return;
      }
      const text = list.map(e => {
        const head = `[${fmtWibLogTimestamp(e.tsMs)}] [${e.unit}] ${e.message}`;
        return e.stackFrames.length > 0 ? `${head}\n${e.stackFrames.join('\n')}` : head;
      }).join('\n') + '\n';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nexa-logs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      ctx.toast(`Exported ${list.length} log line(s) locally.`);
      return;
    }

    if (ev.target.id === 'logs-clear-btn' && client) {
      client.clearBuffer();
      unseenCount = 0;
      return;
    }

    if (ev.target.id === 'logs-latest-pill') {
      const vp = rootEl.querySelector('#logs-viewport');
      stickToBottom = true;
      unseenCount = 0;
      if (vp) vp.scrollTop = vp.scrollHeight;
      ev.target.classList.add('hidden');
    }
  }

  function handleKeyDown(ev) {
    if (ev.key === '/' && document.activeElement && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      ev.preventDefault();
      const input = rootEl && rootEl.querySelector('#logs-search-input');
      if (input) input.focus();
    }
  }

  return {
    async mount(el, opts = {}) {
      rootEl = el;
      rootEl.classList.add('full-bleed');
      activeCategory = (opts && opts.category) || 'all';
      activeUnit = (opts && opts.unit) || 'all';
      activeTail = (ctx.getPrefs && ctx.getPrefs().logsTail) || 200;
      searchQuery = (opts && opts.search) || '';
      stickToBottom = true;
      unseenCount = 0;

      renderShell();
      rootEl.addEventListener('click', handleClick);
      window.addEventListener('keydown', handleKeyDown);

      client = new LogsStreamClient({
        onEntries: (_entries, added) => {
          if (!stickToBottom && added > 0) unseenCount += added;
          scheduleRender();
        },
        onStateChange: (state, detail) => {
          updateStatusBadge(state, detail);
        },
        onError: (msg) => {
          ctx.toast(`Logs stream: ${msg}`);
        }
      });

      await client.connect({ category: activeCategory, unit: activeUnit, tailLines: activeTail });
    },
    onThemeChange() {
      scheduleRender();
    },
    unmount() {
      window.removeEventListener('keydown', handleKeyDown);
      if (rootEl) {
        rootEl.removeEventListener('click', handleClick);
        rootEl.classList.remove('full-bleed');
      }
      if (client) {
        client.disconnect(true);
        client = null;
      }
      rootEl = null;
    }
  };
}
