// scripts/activity.js
// =====================================================================
// Bloque 4 · Análisis temporal: lógica de actividad (SIN DOM).
// Cargar DESPUÉS de harmonize.js y ANTES de script.js.
//
// Reutiliza de harmonize.js: harmonizeDetections, excludeCells,
// findPersistentCells, SENSOR_META, addDaysISO, daysBetween, pearson.
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
    maxConsecutiveErrors: 6,   // corta la descarga si FIRMS falla seguido

    // Filtro de fuentes de calor persistentes (chimeneas, hornos, quemas
    // recurrentes). Es una decisión metodológica: documentar estos valores.
    //   minEpisodes / maxGapDays: mismo criterio que findPersistentCells
    //     (harmonize.js), aplicado dentro de CADA año.
    //   minYears: una celda se excluye solo si es persistente en al menos
    //     este número de años (o en todos, si hay menos años con datos).
    //     Con una serie de muchos años, evaluar todo el período junto
    //     marcaría como "persistente" a una celda forestal que simplemente
    //     se quemó 4 veces en una década.
    persistentFilter: { minEpisodes: 4, maxGapDays: 5, minYears: 2 }
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

// "Hoy" en UTC, a propósito: las fechas de adquisición de FIRMS (acq_date)
// son UTC, así que el último día que puede tener datos es el de hoy en UTC,
// aunque en la zona horaria del usuario todavía sea el día anterior.
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
                consecutiveErrors++;

                // Límite de transacciones de FIRMS: insistir solo empeora el bloqueo.
                const rateLimited = /transaction|l[ií]mite|inesperada|502/i.test(error.message);
                if (rateLimited || consecutiveErrors >= ACTIVITY_CONFIG.maxConsecutiveErrors) {
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
// FILTRO DE FUENTES PERSISTENTES PARA SERIES MULTIANUALES
//
// findPersistentCells (harmonize.js) cuenta "episodios" de una celda a lo
// largo de TODO lo que recibe. Pensado para comparar sensores en un año,
// aplicado a una década marcaría como persistente a cualquier celda con 4
// incendios separados. Acá se evalúa año por año: una celda se excluye solo
// si es persistente en `minYears` años distintos (o en todos los años con
// datos, si hay menos). Un incendio grande o un par de eventos aislados no
// alcanzan; una chimenea que reaparece cada año sí.
//
// Límites a declarar: un año con pocos meses cargados tiene menos
// posibilidades de alcanzar `minEpisodes` (criterio conservador), y los
// umbrales son una decisión metodológica.
//
// @param detectionSets  [detecciones[], detecciones[], ...] (uno por sensor)
// @returns { cells: Set<cellId>, yearsEvaluated, requiredYears, params }
// ---------------------------------------------------------------------
function findPersistentCellsByYear(
    detectionSets, referenceLat, cellSizeKm = ACTIVITY_CONFIG.cellSizeKm, options = {}
) {
    const cfg = { ...ACTIVITY_CONFIG.persistentFilter, ...options };

    const years = new Set();
    for (const set of detectionSets) {
        for (const d of set) {
            if (d.date) years.add(String(d.date).slice(0, 4));
        }
    }

    const requiredYears = Math.max(1, Math.min(cfg.minYears, years.size));
    const yearsByCell = new Map();       // cellId -> Set de años en que es persistente

    for (const year of years) {
        const prefix = `${year}-`;
        const slice = detectionSets.map(set =>
            set.filter(d => d.date && String(d.date).startsWith(prefix))
        );

        const flagged = findPersistentCells(slice, referenceLat, cellSizeKm, {
            minEpisodes: cfg.minEpisodes,
            maxGapDays: cfg.maxGapDays
        });

        for (const cellId of flagged) {
            if (!yearsByCell.has(cellId)) yearsByCell.set(cellId, new Set());
            yearsByCell.get(cellId).add(year);
        }
    }

    const cells = new Set();
    for (const [cellId, ys] of yearsByCell) {
        if (ys.size >= requiredYears) cells.add(cellId);
    }

    return {
        cells,
        yearsEvaluated: years.size,
        requiredYears,
        params: { minEpisodes: cfg.minEpisodes, maxGapDays: cfg.maxGapDays, minYears: cfg.minYears }
    };
}

// ---------------------------------------------------------------------
// ORQUESTADOR (descarga ambos sensores y arma la serie).
// Cada sensor se pide desde su propia fecha de inicio: los días previos
// quedan SIN cobertura (null), no como ceros.
//
// filterPersistent: si es true, excluye las celdas de fuentes persistentes
// (ver findPersistentCellsByYear) antes de armar la serie. El resultado
// informa en meta.persistentFilter = { requested, applied, cells, ... }.
// ---------------------------------------------------------------------
async function runActivityPipeline({
    bounds, geometry, startDate, endDate,
    sensors = ACTIVITY_CONFIG.defaultSensors,
    cellSizeKm = ACTIVITY_CONFIG.cellSizeKm,
    excludeCellIds = null,
    filterPersistent = false,
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
    const hasCoverage = Object.values(coverage).some(s => s.size > 0);

    if (!hasCoverage) {
        const firstError = fetchResults
            .flatMap(r => r.chunks)
            .find(c => c.status === 'error')?.error;

        throw new Error(
            'No se pudo descargar ningún tramo de FIRMS.' +
            (firstError ? ` Primer error: ${firstError}` : ' Revisá el rango y los sensores.')
        );
    }

    const referenceLat = aoiReferenceLat(bounds);

    // Celdas a excluir: las que pasó el llamador + (opcional) las persistentes.
    let excluded = excludeCellIds ? new Set(excludeCellIds) : null;
    let persistentFilter = { requested: Boolean(filterPersistent), applied: false, cells: 0 };

    if (filterPersistent) {
        const found = findPersistentCellsByYear(
            Object.values(detectionsBySensor), referenceLat, cellSizeKm
        );

        excluded = new Set([...(excluded ?? []), ...found.cells]);
        persistentFilter = {
            requested: true,
            applied: true,                       // el filtro corrió (aunque no halle celdas)
            cells: found.cells.size,
            cellIds: [...found.cells].sort().slice(0, 500),   // trazabilidad (tope 500)
            yearsEvaluated: found.yearsEvaluated,
            requiredYears: found.requiredYears,
            params: found.params
        };
    }

    const { series, meta } = buildHarmonizedDailySeries({
        detectionsBySensor, coverage, startDate, endDate,
        referenceLat, cellSizeKm, excludeCellIds: excluded
    });

    return {
        series,
        meta: { ...meta, sensors, notes, persistentFilter },
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
            // Instrumentos con cobertura en TODOS los días presentes en la serie
            // (sirve para meses incompletos y para el mes en curso).
            sensorSetObserved: instruments
                .filter(i => _instDays[i] === m.daysInSeries)
                .join('+'),
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

// =====================================================================
// ETAPA 4 · MEDIANA HISTÓRICA Y ANOMALÍAS
// Entrada: filas de aggregateHarmonizedMonthly().
//
// Reglas:
// - La referencia de un mes usa SOLO el mismo mes de otros años, con mes
//   completo y el MISMO conjunto de sensores (evita discontinuidades).
// - El año analizado nunca entra en su propia referencia.
// - Mes incompleto / en curso: se comparan los MISMOS días del mes en los
//   años de referencia (y el resultado se marca provisional).
// - Sin suficientes años, o con mediana 0, no se inventa un porcentaje.
// - Es una anomalía ESTADÍSTICA respecto de los años cargados.
//   No es una predicción de incendios.
// =====================================================================
const HISTORICAL_CONFIG = {
    minReferenceYears: 5,
    // 'previous'  : solo años anteriores al analizado (por defecto).
    // 'all-other' : todos los demás años cargados (incluye posteriores).
    referenceMode: 'previous',
    // Umbrales sobre la anomalía porcentual. Definidos por FireWatch,
    // configurables; NO son categorías oficiales de NASA.
    //   < belowPct                  -> inferior a la habitual
    //   belowPct..abovePct          -> cercana a la habitual
    //   abovePct..exceptionalPct    -> superior a la habitual
    //   > exceptionalPct            -> excepcionalmente elevada
    thresholds: { belowPct: -25, abovePct: 25, exceptionalPct: 100 }
};

const ANOMALY_CATEGORY_LABELS = {
    below: 'Inferior a la habitual',
    normal: 'Cercana a la habitual',
    above: 'Superior a la habitual',
    exceptional: 'Excepcionalmente elevada'
};

function classifyAnomaly(pct, thresholds = HISTORICAL_CONFIG.thresholds) {
    if (!Number.isFinite(pct)) return null;
    if (pct < thresholds.belowPct) return 'below';
    if (pct <= thresholds.abovePct) return 'normal';
    if (pct <= thresholds.exceptionalPct) return 'above';
    return 'exceptional';
}

// ---------------------------------------------------------------------
// Compara UN mes (target) contra su referencia histórica en `monthly`.
// status: 'ok' | 'no-observation' | 'no-sensors' |
//         'insufficient-years' | 'zero-median'
// ---------------------------------------------------------------------
function calculateHistoricalMedian(monthly, target, options = {}) {
    if (!Array.isArray(monthly) || !target) {
        throw new TypeError('calculateHistoricalMedian(monthly, target, options): faltan argumentos');
    }

    const cfg = {
        ...HISTORICAL_CONFIG,
        ...options,
        thresholds: { ...HISTORICAL_CONFIG.thresholds, ...(options.thresholds || {}) }
    };
    const t = cfg.thresholds;

    if (!(t.belowPct < t.abovePct && t.abovePct < t.exceptionalPct)) {
        throw new RangeError('Umbrales inválidos: se exige belowPct < abovePct < exceptionalPct');
    }
    if (!Number.isInteger(cfg.minReferenceYears) || cfg.minReferenceYears < 1) {
        throw new RangeError('minReferenceYears debe ser un entero >= 1');
    }

    const out = {
        status: null, reason: null, note: null,
        provisional: !target.complete,
        comparison: null, comparedDays: null,
        observed: null, median: null, difference: null,
        anomalyPct: null, category: null,
        referenceYears: [], nReference: 0,
        minRequired: cfg.minReferenceYears,
        sensorSet: null, referenceMode: cfg.referenceMode
    };

    if (target.iaicd === null) {
        out.status = 'no-observation';
        out.reason = 'Mes sin datos: no hay actividad observada para comparar (no equivale a actividad cero).';
        return out;
    }

    const targetSet = target.complete ? target.sensorSet : (target.sensorSetObserved ?? '');
    out.sensorSet = targetSet || null;

    if (!targetSet) {
        out.status = 'no-sensors';
        out.reason =
            'Ningún instrumento tiene cobertura continua en los días disponibles de este mes; ' +
            'no se compara para no mezclar conjuntos de sensores distintos.';
        return out;
    }

    // Días a comparar: mes completo -> todos; incompleto -> los días con valor.
    let dayIdx = null;
    if (!target.complete) {
        dayIdx = [];
        target.dailyIaicd.forEach((v, i) => { if (v !== null) dayIdx.push(i); });
    }

    const sumDays = (arr, idx) => idx.reduce((s, i) => s + (arr[i] ?? 0), 0);

    out.comparison = dayIdx ? 'equivalent-days' : 'full-month';
    out.comparedDays = dayIdx ? dayIdx.length : target.expectedDays;
    out.observed = dayIdx ? sumDays(target.dailyIaicd, dayIdx) : target.iaicd;

    // Referencia: mismo mes, otro año, completo y con el mismo conjunto de sensores.
    const refs = [];
    for (const r of monthly) {
        if (r.monthNum !== target.monthNum || r.year === target.year) continue;
        if (cfg.referenceMode === 'previous' && r.year > target.year) continue;
        if (!r.complete || r.iaicd === null) continue;
        if (r.sensorSet !== targetSet) continue;

        let value = r.iaicd;
        if (dayIdx) {
            if (dayIdx.some(i => i >= r.expectedDays)) continue;
            value = sumDays(r.dailyIaicd, dayIdx);
        }
        refs.push({ year: r.year, value });
    }

    refs.sort((a, b) => a.year - b.year);
    out.referenceYears = refs.map(r => r.year);
    out.nReference = refs.length;

    if (refs.length < cfg.minReferenceYears) {
        out.status = 'insufficient-years';
        out.reason =
            `Hay ${refs.length} año(s) de referencia válidos del mismo mes y con los mismos sensores; ` +
            `se necesitan al menos ${cfg.minReferenceYears}. No se declara anomalía.`;
        return out;
    }

    out.median = median(refs.map(r => r.value));
    out.difference = out.observed - out.median;

    if (out.median === 0) {
        out.status = 'zero-median';
        out.reason =
            'La mediana histórica es 0: el porcentaje de anomalía no está definido ' +
            '(división por cero). Se informa solo la diferencia absoluta.';
        return out;
    }

    out.anomalyPct = (out.difference / out.median) * 100;
    out.category = classifyAnomaly(out.anomalyPct, t);
    out.status = 'ok';

    if (out.provisional) {
        out.note =
            `Resultado provisional: mes incompleto. Se comparan los mismos ${out.comparedDays} ` +
            'días del mes en cada año de referencia.';
    }
    return out;
}

// Devuelve una copia de cada fila mensual con su campo `historical`.
function annotateHistorical(monthly, options = {}) {
    return monthly.map(m => ({ ...m, historical: calculateHistoricalMedian(monthly, m, options) }));
}

// ---------------------------------------------------------------------
// AUTOTEST (sin red). Uso en consola: selfTestHistorical()
// ---------------------------------------------------------------------
function selfTestHistorical() {
    const mk = (year, monthNum, {
        daily = {}, complete = true, sensorSet = 'MODIS+VIIRS',
        daysInSeries = null, noData = false
    } = {}) => {
        const expectedDays = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
        const n = daysInSeries ?? expectedDays;
        const dailyIaicd = new Array(expectedDays).fill(null);
        if (!noData) for (let i = 0; i < n; i++) dailyIaicd[i] = daily[i + 1] ?? 0;
        const iaicd = noData ? null : dailyIaicd.reduce((s, v) => s + (v ?? 0), 0);

        return {
            month: `${year}-${String(monthNum).padStart(2, '0')}`,
            year, monthNum, expectedDays, daysInSeries: n,
            complete, provisional: !complete, iaicd,
            state: noData ? 'no-data' : !complete ? 'incomplete'
                : iaicd === 0 ? 'complete-zero' : 'complete-active',
            sensorSet: complete ? sensorSet : '',
            sensorSetObserved: noData ? '' : sensorSet,
            dailyIaicd
        };
    };

    const june = (year, value, extra = {}) => mk(year, 6, { daily: { 5: value }, ...extra });
    const refs = [10, 20, 30, 40, 50].map((v, i) => june(2019 + i, v));   // mediana 30

    const target = june(2024, 45);
    const A = calculateHistoricalMedian([...refs, target], target);

    const later = june(2025, 1000);
    const B1 = calculateHistoricalMedian([...refs, target, later], target);
    const B2 = calculateHistoricalMedian([...refs, target, later], target, { referenceMode: 'all-other' });

    const C = calculateHistoricalMedian(refs.slice(0, 3), target);

    const zeroRefs = [0, 0, 0, 0, 0].map((v, i) => june(2019 + i, v));
    const D = calculateHistoricalMedian(zeroRefs, june(2024, 7));

    const badSensors = june(2017, 999, { sensorSet: 'MODIS' });
    const badIncomplete = june(2018, 999, { complete: false });
    const E = calculateHistoricalMedian([...refs, badSensors, badIncomplete], target);

    const F = calculateHistoricalMedian(refs, mk(2024, 6, { noData: true }));

    // Mes en curso: 13 días con valor; los años de referencia tienen además 100 el día 20.
    const refsWithTail = [10, 20, 30, 40, 50].map((v, i) => mk(2019 + i, 6, { daily: { 5: v, 20: 100 } }));
    const current = mk(2024, 6, { daily: { 5: 45 }, complete: false, daysInSeries: 13 });
    const G = calculateHistoricalMedian(refsWithTail, current);

    const H = obs => calculateHistoricalMedian(refs, june(2024, obs));
    const I = calculateHistoricalMedian(refs, target, { thresholds: { abovePct: 60 } });
    const J = calculateHistoricalMedian(refs.slice(0, 3), target, { minReferenceYears: 3 });

    let threw = false;
    try { calculateHistoricalMedian(refs, target, { thresholds: { abovePct: -50 } }); }
    catch (e) { threw = e instanceof RangeError; }

    const sixRefs = [10, 20, 30, 40, 50, 60].map((v, i) => june(2018 + i, v));
    const L = calculateHistoricalMedian(sixRefs, june(2025, 35));

    const input = [...refs, target];
    const M = annotateHistorical(input);

    const checks = [
        ['Mediana de junio = 30 y el 2024 no entra en su referencia',
            A.status === 'ok' && A.median === 30 && !A.referenceYears.includes(2024)],
        ['Diferencia = 15 y anomalía = +50 %', A.difference === 15 && Math.abs(A.anomalyPct - 50) < 1e-9],
        ['5 años de referencia; categoría "superior"', A.nReference === 5 && A.category === 'above'],
        ['Modo "previous": un año posterior no entra', B1.nReference === 5 && B1.median === 30],
        ['Modo "all-other": el año posterior sí entra', B2.nReference === 6 && B2.median === 35],
        ['Pocos años -> insufficient-years, sin mediana ni porcentaje',
            C.status === 'insufficient-years' && C.median === null && C.anomalyPct === null && C.category === null],
        ['Mediana 0 -> zero-median, sin porcentaje, con diferencia',
            D.status === 'zero-median' && D.anomalyPct === null && D.difference === 7],
        ['Referencias incompletas o con otros sensores se excluyen',
            E.nReference === 5 && E.median === 30],
        ['Mes sin datos -> no-observation, sin valor observado',
            F.status === 'no-observation' && F.observed === null],
        ['Mes en curso: compara los mismos 13 días (mediana 30, +50 %)',
            G.status === 'ok' && G.comparison === 'equivalent-days' && G.comparedDays === 13 &&
            G.median === 30 && Math.abs(G.anomalyPct - 50) < 1e-9],
        ['Mes en curso marcado provisional', G.provisional === true && typeof G.note === 'string'],
        ['+233 % -> excepcionalmente elevada', H(100).category === 'exceptional'],
        ['-66,7 % -> inferior a la habitual', H(10).category === 'below'],
        ['0 % -> cercana a la habitual', H(30).category === 'normal'],
        ['Umbral configurable: +50 % es "cercana" si abovePct = 60', I.category === 'normal'],
        ['minReferenceYears configurable (3 años alcanzan)', J.status === 'ok' && J.nReference === 3],
        ['Umbrales desordenados lanzan RangeError', threw],
        ['Mediana con cantidad par de años = 35', L.median === 35 && L.anomalyPct === 0],
        ['annotateHistorical no muta la entrada',
            M.every(m => m.historical) && input.every(m => m.historical === undefined)]
    ];

    console.table(checks.map(([prueba, ok]) => ({ prueba, resultado: ok ? 'OK' : 'FALLA' })));
    return checks.every(c => c[1]);
}

// =====================================================================
// ETAPA 7 · SOLAPAMIENTO MODIS-VIIRS Y AUDITORÍA
// =====================================================================

// Evalúa el solapamiento usando SOLO meses completos con ambos instrumentos.
// Todo se mide en celdas-día (misma grilla y mismo AOI). Describe cómo se
// comportan los dos sensores en esta área; NO es una calibración.
function evaluateSensorOverlap(monthly) {
    const done = monthly.filter(m => m.complete && m.iaicd !== null);

    const setCounts = {};
    for (const m of done) setCounts[m.sensorSet] = (setCounts[m.sensorSet] || 0) + 1;

    const used = done.filter(m => {
        const s = m.sensorSet.split('+');
        return s.includes('MODIS') && s.includes('VIIRS');
    });

    const sum = k => used.reduce((acc, m) => acc + (m[k] ?? 0), 0);
    const div = (a, b) => (b > 0 ? a / b : null);

    const onlyM = sum('cellDaysOnlyModis');
    const onlyV = sum('cellDaysOnlyViirs');
    const both = sum('cellDaysBoth');
    const total = onlyM + onlyV + both;
    const withM = onlyM + both;
    const withV = onlyV + both;

    return {
        nMonths: used.length,
        setCounts,
        cellDays: total,
        shareOnlyModis: div(onlyM, total),
        shareOnlyViirs: div(onlyV, total),
        shareBoth: div(both, total),
        coverageOfModisByViirs: div(both, withM),
        coverageOfViirsByModis: div(both, withV),
        jaccard: div(both, total),
        unionOverModis: div(total, withM),
        unionOverViirs: div(total, withV),
        correlationMonthly: used.length >= 3
            ? pearson(
                used.map(m => m.cellDaysOnlyModis + m.cellDaysBoth),
                used.map(m => m.cellDaysOnlyViirs + m.cellDaysBoth))
            : null
    };
}

// Auditoría de un resultado REAL. Uso: auditActivityResult(act)
function auditActivityResult(act, params = {}) {
    const { series, monthly } = act ?? {};
    if (!Array.isArray(series) || !Array.isArray(monthly)) {
        throw new TypeError('auditActivityResult(act): faltan act.series y act.monthly');
    }

    const annotated = annotateHistorical(monthly, params);
    const byKey = new Map(monthly.map(m => [m.month, m]));
    const sum = a => a.reduce((s, v) => s + v, 0);
    const pad = n => String(n).padStart(2, '0');
    const expectedLen = series.length
        ? daysBetween(series[0].date, series[series.length - 1].date) + 1 : 0;

    const checks = [
        ['Serie continua: un día tras otro, sin saltos ni repetidos',
            series.length === expectedLen &&
            series.every((d, i) => i === 0 || daysBetween(series[i - 1].date, d.date) === 1)],
        ['Sin datos -> IAICD null; con cobertura -> entero >= 0',
            series.every(d => d.status === 'no-data'
                ? d.iaicd === null : Number.isInteger(d.iaicd) && d.iaicd >= 0)],
        ['IAICD diario = solo M + solo V + ambos = celdas únicas',
            series.every(d => d.iaicd === null ||
                (d.iaicd === d.onlyModis + d.onlyViirs + d.both && d.iaicd === d.cells.length))],
        ['Ninguna celda repetida dentro de un mismo día',
            series.every(d => new Set(d.cells.map(c => c[0])).size === d.cells.length)],
        ['Total mensual = total diario',
            sum(monthly.map(m => m.iaicd ?? 0)) === sum(series.map(d => d.iaicd ?? 0))],
        ['dailyIaicd de cada mes suma su IAICD',
            monthly.every(m => m.iaicd === null
                ? m.dailyIaicd.every(v => v === null)
                : sum(m.dailyIaicd.filter(v => v !== null)) === m.iaicd)],
        ['La procedencia exclusiva suma el IAICD',
            monthly.every(m => m.iaicd === null ||
                m.cellDaysOnlyModis + m.cellDaysOnlyViirs + m.cellDaysBoth === m.iaicd)],
        ['Meses completos: sin días sin datos, parciales ni provisionales',
            monthly.filter(m => m.complete)
                .every(m => m.daysNoData === 0 && m.daysPartial === 0 && !m.provisional)],
        ['Meses sin datos: IAICD null y sin comparación',
            annotated.filter(m => m.state === 'no-data')
                .every(m => m.iaicd === null && m.historical.status === 'no-observation' &&
                    m.historical.anomalyPct === null)],
        ['Mediana 0 -> sin porcentaje (no se divide por cero)',
            annotated.every(m => m.historical.median !== 0 || m.historical.anomalyPct === null)],
        ['Ningún año analizado figura en su propia referencia',
            annotated.every(m => !m.historical.referenceYears.includes(m.year))],
        ['Referencias: mismo mes, completo y mismo conjunto de sensores',
            annotated.every(m => {
                const want = m.complete ? m.sensorSet : m.sensorSetObserved;
                return m.historical.referenceYears.every(y => {
                    const r = byKey.get(`${y}-${pad(m.monthNum)}`);
                    return r && r.complete && r.sensorSet === want;
                });
            })],
        ['Anomalía declarada solo con los años mínimos',
            annotated.every(m => m.historical.status !== 'ok' ||
                m.historical.nReference >= m.historical.minRequired)],
        ['Porcentaje de anomalía solo si hay mediana válida',
            annotated.every(m => m.historical.anomalyPct === null ||
                (m.historical.status === 'ok' && Number.isFinite(m.historical.median)))]
    ];

    console.table(checks.map(([prueba, ok]) => ({ prueba, resultado: ok ? 'OK' : 'FALLA' })));
    return checks.every(c => c[1]);
}

// AUTOTEST (sin red). Uso en consola: selfTestOverlap()
function selfTestOverlap() {
    const mk = (month, oM, oV, b, extra = {}) => ({
        month, complete: true, sensorSet: 'MODIS+VIIRS', iaicd: oM + oV + b,
        cellDaysOnlyModis: oM, cellDaysOnlyViirs: oV, cellDaysBoth: b, ...extra
    });

    const monthly = [
        mk('2023-01', 6, 2, 2),
        mk('2023-02', 12, 4, 4),
        mk('2023-03', 3, 1, 1),
        mk('2011-06', 9, 0, 0, { sensorSet: 'MODIS' }),
        mk('2023-04', 50, 50, 50, { complete: false })
    ];
    const ov = evaluateSensorOverlap(monthly);
    const near = (a, b) => Math.abs(a - b) < 1e-9;

    const checks = [
        ['Solo entran meses completos con ambos instrumentos', ov.nMonths === 3 && ov.cellDays === 35],
        ['Procedencia: 60 % solo MODIS, 20 % solo VIIRS, 20 % ambos',
            near(ov.shareOnlyModis, 0.6) && near(ov.shareOnlyViirs, 0.2) && near(ov.shareBoth, 0.2)],
        ['Las tres participaciones suman 100 %',
            near(ov.shareOnlyModis + ov.shareOnlyViirs + ov.shareBoth, 1)],
        ['Cobertura: VIIRS ve 25 % de MODIS; MODIS ve 50 % de VIIRS',
            near(ov.coverageOfModisByViirs, 0.25) && near(ov.coverageOfViirsByModis, 0.5)],
        ['Jaccard de celda-día = 20 %', near(ov.jaccard, 0.2)],
        ['Unión / solo MODIS = 1,25 y unión / solo VIIRS = 2,5',
            near(ov.unionOverModis, 1.25) && near(ov.unionOverViirs, 2.5)],
        ['Correlación mensual = 1 (series proporcionales)', near(ov.correlationMonthly, 1)],
        ['Conjuntos de sensores contados solo en meses completos',
            ov.setCounts['MODIS+VIIRS'] === 3 && ov.setCounts['MODIS'] === 1 &&
            Object.keys(ov.setCounts).length === 2],
        ['Sin meses evaluables: nulos, sin error',
            (() => { const e = evaluateSensorOverlap([]); return e.nMonths === 0 && e.shareBoth === null && e.correlationMonthly === null; })()],
        ['El orden "VIIRS+MODIS" también cuenta',
            evaluateSensorOverlap([mk('2023-01', 1, 1, 1, { sensorSet: 'VIIRS+MODIS' })]).nMonths === 1]
    ];

    console.table(checks.map(([prueba, ok]) => ({ prueba, resultado: ok ? 'OK' : 'FALLA' })));
    return checks.every(c => c[1]);
}

// AUTOTEST (sin red). Uso en consola: selfTestPersistent()
function selfTestPersistent() {
    const lat0 = -31.42, lng0 = -64.50;     // celdas distintas: ≥ 4,7 km entre sí
    const mk = (date, dLat, dLng, sensor = 'MODIS_SP') => ({
        date, lat: lat0 + dLat, lng: lng0 + dLng, sensor,
        instrument: SENSOR_META[sensor].instrument
    });

    // 4 episodios separados 20 días (> maxGapDays) dentro de un año.
    const episodes = year => [`${year}-01-01`, `${year}-01-21`, `${year}-02-10`, `${year}-03-01`];
    // 10 días seguidos = 1 solo episodio (un incendio grande).
    const longFire = year => Array.from({ length: 10 }, (_, i) => addDaysISO(`${year}-07-01`, i));

    const P = [0, 0];          // persistente: 4 episodios en 2020 y en 2021
    const Q = [0.05, 0];       // 4 episodios solo en 2020
    const F = [0, 0.05];       // incendio largo en 2020 y 2021 (1 episodio por año)

    const detections = [];
    for (const year of [2020, 2021]) {
        for (const d of episodes(year)) detections.push(mk(d, P[0], P[1]));
        for (const d of longFire(year)) detections.push(mk(d, F[0], F[1]));
    }
    for (const d of episodes(2020)) detections.push(mk(d, Q[0], Q[1]));

    const cellOf = (dLat, dLng) => harmonizeDetections(
        [mk('2020-01-01', dLat, dLng)], lat0, 1)[0].cellId;
    const cP = cellOf(...P), cQ = cellOf(...Q), cF = cellOf(...F);

    const A = findPersistentCellsByYear([detections], lat0, 1);

    // Un solo año de datos: alcanza con serlo en ese año.
    const oneYear = detections.filter(d => d.date.startsWith('2020-'));
    const B = findPersistentCellsByYear([oneYear], lat0, 1);

    // Varios sensores: la celda se marca si alguno la marca.
    const viirs = [];
    for (const year of [2020, 2021]) {
        for (const d of episodes(year)) viirs.push(mk(d, 0.1, 0, 'VIIRS_SNPP_SP'));
    }
    const C = findPersistentCellsByYear([detections, viirs], lat0, 1);
    const cV = cellOf(0.1, 0);

    // Sin detecciones: no falla.
    const D = findPersistentCellsByYear([[], []], lat0, 1);

    // La exclusión saca solo las detecciones de las celdas marcadas.
    const kept = excludeCells(detections, A.cells, lat0, 1);
    const keptCells = new Set(harmonizeDetections(kept, lat0, 1).map(g => g.cellId));

    // minYears configurable: con 3 años exigidos y solo 2 con datos, se exigen 2.
    const E = findPersistentCellsByYear([detections], lat0, 1, { minYears: 3 });

    const checks = [
        ['Celda con 4 episodios en 2 años -> persistente', A.cells.has(cP)],
        ['Celda con 4 episodios en un solo año (de 2) -> NO persistente', !A.cells.has(cQ)],
        ['Incendio largo (1 episodio por año) -> NO persistente', !A.cells.has(cF)],
        ['2 años evaluados y 2 exigidos', A.yearsEvaluated === 2 && A.requiredYears === 2],
        ['Con un solo año de datos alcanza serlo en ese año (Q y P)',
            B.requiredYears === 1 && B.cells.has(cP) && B.cells.has(cQ) && !B.cells.has(cF)],
        ['Con varios sensores se marca si alguno la marca', C.cells.has(cV) && C.cells.has(cP)],
        ['Sin detecciones: conjunto vacío, sin error',
            D.cells.size === 0 && D.yearsEvaluated === 0 && D.requiredYears === 1],
        ['excludeCells quita P y conserva Q y F',
            !keptCells.has(cP) && keptCells.has(cQ) && keptCells.has(cF)],
        ['minYears mayor que los años disponibles se limita a los años con datos',
            E.requiredYears === 2 && E.cells.has(cP)]
    ];

    console.table(checks.map(([prueba, ok]) => ({ prueba, resultado: ok ? 'OK' : 'FALLA' })));
    return checks.every(c => c[1]);
}