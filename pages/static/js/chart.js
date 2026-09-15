/**
 * Versatile High-Visibility SVG Chart Engine for Token Trends.
 * 
 * Supports 5 distinct visual styles:
 * - 'area': Smooth stacked area chart with vibrant linear gradients
 * - 'spline': Multi-line spline curve with glowing nodes and crosshair tracking
 * - 'bar': Modern stacked column chart with rounded capsule caps
 * - 'combo': Stacked token volume columns + glowing overlaid cost line
 * - 'heatmap': GitHub-style calendar activity grid
 */

const MAX_BUCKETS = 120;
const PAD = { left: 62, right: 48, top: 22, bottom: 42 };
const NICE_STEPS = [1, 2, 2.5, 5, 10];
const GRID_LINES = 4;
const MIN_LABEL_SPACING = 58;

export function formatCompact(value) {
    const v = Number(value) || 0;
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
}

function niceMax(value) {
    if (!(value > 0)) return 1;
    const exp = Math.floor(Math.log10(value));
    const base = Math.pow(10, exp);
    const frac = value / base;
    for (let i = 0; i < NICE_STEPS.length; i++) {
        if (frac <= NICE_STEPS[i]) return NICE_STEPS[i] * base;
    }
    return 10 * base;
}

function escapeText(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderEmpty(container, message) {
    const empty = document.createElement('div');
    empty.className = 'tc-empty';
    empty.textContent = message;
    container.appendChild(empty);
}

function buildLegend(items) {
    const legend = document.createElement('div');
    legend.className = 'tc-legend';
    items.forEach(s => {
        const item = document.createElement('span');
        item.className = 'tc-legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'tc-legend-swatch';
        swatch.style.backgroundColor = s.color;
        if (s.isLine) {
            swatch.style.height = '3px';
            swatch.style.width = '14px';
            swatch.style.borderRadius = '2px';
        }
        item.appendChild(swatch);
        const label = document.createElement('span');
        label.textContent = s.name;
        item.appendChild(label);
        legend.appendChild(item);
    });
    return legend;
}

/** Generates smooth cubic Bézier SVG path data through coordinate points */
function buildSplinePath(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    
    let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;

        d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
}

/** Renders the GitHub-style Calendar Activity Heatmap */
export function renderCalendarHeatmap(container, dailyBuckets, options) {
    container.innerHTML = '';
    if (!Array.isArray(dailyBuckets) || dailyBuckets.length === 0) {
        renderEmpty(container, options.emptyMessage || 'No activity recorded yet.');
        return;
    }

    const buckets = dailyBuckets.filter(b => b && b.date);
    if (buckets.length === 0) {
        renderEmpty(container, options.emptyMessage || 'No dated activity recorded.');
        return;
    }

    const bucketMap = new Map();
    let maxTotal = 0;
    buckets.forEach(b => {
        let inT = 0, outT = 0;
        const models = b.models || {};
        Object.keys(models).forEach(k => {
            inT += Number(models[k].input) || 0;
            outT += Number(models[k].output) || 0;
        });
        const tot = inT + outT;
        if (tot > maxTotal) maxTotal = tot;
        bucketMap.set(b.date, { input: inT, output: outT, total: tot });
    });

    const today = new Date();
    const days = 140; // ~20 weeks
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        dates.push(d);
    }

    const width = Math.max(340, container.clientWidth || 760);
    const cellSize = Math.max(10, Math.min(16, (width - 60) / 22));
    const cellGap = 3;
    const height = (cellSize + cellGap) * 7 + 45;

    const parts = [];
    parts.push(`<svg class="tc-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    
    // Intensity Colors (Gruvbox-inspired vibrant emerald/cyan ramp)
    const levels = [
        'rgba(var(--gb-bg-light-1), 0.5)',
        '#2d5e59',
        '#458588',
        '#68d3d8',
        '#8ec07c'
    ];

    const dowNames = ['M', '', 'W', '', 'F', '', 'S'];
    for (let row = 0; row < 7; row++) {
        const y = 20 + row * (cellSize + cellGap) + cellSize - 2;
        if (dowNames[row]) {
            parts.push(`<text class="tc-axis-label" x="16" y="${y}" text-anchor="middle">${dowNames[row]}</text>`);
        }
    }

    // Start alignment by day of week
    let col = 0;
    dates.forEach(date => {
        const dow = (date.getDay() + 6) % 7; // Monday = 0
        const dateStr = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
        const info = bucketMap.get(dateStr) || { input: 0, output: 0, total: 0 };
        
        let color = levels[0];
        if (info.total > 0 && maxTotal > 0) {
            const ratio = info.total / maxTotal;
            if (ratio > 0.65) color = levels[4];
            else if (ratio > 0.35) color = levels[3];
            else if (ratio > 0.12) color = levels[2];
            else color = levels[1];
        }

        const x = 34 + col * (cellSize + cellGap);
        const y = 20 + dow * (cellSize + cellGap);

        parts.push(`<rect class="tc-heatmap-cell" data-date="${dateStr}" data-in="${info.input}" data-out="${info.output}" data-tot="${info.total}" x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2.5" fill="${color}"></rect>`);

        if (dow === 6) col++;
    });

    parts.push('</svg>');

    const legendItems = [
        { name: 'Less', color: levels[0] },
        { name: 'Modest', color: levels[2] },
        { name: 'High', color: levels[4] }
    ];
    container.appendChild(buildLegend(legendItems));

    const surface = document.createElement('div');
    surface.className = 'tc-chart-wrap';
    surface.innerHTML = parts.join('');

    const tooltip = document.createElement('div');
    tooltip.className = 'tc-chart-tooltip';
    tooltip.style.display = 'none';
    surface.appendChild(tooltip);

    const svg = surface.querySelector('svg');
    if (svg) {
        svg.addEventListener('mousemove', (e) => {
            const cell = e.target.closest('.tc-heatmap-cell');
            if (!cell) {
                tooltip.style.display = 'none';
                return;
            }
            const d = cell.getAttribute('data-date');
            const inT = Number(cell.getAttribute('data-in')) || 0;
            const outT = Number(cell.getAttribute('data-out')) || 0;
            const tot = Number(cell.getAttribute('data-tot')) || 0;

            tooltip.innerHTML = `
                <div class="tc-tip-title">${d}</div>
                <div class="tc-tip-row"><span>Total Tokens:</span><span class="tc-tip-value font-bold">${tot.toLocaleString()}</span></div>
                <div class="tc-tip-row"><span class="text-gb-blueAccent">Inputted:</span><span class="tc-tip-value text-gb-blueAccent">${inT.toLocaleString()}</span></div>
                <div class="tc-tip-row"><span class="text-gb-greenAccent">Outputted:</span><span class="tc-tip-value text-gb-greenAccent">${outT.toLocaleString()}</span></div>
            `;

            const rect = surface.getBoundingClientRect();
            const localX = e.clientX - rect.left;
            const localY = e.clientY - rect.top;
            tooltip.style.display = 'block';
            const tipW = tooltip.offsetWidth || 160;
            tooltip.style.left = Math.max(4, Math.min(localX + 14, rect.width - tipW - 4)) + 'px';
            tooltip.style.top = Math.max(4, localY - 14) + 'px';
        });
        svg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    }

    container.appendChild(surface);
}

/**
 * Main Unified Chart Renderer (Area, Spline, Stacked Bar, Combo).
 */
export function renderBarChart(container, options) {
    if (!container) return;
    const opts = options || {};
    const chartType = opts.type || 'area';

    if (chartType === 'heatmap' && Array.isArray(opts.dailyRaw)) {
        renderCalendarHeatmap(container, opts.dailyRaw, opts);
        return;
    }

    const formatValue = typeof opts.formatValue === 'function' ? opts.formatValue : (v) => (Number(v) || 0).toLocaleString();
    container.innerHTML = '';

    let labels = Array.isArray(opts.labels) ? opts.labels : [];
    let series = Array.isArray(opts.series) ? opts.series.filter(s => s && Array.isArray(s.values)) : [];
    let costSeries = opts.costSeries && Array.isArray(opts.costSeries.values) ? opts.costSeries : null;

    if (labels.length === 0 || series.length === 0) {
        renderEmpty(container, opts.emptyMessage || 'No usage recorded in this window.');
        return;
    }

    if (labels.length > MAX_BUCKETS) {
        const start = labels.length - MAX_BUCKETS;
        labels = labels.slice(start);
        series = series.map(s => Object.assign({}, s, { values: s.values.slice(start) }));
        if (costSeries) {
            costSeries = Object.assign({}, costSeries, { values: costSeries.values.slice(start) });
        }
    }

    const count = labels.length;
    
    // Calculate Max Value depending on whether series are stacked or overlaid
    let maxTokenValue = 0;
    const isStacked = (chartType === 'area' || chartType === 'bar' || chartType === 'combo');

    if (isStacked) {
        for (let i = 0; i < count; i++) {
            let stackedTot = 0;
            series.forEach(s => { stackedTot += (Number(s.values[i]) || 0); });
            if (stackedTot > maxTokenValue) maxTokenValue = stackedTot;
        }
    } else {
        series.forEach(s => {
            for (let i = 0; i < count; i++) {
                const v = Number(s.values[i]) || 0;
                if (v > maxTokenValue) maxTokenValue = v;
            }
        });
    }

    if (maxTokenValue <= 0) {
        container.appendChild(buildLegend(series));
        renderEmpty(container, opts.emptyMessage || 'No usage recorded in this window.');
        return;
    }

    let maxCostValue = 0;
    if (costSeries && chartType === 'combo') {
        costSeries.values.forEach(v => {
            const c = Number(v) || 0;
            if (c > maxCostValue) maxCostValue = c;
        });
    }

    const width = Math.max(320, container.clientWidth || 760);
    const height = opts.height || 320;
    const rightPad = (chartType === 'combo' && maxCostValue > 0) ? PAD.right : 16;
    const plotW = Math.max(40, width - PAD.left - rightPad);
    const plotH = Math.max(40, height - PAD.top - PAD.bottom);
    
    const topToken = niceMax(maxTokenValue);
    const topCost = niceMax(maxCostValue || 1);

    const groupW = plotW / Math.max(1, count);
    const yFor = (v) => PAD.top + plotH - ((Number(v) || 0) / topToken) * plotH;
    const yForCost = (c) => PAD.top + plotH - ((Number(c) || 0) / topCost) * plotH;
    const xForCenter = (i) => PAD.left + groupW * i + groupW / 2;

    const parts = [];
    parts.push(`<svg class="tc-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`);

    // SVG Gradients & Filter Definitions
    parts.push(`
        <defs>
            <linearGradient id="tc-grad-in" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#74d2e7" stop-opacity="0.75" />
                <stop offset="70%" stop-color="#458588" stop-opacity="0.35" />
                <stop offset="100%" stop-color="#458588" stop-opacity="0.02" />
            </linearGradient>
            <linearGradient id="tc-grad-out" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#b8bb26" stop-opacity="0.85" />
                <stop offset="70%" stop-color="#98971a" stop-opacity="0.40" />
                <stop offset="100%" stop-color="#98971a" stop-opacity="0.02" />
            </linearGradient>
            <linearGradient id="tc-grad-bar-in" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#83a598" />
                <stop offset="100%" stop-color="#458588" />
            </linearGradient>
            <linearGradient id="tc-grad-bar-out" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#d4e157" />
                <stop offset="100%" stop-color="#b8bb26" />
            </linearGradient>
            <filter id="tc-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                </feMerge>
            </filter>
        </defs>
    `);

    // Horizontal Grid Lines & Ticks
    for (let i = 0; i <= GRID_LINES; i++) {
        const value = (topToken / GRID_LINES) * i;
        const y = yFor(value);
        parts.push(`<line class="tc-grid-line" x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${(PAD.left + plotW)}" y2="${y.toFixed(1)}"></line>`);
        parts.push(`<text class="tc-axis-label" x="${PAD.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${escapeText(formatCompact(value))}</text>`);
        
        // Right Y Axis for Cost in Combo mode
        if (chartType === 'combo' && maxCostValue > 0) {
            const cVal = (topCost / GRID_LINES) * i;
            const cLabel = opts.formatCost ? opts.formatCost(cVal) : '$' + formatCompact(cVal);
            parts.push(`<text class="tc-axis-label text-gb-purpleAccent" x="${(PAD.left + plotW + 8)}" y="${(y + 3.5).toFixed(1)}" text-anchor="start" fill="#d3869b">${escapeText(cLabel)}</text>`);
        }
    }

    const baseY = PAD.top + plotH;

    // 1. RENDER AREA / SPLINE / BARS
    if (chartType === 'bar' || chartType === 'combo') {
        const barW = Math.max(3, Math.min(24, groupW * 0.55));
        for (let i = 0; i < count; i++) {
            const center = xForCenter(i);
            const inVal = Number(series[0]?.values[i]) || 0;
            const outVal = Number(series[1]?.values[i]) || 0;
            const totalVal = inVal + outVal;
            if (totalVal <= 0) continue;

            const yTop = yFor(totalVal);
            const yMid = yFor(inVal);
            const x = center - barW / 2;

            // Bottom chunk (Input Tokens)
            if (inVal > 0) {
                const hIn = baseY - yMid;
                parts.push(`<rect x="${x.toFixed(1)}" y="${yMid.toFixed(1)}" width="${barW.toFixed(1)}" height="${hIn.toFixed(1)}" fill="url(#tc-grad-bar-in)" rx="1.5"></rect>`);
            }
            // Top chunk (Output Tokens)
            if (outVal > 0) {
                const hOut = yMid - yTop;
                parts.push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${hOut.toFixed(1)}" fill="url(#tc-grad-bar-out)" rx="3"></rect>`);
            }
        }
    } else if (chartType === 'area') {
        // Stacked Area (Input Base + Output Top Curve)
        const inPoints = [];
        const totPoints = [];
        for (let i = 0; i < count; i++) {
            const inVal = Number(series[0]?.values[i]) || 0;
            const outVal = Number(series[1]?.values[i]) || 0;
            const cx = xForCenter(i);
            inPoints.push({ x: cx, y: yFor(inVal) });
            totPoints.push({ x: cx, y: yFor(inVal + outVal) });
        }

        // Total (Outer) Area Path
        let totAreaD = buildSplinePath(totPoints);
        totAreaD += ` L ${totPoints[totPoints.length - 1].x.toFixed(1)} ${baseY} L ${totPoints[0].x.toFixed(1)} ${baseY} Z`;
        parts.push(`<path d="${totAreaD}" fill="url(#tc-grad-out)"></path>`);

        // Input (Base) Area Path
        let inAreaD = buildSplinePath(inPoints);
        inAreaD += ` L ${inPoints[inPoints.length - 1].x.toFixed(1)} ${baseY} L ${inPoints[0].x.toFixed(1)} ${baseY} Z`;
        parts.push(`<path d="${inAreaD}" fill="url(#tc-grad-in)"></path>`);

        // Vibrant Stroke lines
        parts.push(`<path d="${buildSplinePath(totPoints)}" fill="none" stroke="#b8bb26" stroke-width="2.5" filter="url(#tc-glow)"></path>`);
        parts.push(`<path d="${buildSplinePath(inPoints)}" fill="none" stroke="#74d2e7" stroke-width="2.2"></path>`);
    } else if (chartType === 'spline') {
        // Unstacked Multi-line Splines with Glowing Node markers
        series.forEach((s, sIdx) => {
            const pts = [];
            for (let i = 0; i < count; i++) {
                pts.push({ x: xForCenter(i), y: yFor(Number(s.values[i]) || 0) });
            }
            const pathD = buildSplinePath(pts);
            const color = sIdx === 0 ? '#74d2e7' : '#b8bb26';
            parts.push(`<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2.5" filter="url(#tc-glow)"></path>`);
            
            // Data nodes
            pts.forEach(p => {
                parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${color}" stroke="#1d2021" stroke-width="1.5"></circle>`);
            });
        });
    }

    // 2. OVERLAY COST LINE FOR COMBO CHART
    if (chartType === 'combo' && costSeries && maxCostValue > 0) {
        const costPts = [];
        for (let i = 0; i < count; i++) {
            costPts.push({ x: xForCenter(i), y: yForCost(Number(costSeries.values[i]) || 0) });
        }
        const costD = buildSplinePath(costPts);
        parts.push(`<path d="${costD}" fill="none" stroke="#d3869b" stroke-width="3" stroke-dasharray="4 3" filter="url(#tc-glow)"></path>`);
        costPts.forEach(p => {
            parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#fabd2f" stroke="#d3869b" stroke-width="2"></circle>`);
        });
    }

    // Baseline
    parts.push(`<line class="tc-axis-line" x1="${PAD.left}" y1="${baseY}" x2="${(PAD.left + plotW)}" y2="${baseY}"></line>`);

    // X Axis Labels
    const labelStep = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotW / MIN_LABEL_SPACING))));
    for (let i = 0; i < count; i++) {
        if (i % labelStep !== 0 && i !== count - 1) continue;
        const center = xForCenter(i);
        parts.push(`<text class="tc-axis-label" x="${center.toFixed(1)}" y="${(baseY + 18)}" text-anchor="middle">${escapeText(labels[i])}</text>`);
    }

    // Crosshair Guide Line (Hidden by default)
    parts.push(`<line id="tc-crosshair" class="tc-crosshair-line hidden" x1="0" y1="${PAD.top}" x2="0" y2="${baseY}"></line>`);

    // Transparent hover hit targets
    for (let i = 0; i < count; i++) {
        const x = PAD.left + groupW * i;
        parts.push(`<rect class="tc-bar-hit" data-idx="${i}" x="${x.toFixed(1)}" y="${PAD.top}" width="${groupW.toFixed(1)}" height="${plotH}"></rect>`);
    }

    parts.push('</svg>');

    // Legend
    const legendItems = [
        { name: 'Inputted', color: '#74d2e7' },
        { name: 'Outputted', color: '#b8bb26' }
    ];
    if (chartType === 'combo' && costSeries) {
        legendItems.push({ name: 'Cost Trend', color: '#d3869b', isLine: true });
    }
    container.appendChild(buildLegend(legendItems));

    const surface = document.createElement('div');
    surface.className = 'tc-chart-wrap';
    surface.innerHTML = parts.join('');

    const tooltip = document.createElement('div');
    tooltip.className = 'tc-chart-tooltip';
    tooltip.style.display = 'none';
    surface.appendChild(tooltip);

    const svg = surface.querySelector('svg');
    const crosshair = surface.querySelector('#tc-crosshair');

    if (svg) {
        svg.addEventListener('mousemove', (e) => {
            const hit = e.target.closest('.tc-bar-hit');
            if (!hit) {
                tooltip.style.display = 'none';
                if (crosshair) crosshair.classList.add('hidden');
                return;
            }
            const idx = Number(hit.getAttribute('data-idx'));
            if (!Number.isFinite(idx) || idx < 0 || idx >= count) {
                tooltip.style.display = 'none';
                if (crosshair) crosshair.classList.add('hidden');
                return;
            }

            const inVal = Number(series[0]?.values[idx]) || 0;
            const outVal = Number(series[1]?.values[idx]) || 0;
            const totVal = inVal + outVal;
            const costVal = costSeries ? (Number(costSeries.values[idx]) || 0) : null;

            const lines = [`<div class="tc-tip-title">${escapeText(labels[idx])}</div>`];
            lines.push(`<div class="tc-tip-row"><span>Total Tokens:</span><span class="tc-tip-value font-bold">${totVal.toLocaleString()}</span></div>`);
            lines.push(`<div class="tc-tip-row"><span class="tc-legend-swatch" style="background-color:#74d2e7"></span><span>Input:</span><span class="tc-tip-value text-gb-blueAccent">${inVal.toLocaleString()}</span></div>`);
            lines.push(`<div class="tc-tip-row"><span class="tc-legend-swatch" style="background-color:#b8bb26"></span><span>Output:</span><span class="tc-tip-value text-gb-greenAccent">${outVal.toLocaleString()}</span></div>`);
            if (costVal !== null && costVal > 0) {
                lines.push(`<div class="tc-tip-row border-t border-gb-bgLight2 pt-1 mt-1"><span class="tc-legend-swatch" style="background-color:#d3869b"></span><span>Est. Cost:</span><span class="tc-tip-value text-gb-purpleAccent font-bold">${opts.formatCost ? opts.formatCost(costVal) : '$' + costVal.toFixed(3)}</span></div>`);
            }
            tooltip.innerHTML = lines.join('');

            const rect = surface.getBoundingClientRect();
            const localX = e.clientX - rect.left;
            const localY = e.clientY - rect.top;
            tooltip.style.display = 'block';

            const tipW = tooltip.offsetWidth || 160;
            const left = Math.max(4, Math.min(localX + 16, rect.width - tipW - 4));
            tooltip.style.left = left + 'px';
            tooltip.style.top = Math.max(4, localY - 14) + 'px';

            if (crosshair) {
                const cx = xForCenter(idx);
                crosshair.setAttribute('x1', cx.toFixed(1));
                crosshair.setAttribute('x2', cx.toFixed(1));
                crosshair.classList.remove('hidden');
            }
        });

        svg.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
            if (crosshair) crosshair.classList.add('hidden');
        });
    }

    container.appendChild(surface);
}
