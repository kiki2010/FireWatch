// scripts/activity.js
// =====================================================================
// Bloque 3 · Lógica de actividad (SIN DOM).
// Cargar DESPUÉS de harmonize.js y ANTES de script.js.
//
// Reutiliza de harmonize.js: harmonizeDetections, excludeCells,
// SENSOR_META, addDaysISO, daysBetween.
// Usa en tiempo de ejecución (definidas en script.js): fetchFirmsChunk,
// buildChunks, productForDate, pointInGeometry.
//
// IAICD = Índice de Actividad de Incendios por Celda-Día:
// nº de celdas únicas con al menos una detección (MODIS o VIIRS) ese día.
// Mide actividad espacial detectada, NO nº de incendios, superficie
// quemada ni intensidad. Es un indicador experimental: la unión de celdas
// activas no es una calibración entre sensores.
// =====================================================================

const ACTIVITY_CONFIG = {
    cellSizeKm: 1,
    defaultSensors: ['MODIS_NRT', 'VIIRS_SNPP_NRT'], // conjunto fijo (decisión Etapa 1)
    chunkDays: 5,
    provisionalDays: 2,        // últimos días: NRT todavía puede cambiar
    cacheMinAgeDays: 7,        // no se cachean tramos más recientes que esto
    maxConsecutiveErrors: 6    // corta la descarga si FIRMS falla seguido
};

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
function median(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function todayISO() {
    return new Date().toISOString().slice(0, 10);
}

// Misma latitud de referencia que usa "Comparar sensores".
function aoiReferenceLat(bounds) {
    return (bounds.south + bounds.north) / 2;
}

// ---------------------------------------------------------------------
// Caché en memoria de tramos (evita repetir consultas a FIRMS).
// Clave: producto | bounds | inicio | días. Solo se guardan respuestas
// exitosas de tramos con más de `cacheMinAgeDays` días de antigüedad.
// ---------------------------------------------------------------------
const firmsChunkCache = new Map();

function chunkCacheKey(bounds, product, chunk) {
    return [
        product, bounds.west, bounds.south, bounds.east, bounds.north,
        chunk.startDate, chunk.dayRange
    ].join('|');
}

function clearFirmsCache() {
    firmsChunkCache.clear();
}

// ---------------------------------------------------------------------
// Descarga con registro de cobertura.
//
// Estado de cada tramo:
//   ok      -> respuesta válida con detecciones
//   empty   -> respuesta válida SIN detecciones (día cubierto, actividad 0)
//   error   -> falló tras los reintentos (días NO cubiertos)
//   skipped -> no se intentó porque se cortó la descarga (NO cubiertos)
//
// Limitación: FIRMS devuelve CSV vacío tanto para "sin focos" como,
// a veces, para fechas fuera de la disponibilidad del producto. Esa
// diferencia no se puede detectar desde la respuesta; por eso cada sensor
// se pide solo desde su fecha de inicio (SENSOR_META).
// ---------------------------------------------------------------------
async function fetchFirmsRangeWithCoverage({
    bounds, geometry, sensor, startDate, endDate,
    concurrency = 3, onProgress
}) {
    const chunks = buildChunks(startDate, endDate, ACTIVITY_CONFIG.chunkDays);

    const report = chunks.map(c => ({
        startDate: c.startDate,
        dayRange: c.dayRange,
        status: 'pending',
        count: 0,
        fromCache: false,
        error: null
    }));

    const raw = new Array(chunks.length).fill(null);
    const cacheLimit = addDaysISO(todayISO(), -ACTIVITY_CONFIG.cacheMinAgeDays);

    let next = 0;
    let done = 0;
    let consecutiveErrors = 0;
    let aborted = false;

    async function worker() {
        while (!aborted && next < chunks.length) {
            const i = next++;
            const chunk = chunks[i];
            const product = productForDate(sensor, chunk.startDate);
            const key = chunkCacheKey(bounds, product, chunk);
            const chunkEnd = addDaysISO(chunk.startDate, chunk.dayRange - 1);

            try {
                let detections = firmsChunkCache.get(key);

                if (detections) {
                    report[i].fromCache = true;
                } else {
                    detections = await fetchFirmsChunk(bounds, sensor, chunk);
                    if (chunkEnd <= cacheLimit) firmsChunkCache.set(key, detections);
                }

                raw[i] = detections;
                report[i].count = detections.length;
                report[i].status = detections.length > 0 ? 'ok' : 'empty';
                consecutiveErrors = 0;

            } catch (error) {
                report[i].status = 'error';
                report[i].error = error.message;
                if (++consecutiveErrors >= ACTIVITY_CONFIG.maxConsecutiveErrors) {
                    aborted = true;
                }
            }

            done++;
            onProgress?.(done, chunks.length);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, chunks.length) }, worker)
    );

    // Los tramos no intentados quedan marcados, nunca como "cubiertos".
    for (const r of report) {
        if (r.status === 'pending') r.status = 'skipped';
    }

    // Días cubiertos = días de tramos con respuesta válida.
    const coveredDays = new Set();
    report.forEach(r => {
        if (r.status === 'ok' || r.status === 'empty') {
            for (let k = 0; k < r.dayRange; k++) {
                coveredDays.add(addDaysISO(r.startDate, k));
            }
        }
    });

    // Aplanar, filtrar por geometría exacta y quitar duplicados de borde.
    const seen = new Set();
    const detections = [];

    for (const item of raw.flat()) {
        if (!item) continue;
        if (geometry && !pointInGeometry(item.lng, item.lat, geometry)) continue;

        const key = `${item.lat},${item.lng},${item.datetime},${item.satellite}`;
        if (seen.has(key)) continue;
        seen.add(key);
        detections.push(item);
    }

    const count = s => report.filter(r => r.status === s).length;

    return {
        sensor,
        startDate,
        endDate,
        detections,
        chunks: report,
        coveredDays,
        summary: {
            total: report.length,
            ok: count('ok'),
            empty: count('empty'),
            error: count('error'),
            skipped: count('skipped'),
            fromCache: report.filter(r => r.fromCache).length,
            aborted
        }
    };
}

// Une los días cubiertos por instrumento: { MODIS: Set, VIIRS: Set }.
function coverageByInstrument(fetchResults) {
    const coverage = {};

    for (const r of fetchResults) {
        const instrument = SENSOR_META[r.sensor]?.instrument;
        if (!instrument) continue;

        coverage[instrument] ??= new Set();
        r.coveredDays.forEach(d => coverage[instrument].add(d));
    }

    return coverage;
}

// ---------------------------------------------------------------------
// SERIE DIARIA ARMONIZADA
//
// - Usa la MISMA grilla del bloque 2 (harmonizeDetections, un único
//   referenceLat y cellSizeKm).
// - Una celda-día = un grupo, sin importar cuántos sensores la vean:
//   no hay doble conteo.
// - Procedencia EXCLUSIVA: onlyModis + onlyViirs + both = iaicd.
// - iaicd = null cuando ningún instrumento tiene cobertura ese día
//   (SIN DATOS ≠ 0). iaicd = 0 solo si hubo cobertura y ninguna detección.
// - status: 'full' (todos los instrumentos cubiertos), 'partial'
//   (alguno sin cobertura: el valor es un mínimo), 'no-data'.
//
// @param detectionsBySensor { MODIS_NRT: [...], VIIRS_SNPP_NRT: [...] }
// @param coverage           { MODIS: Set<fecha>, VIIRS: Set<fecha> }
// ---------------------------------------------------------------------
function instrumentOf(d) {
    return SENSOR_META[d.sensor]?.instrument ?? String(d.instrument || '').toUpperCase();
}

function buildHarmonizedDailySeries({
    detectionsBySensor, coverage, startDate, endDate,
    referenceLat, cellSizeKm = ACTIVITY_CONFIG.cellSizeKm,
    excludeCellIds = null
}) {
    if (!detectionsBySensor || typeof detectionsBySensor !== 'object') {
        throw new TypeError('detectionsBySensor debe ser un objeto { sensor: detecciones[] }');
    }
    if (!coverage || Object.keys(coverage).length === 0) {
        throw new TypeError('coverage es obligatorio: sin él no se puede distinguir "sin datos" de "0".');
    }
    if (!startDate || !endDate || startDate > endDate) {
        throw new RangeError('Rango de fechas inválido');
    }

    // 1. Anotar el instrumento (MODIS / VIIRS) de cada detección.
    let unknownInstrument = 0;
    const annotated = [];

    for (const list of Object.values(detectionsBySensor)) {
        for (const d of list) {
            const instrument = instrumentOf(d);
            if (instrument !== 'MODIS' && instrument !== 'VIIRS') {
                unknownInstrument++;
                continue;
            }
            annotated.push({ ...d, instrument });
        }
    }

    // 2. Excluir celdas (opcional) y armonizar UNA vez sobre todo.
    const usable = excludeCellIds?.size
        ? excludeCells(annotated, excludeCellIds, referenceLat, cellSizeKm)
        : annotated;

    const groups = harmonizeDetections(usable, referenceLat, cellSizeKm);

    // 3. Clasificar cada celda-día por procedencia.
    const byDate = new Map();

    for (const g of groups) {
        if (g.date < startDate || g.date > endDate) continue;

        const m = g.byInstrument.MODIS || 0;
        const v = g.byInstrument.VIIRS || 0;
        if (m === 0 && v === 0) continue;

        let day = byDate.get(g.date);
        if (!day) {
            day = { onlyModis: 0, onlyViirs: 0, both: 0, detM: 0, detV: 0, cells: [] };
            byDate.set(g.date, day);
        }

        let code;
        if (m > 0 && v > 0) { day.both++;      code = 'B'; }
        else if (m > 0)     { day.onlyModis++; code = 'M'; }
        else                { day.onlyViirs++; code = 'V'; }

        day.detM += m;
        day.detV += v;
        day.cells.push([g.cellId, code]);
    }

    // 4. Serie continua con cobertura por día.
    const instruments = Object.keys(coverage);
    const provisionalFrom = addDaysISO(todayISO(), -ACTIVITY_CONFIG.provisionalDays);
    const series = [];
    const n = daysBetween(startDate, endDate);

    for (let i = 0; i <= n; i++) {
        const date = addDaysISO(startDate, i);
        const d = byDate.get(date);

        // Un instrumento con detecciones ese día está cubierto por definición.
        const covered = {};
        for (const inst of instruments) {
            const hasDetections = d && (inst === 'MODIS' ? d.detM : d.detV) > 0;
            covered[inst] = Boolean(coverage[inst]?.has(date)) || Boolean(hasDetections);
        }

        const nCovered = instruments.filter(inst => covered[inst]).length;
        const status =
            nCovered === 0 ? 'no-data' :
            nCovered === instruments.length ? 'full' : 'partial';

        const onlyModis = d?.onlyModis ?? 0;
        const onlyViirs = d?.onlyViirs ?? 0;
        const both = d?.both ?? 0;

        series.push({
            date,
            iaicd: status === 'no-data' ? null : onlyModis + onlyViirs + both,
            onlyModis,
            onlyViirs,
            both,
            detectionsModis: d?.detM ?? 0,
            detectionsViirs: d?.detV ?? 0,
            cells: d?.cells ?? [],        // [[cellId, 'M'|'V'|'B'], ...]
            covered,
            status,
            provisional: date >= provisionalFrom
        });
    }

    return {
        series,
        meta: {
            startDate, endDate, cellSizeKm, referenceLat,
            instruments,
            groupsUsed: groups.length,
            detectionsUsed: usable.length,
            excludedByCells: annotated.length - usable.length,
            unknownInstrument,
            daysFull: series.filter(s => s.status === 'full').length,
            daysPartial: series.filter(s => s.status === 'partial').length,
            daysNoData: series.filter(s => s.status === 'no-data').length,
            definition:
                'IAICD = celdas únicas con actividad por día (MODIS ∪ VIIRS). ' +
                'Indicador experimental: no es nº de incendios, superficie ni intensidad, ' +
                'y no es una calibración entre sensores. Depende del tamaño de celda y del AOI.'
        }
    };
}

// ---------------------------------------------------------------------
// ORQUESTADOR (descarga ambos sensores y arma la serie).
// Cada sensor se pide desde su propia fecha de inicio: los días previos
// quedan SIN cobertura (null), no como ceros.
// ---------------------------------------------------------------------
async function runActivityPipeline({
    bounds, geometry, startDate, endDate,
    sensors = ACTIVITY_CONFIG.defaultSensors,
    cellSizeKm = ACTIVITY_CONFIG.cellSizeKm,
    excludeCellIds = null,
    onProgress
}) {
    const today = todayISO();
    const notes = [];

    if (!bounds || !startDate || !endDate || startDate > endDate) {
        throw new RangeError('Revisá el AOI y las fechas.');
    }
    if (endDate > today) {
        endDate = today;
        notes.push(`Fecha fin ajustada a hoy (${today}).`);
    }

    const fetchResults = [];
    const detectionsBySensor = {};

    for (const sensor of sensors) {
        const sensorStart = SENSOR_META[sensor]?.startDate;
        const from = sensorStart && sensorStart > startDate ? sensorStart : startDate;

        if (from > endDate) {
            notes.push(`${sensor}: no existe en el rango pedido (empieza el ${sensorStart}).`);
            continue;
        }
        if (from !== startDate) {
            notes.push(`${sensor}: se pide desde ${from}; antes no hay cobertura de este sensor.`);
        }

        const result = await fetchFirmsRangeWithCoverage({
            bounds, geometry, sensor, startDate: from, endDate,
            onProgress: (done, total) => onProgress?.(sensor, done, total)
        });

        fetchResults.push(result);
        detectionsBySensor[sensor] = result.detections;

        if (result.summary.error + result.summary.skipped > 0) {
            notes.push(
                `${sensor}: ${result.summary.error} tramo(s) con error y ` +
                `${result.summary.skipped} sin intentar. Esos días figuran SIN DATOS.`
            );
        }
    }

    const coverage = coverageByInstrument(fetchResults);
    if (Object.keys(coverage).length === 0) {
        throw new Error('Ningún sensor tiene cobertura en el rango pedido.');
    }

    const { series, meta } = buildHarmonizedDailySeries({
        detectionsBySensor, coverage, startDate, endDate,
        referenceLat: aoiReferenceLat(bounds), cellSizeKm, excludeCellIds
    });

    return {
        series,
        meta: { ...meta, sensors, notes },
        fetchSummary: Object.fromEntries(fetchResults.map(r => [r.sensor, r.summary])),
        chunkReports: Object.fromEntries(fetchResults.map(r => [r.sensor, r.chunks]))
    };
}

// ---------------------------------------------------------------------
// AUTOTEST con datos sintéticos (no usa red).
// Uso en consola: selfTestActivity()
// ---------------------------------------------------------------------
function selfTestActivity() {
    const mk = (date, lat, lng, sensor) => ({
        date, lat, lng, sensor, instrument: SENSOR_META[sensor].instrument,
        frp: null, confidenceLevel: null
    });

    const lat0 = -31.42, lng0 = -64.50;      // celdas distintas: ≥ 4,7 km entre sí
    const detectionsBySensor = {
        MODIS_SP: [
            mk('2024-01-01', lat0, lng0, 'MODIS_SP'),            // celda A (ambos)
            mk('2024-01-01', lat0 + 0.05, lng0, 'MODIS_SP')      // celda B (solo MODIS)
        ],
        VIIRS_SNPP_SP: [
            mk('2024-01-01', lat0, lng0, 'VIIRS_SNPP_SP'),       // celda A (ambos)
            mk('2024-01-01', lat0, lng0, 'VIIRS_SNPP_SP'),       // 2ª detección en A
            mk('2024-01-01', lat0, lng0 + 0.05, 'VIIRS_SNPP_SP') // celda C (solo VIIRS)
        ]
    };
    const coverage = {
        MODIS: new Set(['2024-01-01', '2024-01-03', '2024-01-04']),
        VIIRS: new Set(['2024-01-01', '2024-01-03'])
    };

    const { series } = buildHarmonizedDailySeries({
        detectionsBySensor, coverage,
        startDate: '2024-01-01', endDate: '2024-01-04', referenceLat: lat0
    });

    const [d1, d2, d3, d4] = series;
    const checks = [
        ['Longitud de la serie = 4', series.length === 4],
        ['Día 1: IAICD = 3 (A, B, C sin doble conteo)', d1.iaicd === 3],
        ['Día 1: 1 coincidencia (ambos)', d1.both === 1],
        ['Día 1: 1 solo MODIS y 1 solo VIIRS', d1.onlyModis === 1 && d1.onlyViirs === 1],
        ['Día 1: detecciones VIIRS brutas = 3 (≠ celdas)', d1.detectionsViirs === 3],
        ['Día 2 (sin cobertura): IAICD = null, no 0', d2.iaicd === null && d2.status === 'no-data'],
        ['Día 3 (cubierto, sin focos): IAICD = 0, full', d3.iaicd === 0 && d3.status === 'full'],
        ['Día 4 (solo MODIS cubierto): partial', d4.status === 'partial' && d4.iaicd === 0],
        ['Invariante: IAICD = onlyM + onlyV + both',
            series.every(s => s.iaicd === null || s.iaicd === s.onlyModis + s.onlyViirs + s.both)]
    ];

    console.table(checks.map(([prueba, ok]) => ({ prueba, resultado: ok ? 'OK' : 'FALLA' })));
    return checks.every(c => c[1]);
}

// =====================================================================
// ETAPA 3 · AGREGACIÓN MENSUAL Y ANUAL
// Entrada: la serie de buildHarmonizedDailySeries().series
// =====================================================================

// ---------------------------------------------------------------------
// Mensual.
// IAICD mensual = suma de los IAICD diarios (celdas-día activas).
// "uniqueCells" = celdas distintas activas en el mes (se informa aparte).
// meanDaily = IAICD mensual / días con cobertura (no / días del mes).
// ---------------------------------------------------------------------
function aggregateHarmonizedMonthly(series) {
    if (!Array.isArray(series)) {
        throw new TypeError('series debe ser el array de buildHarmonizedDailySeries()');
    }

    const instruments = series.length ? Object.keys(series[0].covered) : [];
    const byMonth = new Map();

    for (const day of series) {
        const key = day.date.slice(0, 7);
        let m = byMonth.get(key);

        if (!m) {
            const year = Number(key.slice(0, 4));
            const monthNum = Number(key.slice(5, 7));
            const expectedDays = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();

            m = {
                month: key, year, monthNum, expectedDays,
                daysInSeries: 0, daysFull: 0, daysPartial: 0, daysNoData: 0,
                daysActive: 0, iaicd: 0, maxDaily: 0,
                cellDaysOnlyModis: 0, cellDaysOnlyViirs: 0, cellDaysBoth: 0,
                provisional: false,
                dailyIaicd: new Array(expectedDays).fill(null),
                _cells: new Set(),
                _instDays: Object.fromEntries(instruments.map(i => [i, 0]))
            };
            byMonth.set(key, m);
        }

        m.daysInSeries++;
        if (day.status === 'full') m.daysFull++;
        else if (day.status === 'partial') m.daysPartial++;
        else m.daysNoData++;

        if (day.provisional) m.provisional = true;

        for (const inst of instruments) {
            if (day.covered[inst]) m._instDays[inst]++;
        }

        if (day.iaicd !== null) {
            m.iaicd += day.iaicd;
            m.maxDaily = Math.max(m.maxDaily, day.iaicd);
            if (day.iaicd > 0) m.daysActive++;
            m.cellDaysOnlyModis += day.onlyModis;
            m.cellDaysOnlyViirs += day.onlyViirs;
            m.cellDaysBoth += day.both;
            for (const [cellId] of day.cells) m._cells.add(cellId);
        }

        m.dailyIaicd[Number(day.date.slice(8, 10)) - 1] = day.iaicd;
    }

    return [...byMonth.values()].map(m => {
        const daysCovered = m.daysFull + m.daysPartial;
        const hasData = daysCovered > 0;

        const complete =
            m.daysInSeries === m.expectedDays &&
            m.daysFull === m.expectedDays &&
            !m.provisional;

        const state =
            !hasData ? 'no-data' :
            !complete ? 'incomplete' :
            m.iaicd === 0 ? 'complete-zero' : 'complete-active';

        const share = n => (hasData && m.iaicd > 0 ? n / m.iaicd : null);

        const sensorSet = instruments
            .filter(i => m._instDays[i] === m.expectedDays)
            .join('+');

        const { _cells, _instDays, ...rest } = m;

        return {
            ...rest,
            daysCovered,
            complete,
            state,
            sensorSet,
            iaicd: hasData ? m.iaicd : null,
            maxDaily: hasData ? m.maxDaily : null,
            meanDaily: hasData ? m.iaicd / daysCovered : null,
            uniqueCells: hasData ? _cells.size : null,

            // Procedencia EXCLUSIVA: las tres suman 100% del IAICD.
            shareOnlyModis: share(m.cellDaysOnlyModis),
            shareOnlyViirs: share(m.cellDaysOnlyViirs),
            shareBoth: share(m.cellDaysBoth),
            coincidences: m.cellDaysBoth,

            // Presencia por instrumento (se solapan; no suman 100%).
            cellDaysWithModis: m.cellDaysOnlyModis + m.cellDaysBoth,
            cellDaysWithViirs: m.cellDaysOnlyViirs + m.cellDaysBoth
        };
    });
}

// ---------------------------------------------------------------------
// Anual. El total "iaicdCompleteMonths" suma SOLO meses completos.
// "comparable" es true únicamente si los 12 meses están completos.
// ---------------------------------------------------------------------
function aggregateHarmonizedAnnual(series, monthly) {
    const cellsByYear = new Map();

    for (const day of series) {
        if (day.iaicd === null) continue;
        const year = Number(day.date.slice(0, 4));
        if (!cellsByYear.has(year)) cellsByYear.set(year, new Set());
        for (const [cellId] of day.cells) cellsByYear.get(year).add(cellId);
    }

    const byYear = new Map();

    for (const m of monthly) {
        let y = byYear.get(m.year);
        if (!y) {
            y = {
                year: m.year,
                monthsComplete: 0, monthsIncomplete: 0, monthsNoData: 0,
                iaicdObserved: 0, iaicdCompleteMonths: 0,
                daysActive: 0, maxDaily: null
            };
            byYear.set(m.year, y);
        }

        if (m.state === 'no-data') { y.monthsNoData++; continue; }

        if (m.complete) {
            y.monthsComplete++;
            y.iaicdCompleteMonths += m.iaicd;
        } else {
            y.monthsIncomplete++;
        }

        y.iaicdObserved += m.iaicd;
        y.daysActive += m.daysActive;
        y.maxDaily = y.maxDaily === null ? m.maxDaily : Math.max(y.maxDaily, m.maxDaily);
    }

    return [...byYear.values()]
        .sort((a, b) => a.year - b.year)
        .map(y => ({
            ...y,
            uniqueCells: cellsByYear.get(y.year)?.size ?? null,
            comparable: y.monthsComplete === 12
        }));
}

// ---------------------------------------------------------------------
// AUTOTEST (sin red). Uso en consola: selfTestMonthly()
// ---------------------------------------------------------------------
function selfTestMonthly() {
    const mkSeries = (startDate, endDate, overrides = {}) => {
        const out = [];
        const n = daysBetween(startDate, endDate);

        for (let i = 0; i <= n; i++) {
            const date = addDaysISO(startDate, i);
            const o = overrides[date] || {};
            const cells = o.cells || [];
            const noData = o.noData === true;

            out.push({
                date,
                iaicd: noData ? null : cells.length,
                onlyModis: cells.filter(c => c[1] === 'M').length,
                onlyViirs: cells.filter(c => c[1] === 'V').length,
                both: cells.filter(c => c[1] === 'B').length,
                detectionsModis: 0, detectionsViirs: 0,
                cells,
                covered: { MODIS: !noData, VIIRS: !noData },
                status: noData ? 'no-data' : 'full',
                provisional: false
            });
        }
        return out;
    };

    const ov = {
        '2024-01-05': { cells: [['c1', 'B'], ['c2', 'M'], ['c3', 'V']] },
        '2024-01-06': { cells: [['c1', 'M'], ['c5', 'V']] }
    };
    for (let d = 10; d <= 12; d++) ov[`2024-03-${d}`] = { noData: true };
    for (let d = 1; d <= 30; d++) ov[`2024-04-${String(d).padStart(2, '0')}`] = { noData: true };

    const series = mkSeries('2024-01-01', '2024-04-30', ov);
    const [jan, feb, mar, apr] = aggregateHarmonizedMonthly(series);
    const annual = aggregateHarmonizedAnnual(series, [jan, feb, mar, apr]);

    const shortJan = aggregateHarmonizedMonthly(mkSeries('2024-01-20', '2024-01-31'))[0];

    const checks = [
        ['Ene: IAICD = 5 y días activos = 2', jan.iaicd === 5 && jan.daysActive === 2],
        ['Ene: máxima diaria = 3', jan.maxDaily === 3],
        ['Ene: celdas únicas = 4 (c1 repetida no se duplica)', jan.uniqueCells === 4],
        ['Ene: 1 coincidencia; promedio = 5/31', jan.coincidences === 1 && Math.abs(jan.meanDaily - 5 / 31) < 1e-9],
        ['Ene: procedencia exclusiva suma 100%',
            Math.abs(jan.shareOnlyModis + jan.shareOnlyViirs + jan.shareBoth - 1) < 1e-9],
        ['Ene: completo con actividad, sensorSet = MODIS+VIIRS',
            jan.state === 'complete-active' && jan.complete && jan.sensorSet === 'MODIS+VIIRS'],
        ['Ene: dailyIaicd[4] = 3 y dailyIaicd[0] = 0', jan.dailyIaicd[4] === 3 && jan.dailyIaicd[0] === 0],
        ['Feb (bisiesto): 29 días, completo con actividad 0',
            feb.expectedDays === 29 && feb.state === 'complete-zero' && feb.iaicd === 0],
        ['Mar: incompleto (3 días sin datos), IAICD 0 sobre 28 días cubiertos',
            mar.state === 'incomplete' && mar.daysNoData === 3 && mar.iaicd === 0 && mar.daysCovered === 28],
        ['Abr: sin datos -> IAICD null (no 0)',
            apr.state === 'no-data' && apr.iaicd === null && apr.meanDaily === null],
        ['Rango parcial (20-31 ene): mes incompleto, 12 días',
            shortJan.state === 'incomplete' && shortJan.daysInSeries === 12],
        ['Anual 2024: 2 completos, 1 incompleto, 1 sin datos',
            annual[0].monthsComplete === 2 && annual[0].monthsIncomplete === 1 && annual[0].monthsNoData === 1],
        ['Anual 2024: total de meses completos = 5, celdas únicas = 4, no comparable',
            annual[0].iaicdCompleteMonths === 5 && annual[0].uniqueCells === 4 && annual[0].comparable === false]
    ];

    console.table(checks.map(([prueba, ok]) => ({ prueba, resultado: ok ? 'OK' : 'FALLA' })));
    return checks.every(c => c[1]);
}