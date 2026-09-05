/**
 * Dependency-free grouped bar chart, rendered as inline SVG.
 *
 * Deliberately not Chart.js: this is a local-first tool that already loads
 * four CDN scripts, and a ~200 line renderer in the app's own palette costs
 * less than another remote dependency that breaks offline.
 *
 * The SVG carries no per-bar handlers. One delegated mousemove on the root
 * drives the tooltip, so a re-render never leaks listeners.
 */

// A pathological history could produce an unbounded bucket count. The caller
// already windows its data; this is the backstop.
const MAX_BUCKETS = 120;
const PAD = { left: 58, right: 14, top: 16, bottom: 38 };
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

/** Rounds up to the next 1/2/2.5/5 x 10^n, so axis ticks read cleanly. */
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

function buildLegend(series) {
    const legend = document.createElement('div');
    legend.className = 'tc-legend';
    series.forEach(s => {
        const item = document.createElement('span');
        item.className = 'tc-legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'tc-legend-swatch';
        swatch.style.backgroundColor = s.color;
        item.appendChild(swatch);
        const label = document.createElement('span');
        label.textContent = s.name;
        item.appendChild(label);
        legend.appendChild(item);
    });
    return legend;
}

/**
 * options: { labels: string[], series: [{name, color, values:number[]}],
 *            height?: number, emptyMessage?: string, formatValue?: fn }
 */
export function renderBarChart(container, options) {
    if (!container) return;
    const opts = options || {};
    const formatValue = typeof opts.formatValue === 'function'
        ? opts.formatValue
        : (v) => (Number(v) || 0).toLocaleString();

    container.innerHTML = '';

    let labels = Array.isArray(opts.labels) ? opts.labels : [];
    let series = Array.isArray(opts.series) ? opts.series.filter(s => s && Array.isArray(s.values)) : [];

    if (labels.length === 0 || series.length === 0) {
        renderEmpty(container, opts.emptyMessage || 'No usage recorded in this window.');
        return;
    }

    if (labels.length > MAX_BUCKETS) {
        const start = labels.length - MAX_BUCKETS;
        labels = labels.slice(start);
        series = series.map(s => Object.assign({}, s, { values: s.values.slice(start) }));
    }

    const count = labels.length;
    let maxValue = 0;
    series.forEach(s => {
        for (let i = 0; i < count; i++) {
            const v = Number(s.values[i]) || 0;
            if (v > maxValue) maxValue = v;
        }
    });

    if (maxValue <= 0) {
        container.appendChild(buildLegend(series));
        renderEmpty(container, opts.emptyMessage || 'No usage recorded in this window.');
        return;
    }

    const width = Math.max(320, container.clientWidth || 760);
    const height = opts.height || 280;
    const plotW = Math.max(40, width - PAD.left - PAD.right);
    const plotH = Math.max(40, height - PAD.top - PAD.bottom);
    const top = niceMax(maxValue);

    const groupW = plotW / count;
    const barW = Math.max(2, Math.min(16, (groupW - 6) / series.length));
    const clusterW = barW * series.length;

    const yFor = (v) => PAD.top + plotH - ((Number(v) || 0) / top) * plotH;

    const parts = [];
    parts.push('<svg class="tc-chart-svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" role="img">');

    // Gridlines and Y ticks
    for (let i = 0; i <= GRID_LINES; i++) {
        const value = (top / GRID_LINES) * i;
        const y = yFor(value);
        parts.push('<line class="tc-grid-line" x1="' + PAD.left + '" y1="' + y.toFixed(1) + '" x2="' + (PAD.left + plotW) + '" y2="' + y.toFixed(1) + '"></line>');
        parts.push('<text class="tc-axis-label" x="' + (PAD.left - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + escapeText(formatCompact(value)) + '</text>');
    }

    // Bars
    for (let i = 0; i < count; i++) {
        const center = PAD.left + groupW * i + groupW / 2;
        const startX = center - clusterW / 2;
        for (let s = 0; s < series.length; s++) {
            const value = Number(series[s].values[i]) || 0;
            const y = yFor(value);
            const barH = Math.max(value > 0 ? 1 : 0, PAD.top + plotH - y);
            if (barH <= 0) continue;
            const x = startX + barW * s;
            parts.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + barH.toFixed(1) + '" fill="' + series[s].color + '" rx="1.5"></rect>');
        }
    }

    // Baseline
    const baseY = PAD.top + plotH;
    parts.push('<line class="tc-axis-line" x1="' + PAD.left + '" y1="' + baseY + '" x2="' + (PAD.left + plotW) + '" y2="' + baseY + '"></line>');

    // X labels, thinned so dense daily views stay legible
    const labelStep = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotW / MIN_LABEL_SPACING))));
    for (let i = 0; i < count; i++) {
        if (i % labelStep !== 0 && i !== count - 1) continue;
        const center = PAD.left + groupW * i + groupW / 2;
        parts.push('<text class="tc-axis-label" x="' + center.toFixed(1) + '" y="' + (baseY + 16) + '" text-anchor="middle">' + escapeText(labels[i]) + '</text>');
    }

    // Transparent hit targets, one per group, for the delegated tooltip
    for (let i = 0; i < count; i++) {
        const x = PAD.left + groupW * i;
        parts.push('<rect class="tc-bar-hit" data-idx="' + i + '" x="' + x.toFixed(1) + '" y="' + PAD.top + '" width="' + groupW.toFixed(1) + '" height="' + plotH + '"></rect>');
    }

    parts.push('</svg>');

    container.appendChild(buildLegend(series));

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
            const hit = e.target.closest('.tc-bar-hit');
            if (!hit) {
                tooltip.style.display = 'none';
                return;
            }
            const idx = Number(hit.getAttribute('data-idx'));
            if (!Number.isFinite(idx) || idx < 0 || idx >= count) {
                tooltip.style.display = 'none';
                return;
            }

            const lines = ['<div class="tc-tip-title">' + escapeText(labels[idx]) + '</div>'];
            series.forEach(s => {
                lines.push(
                    '<div class="tc-tip-row"><span class="tc-legend-swatch" style="background-color:' + s.color + '"></span>' +
                    '<span>' + escapeText(s.name) + '</span>' +
                    '<span class="tc-tip-value">' + escapeText(formatValue(s.values[idx])) + '</span></div>'
                );
            });
            tooltip.innerHTML = lines.join('');

            const rect = surface.getBoundingClientRect();
            const localX = e.clientX - rect.left;
            const localY = e.clientY - rect.top;
            tooltip.style.display = 'block';

            const tipW = tooltip.offsetWidth || 140;
            const left = Math.max(4, Math.min(localX + 14, rect.width - tipW - 4));
            tooltip.style.left = left + 'px';
            tooltip.style.top = Math.max(4, localY - 10) + 'px';
        });

        svg.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
        });
    }

    container.appendChild(surface);
}
