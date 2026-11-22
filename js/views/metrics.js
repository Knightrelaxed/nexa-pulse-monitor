'use strict';

import { api, escapeHtml } from '../api.js';
import { SyncedChartGroup } from '../charts.js';

function snapshotToPoint(snap, issuesDelta = 0) {
  return {
    tsSec: snap.tsSec || Math.floor(Date.now() / 1000),
    cpuPct: snap.cpu.processPct,
    vpsCpuPct: snap.cpu.vpsPct,
    vpsAvailMb: snap.memory.vpsAvailMb,
    rssMb: snap.memory.rssMb,
    heapUsedMb: snap.memory.heapUsedMb,
    heapTotalMb: snap.memory.heapTotalMb,
    heapPct: snap.memory.heapPct,
    elMeanMs: snap.eventLoop.meanMs,
    elP95Ms: snap.eventLoop.p95Ms,
    httpReqMin: snap.http.reqPerMin,
    httpMeanMs: snap.http.meanMs,
    httpP95Ms: snap.http.p95Ms,
    activeHandles: snap.runtime.activeHandles,
    activeReqs: snap.runtime.activeRequests,
    issuesDelta,
    aiReqMin: snap.ai ? snap.ai.reqPerMin : 0,
    aiMeanMs: snap.ai ? snap.ai.meanMs : 0
  };
}

function summarize(points, key) {
  if (!points || points.length === 0) return { now: 0, avg: 0, max: 0 };
  let sum = 0;
  let max = 0;
  for (const p of points) {
    const v = Number(p[key]) || 0;
    sum += v;
    if (v > max) max = v;
  }
  const last = Number(points[points.length - 1][key]) || 0;
  const r = (n) => Math.round(n * 100) / 100;
  return { now: r(last), avg: r(sum / points.length), max: r(max) };
}

export function createMetricsView(ctx) {
  let rootEl = null;
  let range = 'live'; // live | 1h | 6h | 24h | 7d
  let groupFilter = 'all'; // all | system | http | domain
  let paused = false;
  let livePoints = [];
  let historyPoints = [];
  let latestSnap = null;
  const chartGroup = new SyncedChartGroup();

  function activePoints() {
    return range === 'live' ? livePoints : historyPoints;
  }

  function cssColor(varName, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
  }

  function renderLayout() {
    if (!rootEl) return;
    chartGroup.clear();
    const pts = activePoints();
    const cpuS = summarize(pts, 'cpuPct');
    const rssS = summarize(pts, 'rssMb');
    const availS = summarize(pts, 'vpsAvailMb');
    const heapUsedS = summarize(pts, 'heapUsedMb');
    const heapTotS = summarize(pts, 'heapTotalMb');
    const elMeanS = summarize(pts, 'elMeanMs');
    const elP95S = summarize(pts, 'elP95Ms');
    const httpRpmS = summarize(pts, 'httpReqMin');
    const httpP95S = summarize(pts, 'httpP95Ms');
    const handlesS = summarize(pts, 'activeHandles');
    const reqsS = summarize(pts, 'activeReqs');
    const aiRpmS = summarize(pts, 'aiReqMin');
    const aiMeanS = summarize(pts, 'aiMeanMs');

    const dom = (latestSnap && latestSnap.domain) || {};
    const mobile = dom.mobile || {};
    const win = dom.windows || {};

    const showSys = groupFilter === 'all' || groupFilter === 'system';
    const showHttp = groupFilter === 'all' || groupFilter === 'http';
    const showDom = groupFilter === 'all' || groupFilter === 'domain';

    rootEl.innerHTML = `
      <div class="page">
        <div class="page-header">
          <div class="page-header-left">
            <h1 class="page-title">Metrics</h1>
            <div class="segmented" role="tablist" aria-label="Metric group">
              <button type="button" class="seg-btn ${groupFilter === 'all' ? 'active' : ''}" data-group="all">All</button>
              <button type="button" class="seg-btn ${groupFilter === 'system' ? 'active' : ''}" data-group="system">System &amp; V8</button>
              <button type="button" class="seg-btn ${groupFilter === 'http' ? 'active' : ''}" data-group="http">HTTP &amp; Runtime</button>
              <button type="button" class="seg-btn ${groupFilter === 'domain' ? 'active' : ''}" data-group="domain">N.E.X.A Domain</button>
            </div>
          </div>
          <div class="page-actions">
            <div class="segmented mono" role="tablist" aria-label="Time range">
              <button type="button" class="seg-btn ${range === 'live' ? 'active' : ''}" data-range="live">Live (2s)</button>
              <button type="button" class="seg-btn ${range === '1h' ? 'active' : ''}" data-range="1h">1h</button>
              <button type="button" class="seg-btn ${range === '6h' ? 'active' : ''}" data-range="6h">6h</button>
              <button type="button" class="seg-btn ${range === '24h' ? 'active' : ''}" data-range="24h">24h</button>
              <button type="button" class="seg-btn ${range === '7d' ? 'active' : ''}" data-range="7d">7d</button>
            </div>
            <button type="button" class="btn ${paused ? 'btn-amber' : ''}" data-action="toggle-pause">${paused ? 'Resume' : 'Pause'}</button>
            <button type="button" class="btn" data-action="reset-monit">Reset Monit</button>
          </div>
        </div>

        ${showSys ? `
          <div class="section-label">System &amp; V8 Runtime</div>
          <div class="charts-grid">
            <div class="card chart-card">
              <div class="chart-head">
                <h2 class="card-title">CPU Usage (%)</h2>
                <span class="chart-stats mono">Now ${cpuS.now}% · Avg ${cpuS.avg}% · Max ${cpuS.max}%</span>
              </div>
              <div class="chart-canvas-wrap"><canvas id="ch-cpu" class="chart-canvas"></canvas></div>
              <div class="chart-legend mono">
                <span class="legend-item"><span class="dot dot-cyan"></span>nexa-server</span>
                <span class="legend-item"><span class="dot dot-muted"></span>VPS total</span>
              </div>
            </div>

            <div class="card chart-card">
              <div class="chart-head">
                <h2 class="card-title">Memory · Node RSS vs VPS Available</h2>
                <span class="chart-stats mono">RSS ${rssS.now} MiB · Avail ${availS.now} MiB</span>
              </div>
              <div class="chart-canvas-wrap"><canvas id="ch-mem" class="chart-canvas"></canvas></div>
              <div class="chart-legend mono">
                <span class="legend-item"><span class="dot dot-cyan"></span>Node RSS</span>
                <span class="legend-item"><span class="dot dot-emerald"></span>VPS Available</span>
                <span class="legend-item"><span class="dot dot-amber"></span>320 MiB High</span>
              </div>
            </div>

            <div class="card chart-card">
              <div class="chart-head">
                <h2 class="card-title">V8 Heap (Used vs Total)</h2>
                <span class="chart-stats mono">Used ${heapUsedS.now} MiB · Total ${heapTotS.now} MiB</span>
              </div>
              <div class="chart-canvas-wrap"><canvas id="ch-heap" class="chart-canvas"></canvas></div>
              <div class="chart-legend mono">
                <span class="legend-item"><span class="dot dot-cyan"></span>Used Heap</span>
                <span class="legend-item"><span class="dot dot-muted"></span>Heap Total</span>
              </div>
            </div>

            <div class="card chart-card">
              <div class="chart-head">
                <h2 class="card-title">Event Loop Delay (perf_hooks)</h2>
                <span class="chart-stats mono">Mean ${elMeanS.now} ms · P95 ${elP95S.now} ms</span>
              </div>
              <div class="chart-canvas-wrap"><canvas id="ch-el" class="chart-canvas"></canvas></div>
              <div class="chart-legend mono">
                <span class="legend-item"><span class="dot dot-cyan"></span>Mean</span>
                <span class="legend-item"><span class="dot dot-amber"></span>P95 Latency</span>
              </div>
            </div>
          </div>
        ` : ''}

        ${showHttp ? `
          <div class="section-label">HTTP &amp; Concurrency</div>
          <div class="charts-grid">
            <div class="card chart-card">
              <div class="chart-head">
                <h2 class="card-title">HTTP Throughput &amp; P95 Latency</h2>
                <span class="chart-stats mono">${httpRpmS.now} req/m · P95 ${httpP95S.now} ms</span>
              </div>
              <div class="chart-canvas-wrap"><canvas id="ch-http" class="chart-canvas"></canvas></div>
              <div class="chart-legend mono">
                <span class="legend-item"><span class="dot dot-muted"></span>Req/min (bars)</span>
                <span class="legend-item"><span class="dot dot-cyan"></span>P95 ms</span>
              </div>
            </div>

            <div class="card chart-card">
              <div class="chart-head">
                <h2 class="card-title">Active Handles &amp; Requests</h2>
                <span class="chart-stats mono">Handles ${handlesS.now} · In-Flight ${reqsS.now}</span>
              </div>
              <div class="chart-canvas-wrap"><canvas id="ch-handles" class="chart-canvas"></canvas></div>
              <div class="chart-legend mono">
                <span class="legend-item"><span class="dot dot-cyan"></span>Active Handles</span>
                <span class="legend-item"><span class="dot dot-emerald"></span>Active Requests</span>
              </div>
            </div>
          </div>
        ` : ''}

        ${showDom ? `
          <div class="section-label">N.E.X.A Domain Metrics</div>
          <div class="charts-grid">
            <div class="card chart-card">
              <div class="chart-head">
                <h2 class="card-title">AI / LLM Operations</h2>
                <span class="chart-stats mono">${aiRpmS.now} req/m · Mean ${aiMeanS.now} ms</span>
              </div>
              <div class="chart-canvas-wrap"><canvas id="ch-ai" class="chart-canvas"></canvas></div>
              <div class="chart-legend mono">
                <span class="legend-item"><span class="dot dot-cyan"></span>Mean Latency (ms)</span>
              </div>
            </div>

            <div class="card chart-card">
              <div class="chart-head">
                <h2 class="card-title">Bridges &amp; Realtime Sessions</h2>
                <span class="chart-stats mono">Live Calls ${dom.activeLiveCalls || 0} · Queue ${mobile.pendingProactive || 0}</span>
              </div>
              <div class="kv-list mt-4">
                <div class="kv-row">
                  <span class="kv-key">Mobile Bridge (Galaxy A33)</span>
                  <span class="kv-val mono"><span class="dot mr-6 ${mobile.connected ? 'dot-emerald' : 'dot-muted'}"></span>${mobile.connected ? `Connected · ${mobile.rttMs !== null ? mobile.rttMs + ' ms' : 'OK'}` : 'Offline'}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Windows Bridge (ThinkPad)</span>
                  <span class="kv-val mono"><span class="dot mr-6 ${win.connected ? 'dot-emerald' : 'dot-muted'}"></span>${win.connected ? `Connected · ${win.rttMs !== null ? win.rttMs + ' ms' : 'OK'}` : 'Offline'}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Active Live Voice Calls</span>
                  <span class="kv-val mono">${dom.activeLiveCalls || 0} active</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Offline Catch-Up Queue</span>
                  <span class="kv-val mono">${mobile.pendingProactive || 0} pending</span>
                </div>
              </div>
            </div>
          </div>
        ` : ''}
      </div>
    `;

    const cyan = cssColor('--accent', '#22d3ee');
    const emerald = cssColor('--emerald', '#10b981');
    const amber = cssColor('--amber', '#f59e0b');
    const muted = cssColor('--text-muted', '#6b7280');

    if (showSys) {
      chartGroup.register({
        canvas: rootEl.querySelector('#ch-cpu'),
        points: pts,
        unit: '%',
        minY: 0,
        series: [
          { key: 'vpsCpuPct', label: 'VPS Total', color: muted, dashed: true, width: 1.2 },
          { key: 'cpuPct', label: 'nexa-server', color: cyan, area: true }
        ]
      });
      chartGroup.register({
        canvas: rootEl.querySelector('#ch-mem'),
        points: pts,
        unit: 'M',
        minY: 0,
        threshold: { value: 320, label: '320 MiB High', color: amber },
        series: [
          { key: 'vpsAvailMb', label: 'VPS Avail', color: emerald, width: 1.5 },
          { key: 'rssMb', label: 'Node RSS', color: cyan, area: true }
        ]
      });
      chartGroup.register({
        canvas: rootEl.querySelector('#ch-heap'),
        points: pts,
        unit: 'M',
        minY: 0,
        series: [
          { key: 'heapTotalMb', label: 'Heap Total', color: muted, dashed: true, width: 1.3 },
          { key: 'heapUsedMb', label: 'Heap Used', color: cyan, area: true }
        ]
      });
      chartGroup.register({
        canvas: rootEl.querySelector('#ch-el'),
        points: pts,
        unit: 'ms',
        minY: 0,
        series: [
          { key: 'elP95Ms', label: 'P95', color: amber, width: 1.5 },
          { key: 'elMeanMs', label: 'Mean', color: cyan, area: true }
        ]
      });
    }

    if (showHttp) {
      chartGroup.register({
        canvas: rootEl.querySelector('#ch-http'),
        points: pts,
        unit: '',
        minY: 0,
        series: [
          { key: 'httpReqMin', label: 'Req/m', color: muted, bar: true },
          { key: 'httpP95Ms', label: 'P95 ms', color: cyan }
        ]
      });
      chartGroup.register({
        canvas: rootEl.querySelector('#ch-handles'),
        points: pts,
        unit: '',
        minY: 0,
        series: [
          { key: 'activeHandles', label: 'Handles', color: cyan, area: true },
          { key: 'activeReqs', label: 'Active Req', color: emerald, width: 1.4 }
        ]
      });
    }

    if (showDom) {
      chartGroup.register({
        canvas: rootEl.querySelector('#ch-ai'),
        points: pts,
        unit: 'ms',
        minY: 0,
        series: [
          { key: 'aiMeanMs', label: 'Mean ms', color: cyan, area: true }
        ]
      });
    }

    chartGroup.renderAll();
  }

  async function loadRange(nextRange) {
    range = nextRange;
    if (range === 'live') {
      renderLayout();
      return;
    }
    try {
      const res = await api.metricsHistory(range, 180);
      historyPoints = res.points || [];
      if (res.current) latestSnap = res.current;
      renderLayout();
    } catch (err) {
      ctx.toast(`Failed to load ${range} metrics: ${err.message}`);
    }
  }

  async function handleClick(ev) {
    const rBtn = ev.target.closest('[data-range]');
    if (rBtn) {
      await loadRange(rBtn.dataset.range);
      return;
    }
    const gBtn = ev.target.closest('[data-group]');
    if (gBtn) {
      groupFilter = gBtn.dataset.group;
      renderLayout();
      return;
    }
    const actBtn = ev.target.closest('[data-action]');
    if (!actBtn) return;
    if (actBtn.dataset.action === 'toggle-pause') {
      paused = !paused;
      ctx.setMetricsWsPaused(paused);
      renderLayout();
    } else if (actBtn.dataset.action === 'reset-monit') {
      try {
        await api.resetMetrics();
        ctx.toast('Runtime latency histograms reset (RESET MONIT).');
      } catch (err) {
        ctx.toast(`Reset failed: ${err.message}`);
      }
    }
  }

  return {
    async mount(el, opts = {}) {
      rootEl = el;
      rootEl.classList.remove('full-bleed');
      rootEl.addEventListener('click', handleClick);
      if (opts && opts.range) range = opts.range;

      // Seed initial points from 1h history so charts never look blank on open
      try {
        const res = await api.metricsHistory(range === 'live' ? '1h' : range, 180);
        if (res.current) latestSnap = res.current;
        if (range === 'live') {
          livePoints = (res.points || []).slice(-60);
          if (res.current) livePoints.push(snapshotToPoint(res.current));
        } else {
          historyPoints = res.points || [];
        }
      } catch (_) {}

      renderLayout();
    },
    onLiveTick(msg) {
      if (!msg || !msg.snapshot) return;
      latestSnap = msg.snapshot;
      if (paused) return;
      livePoints.push(snapshotToPoint(msg.snapshot));
      if (livePoints.length > 180) livePoints.splice(0, livePoints.length - 180);
      if (range === 'live' && rootEl) {
        chartGroup.updatePoints(livePoints);
      }
    },
    onThemeChange() {
      renderLayout();
    },
    unmount() {
      chartGroup.clear();
      if (rootEl) rootEl.removeEventListener('click', handleClick);
      if (paused) {
        paused = false;
        ctx.setMetricsWsPaused(false);
      }
      rootEl = null;
    }
  };
}
