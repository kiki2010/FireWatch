// scripts/calendar-ui.js
// =====================================================================
// Bloque 3 · Etapas 5, 6 y 7 · Calendario histórico de actividad.
// Cargar DESPUÉS de activity.js y script.js (ya está así en index.html).
//
// Usa de activity.js: runActivityPipeline, aggregateHarmonizedMonthly,
//   aggregateHarmonizedAnnual, annotateHistorical, evaluateSensorOverlap,
//   ANOMALY_CATEGORY_LABELS, HISTORICAL_CONFIG, ACTIVITY_CONFIG, todayISO.
// Usa de script.js: selectedPayload, map, escapeHTML.
// Usa de harmonize.js: addDaysISO, daysBetween.
// =====================================================================
(() => {
    'use strict';

    const $ = id => document.getElementById(id);

    const els = {
        start: $('calStart'), end: $('calEnd'), estimate: $('calEstimate'),
        generate: $('calGenerate'), open: $('calOpen'), status: $('calStatus'),
        drawer: $('actDrawer'), close: $('actClose'), banner: $('actBanner'),
        table: $('actCalendar'), legend: $('actLegend'), detail: $('actDetail'),
        minYears: $('actMinYears'), refMode: $('actRefMode'),
        below: $('actBelow'), above: $('actAbove'), exceptional: $('actExceptional'),
        paramsMsg: $('actParamsMsg'),
        chart: $('actChart'), chartLegend: $('actChartLegend'), summary: $('actSummary'),
        exportBtn: $('actExport'), calImport: $('calImport'), calImportFile: $('calImportFile')
    };

    if (!els.generate || !els.drawer || !els.table) {
        console.warn('[FireWatch] Falta el HTML del calendario (ver index.html, inserciones A y B).');
        return;
    }

    // -----------------------------------------------------------------
    // Constantes de presentación
    // -----------------------------------------------------------------
    const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
        'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

    // Secuencial YlOrBr (ColorBrewer, apta para daltonismo).
    const PALETTE = ['#ffffd4', '#fed98e', '#fe9929', '#d95f0e', '#993404'];

    const ANOMALY_COLORS = {
        below:       { bg: '#6baed6', fg: '#08306b' },
        normal:      { bg: '#e5e7eb', fg: '#111827' },
        above:       { bg: '#fdae61', fg: '#111827' },
        exceptional: { bg: '#a50026', fg: '#ffffff' }
    };

    const STATE_LABEL = {
        'complete-active': 'Mes completo con actividad',
        'complete-zero': 'Mes completo sin actividad detectada',
        'incomplete': 'Mes incompleto (valor mínimo observado)',
        'no-data': 'Sin datos disponibles'
    };

    const state = {
        annual: [], monthly: [], rows: [], scale: null, params: null,
        mode: 'activity', selected: null,
        source: null,
        cacheKey: null, cached: null, busy: false, lastFocus: null
    };

    // -----------------------------------------------------------------
    // Formato
    // -----------------------------------------------------------------
    const nf = new Intl.NumberFormat('es-AR');
    const esc = v => (typeof escapeHTML === 'function' ? escapeHTML(v) : String(v ?? ''));
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    const fmtN = v => (Number.isFinite(v) ? nf.format(v) : 'N/D');
    const fmtDec = (v, d = 1) => (Number.isFinite(v)
        ? v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d }) : 'N/D');
    const fmtShare = v => (Number.isFinite(v) ? `${(v * 100).toFixed(0)} %` : 'N/D');
    const fmtSigned = v => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${nf.format(Math.round(v * 10) / 10)}` : 'N/D');
    const fmtAnom = v => (Number.isFinite(v)
        ? `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')} %` : 'No calculada');
    const compact = n => (n >= 10000 ? `${Math.round(n / 1000)}k`
        : n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : String(n));

    // Techo "redondo" para ejes (1, 2, 5 x 10^n).
    function niceMax(v) {
        const p = 10 ** Math.floor(Math.log10(v));
        const f = v / p;
        return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
    }
    const fmtTick = v => (Number.isInteger(v) ? nf.format(v) : v.toFixed(1).replace('.', ','));

    function setStatus(text, empty = false) {
        els.status.textContent = text;
        els.status.classList.toggle('empty', empty);
    }

    // -----------------------------------------------------------------
    // Escala de actividad: 5 clases por cuantiles de los meses cargados
    // (con valor > 0). Es una escala relativa al AOI y al período cargado.
    // -----------------------------------------------------------------
    function buildActivityScale(rows) {
        const vals = rows.filter(r => r.iaicd > 0).map(r => r.iaicd).sort((a, b) => a - b);
        if (!vals.length) return null;

        const max = vals[vals.length - 1];
        const q = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
        const t = [...new Set([0.2, 0.4, 0.6, 0.8].map(q))].filter(v => v < max);
        const nBins = t.length + 1;

        const paletteIdx = bin => (nBins === 1 ? 2 : Math.round(bin * (PALETTE.length - 1) / (nBins - 1)));

        return {
            nBins,
            binOf: v => t.filter(x => v > x).length,
            colorOf: bin => {
                const i = paletteIdx(bin);
                return { bg: PALETTE[i], fg: i >= 3 ? '#ffffff' : '#111827' };
            },
            label: bin => {
                if (nBins === 1) return `${vals[0]}–${max}`;
                if (bin === 0) return `1–${t[0]}`;
                if (bin === nBins - 1) return `más de ${t[t.length - 1]}`;
                return `${t[bin - 1] + 1}–${t[bin]}`;
            }
        };
    }

    // -----------------------------------------------------------------
    // Parámetros de anomalía (desde el panel)
    // -----------------------------------------------------------------
    function readParams() {
        const p = {
            minReferenceYears: Number(els.minYears.value),
            referenceMode: els.refMode.value,
            thresholds: {
                belowPct: Number(els.below.value),
                abovePct: Number(els.above.value),
                exceptionalPct: Number(els.exceptional.value)
            }
        };
        const t = p.thresholds;
        const ok = Number.isInteger(p.minReferenceYears) && p.minReferenceYears >= 3 &&
            [t.belowPct, t.abovePct, t.exceptionalPct].every(Number.isFinite) &&
            t.belowPct < t.abovePct && t.abovePct < t.exceptionalPct;
        return ok ? p : null;
    }

    function recompute() {
        if (!state.monthly.length) return;

        const params = readParams();
        if (!params) {
            els.paramsMsg.textContent =
                'Parámetros inválidos (mínimo 3 años y umbrales crecientes). Se mantienen los anteriores.';
            return;
        }
        els.paramsMsg.textContent = '';

        state.params = params;
        state.rows = annotateHistorical(state.monthly, params);
        render();
    }

    // -----------------------------------------------------------------
    // Render: banner, calendario, leyenda, detalle
    // -----------------------------------------------------------------
    function renderBanner() {
        const s = state.source;
        if (!s) { els.banner.hidden = true; return; }

        els.banner.className = 'act-banner';
        const range = s.start ? ` · período ${esc(s.start)} → ${esc(s.end)}` : '';
        const b = s.bounds;
        const aoi = b ? ` · AOI ${esc(`${b.west}, ${b.south}, ${b.east}, ${b.north}`)}` : '';
        let html;

        if (s.synthetic) {
            els.banner.classList.add('act-banner--synthetic');
            html = 'DATOS SINTÉTICOS DE PRUEBA' + (s.imported ? ' (cargados desde un archivo)' : '') +
                   ': generados para probar la interfaz. No son observaciones de NASA FIRMS.';
        } else if (s.imported) {
            html = `Datos importados de un archivo de FireWatch generado el ${esc(s.generatedAt ?? 'fecha desconocida')}. ` +
                   `Fuente declarada: ${esc(s.sourceText || 'no indicada')}${aoi}${range}. ` +
                   'No corresponde necesariamente al área dibujada ahora.';
        } else {
            html = `Fuente: NASA FIRMS · ${esc(ACTIVITY_CONFIG.defaultSensors.join(' + '))}${aoi}${range}.`;

            const failed = Object.entries(s.fetchSummary || {})
                .filter(([, x]) => x.error + x.skipped > 0);
            if (failed.length) {
                els.banner.classList.add('act-banner--warn');
                html += ' <b>Descarga incompleta:</b> ' + failed.map(([k, x]) =>
                    `${esc(k)} (${x.error} con error, ${x.skipped} sin intentar)`).join('; ') +
                    '. Esos días figuran SIN DATOS.';
            }
            if (s.notes?.length) html += '<br>' + s.notes.map(esc).join('<br>');
        }

        const inc = state.rows.filter(r => r.state === 'incomplete').length;
        const nod = state.rows.filter(r => r.state === 'no-data').length;
        if (inc || nod) {
            html += `<br>${inc} mes(es) incompleto(s) y ${nod} sin datos: no entran en ninguna referencia histórica.`;
        }

        els.banner.innerHTML = html;
        els.banner.hidden = false;
    }

    function cellView(r) {
        if (r.iaicd === null) return { cls: 'nodata', style: '', text: '—' };

        let cls = '';
        let style = '';

        if (state.mode === 'anomaly') {
            const cat = r.historical?.category;
            if (cat) {
                const c = ANOMALY_COLORS[cat];
                style = `background:${c.bg};color:${c.fg}`;
            } else {
                cls = 'noref';
            }
        } else if (r.iaicd === 0) {
            cls = 'zero';
        } else if (state.scale) {
            const c = state.scale.colorOf(state.scale.binOf(r.iaicd));
            style = `background:${c.bg};color:${c.fg}`;
        }

        return { cls, style, text: compact(r.iaicd) + (r.state === 'incomplete' ? '*' : '') };
    }

    function ariaLabel(r) {
        let s = `${cap(MONTHS_LONG[r.monthNum - 1])} ${r.year}: ${STATE_LABEL[r.state]}`;
        if (r.iaicd !== null) s += `, IAICD ${r.iaicd}`;

        const h = r.historical;
        if (h?.category) s += `, ${ANOMALY_CATEGORY_LABELS[h.category]}`;
        else if (r.iaicd !== null) s += ', sin comparación histórica';
        return s;
    }

    function renderCalendar() {
        if (!state.rows.length) {
            els.table.innerHTML =
                '<p class="act-empty">Todavía no hay calendario. Dibujá un área y usá “Generar calendario”.</p>';
            return;
        }

        state.scale = buildActivityScale(state.rows);

        const byKey = new Map(state.rows.map(r => [r.month, r]));
        const years = state.rows.map(r => r.year);
        const y0 = Math.min(...years);
        const y1 = Math.max(...years);

        const head = MONTHS_SHORT.map(m => `<th scope="col">${m}</th>`).join('');
        let body = '';

        for (let y = y0; y <= y1; y++) {
            let cells = '';

            for (let m = 1; m <= 12; m++) {
                const key = `${y}-${String(m).padStart(2, '0')}`;
                const r = byKey.get(key);

                if (!r) {
                    cells += '<td><span class="act-cell--out" aria-hidden="true"></span></td>';
                    continue;
                }

                const v = cellView(r);
                const cls = ['act-cell',
                    v.cls && `act-cell--${v.cls}`,
                    r.state === 'incomplete' && 'act-cell--incomplete',
                    state.selected === key && 'act-cell--selected'
                ].filter(Boolean).join(' ');

                cells += `<td><button type="button" class="${cls}" style="${v.style}"
                    data-month="${key}" aria-pressed="${state.selected === key}"
                    aria-label="${esc(ariaLabel(r))}" title="${esc(ariaLabel(r))}">${esc(v.text)}</button></td>`;
            }

            body += `<tr><th scope="row">${y}</th>${cells}</tr>`;
        }

        els.table.innerHTML =
            `<table class="act-table"><caption class="act-hint">Cada celda es un mes. Número = IAICD mensual ` +
            `(* = mes incompleto, valor mínimo observado).</caption>` +
            `<thead><tr><th scope="col"><span class="act-hint">Año</span></th>${head}</tr></thead>` +
            `<tbody>${body}</tbody></table>`;
    }

    function swatch(extraClass, style) {
        return `<span class="act-swatch ${extraClass}" style="${style}"></span>`;
    }

    function renderLegend() {
        if (!state.rows.length) { els.legend.innerHTML = ''; return; }

        const items = [];
        let title;

        if (state.mode === 'activity') {
            title = 'Actividad mensual (IAICD). Escala por cuantiles de los meses cargados: es relativa a esta área y período.';
            const sc = state.scale;

            if (sc) {
                for (let b = 0; b < sc.nBins; b++) {
                    const c = sc.colorOf(b);
                    items.push(`${swatch('', `background:${c.bg}`)}${esc(sc.label(b))}`);
                }
            }
            items.push(`${swatch('act-cell--zero', '')}0 · mes completo sin actividad detectada`);
        } else {
            const t = state.params?.thresholds ?? HISTORICAL_CONFIG.thresholds;
            title = 'Anomalía respecto de la mediana histórica del mismo mes. Categorías definidas por FireWatch, no oficiales de NASA.';

            const rng = {
                below: `menor que ${t.belowPct} %`,
                normal: `${t.belowPct} % a +${t.abovePct} %`,
                above: `+${t.abovePct} % a +${t.exceptionalPct} %`,
                exceptional: `mayor que +${t.exceptionalPct} %`
            };

            for (const cat of ['below', 'normal', 'above', 'exceptional']) {
                items.push(`${swatch('', `background:${ANOMALY_COLORS[cat].bg}`)}` +
                    `${esc(ANOMALY_CATEGORY_LABELS[cat])} (${esc(rng[cat])})`);
            }
            items.push(`${swatch('act-cell--noref', '')}Sin referencia suficiente: anomalía no calculada`);
        }

        items.push(`${swatch('act-cell--nodata', '')}Sin datos disponibles (no equivale a 0)`);
        items.push(`${swatch('act-cell--incomplete', 'background:#fff')}* Mes incompleto: valor mínimo observado`);

        els.legend.innerHTML =
            `<p class="act-hint"><b>${esc(title)}</b></p><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
    }

    // IAICD diario del mes con ejes (null = sin datos o fuera del período cargado).
    function dailyChart(r) {
        const vals = r.dailyIaicd;
        const top = niceMax(Math.max(1, ...vals.map(v => v ?? 0)));
        const W = 320, H = 130, padL = 32, padR = 6, padT = 8, padB = 20;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const step = plotW / vals.length;
        const bw = Math.max(2, step - 2);
        const y = v => padT + plotH - (v / top) * plotH;
        const r1 = n => Math.round(n * 10) / 10;

        let grid = '';
        for (const f of [0, 0.5, 1]) {
            const v = top * f;
            grid += `<line class="act-grid" x1="${padL}" x2="${W - padR}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>` +
                    `<text class="act-axis" x="${padL - 4}" y="${r1(y(v) + 3)}" text-anchor="end">${fmtTick(v)}</text>`;
        }

        let bars = '', ticks = '';
        vals.forEach((v, i) => {
            const x = padL + i * step + (step - bw) / 2;
            const d = i + 1;

            if (v === null) {
                bars += `<rect class="act-bar act-bar--null" x="${r1(x)}" y="${r1(padT + plotH - 4)}" width="${r1(bw)}" height="4">` +
                        `<title>Día ${d}: sin datos o fuera del período cargado</title></rect>`;
            } else {
                const h = v === 0 ? 1 : Math.max(2, (v / top) * plotH);
                bars += `<rect class="act-bar" x="${r1(x)}" y="${r1(padT + plotH - h)}" width="${r1(bw)}" height="${r1(h)}">` +
                        `<title>Día ${d}: ${v}</title></rect>`;
            }

            if (d === 1 || (d % 5 === 0 && vals.length - d >= 2) || d === vals.length) {
                ticks += `<text class="act-axis" x="${r1(x + bw / 2)}" y="${H - 6}" text-anchor="middle">${d}</text>`;
            }
        });

        const label = `IAICD diario de ${MONTHS_LONG[r.monthNum - 1]} ${r.year}; máximo ${Math.max(0, ...vals.map(v => v ?? 0))}`;
        return `<svg class="act-daily" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">` +
               `${grid}${bars}${ticks}</svg>`;
    }

    function renderDetail(r) {
        if (!r) {
            els.detail.innerHTML =
                '<p class="act-empty">Seleccioná un mes del calendario para ver sus estadísticas.</p>';
            return;
        }

        const h = r.historical;
        const title = `${cap(MONTHS_LONG[r.monthNum - 1])} ${r.year}`;
        let html = `<h3>${esc(title)}</h3>` +
                   `<p class="act-state act-state--${r.state}">${esc(STATE_LABEL[r.state])}</p>`;

        if (r.iaicd === null) {
            html += '<p>Ningún sensor tiene cobertura en este mes. <b>Sin datos no significa sin incendios.</b></p>';
            els.detail.innerHTML = html;
            return;
        }

        const min = r.state === 'incomplete' ? ' <i>(mínimo observado)</i>' : '';

        html += `<dl class="act-dl">
            <dt>Índice de actividad (IAICD)</dt><dd>${fmtN(r.iaicd)} celdas-día${min}</dd>
            <dt>Días activos</dt><dd>${fmtN(r.daysActive)} de ${fmtN(r.daysCovered)} con cobertura</dd>
            <dt>Máxima diaria</dt><dd>${fmtN(r.maxDaily)}</dd>
            <dt>Promedio diario</dt><dd>${fmtDec(r.meanDaily, 2)} (sobre días con cobertura)</dd>
            <dt>Celdas únicas activas</dt><dd>${fmtN(r.uniqueCells)}</dd>
            <dt>Sensores con cobertura total</dt><dd>${esc(r.sensorSet || r.sensorSetObserved || 'cobertura parcial')}</dd>
            <dt>Procedencia</dt><dd>solo MODIS ${fmtShare(r.shareOnlyModis)} · solo VIIRS ${fmtShare(r.shareOnlyViirs)}
                · ambos ${fmtShare(r.shareBoth)} <i>(${fmtN(r.coincidences)} coincidencias)</i></dd>
        </dl>`;

        const compared = h?.comparison === 'equivalent-days' ? ` (${h.comparedDays} días equivalentes)` : '';

        html += `<h4>Comparación histórica</h4>
        <dl class="act-dl">
            <dt>Mediana histórica</dt><dd>${h?.median === null || h?.median === undefined ? 'N/D' : fmtDec(h.median, 1) + ' celdas-día'}</dd>
            <dt>Observado${esc(compared)}</dt><dd>${fmtN(h?.observed)}</dd>
            <dt>Diferencia</dt><dd>${fmtSigned(h?.difference)}</dd>
            <dt>Anomalía</dt><dd>${fmtAnom(h?.anomalyPct)}</dd>
            <dt>Categoría</dt><dd>${h?.category ? esc(ANOMALY_CATEGORY_LABELS[h.category]) : 'No calculada'}</dd>
            <dt>Años de referencia</dt><dd>${h?.nReference ?? 0} (mínimo ${h?.minRequired ?? '—'})${
                h?.referenceYears?.length ? ': ' + esc(h.referenceYears.join(', ')) : ''}</dd>
        </dl>`;

        if (h?.reason) html += `<p class="act-warn">${esc(h.reason)}</p>`;
        if (h?.note) html += `<p class="act-warn">${esc(h.note)}</p>`;

        html += `<h4>Actividad diaria</h4>${dailyChart(r)}
            <p class="act-note">Cada barra es el IAICD de un día. Barra gris baja = sin datos.
            La anomalía es estadística; no predice incendios.</p>`;

        els.detail.innerHTML = html;
    }

    // -----------------------------------------------------------------
    // Gráfico mensual: IAICD observado (barras) vs mediana histórica (línea).
    // Sin datos = columna gris punteada; mes completo en 0 = raya negra;
    // mes incompleto = barra rayada (valor mínimo observado).
    // La mediana solo se dibuja donde hay referencia suficiente.
    // -----------------------------------------------------------------
    function renderChart() {
        if (!els.chart) return;
        if (!state.rows.length) {
            els.chart.innerHTML = '';
            if (els.chartLegend) els.chartLegend.innerHTML = '';
            return;
        }

        const rows = state.rows;
        const bw = 8, step = 10;
        const padL = 46, padR = 12, padT = 12, padB = 24;
        const H = 200, plotH = H - padT - padB;
        const W = padL + rows.length * step + padR;
        const top = niceMax(Math.max(1, ...rows.map(r => Math.max(r.iaicd ?? 0, r.historical?.median ?? 0))));
        const y = v => padT + plotH - (v / top) * plotH;
        const cx = i => padL + i * step + bw / 2;

        let grid = '';
        for (let k = 0; k <= 4; k++) {
            const v = (top * k) / 4;
            grid += `<line class="act-grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>` +
                    `<text class="act-axis" x="${padL - 5}" y="${y(v) + 3}" text-anchor="end">${fmtTick(v)}</text>`;
        }

        let bars = '', hits = '', xl = '', path = '', dots = '', open = false;

        rows.forEach((r, i) => {
            const x = padL + i * step;
            const h = r.historical;
            const med = Number.isFinite(h?.median) ? h.median : null;

            if (r.iaicd === null) {
                bars += `<rect class="act-chart-bar act-chart-bar--nodata" x="${x}" y="${padT}" width="${bw}" height="${plotH}"/>`;
            } else if (r.iaicd === 0) {
                bars += `<rect class="act-chart-bar act-chart-bar--zero" x="${x}" y="${padT + plotH - 2}" width="${bw}" height="2"/>`;
            } else {
                const bh = Math.max(2, (r.iaicd / top) * plotH);
                bars += `<rect class="act-chart-bar${r.state === 'incomplete' ? ' act-chart-bar--incomplete' : ''}" ` +
                        `x="${x}" y="${padT + plotH - bh}" width="${bw}" height="${bh}"/>`;
            }

            if (med !== null) {
                path += `${open ? 'L' : 'M'}${cx(i)},${y(med)} `;
                dots += `<circle class="act-median-dot" cx="${cx(i)}" cy="${y(med)}" r="2.5"/>`;
                open = true;
            } else {
                open = false;
            }

            if (r.monthNum === 1 || (i === 0 && r.monthNum <= 9)) {
                xl += `<line class="act-grid" x1="${x}" x2="${x}" y1="${padT + plotH}" y2="${padT + plotH + 4}"/>` +
                      `<text class="act-axis" x="${x}" y="${H - 8}">${r.year}</text>`;
            }

            const tip = `${cap(MONTHS_SHORT[r.monthNum - 1].toLowerCase())} ${r.year}: ${STATE_LABEL[r.state]}` +
                (r.iaicd !== null ? `; IAICD ${r.iaicd}` : '') +
                (med !== null ? `; mediana ${fmtDec(med, 1)}` : '') +
                (Number.isFinite(h?.anomalyPct) ? `; anomalía ${fmtAnom(h.anomalyPct)}` : '');

            hits += `<rect class="act-chart-hit${state.selected === r.month ? ' act-chart-hit--selected' : ''}" ` +
                    `data-month="${r.month}" x="${x - 1}" y="${padT}" width="${step}" height="${plotH}">` +
                    `<title>${esc(tip)}</title></rect>`;
        });

        const label = `Gráfico mensual de IAICD observado y mediana histórica, de ${rows[0].month} a ${rows[rows.length - 1].month}`;

        els.chart.innerHTML =
            `<div class="act-chart-scroll"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">` +
            `<defs><pattern id="actHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
            `<rect width="4" height="4" fill="#fff"/><rect width="2" height="4" fill="#d95f0e"/></pattern></defs>` +
            `${grid}${bars}<path class="act-median" d="${path.trim()}"/>${dots}${xl}${hits}</svg></div>`;

        if (els.chartLegend) {
            const items = [
                '<span class="act-swatch" style="background:#d95f0e"></span>Mes completo: IAICD observado',
                '<span class="act-swatch act-swatch--hatch"></span>Mes incompleto: valor mínimo observado',
                '<span class="act-swatch act-cell--nodata"></span>Sin datos (no equivale a 0)',
                '<span class="act-swatch" style="background:#111827;height:4px"></span>Mes completo sin actividad (0)',
                '<span class="act-line"></span>Mediana histórica del mismo mes (solo con referencia suficiente)'
            ];
            els.chartLegend.innerHTML =
                `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>` +
                '<p class="act-hint">Hacé clic en una columna para ver sus estadísticas. En un mes incompleto, ' +
                'la mediana corresponde a los mismos días del mes en los años de referencia.</p>';
        }

        scrollChart();
    }

    function scrollChart() {
        const sc = els.chart?.firstElementChild;
        if (sc) sc.scrollLeft = sc.scrollWidth;      // mostrar lo más reciente
    }

    // -----------------------------------------------------------------
    // Resumen del AOI: conteos, rankings, tabla anual y solapamiento.
    // -----------------------------------------------------------------
    function renderSummary() {
        if (!els.summary) return;
        if (!state.rows.length) { els.summary.innerHTML = ''; return; }

        const rows = state.rows;
        const count = s => rows.filter(r => r.state === s).length;
        const withAnomaly = rows.filter(r => r.historical?.status === 'ok').length;
        const pct = v => (Number.isFinite(v) ? `${(v * 100).toFixed(1).replace('.', ',')} %` : 'N/D');
        const ratio = v => (Number.isFinite(v) ? v.toFixed(2).replace('.', ',') : 'N/D');
        const link = (key, text) => `<button type="button" class="act-link" data-month="${esc(key)}">${esc(text)}</button>`;
        const li = arr => (arr.length
            ? `<ol>${arr.map(x => `<li>${x}</li>`).join('')}</ol>`
            : '<p class="act-empty">Sin actividad detectada.</p>');

        const topMonths = rows
            .filter(r => r.complete && r.iaicd > 0)
            .sort((a, b) => b.iaicd - a.iaicd || a.month.localeCompare(b.month))
            .slice(0, 5);

        const days = [];
        for (const r of rows) {
            r.dailyIaicd.forEach((v, i) => { if (v > 0) days.push({ month: r.month, day: i + 1, v }); });
        }
        days.sort((a, b) => b.v - a.v || a.month.localeCompare(b.month) || a.day - b.day);

        const monthsHtml = li(topMonths.map(r =>
            `${link(r.month, `${cap(MONTHS_LONG[r.monthNum - 1])} ${r.year}`)}: ${fmtN(r.iaicd)}`));
        const daysHtml = li(days.slice(0, 5).map(d =>
            `${link(d.month, `${d.day} de ${MONTHS_LONG[Number(d.month.slice(5, 7)) - 1]} de ${d.month.slice(0, 4)}`)}: ${fmtN(d.v)}`));

        const annualRows = (state.annual || []).map(a =>
            `<tr><th scope="row">${a.year}</th><td>${a.monthsComplete}</td><td>${a.monthsIncomplete}</td>` +
            `<td>${a.monthsNoData}</td><td>${fmtN(a.iaicdCompleteMonths)}</td><td>${fmtN(a.iaicdObserved)}</td>` +
            `<td>${fmtN(a.uniqueCells)}</td><td>${a.comparable ? 'Sí' : 'No'}</td></tr>`).join('');

        const annualHtml =
            `<table class="act-annual"><thead><tr><th>Año</th><th>Completos</th><th>Incompl.</th><th>Sin datos</th>` +
            `<th>IAICD (solo completos)</th><th>IAICD observado</th><th>Celdas únicas</th><th>Comparable</th></tr></thead>` +
            `<tbody>${annualRows}</tbody></table>` +
            '<p class="act-note">“Comparable” = los 12 meses completos. Solo conviene comparar totales anuales entre años comparables. ' +
            'En datos importados, las celdas únicas por año no están disponibles.</p>';

        const ov = evaluateSensorOverlap(rows);
        const sets = Object.entries(ov.setCounts).map(([k, n]) => `${esc(k)}: ${n}`).join(' · ') || 'ninguno';

        const overlapHtml = (ov.nMonths === 0
            ? '<p class="act-empty">No hay meses completos con ambos instrumentos para evaluar el solapamiento.</p>'
            : `<dl class="act-dl">
                <dt>Meses evaluados</dt><dd>${ov.nMonths} (${fmtN(ov.cellDays)} celdas-día)</dd>
                <dt>Solo MODIS</dt><dd>${pct(ov.shareOnlyModis)}</dd>
                <dt>Solo VIIRS</dt><dd>${pct(ov.shareOnlyViirs)}</dd>
                <dt>Ambos</dt><dd>${pct(ov.shareBoth)}</dd>
                <dt>Celdas-día de MODIS que VIIRS también vio</dt><dd>${pct(ov.coverageOfModisByViirs)}</dd>
                <dt>Celdas-día de VIIRS que MODIS también vio</dt><dd>${pct(ov.coverageOfViirsByModis)}</dd>
                <dt>Jaccard (celda-día)</dt><dd>${pct(ov.jaccard)}</dd>
                <dt>IAICD unión / solo MODIS</dt><dd>${ratio(ov.unionOverModis)}</dd>
                <dt>Correlación mensual MODIS vs VIIRS</dt><dd>${ratio(ov.correlationMonthly)}</dd>
            </dl>`) +
            `<p class="act-note">Meses completos por conjunto de sensores: ${sets}. “Unión / solo MODIS” indica cuánto sube el índice ` +
            'al pasar de MODIS a MODIS ∪ VIIRS en este período y área: da una idea del salto en la serie, pero no es una calibración. ' +
            'Por eso las anomalías solo comparan meses con el mismo conjunto de sensores.</p>';

        els.summary.innerHTML =
            `<h3>Resumen del área</h3>` +
            `<p>${rows.length} meses cargados: ${count('complete-active')} completos con actividad, ` +
            `${count('complete-zero')} completos sin actividad detectada, ${count('incomplete')} incompletos y ` +
            `${count('no-data')} sin datos. Anomalía calculada en ${withAnomaly} mes(es).</p>` +
            `<div class="act-cols"><div><h4>Meses completos con mayor actividad</h4>${monthsHtml}</div>` +
            `<div><h4>Días con mayor actividad (IAICD diario)</h4>${daysHtml}</div></div>` +
            `<details><summary>Resumen anual</summary>${annualHtml}</details>` +
            `<details><summary>Solapamiento MODIS–VIIRS</summary>${overlapHtml}</details>`;
    }

    function render() {
        renderBanner();
        renderCalendar();
        renderLegend();
        renderChart();
        renderSummary();
        renderDetail(state.rows.find(r => r.month === state.selected));
        refreshControls();
    }

    function select(key) {
        state.selected = key;

        els.table.querySelectorAll('.act-cell--selected').forEach(b => {
            b.classList.remove('act-cell--selected');
            b.setAttribute('aria-pressed', 'false');
        });

        const btn = els.table.querySelector(`button[data-month="${key}"]`);
        if (btn) {
            btn.classList.add('act-cell--selected');
            btn.setAttribute('aria-pressed', 'true');
        }

        els.chart?.querySelectorAll('.act-chart-hit--selected')
            .forEach(n => n.classList.remove('act-chart-hit--selected'));
        els.chart?.querySelector(`[data-month="${key}"]`)?.classList.add('act-chart-hit--selected');

        renderDetail(state.rows.find(r => r.month === key));
    }

    // -----------------------------------------------------------------
    // Panel: abrir / cerrar
    // -----------------------------------------------------------------
    function openDrawer() {
        state.lastFocus = document.activeElement;
        els.drawer.hidden = false;
        scrollChart();
        els.close.focus();
    }

    function closeDrawer() {
        els.drawer.hidden = true;
        state.lastFocus?.focus?.();
    }

    // -----------------------------------------------------------------
    // Controles de la barra lateral
    // -----------------------------------------------------------------
    function hasAoi() {
        return typeof selectedPayload !== 'undefined' && Boolean(selectedPayload);
    }

    function refreshControls() {
        els.generate.disabled = !hasAoi() || state.busy;
        els.open.disabled = state.rows.length === 0;
        if (els.exportBtn) els.exportBtn.disabled = state.rows.length === 0;
    }

    function updateEstimate() {
        if (!hasAoi()) { els.estimate.textContent = ''; return; }

        const s = els.start.value;
        const e = els.end.value;
        if (!s || !e || s > e) { els.estimate.textContent = 'Revisá las fechas.'; return; }

        const days = daysBetween(s, e) + 1;
        const requests = Math.ceil(days / ACTIVITY_CONFIG.chunkDays) * ACTIVITY_CONFIG.defaultSensors.length;

        const b = selectedPayload.bounds;
        const lat = (b.north + b.south) / 2;
        const areaKm2 = (b.east - b.west) * 111.32 * Math.cos(lat * Math.PI / 180) *
                        (b.north - b.south) * 110.574;

        els.estimate.textContent =
            `≈ ${nf.format(requests)} consultas a FIRMS · área ≈ ${nf.format(Math.round(areaKm2))} km². ` +
            (requests > 150 ? 'Consulta pesada: FIRMS limita las transacciones por ventana de 10 min; usá un área chica o un período más corto.' : '');
    }

    function resetCalendar(message) {
        state.monthly = [];
        state.rows = [];
        state.annual = [];
        state.selected = null;
        state.source = null;
        if (!els.drawer.hidden) closeDrawer();
        render();
        setStatus(message ?? (hasAoi()
            ? 'Área lista. Elegí el período y generá el calendario.'
            : 'Esperando un área seleccionada'), !hasAoi());
        updateEstimate();
    }

    // -----------------------------------------------------------------
    // Generar: pipeline real -> mensual -> mediana histórica -> render
    // -----------------------------------------------------------------
    async function generate() {
        if (state.busy) return;

        if (!hasAoi()) { setStatus('Primero seleccioná un área en el mapa', true); return; }

        const payload = selectedPayload;
        const startDate = els.start.value;
        const endDate = els.end.value;

        if (!startDate || !endDate || startDate > endDate || endDate > todayISO()) {
            setStatus('Revisá las fechas: inicio ≤ fin ≤ hoy');
            return;
        }

        const requests = Math.ceil((daysBetween(startDate, endDate) + 1) / ACTIVITY_CONFIG.chunkDays) *
                         ACTIVITY_CONFIG.defaultSensors.length;
        if (requests > 150 &&
            !confirm(`Se harán ≈ ${requests} consultas a NASA FIRMS y puede tardar varios minutos. ¿Continuar?`)) {
            return;
        }

        state.busy = true;
        els.generate.textContent = 'Generando…';
        refreshControls();

        try {
            const key = JSON.stringify([payload.bounds, startDate, endDate,
                ACTIVITY_CONFIG.cellSizeKm, ACTIVITY_CONFIG.defaultSensors]);

            let result = state.cacheKey === key ? state.cached : null;

            if (result) {
                setStatus('Usando datos ya descargados (sin nuevas consultas a FIRMS).');
            } else {
                result = await runActivityPipeline({
                    bounds: payload.bounds,
                    geometry: payload.geometry,
                    startDate, endDate,
                    onProgress: (sensor, done, total) =>
                        setStatus(`Descargando ${sensor}: tramo ${done} de ${total}…`)
                });

                // Solo se cachea si no hubo errores: así un reintento vuelve a pedir lo que falló.
                const clean = Object.values(result.fetchSummary).every(x => x.error + x.skipped === 0);
                state.cacheKey = clean ? key : null;
                state.cached = clean ? result : null;
            }

            // Los resultados deben corresponder al AOI seleccionado.
            if (selectedPayload !== payload) {
                setStatus('El área cambió durante la descarga: resultado descartado.');
                return;
            }

            const monthly = aggregateHarmonizedMonthly(result.series);
            const annual = aggregateHarmonizedAnnual(result.series, monthly);
            window.act = { ...result, monthly, annual };     // para inspeccionar desde la consola

            state.monthly = monthly;
            state.annual = annual;
            state.selected = null;
            state.source = {
                synthetic: false,
                bounds: payload.bounds,
                start: result.meta.startDate,
                end: result.meta.endDate,
                notes: result.meta.notes,
                fetchSummary: result.fetchSummary
            };

            recompute();
            openDrawer();

            const incomplete = monthly.filter(m => m.state === 'incomplete' || m.state === 'no-data').length;
            setStatus(`Listo · ${monthly.length} meses · ${incomplete} incompleto(s) o sin datos`);

        } catch (error) {
            console.error('[FireWatch] Error en calendario:', error);
            setStatus(`Error: ${error.message}`);

        } finally {
            state.busy = false;
            els.generate.textContent = 'Generar calendario';
            refreshControls();
        }
    }

    // -----------------------------------------------------------------
    // Demo con datos SINTÉTICOS (para probar la interfaz sin FIRMS).
    // Se rotula siempre como sintética. Uso: FireWatchCalendar.demo()
    // -----------------------------------------------------------------
    function syntheticSeries() {
        let seed = 12345;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

        const weights = [0.2, 0.2, 0.3, 0.6, 0.9, 1, 1.6, 3, 4, 2.5, 0.8, 0.3];
        const start = '2014-01-01';
        const end = todayISO();
        const provisionalFrom = addDaysISO(end, -ACTIVITY_CONFIG.provisionalDays);

        const series = [];
        const n = daysBetween(start, end);

        for (let i = 0; i <= n; i++) {
            const date = addDaysISO(start, i);
            const y = Number(date.slice(0, 4));
            const m = Number(date.slice(5, 7));

            const noData = date.startsWith('2016-03') || (date >= '2019-07-10' && date <= '2019-07-20');

            let factor = 0.5 + ((y * 37) % 11) / 8;
            if (y === 2015 && m === 2) factor = 0;           // mes completo sin actividad
            if (y === 2020 && m === 8) factor *= 4;          // mes excepcional

            const k = noData ? 0 : Math.floor(rnd() * weights[m - 1] * factor * 4);
            const ids = new Set();
            for (let j = 0; j < k; j++) ids.add(`${Math.floor(rnd() * 60)}_${Math.floor(rnd() * 60)}`);

            const cells = [...ids].map(id => {
                const p = rnd();
                return [id, p < 0.45 ? 'M' : p < 0.8 ? 'V' : 'B'];
            });

            series.push({
                date,
                iaicd: noData ? null : cells.length,
                onlyModis: cells.filter(c => c[1] === 'M').length,
                onlyViirs: cells.filter(c => c[1] === 'V').length,
                both: cells.filter(c => c[1] === 'B').length,
                detectionsModis: 0, detectionsViirs: 0,
                cells,
                covered: { MODIS: !noData, VIIRS: !noData },
                status: noData ? 'no-data' : 'full',
                provisional: date >= provisionalFrom
            });
        }

        return series;
    }

    function demo() {
        const series = syntheticSeries();
        state.monthly = aggregateHarmonizedMonthly(series);
        state.annual = aggregateHarmonizedAnnual(series, state.monthly);
        state.selected = null;
        state.source = { synthetic: true };
        recompute();
        openDrawer();
        setStatus('Mostrando datos SINTÉTICOS de prueba', false);
    }

    // -----------------------------------------------------------------
    // Eventos
    // -----------------------------------------------------------------
    els.table.addEventListener('click', e => {
        const btn = e.target.closest('button[data-month]');
        if (btn) select(btn.dataset.month);
    });

    document.querySelectorAll('input[name="actMode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            state.mode = radio.value;
            render();
        });
    });

    [els.minYears, els.refMode, els.below, els.above, els.exceptional]
        .forEach(el => el.addEventListener('change', recompute));

    els.generate.addEventListener('click', generate);
    els.open.addEventListener('click', openDrawer);
    els.close.addEventListener('click', closeDrawer);
    els.drawer.addEventListener('click', e => { if (e.target === els.drawer) closeDrawer(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !els.drawer.hidden) closeDrawer();
    });

    els.start.addEventListener('change', updateEstimate);
    els.end.addEventListener('change', updateEstimate);

    // Cambio de AOI: los handlers de script.js ya actualizaron selectedPayload.
    if (typeof map !== 'undefined' && typeof L !== 'undefined' && L.Draw) {
        [L.Draw.Event.CREATED, L.Draw.Event.EDITED, L.Draw.Event.DELETED]
            .forEach(ev => map.on(ev, () => resetCalendar()));
    }

    // -----------------------------------------------------------------
    // Clic en el gráfico o en el resumen -> selecciona el mes
    // -----------------------------------------------------------------
    function pickFrom(e) {
        const el = e.target.closest('[data-month]');
        if (!el) return;
        select(el.dataset.month);
        els.detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    els.chart?.addEventListener('click', pickFrom);
    els.summary?.addEventListener('click', pickFrom);

    // -----------------------------------------------------------------
    // Exportar / importar los resultados mensuales (con su procedencia).
    // Sirve para demostrar el calendario sin volver a descargar de FIRMS.
    // -----------------------------------------------------------------
    const NUM_FIELDS = ['year', 'monthNum', 'expectedDays', 'daysInSeries', 'daysFull', 'daysPartial',
        'daysNoData', 'daysCovered', 'daysActive', 'iaicd', 'maxDaily', 'meanDaily', 'uniqueCells',
        'shareOnlyModis', 'shareOnlyViirs', 'shareBoth', 'coincidences', 'cellDaysOnlyModis',
        'cellDaysOnlyViirs', 'cellDaysBoth', 'cellDaysWithModis', 'cellDaysWithViirs'];
    const MONTH_STATES = ['complete-active', 'complete-zero', 'incomplete', 'no-data'];
    const ISO = /^\d{4}-\d{2}-\d{2}$/;

    function exportData() {
        if (!state.monthly.length) return;

        const src = state.source || {};
        const first = state.monthly[0].month;
        const last = state.monthly[state.monthly.length - 1].month;

        const payload = {
            format: 'firewatch-monthly',
            version: 1,
            generatedAt: new Date().toISOString(),
            synthetic: Boolean(src.synthetic),
            source: src.synthetic
                ? 'Datos sintéticos de prueba (no son observaciones de NASA FIRMS)'
                : (src.sourceText || 'NASA FIRMS (MODIS + VIIRS), procesado con FireWatch'),
            aoi: src.bounds ?? null,
            period: { start: src.start ?? `${first}-01`, end: src.end ?? `${last}-01` },
            sensors: ACTIVITY_CONFIG.defaultSensors,
            cellSizeKm: ACTIVITY_CONFIG.cellSizeKm,
            monthly: state.monthly
        };

        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `firewatch-monthly_${payload.period.start}_${payload.period.end}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function validateImport(f) {
        if (!f || f.format !== 'firewatch-monthly') return 'El archivo no es una exportación de FireWatch.';
        if (f.version !== 1) return `Versión de archivo no soportada: ${f.version}.`;
        if (!Array.isArray(f.monthly) || f.monthly.length === 0) return 'El archivo no tiene meses.';
        if (f.monthly.length > 1200) return 'Demasiados meses (máximo 1200).';

        const seen = new Set();
        for (const m of f.monthly) {
            const ok = m && typeof m.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m.month) &&
                Number.isInteger(m.year) && Number.isInteger(m.monthNum) &&
                m.month === `${m.year}-${String(m.monthNum).padStart(2, '0')}` &&
                MONTH_STATES.includes(m.state) && typeof m.complete === 'boolean' &&
                m.complete === m.state.startsWith('complete') &&
                Number.isInteger(m.expectedDays) &&
                m.expectedDays === new Date(Date.UTC(m.year, m.monthNum, 0)).getUTCDate() &&
                Array.isArray(m.dailyIaicd) && m.dailyIaicd.length === m.expectedDays &&
                m.dailyIaicd.every(v => v === null || (Number.isInteger(v) && v >= 0)) &&
                (m.iaicd === null || (Number.isInteger(m.iaicd) && m.iaicd >= 0)) &&
                (m.state === 'no-data') === (m.iaicd === null) &&
                typeof m.sensorSet === 'string';

            if (!ok) return `Mes con formato inválido: ${typeof m?.month === 'string' ? m.month : '(sin nombre)'}.`;
            if (seen.has(m.month)) return `Mes duplicado: ${m.month}.`;
            seen.add(m.month);
        }
        return null;
    }

    function sanitizeMonth(m) {
        const o = {
            month: m.month, state: m.state, complete: m.complete,
            provisional: Boolean(m.provisional),
            sensorSet: m.sensorSet.slice(0, 40),
            sensorSetObserved: typeof m.sensorSetObserved === 'string' ? m.sensorSetObserved.slice(0, 40) : '',
            dailyIaicd: m.dailyIaicd.slice()
        };
        for (const k of NUM_FIELDS) o[k] = Number.isFinite(m[k]) ? m[k] : null;
        return o;
    }

    async function importData(file) {
        try {
            if (file.size > 20e6) throw new Error('Archivo demasiado grande (máximo 20 MB).');

            const f = JSON.parse(await file.text());
            const err = validateImport(f);
            if (err) throw new Error(err);

            const monthly = f.monthly.map(sanitizeMonth).sort((a, b) => a.month.localeCompare(b.month));
            const bb = f.aoi;
            const bounds = bb && ['west', 'south', 'east', 'north'].every(k => Number.isFinite(bb[k]))
                ? { west: bb.west, south: bb.south, east: bb.east, north: bb.north } : null;

            state.monthly = monthly;
            state.annual = aggregateHarmonizedAnnual([], monthly);     // sin serie diaria: celdas únicas = N/D
            state.selected = null;
            state.source = {
                imported: true,
                synthetic: Boolean(f.synthetic),
                generatedAt: typeof f.generatedAt === 'string' ? f.generatedAt.slice(0, 40) : null,
                sourceText: typeof f.source === 'string' ? f.source.slice(0, 200) : '',
                bounds,
                start: ISO.test(f.period?.start ?? '') ? f.period.start : null,
                end: ISO.test(f.period?.end ?? '') ? f.period.end : null
            };

            recompute();
            openDrawer();
            setStatus(`Datos importados: ${monthly.length} meses (desde archivo, sin consultar FIRMS)`);

        } catch (error) {
            console.error('[FireWatch] Error al importar:', error);
            setStatus(`No se pudo importar: ${error.message}`);
        }
    }

    els.exportBtn?.addEventListener('click', exportData);
    els.calImport?.addEventListener('click', () => els.calImportFile?.click());
    els.calImportFile?.addEventListener('change', async () => {
        const file = els.calImportFile.files[0];
        els.calImportFile.value = '';
        if (file) await importData(file);
    });

    // -----------------------------------------------------------------
    // Inicio
    // -----------------------------------------------------------------
    els.end.value = todayISO();
    els.end.max = todayISO();
    state.params = readParams() ?? HISTORICAL_CONFIG;
    render();
    updateEstimate();

    window.FireWatchCalendar = { demo, state };
})();