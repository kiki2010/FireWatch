// harmonize.js
// IMPORTANTE: cargar ANTES que script.js (ver orden en index.html).

// ---------------------------------------------------------------
// Metadatos por producto FIRMS (NRT = tiempo casi real, SP = procesamiento estándar).
// startDate = primera fecha con datos que consideramos válida para ese sensor.
// ⚠️ Son valores conservadores (inicio de año). Verificá las fechas reales con:
//    https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/<MAP_KEY>/ALL
// ---------------------------------------------------------------
const SENSOR_META = {
    VIIRS_SNPP_NRT:   { instrument: 'VIIRS', resolutionM: 375,  since: 2012, startDate: '2012-01-20', confidence: 'l/n/h' },
    VIIRS_SNPP_SP:    { instrument: 'VIIRS', resolutionM: 375,  since: 2012, startDate: '2012-01-20', confidence: 'l/n/h' },
    VIIRS_NOAA20_NRT: { instrument: 'VIIRS', resolutionM: 375,  since: 2018, startDate: '2018-04-01', confidence: 'l/n/h' },
    VIIRS_NOAA20_SP:  { instrument: 'VIIRS', resolutionM: 375,  since: 2018, startDate: '2018-04-01', confidence: 'l/n/h' },
    VIIRS_NOAA21_NRT: { instrument: 'VIIRS', resolutionM: 375,  since: 2023, startDate: '2023-01-01', confidence: 'l/n/h' },
    VIIRS_NOAA21_SP:  { instrument: 'VIIRS', resolutionM: 375,  since: 2023, startDate: '2023-01-01', confidence: 'l/n/h' },
    MODIS_NRT:        { instrument: 'MODIS', resolutionM: 1000, since: 2000, startDate: '2000-11-01', confidence: '0-100' },
    MODIS_SP:         { instrument: 'MODIS', resolutionM: 1000, since: 2000, startDate: '2000-11-01', confidence: '0-100' }
};

function describeSensor(sensor) {
    const m = SENSOR_META[sensor];
    if (!m) return sensor;
    const res = m.resolutionM >= 1000 ? `${m.resolutionM / 1000} km` : `${m.resolutionM} m`;
    return `${sensor} (${m.instrument}, ${res}, desde ${m.startDate})`;
}

// ---------------------------------------------------------------
// Fechas (movidas desde script.js; borrá las copias de allá)
// ---------------------------------------------------------------
function addDaysISO(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
    return Math.round(
        (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000
    );
}

// ---------------------------------------------------------------
// Período coincidente
// Recorta el rango pedido para que arranque cuando TODOS los sensores
// involucrados ya existían. Si no, los días previos al lanzamiento se
// rellenan con ceros falsos y sesgan promedios, anomalías y correlación.
// ---------------------------------------------------------------
const CHUNK_DAYS = 5;
const MAX_CHUNKS_WARN = 400; // total de requests (sumando sensores) antes de advertir

function resolveRange(sensors, startDate, endDate) {
    const starts = sensors
        .map(s => SENSOR_META[s]?.startDate)
        .filter(Boolean)
        .sort();
    const latestStart = starts.length ? starts[starts.length - 1] : null;

    const start = latestStart && latestStart > startDate ? latestStart : startDate;

    if (start > endDate) {
        return {
            error: `El rango no tiene datos: el sensor más reciente empieza el ${latestStart}.`
        };
    }

    const notes = [];
    if (start !== startDate) {
        notes.push(`Inicio ajustado de ${startDate} a ${start} (período coincidente de los sensores).`);
    }

    const chunksPerSensor = Math.ceil((daysBetween(start, endDate) + 1) / CHUNK_DAYS);
    const totalRequests = chunksPerSensor * sensors.length;

    if (totalRequests > MAX_CHUNKS_WARN) {
        notes.push(`Se harán ${totalRequests} consultas a FIRMS; puede tardar varios minutos.`);
    }

    return { startDate: start, endDate, notes, totalRequests };
}

// ---------------------------------------------------------------
// Estadística básica
// ---------------------------------------------------------------
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

// Desviación estándar muestral (n-1)
const std = arr => {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / (arr.length - 1));
};

function pearson(xs, ys) {
    const mx = mean(xs), my = mean(ys);
    let num = 0, dx = 0, dy = 0;

    for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) ** 2;
        dy += (ys[i] - my) ** 2;
    }

    return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

// ---------------------------------------------------------------
// Agregación diaria
// FIRMS no devuelve filas para los días sin focos, así que rellenamos
// con ceros todo el rango. Si no, los promedios y anomalías quedan sesgados.
// ---------------------------------------------------------------
function aggregateDaily(detections, startDate, endDate) {
    const byDate = new Map();

    for (const d of detections) {
        let row = byDate.get(d.date);

        if (!row) {
            row = { date: d.date, count: 0, frpSum: 0, frpMax: 0, highConf: 0 };
            byDate.set(d.date, row);
        }

        row.count++;
        if (d.frp !== null) {
            row.frpSum += d.frp;
            row.frpMax = Math.max(row.frpMax, d.frp);
        }
        if (d.confidenceLevel === 'high') row.highConf++;
    }

    const series = [];
    const n = daysBetween(startDate, endDate);

    for (let i = 0; i <= n; i++) {
        const date = addDaysISO(startDate, i);
        series.push(
            byDate.get(date) ?? { date, count: 0, frpSum: 0, frpMax: 0, highConf: 0 }
        );
    }

    return series;
}

// ---------------------------------------------------------------
// Agregación mensual
// ---------------------------------------------------------------
function aggregateMonthly(dailySeries) {
    const byMonth = new Map();

    for (const day of dailySeries) {
        const key = day.date.slice(0, 7);
        let m = byMonth.get(key);

        if (!m) {
            const year = Number(key.slice(0, 4));
            const monthNum = Number(key.slice(5, 7));

            m = {
                month: key, year, monthNum,
                expectedDays: new Date(Date.UTC(year, monthNum, 0)).getUTCDate(),
                days: 0, activeDays: 0, count: 0, frpSum: 0
            };
            byMonth.set(key, m);
        }

        m.days++;
        m.count += day.count;
        m.frpSum += day.frpSum;
        if (day.count > 0) m.activeDays++;
    }

    // "complete" evita usar meses parciales para calcular la climatología
    return [...byMonth.values()].map(m => ({
        ...m,
        complete: m.days === m.expectedDays
    }));
}

// ---------------------------------------------------------------
// Anomalías estacionales
// Compara cada mes con el promedio de ese mismo mes en todos los años
// disponibles (incluido el mes evaluado). Necesita al menos 3 años;
// con menos, zscore queda en null.
// ---------------------------------------------------------------
const MIN_YEARS_FOR_ZSCORE = 3;

function seasonalAnomalies(monthly, field = 'count') {
    const complete = monthly.filter(m => m.complete);
    const valuesByMonthNum = {};

    for (const m of complete) {
        (valuesByMonthNum[m.monthNum] ??= []).push(m[field]);
    }

    const stats = {};
    for (const [k, vals] of Object.entries(valuesByMonthNum)) {
        stats[k] = { mean: mean(vals), std: std(vals), n: vals.length };
    }

    return complete.map(m => {
        const s = stats[m.monthNum];
        const enough = s.n >= MIN_YEARS_FOR_ZSCORE && s.std > 0;

        return {
            ...m,
            baseline: s.mean,
            n: s.n,
            anomaly: m[field] - s.mean,
            zscore: enough ? (m[field] - s.mean) / s.std : null
        };
    });
}

// Cuántos meses del resultado tienen z-score calculable (para avisar al usuario)
function countWithZScore(anomalies) {
    return anomalies.filter(a => a.zscore !== null).length;
}

// ---------------------------------------------------------------
// Comparación de sensores
// Ambas series deben construirse con el mismo startDate/endDate.
// VIIRS (375 m) detecta muchos más focos que MODIS (1 km): los conteos
// absolutos no son comparables, pero la correlación y el ratio sí informan.
// ---------------------------------------------------------------
function compareSensors(dailyA, dailyB, field = 'count') {
    const xs = dailyA.map(d => d[field]);
    const ys = dailyB.map(d => d[field]);
    const totalA = xs.reduce((a, b) => a + b, 0);
    const totalB = ys.reduce((a, b) => a + b, 0);

    return {
        days: xs.length,
        correlation: pearson(xs, ys),
        totalA,
        totalB,
        ratioAB: totalB ? totalA / totalB : null
    };
}

// Días en que ambos sensores no detectaron nada (candidatos a revisar con clima)
function coincidentZeroDays(dailyA, dailyB) {
    return dailyA
        .filter((d, i) => d.count === 0 && dailyB[i].count === 0)
        .map(d => d.date);
}


/**
 * Agrupa detecciones por día y celda espacial.
 *
 * IMPORTANTE:
 * - Es una primera armonización espacial aproximada.
 * - Conserva las detecciones originales.
 * - No convierte conteos MODIS y VIIRS en mediciones equivalentes.
 *
 * @param {Array} detections Detecciones normalizadas de NASA FIRMS.
 * @param {number} referenceLat Latitud central del área de estudio.
 * @param {number} cellSizeKm Tamaño de celda en kilómetros.
 */
function harmonizeDetections(
    detections,
    referenceLat,
    cellSizeKm = 1
) {
    if (!Array.isArray(detections)) {
        throw new TypeError('detections debe ser un array');
    }

    if (!Number.isFinite(referenceLat) || Math.abs(referenceLat) >= 90) {
        throw new RangeError('referenceLat debe ser una latitud válida');
    }

    if (!Number.isFinite(cellSizeKm) || cellSizeKm <= 0) {
        throw new RangeError('cellSizeKm debe ser mayor que cero');
    }

    const groups = new Map();

    // Aproximación local de grados a kilómetros.
    const kmPerDegreeLat = 110.574;
    const kmPerDegreeLng =
        111.320 * Math.cos(referenceLat * Math.PI / 180);

    for (const detection of detections) {
        if (
            !Number.isFinite(detection.lat) ||
            !Number.isFinite(detection.lng) ||
            !detection.date
        ) {
            continue;
        }

        // Coordenadas aproximadas en kilómetros.
        const x = detection.lng * kmPerDegreeLng;
        const y = detection.lat * kmPerDegreeLat;

        const cellX = Math.floor(x / cellSizeKm);
        const cellY = Math.floor(y / cellSizeKm);

        const key = `${detection.date}_${cellX}_${cellY}`;

        let group = groups.get(key);

        if (!group) {
            group = {
                date: detection.date,
                cellId: `${cellX}_${cellY}`,
                cellX,
                cellY,
                totalDetections: 0,
                bySensor: {},
                byInstrument: {},
                frpSum: 0,
                frpMax: 0,
                frpCount: 0,
                highConfidence: 0,
                detections: []
            };

            groups.set(key, group);
        }

        group.totalDetections++;

        const sensor = detection.sensor || 'UNKNOWN';
        const instrument = detection.instrument || 'UNKNOWN';

        group.bySensor[sensor] =
            (group.bySensor[sensor] || 0) + 1;

        group.byInstrument[instrument] =
            (group.byInstrument[instrument] || 0) + 1;

        if (Number.isFinite(detection.frp)) {
            group.frpSum += detection.frp;
            group.frpMax = Math.max(group.frpMax, detection.frp);
            group.frpCount++;
        }

        if (detection.confidenceLevel === 'high') {
            group.highConfidence++;
        }

        // Conservamos el registro original para trazabilidad.
        group.detections.push(detection);
    }

    return [...groups.values()]
        .map(group => {
            const centerX = (group.cellX + 0.5) * cellSizeKm;
            const centerY = (group.cellY + 0.5) * cellSizeKm;

            return {
                ...group,
                centerLat: centerY / kmPerDegreeLat,
                centerLng: centerX / kmPerDegreeLng,
                frpMean: group.frpCount
                    ? group.frpSum / group.frpCount
                    : null
            };
        })
        .sort((a, b) =>
            a.date.localeCompare(b.date) ||
            a.cellId.localeCompare(b.cellId)
        );
}
