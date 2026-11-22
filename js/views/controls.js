'use strict';

import { api, escapeHtml, fmtWibDateTime, fmtTtl } from '../api.js';

export function createControlsView(ctx) {
  let rootEl = null;
  let state = null;

  async function loadControls() {
    try {
      state = await api.controls();
      render();
    } catch (err) {
      if (rootEl) rootEl.innerHTML = `<div class="page page-narrow"><div class="card">Failed to load controls: ${escapeHtml(err.message)}</div></div>`;
    }
  }

  function render() {
    if (!rootEl || !state) return;
    const { services, activeLiveCalls, aiHealth, alerts, alertCooldownMinutes, alertChannel, auth, auditLog } = state;
    const killOn = Boolean(services && services.terminalKillSwitchEnabled);
    const prefs = (ctx.getPrefs && ctx.getPrefs()) || { themeMode: 'dark', logsFont: 'normal', logsTail: 200, metricsIntervalMs: 2000 };
    const ai = aiHealth || { groups: [], keysCoolingDown: [], openCount: 0, halfOpenCount: 0, coolingKeysCount: 0 };
    const ch = alertChannel || { mobileConnected: false, telegramConfigured: false, activeRoute: 'Mobile Bridge' };
    const cooldownMin = Number(alertCooldownMinutes) || 15;

    rootEl.innerHTML = `
      <div class="page page-narrow">
        <div class="page-header">
          <div>
            <h1 class="page-title">Controls &amp; Security</h1>
            <p class="page-subtitle">Service operations, editable alert thresholds, console preferences, sessions, and audit trail.</p>
          </div>
          <span class="pill mono">
            <span class="dot ${services && services.canPolkitRestart ? 'dot-emerald' : 'dot-amber'}"></span>
            ${escapeHtml(services ? services.systemdVersion : 'systemd')} · ${escapeHtml(services ? services.manager : 'node')}
          </span>
        </div>

        <!-- 1. SERVICE OPERATIONS -->
        <div class="section-label">Service Operations</div>
        <div class="card card-flush">
          <div class="group-row">
            <div class="group-row-info">
              <div class="group-row-title">
                <span>Restart nexa-server</span>
                <span class="pill pill-amber mono">SIGTERM Graceful</span>
              </div>
              <div class="group-row-desc mono">
                Polkit (51-nexa-monitor.rules) · Live Voice Calls: ${activeLiveCalls || 0} active
              </div>
            </div>
            <button type="button" class="btn btn-amber" data-action="restart-server">Restart Server</button>
          </div>

          <div class="group-row">
            <div class="group-row-info">
              <div class="group-row-title">
                <span>Reset AI Circuit Breakers</span>
                <span class="pill mono ${ai.openCount > 0 ? 'pill-rose' : (ai.coolingKeysCount > 0 ? 'pill-amber' : 'pill-emerald')}">${ai.openCount} Open · ${ai.coolingKeysCount} Cooling</span>
              </div>
              <div class="group-row-desc">Clear open provider breakers &amp; API key cooldown timers in Provider_Health immediately.</div>
            </div>
            <button type="button" class="btn" data-action="reset-breakers">Reset Breakers</button>
          </div>

          <div class="group-row">
            <div class="group-row-info">
              <div class="group-row-title">
                <span>Reset Runtime Metrics</span>
                <span class="pill mono">In-memory</span>
              </div>
              <div class="group-row-desc">Clear in-memory HTTP &amp; Event Loop histograms and peak counters (RESET MONIT).</div>
            </div>
            <button type="button" class="btn" data-action="reset-metrics">Reset</button>
          </div>

          <div class="group-row">
            <div class="group-row-info">
              <div class="group-row-title">
                <span>Remote Terminal Kill Switch</span>
                <span class="pill mono">Read-only</span>
              </div>
              <div class="group-row-desc mono">/opt/nexa/etc/terminal.enabled · Managed exclusively via VPS SSH</div>
            </div>
            <span class="pill ${killOn ? 'pill-amber' : ''} mono">${killOn ? 'ON' : 'OFF'}</span>
          </div>
        </div>

        <!-- 2. PROACTIVE ALERTS -> MOBILE BRIDGE (EDITABLE THRESHOLDS + TEST ALERT) -->
        <div class="page-header">
          <div class="page-header-left">
            <span class="section-label m-0">Proactive Alerts</span>
            <span class="pill mono ${ch.mobileConnected ? 'pill-emerald' : 'pill-amber'}">
              <span class="dot ${ch.mobileConnected ? 'dot-emerald' : 'dot-amber'}"></span>
              Route: ${escapeHtml(ch.activeRoute)}
            </span>
          </div>
          <div class="page-actions">
            <label class="num-input-wrap mono" title="Minimum minutes between repeated alerts per rule">
              <span>Cooldown</span>
              <input id="alert-cooldown-input" type="number" class="num-input num-input-sm mono" min="1" max="120" value="${cooldownMin}">
              <span>min</span>
            </label>
            <button type="button" class="btn btn-sm btn-cyan" data-action="test-alert">Send Test Alert</button>
          </div>
        </div>

        <div class="card card-flush">
          ${(alerts || []).map(rule => {
            const ed = rule.editable;
            return `
              <div class="group-row">
                <div class="group-row-info">
                  <div class="group-row-title">
                    <span>${escapeHtml(rule.label)}</span>
                    <span class="pill mono">${escapeHtml(rule.priority)}</span>
                  </div>
                  <div class="group-row-desc">${escapeHtml(rule.description)}</div>
                </div>
                <div class="alert-rule-controls">
                  ${ed ? `
                    <label class="num-input-wrap mono" title="Threshold (${ed.min}..${ed.max} ${ed.unit})">
                      <input type="number" class="num-input mono" data-threshold-rule="${escapeHtml(rule.id)}" data-threshold-field="${escapeHtml(ed.field)}" min="${ed.min}" max="${ed.max}" value="${ed.value}">
                      <span>${escapeHtml(ed.unit)}</span>
                    </label>
                    ${rule.id !== 'http_5xx_spike' ? `
                      <label class="num-input-wrap mono" title="Sustained minutes (${ed.sustainedMin}..${ed.sustainedMax})">
                        <input type="number" class="num-input num-input-sm mono" data-sustained-rule="${escapeHtml(rule.id)}" min="${ed.sustainedMin}" max="${ed.sustainedMax}" value="${rule.sustainedMinutes}">
                        <span>min</span>
                      </label>
                    ` : ''}
                  ` : ''}
                  <label class="switch" aria-label="Toggle ${escapeHtml(rule.label)}">
                    <input type="checkbox" data-alert-rule="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''}>
                    <span class="switch-slider"></span>
                  </label>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <!-- 3. CONSOLE PREFERENCES (BROWSER LOCAL — 0 SERVER RAM) -->
        <div class="section-label">Console Preferences (Local Browser)</div>
        <div class="card card-flush">
          <div class="group-row">
            <div class="group-row-info">
              <div class="group-row-title"><span>Theme Mode</span></div>
              <div class="group-row-desc">Switch between Dark, Light, or follow OS appearance.</div>
            </div>
            <div class="segmented" role="group" aria-label="Theme preference">
              <button type="button" class="seg-btn ${prefs.themeMode === 'dark' ? 'active' : ''}" data-pref-theme="dark">Dark</button>
              <button type="button" class="seg-btn ${prefs.themeMode === 'light' ? 'active' : ''}" data-pref-theme="light">Light</button>
              <button type="button" class="seg-btn ${prefs.themeMode === 'system' ? 'active' : ''}" data-pref-theme="system">System</button>
            </div>
          </div>

          <div class="group-row">
            <div class="group-row-info">
              <div class="group-row-title"><span>Logs Console Font Size</span></div>
              <div class="group-row-desc">Adjust monochrome log line density without affecting server load.</div>
            </div>
            <div class="segmented" role="group" aria-label="Logs font size">
              <button type="button" class="seg-btn ${prefs.logsFont === 'compact' ? 'active' : ''}" data-pref-font="compact">Compact</button>
              <button type="button" class="seg-btn ${prefs.logsFont === 'normal' ? 'active' : ''}" data-pref-font="normal">Default</button>
              <button type="button" class="seg-btn ${prefs.logsFont === 'comfort' ? 'active' : ''}" data-pref-font="comfort">Comfort</button>
            </div>
          </div>

          <div class="group-row">
            <div class="group-row-info">
              <div class="group-row-title"><span>Default Log Tail Lines</span></div>
              <div class="group-row-desc">Initial lines fetched from /io/logs when opening the Logs view.</div>
            </div>
            <div class="segmented mono" role="group" aria-label="Default log tail">
              <button type="button" class="seg-btn ${prefs.logsTail === 100 ? 'active' : ''}" data-pref-tail="100">100</button>
              <button type="button" class="seg-btn ${prefs.logsTail === 200 ? 'active' : ''}" data-pref-tail="200">200</button>
              <button type="button" class="seg-btn ${prefs.logsTail === 500 ? 'active' : ''}" data-pref-tail="500">500</button>
            </div>
          </div>

          <div class="group-row">
            <div class="group-row-info">
              <div class="group-row-title"><span>Live Metrics Refresh Cadence</span></div>
              <div class="group-row-desc">Choose 2s real-time cadence or 5s eco mode to save browser CPU.</div>
            </div>
            <div class="segmented mono" role="group" aria-label="Live metrics interval">
              <button type="button" class="seg-btn ${prefs.metricsIntervalMs === 2000 ? 'active' : ''}" data-pref-interval="2000">Live (2s)</button>
              <button type="button" class="seg-btn ${prefs.metricsIntervalMs === 5000 ? 'active' : ''}" data-pref-interval="5000">Eco (5s)</button>
            </div>
          </div>
        </div>

        <!-- 4. ACCOUNT & ACTIVE SESSIONS + SECURITY AUDIT LOG -->
        <div class="split-2">
          <div class="card">
            <div class="card-head">
              <div>
                <h2 class="card-title">Account &amp; Active Sessions</h2>
                <div class="muted mono txt-xs mt-2">Single-user scrypt · ${escapeHtml(auth ? auth.username : '')}</div>
              </div>
              <button type="button" class="text-btn text-btn-rose" data-action="revoke-all">Sign Out All</button>
            </div>

            <div class="kv-list">
              ${(auth && auth.sessions || []).map(sess => `
                <div class="kv-row">
                  <div>
                    <div class="session-ua">${escapeHtml(sess.userAgent)} ${sess.current ? '<span class="pill pill-cyan ml-6">Current</span>' : ''}</div>
                    <div class="mono muted txt-xs">${escapeHtml(sess.ip)} · Expires in ${fmtTtl(sess.ttlSec)}</div>
                  </div>
                  <span class="status-cell"><span class="dot dot-emerald"></span>Active</span>
                </div>
              `).join('')}
            </div>

            <div class="muted mono txt-xs mt-12 pt-10">
              Rotate password via VPS CLI: node scripts/nexa_monitor_set_password.js
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <div>
                <h2 class="card-title">Security Audit Log</h2>
                <div class="muted txt-xs mt-2">Recent operator authentication &amp; control events</div>
              </div>
              <span class="pill mono">${(auditLog || []).length} events</span>
            </div>

            <div>
              ${(auditLog || []).length === 0
                ? '<div class="muted mono audit-empty">No audit events recorded yet.</div>'
                : (auditLog || []).slice(0, 12).map(ev => {
                  const dotCls = ev.severity === 'error' ? 'dot-rose' : ev.severity === 'warn' ? 'dot-amber' : 'dot-emerald';
                  return `
                    <div class="audit-row">
                      <div class="min-w-0">
                        <div class="flex-row-6">
                          <span class="dot ${dotCls}"></span>
                          <span class="mono txt-xs txt-primary">${escapeHtml(ev.event)}</span>
                        </div>
                        <div class="muted mono txt-xs mt-2 break-word">${escapeHtml(ev.detail)} (${escapeHtml(ev.ip)})</div>
                      </div>
                      <span class="mono muted txt-xs nowrap">${fmtWibDateTime(ev.ts)}</span>
                    </div>
                  `;
                }).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  async function handleClick(ev) {
    const themeBtn = ev.target.closest('[data-pref-theme]');
    if (themeBtn && ctx.updatePrefs) {
      ctx.updatePrefs({ themeMode: themeBtn.dataset.prefTheme });
      render();
      return;
    }
    const fontBtn = ev.target.closest('[data-pref-font]');
    if (fontBtn && ctx.updatePrefs) {
      ctx.updatePrefs({ logsFont: fontBtn.dataset.prefFont });
      ctx.toast(`Logs font size set to ${fontBtn.dataset.prefFont}.`);
      render();
      return;
    }
    const tailBtn = ev.target.closest('[data-pref-tail]');
    if (tailBtn && ctx.updatePrefs) {
      ctx.updatePrefs({ logsTail: Number(tailBtn.dataset.prefTail) });
      ctx.toast(`Default log tail set to ${tailBtn.dataset.prefTail} lines.`);
      render();
      return;
    }
    const intBtn = ev.target.closest('[data-pref-interval]');
    if (intBtn && ctx.updatePrefs) {
      const ms = Number(intBtn.dataset.prefInterval);
      ctx.updatePrefs({ metricsIntervalMs: ms });
      ctx.toast(`Metrics cadence set to ${ms === 5000 ? 'Eco (5s)' : 'Live (2s)'}.`);
      render();
      return;
    }

    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const act = btn.dataset.action;

    if (act === 'restart-server') {
      ctx.openRestartModal();
    } else if (act === 'reset-breakers') {
      try {
        const res = await api.resetBreakers();
        ctx.toast(`Cleared ${res.clearedGroups} breaker group(s) & ${res.clearedKeys} cooling key(s).`);
        await loadControls();
      } catch (err) {
        ctx.toast(`Reset breakers failed: ${err.message}`);
      }
    } else if (act === 'reset-metrics') {
      try {
        await api.resetMetrics();
        ctx.toast('Runtime metrics reset (RESET MONIT).');
        await loadControls();
      } catch (err) {
        ctx.toast(`Reset failed: ${err.message}`);
      }
    } else if (act === 'test-alert') {
      btn.disabled = true;
      try {
        const res = await api.sendTestAlert();
        ctx.toast(`Test alert dispatched via ${res.channel}.`);
        await loadControls();
      } catch (err) {
        ctx.toast(`Test alert failed: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    } else if (act === 'revoke-all') {
      try {
        await api.revokeAllSessions();
        ctx.toast('All active sessions revoked.');
        ctx.showLogin('All sessions signed out.');
      } catch (err) {
        ctx.toast(`Revoke failed: ${err.message}`);
      }
    }
  }

  async function handleChange(ev) {
    const toggle = ev.target.closest('[data-alert-rule]');
    if (toggle) {
      const ruleId = toggle.dataset.alertRule;
      const enabled = toggle.checked;
      try {
        await api.updateAlertRule(ruleId, { enabled });
        ctx.toast(`Alert rule "${ruleId}" ${enabled ? 'enabled' : 'disabled'}.`);
        await loadControls();
      } catch (err) {
        toggle.checked = !enabled;
        ctx.toast(`Failed to update alert rule: ${err.message}`);
      }
      return;
    }

    const thrInput = ev.target.closest('[data-threshold-rule]');
    if (thrInput) {
      const ruleId = thrInput.dataset.thresholdRule;
      const field = thrInput.dataset.thresholdField;
      const val = Number(thrInput.value);
      if (!Number.isFinite(val)) return;
      try {
        const updated = await api.updateAlertRule(ruleId, { [field]: val });
        ctx.toast(`Updated ${ruleId}: ${updated.description}`);
        await loadControls();
      } catch (err) {
        ctx.toast(`Update failed: ${err.message}`);
      }
      return;
    }

    const susInput = ev.target.closest('[data-sustained-rule]');
    if (susInput) {
      const ruleId = susInput.dataset.sustainedRule;
      const val = Number(susInput.value);
      if (!Number.isFinite(val)) return;
      try {
        const updated = await api.updateAlertRule(ruleId, { sustainedMinutes: val });
        ctx.toast(`Updated ${ruleId}: sustained ${updated.sustainedMinutes}m.`);
        await loadControls();
      } catch (err) {
        ctx.toast(`Update failed: ${err.message}`);
      }
      return;
    }

    if (ev.target.id === 'alert-cooldown-input') {
      const mins = Number(ev.target.value);
      if (!Number.isFinite(mins)) return;
      try {
        const res = await api.setAlertCooldown(mins);
        ctx.toast(`Global alert cooldown saved (${res.cooldownMinutes} min).`);
        await loadControls();
      } catch (err) {
        ctx.toast(`Cooldown update failed: ${err.message}`);
      }
    }
  }

  return {
    async mount(el) {
      rootEl = el;
      rootEl.classList.remove('full-bleed');
      rootEl.innerHTML = '<div class="page page-narrow"><div class="card muted mono">Loading controls...</div></div>';
      rootEl.addEventListener('click', handleClick);
      rootEl.addEventListener('change', handleChange);
      await loadControls();
    },
    unmount() {
      if (rootEl) {
        rootEl.removeEventListener('click', handleClick);
        rootEl.removeEventListener('change', handleChange);
      }
      rootEl = null;
    }
  };
}
