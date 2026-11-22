'use strict';

import { api, setApiHooks, MetricsSocketClient, escapeHtml, fmtUptime, fmtTtl } from './api.js';
import { createOverviewView } from './views/overview.js';
import { createMetricsView } from './views/metrics.js';
import { createLogsView } from './views/logs.js';
import { createIssuesView } from './views/issues.js';
import { createControlsView } from './views/controls.js';

const ROUTES = ['overview', 'metrics', 'logs', 'issues', 'controls'];

const els = {
  loginGate: document.getElementById('login-gate'),
  loginHost: document.getElementById('login-host'),
  loginForm: document.getElementById('login-form'),
  loginUser: document.getElementById('login-username'),
  loginPass: document.getElementById('login-password'),
  loginErr: document.getElementById('login-error'),
  loginBtn: document.getElementById('login-submit'),
  togglePassBtn: document.getElementById('toggle-password-btn'),
  appShell: document.getElementById('app-shell'),
  sidebar: document.getElementById('sidebar'),
  sidebarToggle: document.getElementById('sidebar-toggle-btn'),
  viewRoot: document.getElementById('view-root'),
  statusDot: document.getElementById('topbar-status-dot'),
  statusText: document.getElementById('topbar-status-text'),
  sessionPill: document.getElementById('session-pill'),
  issuesBadge: document.getElementById('nav-issues-badge'),
  railVpsPct: document.getElementById('rail-vps-pct'),
  railVpsBar: document.getElementById('rail-vps-bar'),
  railVpsTotal: document.getElementById('rail-vps-total'),
  railVpsAvail: document.getElementById('rail-vps-avail'),
  railSwap: document.getElementById('rail-swap'),
  railDisk: document.getElementById('rail-disk'),
  offlineBanner: document.getElementById('server-offline-banner'),
  themeBtn: document.getElementById('theme-toggle-btn'),
  themeIcon: document.getElementById('theme-icon'),
  signoutBtn: document.getElementById('signout-btn'),
  cmdkTrigger: document.getElementById('cmdk-trigger'),
  cmdkBackdrop: document.getElementById('cmdk-backdrop'),
  cmdkInput: document.getElementById('cmdk-input'),
  cmdkList: document.getElementById('cmdk-list'),
  restartBackdrop: document.getElementById('restart-backdrop'),
  restartClose: document.getElementById('restart-close-btn'),
  restartBody: document.getElementById('restart-body'),
  restartFooter: document.getElementById('restart-footer'),
  toastRoot: document.getElementById('toast-root')
};

let currentRoute = 'overview';
let activeView = null;
let metricsWs = null;
let currentSession = null;
let latestSnapshot = null;
let lastUiTickAt = 0;

// ============================================================
// CONSOLE PREFERENCES (localStorage only — 0 server RAM)
// ============================================================
const DEFAULT_PREFS = {
  themeMode: 'dark',     // dark | light | system
  logsFont: 'normal',    // compact | normal | comfort
  logsTail: 200,         // 100 | 200 | 500
  metricsIntervalMs: 2000 // 2000 | 5000
};

let prefs = { ...DEFAULT_PREFS };

function loadPrefs() {
  try {
    const raw = localStorage.getItem('nexa_pulse_prefs');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (['dark', 'light', 'system'].includes(parsed.themeMode)) prefs.themeMode = parsed.themeMode;
        if (['compact', 'normal', 'comfort'].includes(parsed.logsFont)) prefs.logsFont = parsed.logsFont;
        if ([100, 200, 500].includes(Number(parsed.logsTail))) prefs.logsTail = Number(parsed.logsTail);
        if ([2000, 5000].includes(Number(parsed.metricsIntervalMs))) prefs.metricsIntervalMs = Number(parsed.metricsIntervalMs);
      }
    } else {
      const legacyTheme = localStorage.getItem('nexa_pulse_theme');
      if (legacyTheme === 'light' || legacyTheme === 'dark') prefs.themeMode = legacyTheme;
    }
  } catch (_) {}
}

function savePrefs(patch = {}) {
  if (patch.themeMode && ['dark', 'light', 'system'].includes(patch.themeMode)) prefs.themeMode = patch.themeMode;
  if (patch.logsFont && ['compact', 'normal', 'comfort'].includes(patch.logsFont)) prefs.logsFont = patch.logsFont;
  if (patch.logsTail !== undefined && [100, 200, 500].includes(Number(patch.logsTail))) prefs.logsTail = Number(patch.logsTail);
  if (patch.metricsIntervalMs !== undefined && [2000, 5000].includes(Number(patch.metricsIntervalMs))) prefs.metricsIntervalMs = Number(patch.metricsIntervalMs);
  try {
    localStorage.setItem('nexa_pulse_prefs', JSON.stringify(prefs));
    localStorage.setItem('nexa_pulse_theme', resolveEffectiveTheme(prefs.themeMode));
  } catch (_) {}
  applyPrefsToDom();
  return { ...prefs };
}

function resolveEffectiveTheme(mode) {
  if (mode === 'light') return 'light';
  if (mode === 'system') {
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  }
  return 'dark';
}

function applyPrefsToDom() {
  const effective = resolveEffectiveTheme(prefs.themeMode);
  document.documentElement.setAttribute('data-theme', effective);
  document.documentElement.classList.remove('logs-font-compact', 'logs-font-comfort');
  if (prefs.logsFont === 'compact') document.documentElement.classList.add('logs-font-compact');
  if (prefs.logsFont === 'comfort') document.documentElement.classList.add('logs-font-comfort');
  if (els.themeIcon) els.themeIcon.textContent = effective === 'dark' ? '☾' : '☀';
  if (activeView && typeof activeView.onThemeChange === 'function') {
    activeView.onThemeChange(effective);
  }
}

function applyTheme(theme) {
  savePrefs({ themeMode: theme === 'light' ? 'light' : (theme === 'system' ? 'system' : 'dark') });
}

function initTheme() {
  loadPrefs();
  applyPrefsToDom();
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function toast(message) {
  if (!els.toastRoot) return;
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = String(message || '');
  els.toastRoot.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 3600);
}

// ============================================================
// SHELL STATUS & RAIL UPDATERS
// ============================================================
function updateIssuesBadge(count) {
  const n = Math.max(0, Number(count) || 0);
  if (!els.issuesBadge) return;
  els.issuesBadge.textContent = String(n);
  els.issuesBadge.classList.toggle('has-errors', n > 0);
}

function updateShellFromSnapshot(snap, issuesSummary = null) {
  if (!snap) return;
  latestSnapshot = snap;
  const git = snap.git || {};
  const up = fmtUptime(snap.runtime && snap.runtime.uptimeSec);
  const ref = git.branch && git.commitShort ? `${git.branch}@${git.commitShort}` : '';

  if (els.statusDot) els.statusDot.className = 'dot dot-emerald';
  if (els.statusText) {
    els.statusText.textContent = ['Online', up, ref].filter(Boolean).join(' · ');
  }

  const mem = snap.memory;
  if (mem && mem.vpsTotalMb > 0) {
    const usedPct = Math.min(100, Math.max(0, Math.round(((mem.vpsTotalMb - mem.vpsAvailMb) / mem.vpsTotalMb) * 100)));
    if (els.railVpsPct) els.railVpsPct.textContent = `${usedPct}%`;
    if (els.railVpsBar) els.railVpsBar.value = usedPct;
    if (els.railVpsTotal) els.railVpsTotal.textContent = `${Math.round(mem.vpsTotalMb)} MiB`;
    if (els.railVpsAvail) els.railVpsAvail.textContent = `${Math.round(mem.vpsAvailMb)} avail`;
  }
  if (els.railSwap && mem) {
    els.railSwap.textContent = mem.swapTotalMb > 0 ? `Swap ${Math.round(mem.swapUsedMb)}M` : 'Swap 0M';
  }
  if (els.railDisk && snap.disk && snap.disk.totalGb > 0) {
    els.railDisk.textContent = `Disk ${Math.round(snap.disk.usedPct)}%`;
  }

  if (issuesSummary) {
    updateIssuesBadge(issuesSummary.unresolved);
  }
}

function updateSessionPill() {
  if (!els.sessionPill || !currentSession) return;
  const remSec = Math.max(0, Math.floor((currentSession.expiresAt - Date.now()) / 1000));
  els.sessionPill.textContent = `${currentSession.username} · ${fmtTtl(remSec)}`;
}

// ============================================================
// RESTART CONFIRMATION & LIVE STEPPER MODAL
// ============================================================
function closeRestartModal() {
  els.restartBackdrop.classList.add('hidden');
  els.restartBackdrop.setAttribute('aria-hidden', 'true');
}

function openRestartModal() {
  const activeCalls = (latestSnapshot && latestSnapshot.domain && latestSnapshot.domain.activeLiveCalls) || 0;
  const warnHtml = activeCalls > 0
    ? `<div class="login-error mb-12">Warning: ${activeCalls} active Live Voice Call(s) detected. Restarting now will disconnect the call.</div>`
    : '';

  els.restartBody.innerHTML = `
    ${warnHtml}
    <p class="m-0">Send a graceful <code class="mono">SIGTERM</code> restart to <code class="mono">nexa-server.service</code> via Polkit?</p>
    <p class="muted txt-sm mt-12">Active connections will drain cleanly. If the Logs tab is open, <code class="mono">/io/logs</code> will stay connected independently during reboot.</p>
  `;
  els.restartFooter.innerHTML = `
    <button type="button" class="btn" id="restart-cancel-btn">Cancel</button>
    <button type="button" class="btn btn-amber" id="restart-confirm-btn">${activeCalls > 0 ? 'Force Restart Now' : 'Confirm Restart'}</button>
  `;

  els.restartBackdrop.classList.remove('hidden');
  els.restartBackdrop.setAttribute('aria-hidden', 'false');

  document.getElementById('restart-cancel-btn').addEventListener('click', closeRestartModal);
  document.getElementById('restart-confirm-btn').addEventListener('click', () => executeRestart(activeCalls > 0));
}

async function executeRestart(force) {
  const oldPid = latestSnapshot && latestSnapshot.runtime ? latestSnapshot.runtime.pid : null;
  els.restartFooter.innerHTML = '<button type="button" class="btn" id="restart-open-logs-btn">Watch Live Logs</button>';
  document.getElementById('restart-open-logs-btn').addEventListener('click', () => {
    closeRestartModal();
    navigate('logs');
  });

  const renderStepper = (step, note = '') => {
    const dot = (idx) => idx < step ? 'dot-emerald' : (idx === step ? 'dot-amber pulse' : 'dot-muted');
    els.restartBody.innerHTML = `
      <div class="stepper mono">
        <div class="stepper-item"><span class="dot ${dot(1)}"></span><span>1. Scheduling Polkit SIGTERM restart...</span></div>
        <div class="stepper-item"><span class="dot ${dot(2)}"></span><span>2. Draining connections &amp; respawning process...</span></div>
        <div class="stepper-item"><span class="dot ${dot(3)}"></span><span>3. Waiting for nexa-server to come back online...</span></div>
      </div>
      ${note ? `<p class="muted txt-sm mt-12">${escapeHtml(note)}</p>` : ''}
    `;
  };

  renderStepper(1);
  try {
    await api.restartServer(force);
  } catch (err) {
    renderStepper(1, `Restart could not be scheduled: ${err.message}`);
    els.restartFooter.innerHTML = '<button type="button" class="btn" id="restart-done-btn">Close</button>';
    document.getElementById('restart-done-btn').addEventListener('click', closeRestartModal);
    return;
  }

  renderStepper(2);
  // Poll /monitor/api/overview until online with fresh PID (max 25s)
  const startedAt = Date.now();
  while (Date.now() - startedAt < 25000) {
    await new Promise(r => setTimeout(r, 1500));
    renderStepper(3);
    try {
      const ov = await api.overview();
      const newPid = ov && ov.snapshot && ov.snapshot.runtime ? ov.snapshot.runtime.pid : null;
      if (!oldPid || (newPid && newPid !== oldPid) || (Date.now() - startedAt > 4000 && ov.snapshot.runtime.uptimeSec < 15)) {
        renderStepper(4, `Online with PID ${newPid || 'active'}.`);
        updateShellFromSnapshot(ov.snapshot, ov.issues);
        els.restartFooter.innerHTML = '<button type="button" class="btn btn-primary" id="restart-done-btn">Done</button>';
        document.getElementById('restart-done-btn').addEventListener('click', closeRestartModal);
        toast('nexa-server restarted cleanly.');
        return;
      }
    } catch (_) {
      // Expected while restarting
    }
  }
  renderStepper(3, 'Restart timed out waiting for health check. Inspect Live Logs for details.');
  els.restartFooter.innerHTML = '<button type="button" class="btn" id="restart-done-btn">Close</button>';
  document.getElementById('restart-done-btn').addEventListener('click', closeRestartModal);
}

// ============================================================
// CTRL+K COMMAND PALETTE
// ============================================================
const COMMANDS = [
  { label: 'Go to Overview', hint: 'Page', run: () => navigate('overview') },
  { label: 'Go to Metrics (Live 2s)', hint: 'Page', run: () => navigate('metrics', { range: 'live' }) },
  { label: 'Go to Metrics (24h History)', hint: 'Page', run: () => navigate('metrics', { range: '24h' }) },
  { label: 'Go to Metrics (7d History)', hint: 'Page', run: () => navigate('metrics', { range: '7d' }) },
  { label: 'Go to Logs (All)', hint: 'Page', run: () => navigate('logs', { category: 'all' }) },
  { label: 'Go to Logs (Errors Only)', hint: 'Filter', run: () => navigate('logs', { category: 'errors' }) },
  { label: 'Go to Issues', hint: 'Page', run: () => navigate('issues') },
  { label: 'Go to Controls & Security', hint: 'Page', run: () => navigate('controls') },
  { label: 'Restart nexa-server', hint: 'Action', run: () => openRestartModal() },
  {
    label: 'Reset Runtime Metrics (RESET MONIT)',
    hint: 'Action',
    run: async () => {
      try {
        await api.resetMetrics();
        toast('Runtime latency histograms reset.');
      } catch (err) {
        toast(`Reset failed: ${err.message}`);
      }
    }
  },
  {
    label: 'Reset AI Circuit Breakers',
    hint: 'Action',
    run: async () => {
      try {
        const res = await api.resetBreakers();
        toast(`Cleared ${res.clearedGroups} group(s) & ${res.clearedKeys} cooling key(s).`);
      } catch (err) {
        toast(`Reset breakers failed: ${err.message}`);
      }
    }
  },
  {
    label: 'Toggle Dark / Light Theme',
    hint: 'UI',
    run: () => {
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    }
  }
];

let cmdkSelected = 0;

function renderCmdkList(query = '') {
  const q = query.trim().toLowerCase();
  const matches = q ? COMMANDS.filter(c => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)) : COMMANDS;
  cmdkSelected = Math.min(cmdkSelected, Math.max(0, matches.length - 1));
  els.cmdkList.innerHTML = matches.length === 0
    ? '<div class="muted mono cmdk-empty">No matching commands</div>'
    : matches.map((c, idx) => `
      <button type="button" class="cmdk-item ${idx === cmdkSelected ? 'active' : ''}" data-cmd-idx="${idx}">
        <span>${escapeHtml(c.label)}</span>
        <span class="pill mono">${escapeHtml(c.hint)}</span>
      </button>
    `).join('');
  els.cmdkList._matches = matches;
}

function openCmdk() {
  cmdkSelected = 0;
  els.cmdkInput.value = '';
  renderCmdkList('');
  els.cmdkBackdrop.classList.remove('hidden');
  els.cmdkBackdrop.setAttribute('aria-hidden', 'false');
  els.cmdkInput.focus();
}

function closeCmdk() {
  els.cmdkBackdrop.classList.add('hidden');
  els.cmdkBackdrop.setAttribute('aria-hidden', 'true');
}

// ============================================================
// ROUTER & VIEW LIFECYCLE
// ============================================================
const viewContext = {
  navigate,
  toast,
  openRestartModal,
  updateIssuesBadge,
  getPrefs: () => ({ ...prefs }),
  updatePrefs: (patch) => savePrefs(patch),
  updateShellFromOverview(ov) {
    if (ov && ov.snapshot) updateShellFromSnapshot(ov.snapshot, ov.issues);
  },
  setMetricsWsPaused(paused) {
    if (metricsWs) metricsWs.sendControl(paused ? 'PAUSE' : 'RESUME');
  },
  showLogin
};

function instantiateView(route) {
  switch (route) {
    case 'metrics': return createMetricsView(viewContext);
    case 'logs': return createLogsView(viewContext);
    case 'issues': return createIssuesView(viewContext);
    case 'controls': return createControlsView(viewContext);
    default: return createOverviewView(viewContext);
  }
}

async function navigate(route, opts = {}) {
  const target = ROUTES.includes(route) ? route : 'overview';
  currentRoute = target;
  if (window.location.hash !== `#${target}`) {
    history.replaceState(null, '', `#${target}`);
  }

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.route === target);
  });
  els.sidebar.classList.remove('open');

  if (activeView && typeof activeView.unmount === 'function') {
    activeView.unmount();
  }
  activeView = instantiateView(target);
  await activeView.mount(els.viewRoot, opts);
}

// ============================================================
// AUTH LIFECYCLE (SIGN IN GATE <-> APP SHELL)
// ============================================================
function showLogin(errorMsg = '') {
  if (metricsWs) {
    metricsWs.disconnect();
    metricsWs = null;
  }
  if (activeView && typeof activeView.unmount === 'function') {
    activeView.unmount();
    activeView = null;
  }
  currentSession = null;
  els.appShell.classList.add('hidden');
  els.loginGate.classList.remove('hidden');
  els.loginGate.setAttribute('aria-hidden', 'false');
  els.loginHost.textContent = window.location.host;

  if (errorMsg) {
    els.loginErr.textContent = errorMsg;
    els.loginErr.classList.remove('hidden');
  } else {
    els.loginErr.classList.add('hidden');
  }
  els.loginPass.value = '';
  els.loginUser.focus();
}

async function enterApp(session) {
  const normalized = session ? { ...session } : {};
  if (!normalized.username) normalized.username = 'operator';
  if (!Number.isFinite(normalized.expiresAt)) {
    const ttl = Number(normalized.ttlSec) || 0;
    normalized.expiresAt = Date.now() + ttl * 1000;
  }
  currentSession = normalized;
  els.loginGate.classList.add('hidden');
  els.loginGate.setAttribute('aria-hidden', 'true');
  els.appShell.classList.remove('hidden');
  updateSessionPill();

  if (!metricsWs) {
    metricsWs = new MetricsSocketClient({
      onTick(msg) {
        els.offlineBanner.classList.add('hidden');
        const now = Date.now();
        const minGap = prefs.metricsIntervalMs >= 5000 ? 4500 : 0;
        if (minGap > 0 && (now - lastUiTickAt) < minGap) return;
        lastUiTickAt = now;
        updateShellFromSnapshot(msg.snapshot, msg.issues);
        if (activeView && typeof activeView.onLiveTick === 'function') {
          activeView.onLiveTick(msg);
        }
      },
      onStatus(connected) {
        if (!connected && els.statusDot) {
          els.statusDot.className = 'dot dot-amber';
        }
      }
    });
    metricsWs.connect();
  }

  const hashRoute = window.location.hash.replace(/^#/, '');
  await navigate(ROUTES.includes(hashRoute) ? hashRoute : 'overview');
}

// ============================================================
// EVENT WIRING & BOOTSTRAP
// ============================================================
function bindEvents() {
  setApiHooks({
    onUnauthorized() {
      showLogin('Session expired. Please sign in again.');
    },
    onConnectivity(online) {
      els.offlineBanner.classList.toggle('hidden', online);
      if (!online && els.statusDot && els.statusText) {
        els.statusDot.className = 'dot dot-amber pulse';
        els.statusText.textContent = 'Reconnecting...';
      }
    }
  });

  els.togglePassBtn.addEventListener('click', () => {
    const showing = els.loginPass.type === 'text';
    els.loginPass.type = showing ? 'password' : 'text';
    els.togglePassBtn.textContent = showing ? 'Show' : 'Hide';
  });

  els.loginForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const username = els.loginUser.value.trim();
    const password = els.loginPass.value;
    if (!username || !password) {
      els.loginErr.textContent = 'Please enter both username and password.';
      els.loginErr.classList.remove('hidden');
      return;
    }

    els.loginBtn.disabled = true;
    els.loginBtn.textContent = 'Signing in...';
    els.loginErr.classList.add('hidden');

    try {
      const res = await api.login(username, password);
      await enterApp(res.session);
    } catch (err) {
      els.loginErr.textContent = err.message || 'Sign in failed.';
      els.loginErr.classList.remove('hidden');
    } finally {
      els.loginBtn.disabled = false;
      els.loginBtn.textContent = 'Sign in';
    }
  });

  els.signoutBtn.addEventListener('click', async () => {
    try { await api.logout(); } catch (_) {}
    showLogin();
  });

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.route));
  });

  els.sidebarToggle.addEventListener('click', () => {
    els.sidebar.classList.toggle('open');
  });

  els.themeBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  // Command palette triggers
  els.cmdkTrigger.addEventListener('click', openCmdk);
  els.cmdkBackdrop.addEventListener('click', (ev) => {
    if (ev.target === els.cmdkBackdrop) closeCmdk();
  });
  els.cmdkInput.addEventListener('input', () => renderCmdkList(els.cmdkInput.value));
  els.cmdkInput.addEventListener('keydown', (ev) => {
    const matches = els.cmdkList._matches || [];
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      cmdkSelected = (cmdkSelected + 1) % Math.max(1, matches.length);
      renderCmdkList(els.cmdkInput.value);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      cmdkSelected = (cmdkSelected - 1 + Math.max(1, matches.length)) % Math.max(1, matches.length);
      renderCmdkList(els.cmdkInput.value);
    } else if (ev.key === 'Enter' && matches[cmdkSelected]) {
      ev.preventDefault();
      const fn = matches[cmdkSelected].run;
      closeCmdk();
      fn();
    } else if (ev.key === 'Escape') {
      closeCmdk();
    }
  });
  els.cmdkList.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-cmd-idx]');
    if (!item) return;
    const matches = els.cmdkList._matches || [];
    const cmd = matches[Number(item.dataset.cmdIdx)];
    closeCmdk();
    if (cmd) cmd.run();
  });

  // Restart modal close
  els.restartClose.addEventListener('click', closeRestartModal);
  els.restartBackdrop.addEventListener('click', (ev) => {
    if (ev.target === els.restartBackdrop) closeRestartModal();
  });

  // Global keyboard shortcuts
  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      if (!currentSession) return;
      ev.preventDefault();
      if (els.cmdkBackdrop.classList.contains('hidden')) openCmdk();
      else closeCmdk();
    } else if (ev.key === 'Escape') {
      if (!els.cmdkBackdrop.classList.contains('hidden')) closeCmdk();
      if (!els.restartBackdrop.classList.contains('hidden')) closeRestartModal();
    }
  });

  window.addEventListener('hashchange', () => {
    if (!currentSession) return;
    const h = window.location.hash.replace(/^#/, '');
    if (ROUTES.includes(h) && h !== currentRoute) {
      navigate(h);
    }
  });

  // Cleanly close WebSockets on tab unload (0% idle server overhead)
  window.addEventListener('beforeunload', () => {
    if (metricsWs) metricsWs.disconnect();
    if (activeView && typeof activeView.unmount === 'function') activeView.unmount();
  });

  setInterval(updateSessionPill, 30_000);
}

async function boot() {
  initTheme();
  bindEvents();

  try {
    const status = await api.authStatus();
    if (status && status.authenticated && status.session) {
      await enterApp(status.session);
    } else {
      showLogin(status && status.configured === false
        ? 'Monitor credentials are not configured on the server yet.'
        : '');
    }
  } catch (_) {
    showLogin('Unable to reach server API. Check server connectivity.');
  }
}

boot();
