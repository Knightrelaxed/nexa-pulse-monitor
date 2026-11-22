'use strict';

import { api, escapeHtml, fmtUptime, fmtRelative } from '../api.js';
import { drawSparkline } from '../charts.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtHourTooltip(cell) {
  const d = new Date(cell.hourStartSec * 1000);
  let label = d.toISOString();
  try {
    label = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(d) + ' WIB';
  } catch (_) {}
  if (cell.status === 'nodata') return `${label} — No data`;
  return `${label} · ${cell.status.toUpperCase()} · Avg RSS ${cell.avgRssMb} MiB · Max CPU ${cell.maxCpuPct}% · P95 EL ${cell.maxElP95Ms}ms · Issues ${cell.issues}`;
}

export function createOverviewView(ctx) {
  let rootEl = null;
  let data = null;
  let lastUpdatedAt = Date.now();
  let tickClockTimer = null;

  function renderFull() {
    if (!rootEl || !data) return;
    const { snapshot: s, services, issues, cronJobs, spark1h, heatmap } = data;
    const mem = s.memory;
    const disk = s.disk || { totalGb: 0, usedGb: 0, availGb: 0, usedPct: 0 };
    const cpu = s.cpu;
    const el = s.eventLoop;
    const http = s.http;
    const git = s.git || {};
    const dom = s.domain || {};
    const mobile = dom.mobile || {};
    const win = dom.windows || {};
    const aiHealth = dom.aiHealth || { groups: [], keysCoolingDown: [], openCount: 0, halfOpenCount: 0, coolingKeysCount: 0 };
    const cronList = Array.isArray(cronJobs) ? cronJobs : [];

    const memPctOfMax = Math.min(100, Math.round((mem.rssMb / 420) * 100));

    // Group 168 hourly heatmap cells into 7 rows of 24 hours
    const cells = (heatmap && heatmap.cells) || [];
    const heatmapRows = [];
    for (let r = 0; r < 7; r++) {
      const slice = cells.slice(r * 24, (r + 1) * 24);
      if (slice.length === 0) continue;
      const dayIdx = new Date(slice[0].hourStartSec * 1000).getDay();
      heatmapRows.push({ day: DAY_NAMES[dayIdx] || `D${r + 1}`, cells: slice });
    }

    const serverUnit = (services && services.units || []).find(u => u.name === 'nexa-server.service');
    const restarts = serverUnit ? serverUnit.restarts : 0;

    rootEl.innerHTML = `
      <div class="page">
        <div class="page-header">
          <div class="page-header-left">
            <h1 class="page-title">Overview</h1>
            <span class="pill mono">
              <span class="dot dot-emerald pulse"></span>
              <span id="ov-updated">Live · updated ${fmtRelative(lastUpdatedAt)}</span>
            </span>
          </div>
          <div class="page-actions">
            <button type="button" class="btn" data-action="open-logs">Open Logs</button>
            <button type="button" class="btn" data-action="reset-monit">Reset Monit</button>
            <button type="button" class="btn" data-action="restart-server">Restart Server</button>
          </div>
        </div>

        <!-- 1. TOP KPI ROW -->
        <div class="kpi-grid">
          <div class="card kpi-card">
            <div class="kpi-top">
              <span>CPU Usage</span>
              <span class="pill mono">${cpu.cores} vCPU</span>
            </div>
            <div id="kpi-cpu-val" class="kpi-value mono">${cpu.processPct}%</div>
            <div id="kpi-cpu-sub" class="kpi-sub mono">Load ${(cpu.loadAvg || [0, 0]).slice(0, 2).join(', ')} · Host ${cpu.vpsPct}%</div>
            <canvas id="spark-cpu" class="spark-canvas"></canvas>
          </div>

          <div class="card kpi-card">
            <div class="kpi-top">
              <span>Memory</span>
              <span class="pill mono">Node RSS</span>
            </div>
            <div id="kpi-mem-val" class="kpi-value mono">${mem.rssMb} MiB</div>
            <div id="kpi-mem-sub" class="kpi-sub mono">Heap ${mem.heapUsedMb}/${mem.heapTotalMb}M (${mem.heapPct}%) · ${mem.vpsAvailMb}M free</div>
            <div class="mem-bar-wrap">
              <div class="mem-bar-track">
                <progress id="kpi-mem-fill" class="meter meter-lg" max="100" value="${memPctOfMax}"></progress>
                <div class="mem-threshold-tick mem-threshold-high" title="MemoryHigh 320 MiB"></div>
              </div>
              <div class="mem-bar-labels mono">
                <span>0M</span>
                <span>320M High</span>
                <span>420M Max</span>
              </div>
            </div>
          </div>

          <div class="card kpi-card">
            <div class="kpi-top">
              <span>Event Loop Delay</span>
              <span class="pill mono">perf_hooks</span>
            </div>
            <div id="kpi-el-val" class="kpi-value mono">${el.meanMs} ms</div>
            <div id="kpi-el-sub" class="kpi-sub mono">P95 ${el.p95Ms} ms · Max ${el.maxMs} ms</div>
            <canvas id="spark-el" class="spark-canvas"></canvas>
          </div>

          <div class="card kpi-card">
            <div class="kpi-top">
              <span>HTTP &amp; Issues</span>
              <span id="kpi-http-rpm" class="pill mono">${http.reqPerMin} req/m</span>
            </div>
            <div id="kpi-http-val" class="kpi-value mono">${http.meanMs} ms</div>
            <div id="kpi-http-sub" class="kpi-sub mono">P95 ${http.p95Ms} ms · Issues ${issues.last1h} / ${issues.last24h} / ${issues.last7d}</div>
            <canvas id="spark-http" class="spark-canvas"></canvas>
          </div>
        </div>

        <!-- 2. APPLICATION HEALTH HEATMAP (7 DAYS) -->
        <div class="card">
          <div class="card-head">
            <div class="page-header-left">
              <h2 class="card-title">Application Health · Last 7 Days</h2>
              <span class="mono txt-sm txt-emerald">${heatmap ? heatmap.healthyPct : 100}% healthy</span>
            </div>
            <div class="heatmap-legend">
              <span class="legend-item"><span class="dot dot-emerald"></span>Healthy</span>
              <span class="legend-item"><span class="dot dot-amber"></span>Degraded</span>
              <span class="legend-item"><span class="dot dot-rose"></span>Incident</span>
              <span class="legend-item"><span class="dot dot-muted"></span>No data</span>
            </div>
          </div>
          <div class="heatmap-rows">
            ${heatmapRows.map(row => `
              <div class="heatmap-row">
                <span class="heatmap-day mono">${escapeHtml(row.day)}</span>
                ${row.cells.map(c => `<div class="heatmap-cell ${escapeHtml(c.status)}" title="${escapeHtml(fmtHourTooltip(c))}"></div>`).join('')}
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 3. SERVICES & BRIDGES MATRIX -->
        <div class="card card-flush">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th>RAM</th>
                  <th>CPU / Latency</th>
                  <th>Errors (1h · 24h · 7d)</th>
                  <th>Uptime</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${(services && services.units || []).map(u => {
                  const isActive = u.status === 'active';
                  const dotCls = isActive ? 'dot-emerald' : 'dot-muted';
                  const errStr = u.name === 'nexa-server.service'
                    ? `${issues.last1h} · ${issues.last24h} · ${issues.last7d}`
                    : '0 · 0 · 0';
                  const unitKey = u.name.replace('.service', '');
                  return `
                    <tr>
                      <td class="mono">${escapeHtml(u.name)}</td>
                      <td><span class="status-cell"><span class="dot ${dotCls}"></span>${escapeHtml(isActive ? 'Active' : (u.status === 'idle' ? 'Idle' : u.status))}</span></td>
                      <td class="secondary">${escapeHtml(u.mode)}</td>
                      <td class="mono">${u.memoryMb} MiB</td>
                      <td class="mono">${u.cpuPct}%</td>
                      <td class="mono secondary">${errStr}</td>
                      <td class="mono secondary">${u.uptimeSec > 0 ? fmtUptime(u.uptimeSec) : (u.mode.includes('socket') ? 'on-demand' : '—')}</td>
                      <td>
                        ${u.name === 'nexa-server.service'
                          ? `<button type="button" class="text-btn text-btn-cyan" data-action="logs-unit" data-unit="nexa-server">Logs</button><button type="button" class="text-btn" data-action="restart-server">Restart</button>`
                          : (u.name === 'caddy.service' || u.name === 'nexa-log.service'
                            ? `<button type="button" class="text-btn text-btn-cyan" data-action="logs-unit" data-unit="${u.name === 'caddy.service' ? 'caddy' : 'all'}">${u.name === 'caddy.service' ? 'Logs' : 'Open'}</button>`
                            : '<span class="muted">—</span>')}
                      </td>
                    </tr>
                  `;
                }).join('')}
                <tr class="table-subdivider"><td colspan="8">Ecosystem Bridges</td></tr>
                <tr>
                  <td>Mobile Bridge (Galaxy A33)</td>
                  <td><span class="status-cell"><span class="dot ${mobile.connected ? 'dot-emerald' : 'dot-muted'}"></span>${mobile.connected ? 'Connected' : 'Offline'}</span></td>
                  <td class="mono secondary">WSS /ws</td>
                  <td class="mono muted">—</td>
                  <td class="mono">${mobile.connected && mobile.rttMs !== null ? `${mobile.rttMs} ms RTT` : '—'}</td>
                  <td class="mono secondary">0 · 0 · 0</td>
                  <td class="mono secondary">${mobile.connected ? fmtUptime(mobile.uptimeSec) : '—'}</td>
                  <td><button type="button" class="text-btn text-btn-cyan" data-action="logs-cat" data-cat="bridge">Logs</button></td>
                </tr>
                <tr>
                  <td>Windows Bridge (ThinkPad)</td>
                  <td><span class="status-cell"><span class="dot ${win.connected ? 'dot-emerald' : 'dot-muted'}"></span>${win.connected ? 'Connected' : 'Offline'}</span></td>
                  <td class="mono secondary">WSS /ws</td>
                  <td class="mono muted">—</td>
                  <td class="mono">${win.connected && win.rttMs !== null ? `${win.rttMs} ms RTT` : '—'}</td>
                  <td class="mono secondary">0 · 0 · 0</td>
                  <td class="mono secondary">${win.connected ? fmtUptime(win.uptimeSec) : '—'}</td>
                  <td><button type="button" class="text-btn text-btn-cyan" data-action="logs-cat" data-cat="bridge">Logs</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 4. RUNTIME & GIT VERSIONING + N.E.X.A TELEMETRY -->
        <div class="split-2">
          <div class="card">
            <div class="card-head">
              <h2 class="card-title">Runtime &amp; Git Versioning</h2>
              <span class="pill mono">${escapeHtml(services ? services.manager : 'node')}</span>
            </div>
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Repository</span>
                <span class="kv-val mono">${escapeHtml(git.repository || 'nexa-server')} v${escapeHtml(git.appVersion || '')}</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Branch &amp; Commit</span>
                <span class="kv-val mono">
                  ${escapeHtml(git.branch || 'main')} @ ${escapeHtml(git.commitShort || 'unknown')}
                  <span class="pill ml-6 ${git.dirty ? 'pill-amber' : 'pill-emerald'}">${git.dirty ? 'Unstaged' : 'Clean'}</span>
                </span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Last Commit</span>
                <span class="kv-val secondary" title="${escapeHtml(git.commitMessage || '')}">${escapeHtml(git.commitMessage || 'N/A')}</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Node.js</span>
                <span class="kv-val mono">${escapeHtml(s.runtime.nodeVersion)} (V8 ${escapeHtml(s.runtime.v8Version || '')})</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">PID / Restarts</span>
                <span class="kv-val mono">${s.runtime.pid} · ${restarts} restarts</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Host / Private IP</span>
                <span class="kv-val mono">${escapeHtml(s.runtime.hostname || 'nexa-server')} · ${escapeHtml(s.runtime.privateIp || '127.0.0.1')}</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Disk / Swap</span>
                <span class="kv-val mono">${disk.totalGb > 0 ? `${disk.usedGb}/${disk.totalGb} GB (${disk.usedPct}%)` : 'N/A'} · Swap ${Math.round(mem.swapUsedMb || 0)}M</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Environment</span>
                <span class="kv-val mono txt-cyan">${escapeHtml(s.runtime.nodeEnv)}</span>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <h2 class="card-title">N.E.X.A Telemetry Snapshot</h2>
              <button type="button" class="text-btn text-btn-cyan" data-action="open-metrics">View Metrics →</button>
            </div>
            <div class="telemetry-grid">
              <div class="telemetry-cell">
                <div class="telemetry-label">Active Handles</div>
                <div id="tel-handles" class="telemetry-val mono">${s.runtime.activeHandles}</div>
              </div>
              <div class="telemetry-cell">
                <div class="telemetry-label">Active Requests</div>
                <div id="tel-reqs" class="telemetry-val mono">${s.runtime.activeRequests}</div>
              </div>
              <div class="telemetry-cell">
                <div class="telemetry-label">Live Voice Calls</div>
                <div id="tel-calls" class="telemetry-val mono">${dom.activeLiveCalls || 0} active</div>
              </div>
              <div class="telemetry-cell">
                <div class="telemetry-label">AI Req / min</div>
                <div id="tel-ai" class="telemetry-val mono txt-cyan">${s.ai ? s.ai.reqPerMin : 0} <span class="muted txt-xs">(${s.ai ? s.ai.meanMs : 0}ms)</span></div>
              </div>
              <div class="telemetry-cell">
                <div class="telemetry-label">Offline Notif Queue</div>
                <div id="tel-queue" class="telemetry-val mono">${mobile.pendingProactive || 0} pending</div>
              </div>
              <div class="telemetry-cell">
                <div class="telemetry-label">Enrolled Devices</div>
                <div id="tel-devices" class="telemetry-val mono txt-emerald">${dom.enrolledDevices || 0}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 5. AI PROVIDER & CIRCUIT BREAKER HEALTH -->
        <div class="card">
          <div class="card-head">
            <div class="page-header-left">
              <h2 class="card-title">AI Providers &amp; Circuit Breakers</h2>
              <span class="pill mono ${aiHealth.openCount > 0 ? 'pill-rose' : (aiHealth.coolingKeysCount > 0 || aiHealth.halfOpenCount > 0 ? 'pill-amber' : 'pill-emerald')}">
                ${aiHealth.openCount > 0
                  ? `${aiHealth.openCount} Open · ${aiHealth.coolingKeysCount} Cooling`
                  : (aiHealth.coolingKeysCount > 0 ? `${aiHealth.coolingKeysCount} Key(s) Cooling` : 'All Nominal')}
              </span>
            </div>
            <div class="page-actions">
              <span class="muted mono txt-xs">AI Errors: ${s.ai ? s.ai.errorsTotal : 0}</span>
              ${(aiHealth.openCount > 0 || aiHealth.coolingKeysCount > 0 || aiHealth.groups.length > 0)
                ? '<button type="button" class="btn btn-sm" data-action="reset-breakers">Reset Breakers</button>'
                : ''}
            </div>
          </div>
          ${aiHealth.groups.length === 0 && aiHealth.keysCoolingDown.length === 0
            ? '<div class="muted mono txt-sm">All AI provider groups nominal · 0 circuit breakers open · 0 API keys cooling down.</div>'
            : `
              <div class="ai-health-grid">
                ${aiHealth.groups.map(g => {
                  const pillCls = g.state === 'OPEN' ? 'pill-rose' : (g.state === 'HALF_OPEN' ? 'pill-amber' : 'pill-emerald');
                  return `
                    <div class="ai-group-card">
                      <div class="ai-group-head">
                        <span class="mono txt-primary">${escapeHtml(g.name)}</span>
                        <span class="pill mono ${pillCls}">${escapeHtml(g.state)}</span>
                      </div>
                      <div class="muted mono txt-xs">Fails: ${g.fails}${g.reopenInSec > 0 ? ` · Reopen in ${g.reopenInSec}s` : ''}</div>
                    </div>
                  `;
                }).join('')}
                ${aiHealth.keysCoolingDown.map(k => `
                  <div class="ai-group-card">
                    <div class="ai-group-head">
                      <span class="mono txt-primary">${escapeHtml(k.key)}</span>
                      <span class="pill mono pill-amber">COOLDOWN</span>
                    </div>
                    <div class="muted mono txt-xs">Resumes in ${k.resumeInSec}s</div>
                  </div>
                `).join('')}
              </div>
            `}
        </div>

        <!-- 6. SCHEDULED BACKGROUND JOBS (CRON) -->
        ${cronList.length > 0 ? `
          <div class="card card-flush">
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Background Job</th>
                    <th>Schedule (WIB)</th>
                    <th>Status</th>
                    <th>Last Run</th>
                    <th>Duration</th>
                    <th>Runs / Fails</th>
                  </tr>
                </thead>
                <tbody>
                  ${cronList.map(job => {
                    const dotCls = job.lastStatus === 'failed' ? 'dot-rose' : (job.lastStatus === 'ok' ? 'dot-emerald' : 'dot-muted');
                    const statusLbl = job.lastStatus === 'failed' ? 'Failed' : (job.lastStatus === 'ok' ? 'OK' : 'Scheduled');
                    return `
                      <tr>
                        <td class="mono">${escapeHtml(job.name)}</td>
                        <td class="mono secondary">${escapeHtml(job.schedule || '—')}</td>
                        <td><span class="status-cell"><span class="dot ${dotCls}"></span>${statusLbl}</span></td>
                        <td class="mono secondary">${job.lastRunAt ? fmtRelative(job.lastRunAt) : 'pending'}</td>
                        <td class="mono secondary">${job.lastRunAt ? `${job.lastDurationMs} ms` : '—'}</td>
                        <td class="mono ${job.failCount > 0 ? 'txt-rose' : 'secondary'}" title="${escapeHtml(job.lastError || '')}">${job.runCount} / ${job.failCount}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}
      </div>
    `;

    // Draw 1h KPI sparklines
    const pts = Array.isArray(spark1h) && spark1h.length >= 2 ? spark1h : [
      { cpuPct: cpu.processPct, elMeanMs: el.meanMs, httpP95Ms: http.p95Ms },
      { cpuPct: cpu.processPct, elMeanMs: el.meanMs, httpP95Ms: http.p95Ms }
    ];
    drawSparkline(rootEl.querySelector('#spark-cpu'), pts.map(p => p.cpuPct), null);
    drawSparkline(rootEl.querySelector('#spark-el'), pts.map(p => p.elMeanMs), getComputedStyle(document.documentElement).getPropertyValue('--emerald').trim() || '#10b981');
    drawSparkline(rootEl.querySelector('#spark-http'), pts.map(p => p.httpP95Ms), null);
  }

  function patchFromLiveTick(msg) {
    if (!rootEl || !data || !msg || !msg.snapshot) return;
    data.snapshot = msg.snapshot;
    if (msg.issues) data.issues = msg.issues;
    lastUpdatedAt = Date.now();

    const s = msg.snapshot;
    const mem = s.memory;
    const issues = data.issues;

    const setTxt = (sel, txt) => {
      const el = rootEl.querySelector(sel);
      if (el) el.textContent = txt;
    };
    setTxt('#ov-updated', 'Live · updated just now');
    setTxt('#kpi-cpu-val', `${s.cpu.processPct}%`);
    setTxt('#kpi-cpu-sub', `Load ${(s.cpu.loadAvg || [0, 0]).slice(0, 2).join(', ')} · Host ${s.cpu.vpsPct}%`);
    setTxt('#kpi-mem-val', `${mem.rssMb} MiB`);
    setTxt('#kpi-mem-sub', `Heap ${mem.heapUsedMb}/${mem.heapTotalMb}M (${mem.heapPct}%) · ${mem.vpsAvailMb}M free`);
    const fill = rootEl.querySelector('#kpi-mem-fill');
    if (fill) fill.value = Math.min(100, Math.round((mem.rssMb / 420) * 100));
    setTxt('#kpi-el-val', `${s.eventLoop.meanMs} ms`);
    setTxt('#kpi-el-sub', `P95 ${s.eventLoop.p95Ms} ms · Max ${s.eventLoop.maxMs} ms`);
    setTxt('#kpi-http-rpm', `${s.http.reqPerMin} req/m`);
    setTxt('#kpi-http-val', `${s.http.meanMs} ms`);
    setTxt('#kpi-http-sub', `P95 ${s.http.p95Ms} ms · Issues ${issues.last1h} / ${issues.last24h} / ${issues.last7d}`);
    setTxt('#tel-handles', String(s.runtime.activeHandles));
    setTxt('#tel-reqs', String(s.runtime.activeRequests));
    setTxt('#tel-calls', `${(s.domain && s.domain.activeLiveCalls) || 0} active`);
    setTxt('#tel-queue', `${(s.domain && s.domain.mobile && s.domain.mobile.pendingProactive) || 0} pending`);
  }

  async function handleClick(ev) {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const act = btn.dataset.action;
    if (act === 'open-logs') ctx.navigate('logs');
    else if (act === 'open-metrics') ctx.navigate('metrics');
    else if (act === 'logs-unit') ctx.navigate('logs', { unit: btn.dataset.unit || 'all' });
    else if (act === 'logs-cat') ctx.navigate('logs', { category: btn.dataset.cat || 'all' });
    else if (act === 'restart-server') ctx.openRestartModal();
    else if (act === 'reset-monit') {
      try {
        await api.resetMetrics();
        ctx.toast('Runtime metrics reset (RESET MONIT).');
      } catch (err) {
        ctx.toast(`Reset failed: ${err.message}`);
      }
    } else if (act === 'reset-breakers') {
      try {
        const res = await api.resetBreakers();
        ctx.toast(`Cleared ${res.clearedGroups} group(s) & ${res.clearedKeys} cooling key(s).`);
        data = await api.overview();
        renderFull();
      } catch (err) {
        ctx.toast(`Reset breakers failed: ${err.message}`);
      }
    }
  }

  return {
    async mount(el) {
      rootEl = el;
      rootEl.classList.remove('full-bleed');
      rootEl.innerHTML = '<div class="page"><div class="card muted mono">Loading overview telemetry...</div></div>';
      rootEl.addEventListener('click', handleClick);

      try {
        data = await api.overview();
        lastUpdatedAt = Date.now();
        ctx.updateShellFromOverview(data);
        renderFull();
      } catch (err) {
        if (rootEl) rootEl.innerHTML = `<div class="page"><div class="card">Failed to load overview: ${escapeHtml(err.message)}</div></div>`;
      }

      tickClockTimer = setInterval(() => {
        const u = rootEl && rootEl.querySelector('#ov-updated');
        if (u) u.textContent = `Live · updated ${fmtRelative(lastUpdatedAt)}`;
      }, 5000);
    },
    onLiveTick(msg) {
      patchFromLiveTick(msg);
    },
    onThemeChange() {
      renderFull();
    },
    unmount() {
      if (tickClockTimer) {
        clearInterval(tickClockTimer);
        tickClockTimer = null;
      }
      if (rootEl) rootEl.removeEventListener('click', handleClick);
      rootEl = null;
    }
  };
}
