'use strict';
/**
 * N.E.X.A Pulse Monitor — Bespoke HiDPI <canvas> Chart Engine
 * Zero third-party chart libraries; strict CSP compliant.
 * Supports:
 * - Inline KPI sparklines
 * - Synchronized multi-chart vertical crosshair + clean hover tooltip
 * - Horizontal dashed threshold reference lines (e.g. 320 MiB High)
 */

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function drawSparkline(canvas, values, color = null) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(60, Math.floor(rect.width || 220));
  const h = Math.max(24, Math.floor(rect.height || 36));
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pts = Array.isArray(values) && values.length >= 2 ? values : [0, 0];
  let min = Infinity;
  let max = -Infinity;
  for (const v of pts) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) {
    max = min + 1;
    min = Math.max(0, min - 0.5);
  }

  const padY = 4;
  const strokeColor = color || cssVar('--accent', '#22d3ee');
  const stepX = w / (pts.length - 1);

  ctx.beginPath();
  pts.forEach((v, i) => {
    const x = i * stepX;
    const y = h - padY - ((v - min) / (max - min)) * (h - padY * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Subtle translucent fill underneath
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = strokeColor;
  ctx.globalAlpha = 0.08;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function fmtShortTime(tsSec) {
  const d = new Date(tsSec * 1000);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(d);
  } catch (_) {
    return d.toISOString().slice(11, 16);
  }
}

export class SyncedChartGroup {
  constructor() {
    this.charts = [];
    this.hoverIndex = -1;
    this.resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => this.renderAll())
      : null;
  }

  clear() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.charts = [];
    this.hoverIndex = -1;
  }

  /**
   * Register a canvas chart card into the synchronized hover group.
   * config: { canvas, points, unit, minY, maxY, threshold?: { value, label, color }, series: [{ key, label, color, area?, dashed?, bar? }] }
   */
  register(config) {
    const canvas = config.canvas;
    if (!canvas) return;
    this.charts.push(config);
    if (this.resizeObserver) this.resizeObserver.observe(canvas);

    canvas.addEventListener('mousemove', (ev) => {
      const pts = config.points || [];
      if (pts.length < 2) return;
      const rect = canvas.getBoundingClientRect();
      const padL = 44;
      const padR = 12;
      const plotW = Math.max(1, rect.width - padL - padR);
      const relX = Math.max(0, Math.min(plotW, ev.clientX - rect.left - padL));
      const idx = Math.round((relX / plotW) * (pts.length - 1));
      if (idx !== this.hoverIndex) {
        this.hoverIndex = idx;
        this.renderAll();
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (this.hoverIndex !== -1) {
        this.hoverIndex = -1;
        this.renderAll();
      }
    });
  }

  updatePoints(points) {
    for (const c of this.charts) {
      c.points = points;
    }
    this.renderAll();
  }

  renderAll() {
    for (const c of this.charts) {
      this._renderChart(c);
    }
  }

  _renderChart(cfg) {
    const canvas = cfg.canvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(120, Math.floor(rect.width || 420));
    const h = Math.max(100, Math.floor(rect.height || 175));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 44;
    const padR = 12;
    const padT = 12;
    const padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const pts = Array.isArray(cfg.points) ? cfg.points : [];
    const gridColor = cssVar('--chart-grid', 'rgba(255,255,255,0.05)');
    const axisColor = cssVar('--chart-axis', '#6b7280');
    const monoFont = '10.5px "JetBrains Mono", ui-monospace, monospace';

    // Determine Y domain
    let minY = cfg.minY !== undefined ? cfg.minY : 0;
    let maxY = cfg.maxY !== undefined ? cfg.maxY : 0;
    for (const p of pts) {
      for (const s of cfg.series) {
        const v = Number(p[s.key]) || 0;
        if (v > maxY) maxY = v;
        if (v < minY) minY = v;
      }
    }
    if (cfg.threshold && cfg.threshold.value > maxY) {
      maxY = cfg.threshold.value * 1.08;
    }
    if (maxY <= minY) maxY = minY + 10;
    else if (cfg.maxY === undefined) maxY = maxY * 1.15;

    const yOf = (val) => padT + plotH - ((val - minY) / (maxY - minY)) * plotH;

    // Horizontal grid lines + Y labels (4 ticks)
    ctx.font = monoFont;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const frac = i / 3;
      const val = minY + (maxY - minY) * frac;
      const y = Math.round(yOf(val)) + 0.5;
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();

      ctx.fillStyle = axisColor;
      const label = val >= 100 ? `${Math.round(val)}` : `${Math.round(val * 10) / 10}`;
      ctx.fillText(`${label}${cfg.unit || ''}`, padL - 6, y);
    }

    // Empty state
    if (pts.length === 0) {
      ctx.fillStyle = axisColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for telemetry samples...', padL + plotW / 2, padT + plotH / 2);
      return;
    }

    const xOf = (i) => pts.length === 1 ? padL + plotW / 2 : padL + (i / (pts.length - 1)) * plotW;

    // Strictly horizontal dashed threshold line (if configured)
    if (cfg.threshold && Number.isFinite(cfg.threshold.value)) {
      const ty = Math.round(yOf(cfg.threshold.value)) + 0.5;
      if (ty >= padT && ty <= padT + plotH) {
        ctx.save();
        ctx.strokeStyle = cfg.threshold.color || cssVar('--amber', '#f59e0b');
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padL, ty);
        ctx.lineTo(padL + plotW, ty);
        ctx.stroke();
        ctx.setLineDash([]);
        const lbl = cfg.threshold.label || `${cfg.threshold.value}`;
        const tw = ctx.measureText(lbl).width;
        ctx.fillStyle = cssVar('--bg-surface', '#10131a');
        ctx.fillRect(padL + 4, ty + 2, tw + 8, 14);
        ctx.fillStyle = cfg.threshold.color || cssVar('--amber', '#f59e0b');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(lbl, padL + 8, ty + 4);
        ctx.restore();
      }
    }

    // Draw series (bars first, then areas/lines)
    for (const s of cfg.series) {
      const color = s.color || cssVar('--accent', '#22d3ee');
      if (s.bar) {
        const barW = Math.max(2, Math.min(10, (plotW / Math.max(pts.length, 1)) * 0.55));
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.25;
        for (let i = 0; i < pts.length; i++) {
          const val = Number(pts[i][s.key]) || 0;
          const x = xOf(i) - barW / 2;
          const y = yOf(val);
          ctx.fillRect(x, y, barW, Math.max(0, padT + plotH - y));
        }
        ctx.globalAlpha = 1;
        continue;
      }

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = xOf(i);
        const y = yOf(Number(pts[i][s.key]) || 0);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = s.width || 1.75;
      ctx.lineJoin = 'round';
      if (s.dashed) ctx.setLineDash([4, 3]);
      ctx.stroke();

      if (s.area && pts.length >= 2) {
        ctx.lineTo(xOf(pts.length - 1), padT + plotH);
        ctx.lineTo(xOf(0), padT + plotH);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.08;
        ctx.fill();
      }
      ctx.restore();
    }

    // X-axis timestamp ticks (5 clean non-overlapping ticks)
    ctx.fillStyle = axisColor;
    ctx.font = monoFont;
    ctx.textBaseline = 'top';
    const tickCount = Math.min(5, pts.length);
    for (let t = 0; t < tickCount; t++) {
      const idx = tickCount === 1 ? 0 : Math.round((t / (tickCount - 1)) * (pts.length - 1));
      const x = xOf(idx);
      ctx.textAlign = t === 0 ? 'left' : (t === tickCount - 1 ? 'right' : 'center');
      ctx.fillText(fmtShortTime(pts[idx].tsSec), x, padT + plotH + 7);
    }

    // Synchronized hover crosshair + tooltip
    if (this.hoverIndex >= 0 && this.hoverIndex < pts.length) {
      const p = pts[this.hoverIndex];
      const hx = Math.round(xOf(this.hoverIndex)) + 0.5;

      ctx.save();
      ctx.strokeStyle = cssVar('--border-strong', 'rgba(255,255,255,0.22)');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();

      // Active dots
      for (const s of cfg.series) {
        if (s.bar) continue;
        const hy = yOf(Number(p[s.key]) || 0);
        ctx.fillStyle = s.color || cssVar('--accent', '#22d3ee');
        ctx.beginPath();
        ctx.arc(hx, hy, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Crisp floating tooltip box inside plot
      const lines = [`${fmtShortTime(p.tsSec)} WIB`];
      for (const s of cfg.series) {
        const val = Number(p[s.key]) || 0;
        const disp = val >= 100 ? Math.round(val) : Math.round(val * 100) / 100;
        lines.push(`${s.label}: ${disp}${cfg.unit || ''}`);
      }

      ctx.font = monoFont;
      let boxW = 0;
      for (const l of lines) boxW = Math.max(boxW, ctx.measureText(l).width);
      boxW += 16;
      const boxH = lines.length * 15 + 10;
      const boxX = (hx + 10 + boxW <= padL + plotW) ? hx + 10 : Math.max(padL + 2, hx - 10 - boxW);
      const boxY = padT + 4;

      ctx.fillStyle = cssVar('--bg-elevated', '#161b24');
      ctx.strokeStyle = cssVar('--border-strong', 'rgba(255,255,255,0.16)');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((l, li) => {
        ctx.fillStyle = li === 0 ? axisColor : cssVar('--text-primary', '#f3f4f6');
        ctx.fillText(l, boxX + 8, boxY + 6 + li * 15);
      });
      ctx.restore();
    }
  }
}
