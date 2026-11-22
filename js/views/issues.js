'use strict';

import { api, escapeHtml, fmtRelative, fmtWibDateTime } from '../api.js';

export function createIssuesView(ctx) {
  let rootEl = null;
  let statusFilter = 'unresolved'; // unresolved | resolved | all
  let searchQuery = '';
  let summary = { last1h: 0, last24h: 0, last7d: 0, unresolved: 0, resolved: 0 };
  let issues = [];
  let selectedFp = null;
  let selectedDetail = null;

  async function refreshList() {
    try {
      const res = await api.issues({ status: statusFilter, search: searchQuery });
      summary = res.summary || summary;
      issues = res.issues || [];
      ctx.updateIssuesBadge(summary.unresolved || 0);
      if (selectedFp && !issues.some(i => i.fingerprint === selectedFp)) {
        selectedFp = null;
        selectedDetail = null;
      }
      render();
    } catch (err) {
      if (rootEl) rootEl.innerHTML = `<div class="page"><div class="card">Failed to load issues: ${escapeHtml(err.message)}</div></div>`;
    }
  }

  async function selectIssue(fp) {
    selectedFp = fp;
    render();
    try {
      selectedDetail = await api.issueDetail(fp);
      render();
    } catch (err) {
      ctx.toast(`Failed to load issue detail: ${err.message}`);
    }
  }

  function render() {
    if (!rootEl) return;
    const drawerOpen = Boolean(selectedFp && selectedDetail);

    rootEl.innerHTML = `
      <div class="page">
        <div class="page-header">
          <div class="page-header-left">
            <h1 class="page-title">Issues</h1>
            <div class="segmented" role="tablist">
              <button type="button" class="seg-btn ${statusFilter === 'unresolved' ? 'active' : ''}" data-status="unresolved">Unresolved (${summary.unresolved})</button>
              <button type="button" class="seg-btn ${statusFilter === 'resolved' ? 'active' : ''}" data-status="resolved">Resolved (${summary.resolved})</button>
              <button type="button" class="seg-btn ${statusFilter === 'all' ? 'active' : ''}" data-status="all">All</button>
            </div>
          </div>
          <div class="page-actions">
            <input id="issues-search" type="search" class="toolbar-search mono" placeholder="Search issues..." value="${escapeHtml(searchQuery)}">
            <button type="button" class="btn" data-action="clear-resolved" ${summary.resolved === 0 ? 'disabled' : ''}>Clear Resolved</button>
          </div>
        </div>

        <!-- Summary Strip -->
        <div class="kpi-grid">
          <div class="card kpi-card">
            <div class="kpi-top"><span>Last 1 Hour</span><span class="dot ${summary.last1h > 0 ? 'dot-rose' : 'dot-emerald'}"></span></div>
            <div class="kpi-value mono">${summary.last1h}</div>
          </div>
          <div class="card kpi-card">
            <div class="kpi-top"><span>Last 24 Hours</span><span class="dot ${summary.last24h > 0 ? 'dot-amber' : 'dot-emerald'}"></span></div>
            <div class="kpi-value mono">${summary.last24h}</div>
          </div>
          <div class="card kpi-card">
            <div class="kpi-top"><span>Last 7 Days</span><span class="dot dot-muted"></span></div>
            <div class="kpi-value mono">${summary.last7d}</div>
          </div>
          <div class="card kpi-card">
            <div class="kpi-top"><span>Unresolved</span><span class="dot ${summary.unresolved > 0 ? 'dot-rose' : 'dot-emerald'}"></span></div>
            <div class="kpi-value mono">${summary.unresolved}</div>
          </div>
        </div>

        <div class="issues-layout ${drawerOpen ? 'drawer-open' : ''}">
          <!-- Deduplicated Issues Table -->
          <div class="card card-flush">
            ${issues.length === 0 ? `
              <div class="logs-empty mono">No ${statusFilter === 'all' ? '' : statusFilter + ' '}issues logged for nexa-server.</div>
            ` : issues.map(item => {
              const sevDot = item.status === 'resolved'
                ? 'dot-emerald'
                : (item.severity === 'fatal' || item.subsystem === 'HTTP-5XX' ? 'dot-rose' : 'dot-amber');
              const maxBar = Math.max(1, ...(item.spark24h || [1]));
              return `
                <div class="issue-row ${selectedFp === item.fingerprint ? 'selected' : ''}" data-select-fp="${escapeHtml(item.fingerprint)}">
                  <div class="issue-main">
                    <div class="issue-title-line">
                      <span class="dot ${sevDot}"></span>
                      <span class="pill mono">[${escapeHtml(item.subsystem)}]</span>
                      <span class="issue-title-text" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
                    </div>
                    <div class="issue-meta-line mono">
                      ${escapeHtml(item.culprit || item.route || item.fingerprint)}${item.commit ? ` · main@${escapeHtml(item.commit)}` : ''}
                    </div>
                  </div>
                  <div>
                    <div class="mono txt-sm">${item.count}x</div>
                    <div class="sparkbar-mini" title="24h event distribution">
                      ${(item.spark24h || []).map(v => {
                        const lvl = v <= 0 ? 1 : Math.min(5, Math.max(2, Math.ceil((v / maxBar) * 5)));
                        return `<span class="sparkbar-col spark-h-${lvl} ${v > 0 ? 'nonzero' : ''}"></span>`;
                      }).join('')}
                    </div>
                  </div>
                  <div class="mono secondary txt-xs txt-right">${fmtRelative(item.lastSeenAt)}</div>
                  <div class="txt-right">
                    ${item.status === 'unresolved'
                      ? `<button type="button" class="btn btn-sm" data-resolve-fp="${escapeHtml(item.fingerprint)}">Resolve</button>`
                      : `<span class="pill pill-emerald">Resolved</span>`}
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          ${drawerOpen ? `
            <!-- Slide-Over Detail Inspector -->
            <div class="card inspector-card">
              <div class="card-head mb-0">
                <div class="page-header-left">
                  <span class="pill ${selectedDetail.severity === 'fatal' ? 'pill-rose' : 'pill-amber'} mono">[${escapeHtml(selectedDetail.subsystem)}]</span>
                  <span class="pill mono">${escapeHtml(selectedDetail.fingerprint)}</span>
                </div>
                <button type="button" class="icon-btn" data-action="close-drawer" aria-label="Close detail">×</button>
              </div>

              <div class="issue-drawer-title">${escapeHtml(selectedDetail.title)}</div>

              <div class="page-actions">
                ${selectedDetail.status === 'unresolved'
                  ? `<button type="button" class="btn btn-cyan btn-sm" data-resolve-fp="${escapeHtml(selectedDetail.fingerprint)}">Mark Resolved</button>`
                  : `<button type="button" class="btn btn-sm" data-reopen-fp="${escapeHtml(selectedDetail.fingerprint)}">Reopen</button>`}
                <button type="button" class="btn btn-sm" data-action="jump-logs">Jump to Logs</button>
              </div>

              <div class="kv-list">
                <div class="kv-row"><span class="kv-key">Occurrences</span><span class="kv-val mono">${selectedDetail.count} events (deduplicated)</span></div>
                <div class="kv-row"><span class="kv-key">First Seen</span><span class="kv-val mono">${fmtWibDateTime(selectedDetail.firstSeenAt)}</span></div>
                <div class="kv-row"><span class="kv-key">Last Seen</span><span class="kv-val mono">${fmtWibDateTime(selectedDetail.lastSeenAt)}</span></div>
                ${selectedDetail.commit ? `<div class="kv-row"><span class="kv-key">Git Commit</span><span class="kv-val mono">main @ ${escapeHtml(selectedDetail.commit)}</span></div>` : ''}
                ${selectedDetail.route ? `<div class="kv-row"><span class="kv-key">Route</span><span class="kv-val mono">${escapeHtml(selectedDetail.route)}</span></div>` : ''}
              </div>

              <div>
                <div class="card-head mb-6">
                  <span class="section-label m-0">Normalized Stack Trace</span>
                  <span class="muted mono txt-xs">FR-SEC-04 redacted</span>
                </div>
                <div class="stack-box mono">${escapeHtml(selectedDetail.stack || 'No stack trace captured.')}</div>
              </div>

              <div>
                <div class="section-label m-0 mb-8">Recent Occurrences</div>
                <div class="kv-list">
                  ${(selectedDetail.recentOccurrences || []).slice(0, 6).map(occ => `
                    <div class="kv-row">
                      <span class="mono secondary txt-xs">${fmtWibDateTime(occ.ts)}</span>
                      <span class="mono muted txt-xs">${escapeHtml(occ.route || occ.source || (occ.statusCode ? `HTTP ${occ.statusCode}` : 'event'))}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    const searchInput = rootEl.querySelector('#issues-search');
    if (searchInput) {
      let timer = null;
      searchInput.addEventListener('input', (ev) => {
        searchQuery = ev.target.value;
        clearTimeout(timer);
        timer = setTimeout(() => refreshList(), 220);
      });
    }
  }

  async function handleClick(ev) {
    const statusBtn = ev.target.closest('[data-status]');
    if (statusBtn) {
      statusFilter = statusBtn.dataset.status;
      await refreshList();
      return;
    }

    const resolveBtn = ev.target.closest('[data-resolve-fp]');
    if (resolveBtn) {
      ev.stopPropagation();
      try {
        const updated = await api.resolveIssue(resolveBtn.dataset.resolveFp);
        if (selectedFp === updated.fingerprint) selectedDetail = updated;
        ctx.toast(`Resolved ${updated.fingerprint}`);
        await refreshList();
      } catch (err) {
        ctx.toast(`Resolve failed: ${err.message}`);
      }
      return;
    }

    const reopenBtn = ev.target.closest('[data-reopen-fp]');
    if (reopenBtn) {
      try {
        selectedDetail = await api.reopenIssue(reopenBtn.dataset.reopenFp);
        await refreshList();
      } catch (err) {
        ctx.toast(`Reopen failed: ${err.message}`);
      }
      return;
    }

    const actBtn = ev.target.closest('[data-action]');
    if (actBtn) {
      if (actBtn.dataset.action === 'clear-resolved') {
        try {
          const res = await api.clearResolvedIssues();
          ctx.toast(`Cleared ${res.removed} resolved issue(s).`);
          await refreshList();
        } catch (err) {
          ctx.toast(`Clear failed: ${err.message}`);
        }
      } else if (actBtn.dataset.action === 'close-drawer') {
        selectedFp = null;
        selectedDetail = null;
        render();
      } else if (actBtn.dataset.action === 'jump-logs') {
        ctx.navigate('logs', { category: 'errors' });
      }
      return;
    }

    const row = ev.target.closest('[data-select-fp]');
    if (row) {
      await selectIssue(row.dataset.selectFp);
    }
  }

  return {
    async mount(el) {
      rootEl = el;
      rootEl.classList.remove('full-bleed');
      rootEl.innerHTML = '<div class="page"><div class="card muted mono">Loading issues...</div></div>';
      rootEl.addEventListener('click', handleClick);
      await refreshList();
    },
    unmount() {
      if (rootEl) rootEl.removeEventListener('click', handleClick);
      rootEl = null;
    }
  };
}
