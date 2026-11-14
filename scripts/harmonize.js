// harmonize.js
// =====================================================================
// Procesamiento, agregación y armonización de detecciones NASA FIRMS.
// IMPORTANTE: cargar DESPUÉS de config.js y ANTES de script.js.
//
// Este archivo NO toca el DOM ni el mapa: solo recibe datos y devuelve
// resultados. Eso lo hace fácil de probar desde la consola y de defender
// en una presentación (la lógica científica está separada de la interfaz).
// =====================================================================


// ---------------------------------------------------------------------
// 1. METADATOS POR PRODUCTO FIRMS
// NRT = tiempo casi real, SP = procesamiento estándar.
// startDate = primera fecha con datos que consideramos válida.
// ⚠️ Valores conservadores. Verificá las fechas reales con:
//    https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/<MAP_KEY>/ALL
// ---------------------------------------------------------------------
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

// Texto legible de un sensor (para mensajes en pantalla).
function describeSensor(sensor) {
    const m = SENSOR_META[sensor];
    if (!m) return sensor;
    const res = m.resolutionM >= 1000 ? `${m.resolutionM / 1000} km` : `${m.resolutionM} m`;
    return `${sensor} (${m.instrument}, ${res}, desde ${m.startDate})`;
}


// ---------------------------------------------------------------------
// 2. FECHAS (usadas también por script.js)
// Se trabaja siempre en UTC para evitar corrimientos por zona horaria.
// ---------------------------------------------------------------------

// Suma n días a una fecha ISO "YYYY-MM-DD" y devuelve otra fecha ISO.
function addDaysISO(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// Diferencia en días entre dos fechas ISO (b - a).
function daysBetween(a, b) {
    return Math.round(
        (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000
    );
}


// ---------------------------------------------------------------------
// 3. PERÍODO COINCIDENTE
// Recorta el rango pedido para que empiece cuando TODOS los sensores
// involucrados ya existían. Si no, los días previos al lanzamiento se
// rellenan con ceros falsos y sesgan promedios, anomalías y correlación.
// ---------------------------------------------------------------------
const CHUNK_DAYS = 5;          // tamaño de cada consulta a FIRMS
const MAX_CHUNKS_WARN = 400;   // total de requests antes de advertir al usuario

function resolveRange(sensors, startDate, endDate) {
    // Fechas de inicio de cada sensor, ordenadas; la última es la más tardía.
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


// ---------------------------------------------------------------------
// 4. ESTADÍSTICA BÁSICA
// ---------------------------------------------------------------------
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

// Desviación estándar muestral (n-1).
const std = arr => {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / (arr.length - 1));
};

// Correlación de Pearson. Devuelve null si alguna serie no varía
// (división por cero) o si no hay datos.
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


// ---------------------------------------------------------------------
// 5. AGREGACIÓN DIARIA
// FIRMS no devuelve filas para los días sin focos, así que rellenamos
// con ceros todo el rango. Si no, promedios y anomalías quedan sesgados.
// ---------------------------------------------------------------------
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

    // Serie continua: un elemento por día, con ceros donde no hubo focos.
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


// ---------------------------------------------------------------------
// 6. AGREGACIÓN MENSUAL
// ---------------------------------------------------------------------
function aggregateMonthly(dailySeries) {
    const byMonth = new Map();

    for (const day of dailySeries) {
        const key = day.date.slice(0, 7); // "YYYY-MM"
        let m = byMonth.get(key);

        if (!m) {
            const year = Number(key.slice(0, 4));
            const monthNum = Number(key.slice(5, 7));

            m = {
                month: key, year, monthNum,
                // Día 0 del mes siguiente = último día de este mes.
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

    // "complete" evita usar meses parciales para calcular la climatología.
    return [...byMonth.values()].map(m => ({
        ...m,
        complete: m.days === m.expectedDays
    }));
}


// ---------------------------------------------------------------------
// 7. ANOMALÍAS ESTACIONALES
// Compara cada mes con el promedio de ese mismo mes en todos los años
// disponibles (incluido el mes evaluado). Necesita al menos 3 años;
// con menos, zscore queda en null.
// ---------------------------------------------------------------------
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

// Cuántos meses tienen z-score calculable (para avisar al usuario).
function countWithZScore(anomalies) {
    return anomalies.filter(a => a.zscore !== null).length;
}


// ---------------------------------------------------------------------
// 8. COMPARACIÓN TEMPORAL DE SENSORES
// Ambas series deben construirse con el mismo startDate/endDate.
// VIIRS (375 m) detecta muchos más focos que MODIS (1 km): los conteos
// absolutos no son comparables, pero la correlación y el ratio informan.
// ---------------------------------------------------------------------
function compareSensors(dailyA, dailyB, field = 'count') {
    if (dailyA.length !== dailyB.length) {
        throw new Error('Las series temporales deben tener la misma longitud');
    }

    const xs = dailyA.map(d => d[field]);
    const ys = dailyB.map(d => d[field]);

    const totalA = xs.reduce((a, b) => a + b, 0);
    const totalB = ys.reduce((a, b) => a + b, 0);

    // Días "activos": al menos un sensor detectó algo.
    // Se excluyen solo los días en que AMBOS registraron cero.
    const activePairs = dailyA
        .map((day, i) => ({ a: day[field], b: dailyB[i][field] }))
        .filter(pair => pair.a > 0 || pair.b > 0);

    const activeA = activePairs.map(pair => pair.a);
    const activeB = activePairs.map(pair => pair.b);

    return {
        days: xs.length,
        activeDays: activePairs.length,

        // Correlación con todos los días (los ceros compartidos la inflan).
        correlation: pearson(xs, ys),

        // Correlación excluyendo los ceros compartidos.
        correlationActiveDays: activePairs.length >= 2
            ? pearson(activeA, activeB)
            : null,

        totalA,
        totalB,
        ratioAB: totalB ? totalA / totalB : null
    };
}

// Días en que ambos sensores no detectaron nada
// (candidatos a revisar con datos de clima).
function coincidentZeroDays(dailyA, dailyB) {
    return dailyA
        .filter((d, i) => d.count === 0 && dailyB[i].count === 0)
        .map(d => d.date);
}


// ---------------------------------------------------------------------
// 9a. Conversión grados → celda (compartida por todas las funciones
// de grilla, para que usen EXACTAMENTE la misma fórmula).
// ---------------------------------------------------------------------
function kmFactors(referenceLat) {
    return {
        kmPerDegreeLat: 110.574,
        kmPerDegreeLng: 111.320 * Math.cos(referenceLat * Math.PI / 180)
    };
}

function cellIndexOf(lat, lng, kmPerDegreeLat, kmPerDegreeLng, cellSizeKm) {
    return {
        cellX: Math.floor((lng * kmPerDegreeLng) / cellSizeKm),
        cellY: Math.floor((lat * kmPerDegreeLat) / cellSizeKm)
    };
}

// ---------------------------------------------------------------------
// 9. ARMONIZACIÓN ESPACIAL: agrupar detecciones en una grilla común
//
// IMPORTANTE (limitaciones a declarar en el informe):
// - Es una aproximación local grados→km, NO una proyección UTM.
//   kmPerDegreeLat usa el valor del ecuador (110.574) y kmPerDegreeLng
//   usa una única latitud de referencia (el centro del AOI). Para un AOI
//   chico el error es de décimas de %, pero crece en áreas grandes.
// - Conserva las detecciones originales (trazabilidad).
// - No convierte conteos MODIS y VIIRS en mediciones equivalentes.
//
// @param {Array}  detections    Detecciones normalizadas de FIRMS.
// @param {number} referenceLat  Latitud central del área de estudio.
// @param {number} cellSizeKm    Tamaño de celda en km.
// ---------------------------------------------------------------------
function harmonizeDetections(detections, referenceLat, cellSizeKm = 1) {
    // --- Validación de entradas ---
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

    // Factores grados → km (válidos cerca de referenceLat).
    const { kmPerDegreeLat, kmPerDegreeLng } = kmFactors(referenceLat);

    for (const detection of detections) {
        // Descartar registros sin coordenadas o sin fecha.
        if (
            !Number.isFinite(detection.lat) ||
            !Number.isFinite(detection.lng) ||
            !detection.date
        ) {
            continue;
        }

        // Índice de celda (ver cellIndexOf: posición aproximada en km
        // desde el origen (0°, 0°) y Math.floor, que funciona con negativos).
        const { cellX, cellY } = cellIndexOf(
            detection.lat, detection.lng, kmPerDegreeLat, kmPerDegreeLng, cellSizeKm
        );

        // Clave única: fecha + celda. Un grupo = una celda en un día.
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

        group.bySensor[sensor] = (group.bySensor[sensor] || 0) + 1;
        group.byInstrument[instrument] = (group.byInstrument[instrument] || 0) + 1;

        if (Number.isFinite(detection.frp)) {
            group.frpSum += detection.frp;
            group.frpMax = Math.max(group.frpMax, detection.frp);
            group.frpCount++;
        }

        if (detection.confidenceLevel === 'high') {
            group.highConfidence++;
        }

        // Registro original conservado para trazabilidad.
        group.detections.push(detection);
    }

    // Convertir cada celda (índices) de vuelta a coordenadas geográficas
    // para poder dibujarla en Leaflet.
    return [...groups.values()].map(group => {
        // Límites de la celda en km.
        const westKm  = group.cellX * cellSizeKm;
        const eastKm  = (group.cellX + 1) * cellSizeKm;
        const southKm = group.cellY * cellSizeKm;
        const northKm = (group.cellY + 1) * cellSizeKm;

        // km → grados (inversa exacta de la conversión de arriba).
        const west  = westKm / kmPerDegreeLng;
        const east  = eastKm / kmPerDegreeLng;
        const south = southKm / kmPerDegreeLat;
        const north = northKm / kmPerDegreeLat;

        const centerX = (group.cellX + 0.5) * cellSizeKm;
        const centerY = (group.cellY + 0.5) * cellSizeKm;

        return {
            ...group,

            // Centro geográfico de la celda.
            centerLat: centerY / kmPerDegreeLat,
            centerLng: centerX / kmPerDegreeLng,

            // Límites para dibujar rectángulos.
            south, north, west, east,

            // FRP medio (MW) de la celda.
            frpMean: group.frpCount ? group.frpSum / group.frpCount : null
        };
    });
}


// ---------------------------------------------------------------------
// 9b. FUENTES DE CALOR PERSISTENTES (filtro estándar en análisis FIRMS)
//
// Chimeneas, hornos, canteras o quemas recurrentes aparecen una y otra
// vez en la misma celda a lo largo del año. Un incendio forestal, en
// cambio, es un EPISODIO: varios días seguidos y luego se apaga.
//
// Criterio: se agrupan las fechas de cada celda en "episodios" (un hueco
// de más de maxGapDays días abre un episodio nuevo). Si una celda tiene
// minEpisodes o más episodios separados, se la considera persistente.
// Así no se descarta un incendio grande de muchos días seguidos.
//
// Se evalúa en cada sensor por separado y la celda se excluye de AMBOS
// si es persistente en cualquiera, para no sesgar la comparación.
// Los umbrales son una decisión metodológica: documentarlos y probar
// otros valores en el informe.
// ---------------------------------------------------------------------
function findPersistentCells(
    detectionSets,
    referenceLat,
    cellSizeKm = 1,
    { minEpisodes = 4, maxGapDays = 5 } = {}
) {
    const persistent = new Set();

    for (const detections of detectionSets) {
        const datesByCell = new Map();

        for (const g of harmonizeDetections(detections, referenceLat, cellSizeKm)) {
            if (!datesByCell.has(g.cellId)) datesByCell.set(g.cellId, []);
            datesByCell.get(g.cellId).push(g.date);
        }

        for (const [cellId, dates] of datesByCell) {
            dates.sort();

            let episodes = 1;
            for (let i = 1; i < dates.length; i++) {
                if (daysBetween(dates[i - 1], dates[i]) > maxGapDays) episodes++;
            }

            if (episodes >= minEpisodes) persistent.add(cellId);
        }
    }

    return persistent;
}

// Quita de una lista de detecciones las que caen en las celdas indicadas.
function excludeCells(detections, cellIds, referenceLat, cellSizeKm = 1) {
    if (!cellIds || cellIds.size === 0) return detections;

    const { kmPerDegreeLat, kmPerDegreeLng } = kmFactors(referenceLat);

    return detections.filter(d => {
        if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return true;
        const { cellX, cellY } = cellIndexOf(d.lat, d.lng, kmPerDegreeLat, kmPerDegreeLng, cellSizeKm);
        return !cellIds.has(`${cellX}_${cellY}`);
    });
}


// ---------------------------------------------------------------------
// 10. COMPARACIÓN ESPACIAL: A vs B sobre la misma grilla
//
// Una "coincidencia" significa que ambos sensores detectaron focos en la
// misma celda y fecha, NO que detectaron el mismo evento individual.
//
// Limitaciones a declarar:
// - Celda exacta: dos focos cercanos separados por un borde de celda
//   cuentan como "solo A" y "solo B".
// - Resolución temporal diaria: no se considera la hora de pasada.
// - `cells` solo contiene celdas con actividad en A o B, por eso el
//   Pearson espacial está sesgado (selección). Preferir Jaccard y
//   cobertura (coverageOfA / coverageOfB).
// ---------------------------------------------------------------------
function compareSpatialDetections(detectionsA, detectionsB, referenceLat, cellSizeKm = 1, options = {}) {
    // Radio de vecindad en celdas: 0 = celda exacta, 1 = ventana 3×3.
    const neighborRadius =
        Number.isInteger(options.neighborRadius) && options.neighborRadius >= 0
            ? options.neighborRadius
            : 1;

    // Misma grilla para ambos (mismo referenceLat y cellSizeKm).
    const groupsA = harmonizeDetections(detectionsA, referenceLat, cellSizeKm);
    const groupsB = harmonizeDetections(detectionsB, referenceLat, cellSizeKm);

    // Mapas "fecha|celda" → cantidad de detecciones.
    const mapA = new Map();
    const mapB = new Map();

    for (const group of groupsA) {
        mapA.set(`${group.date}|${group.cellId}`, group.totalDetections);
    }
    for (const group of groupsB) {
        mapB.set(`${group.date}|${group.cellId}`, group.totalDetections);
    }

    // Unión de todas las celdas-día activas en A o en B.
    const keys = new Set([...mapA.keys(), ...mapB.keys()]);

    // Metadatos espaciales (límites, centro) de cada celda-día.
    const metadata = new Map();

    for (const group of [...groupsA, ...groupsB]) {
        const key = `${group.date}|${group.cellId}`;

        if (!metadata.has(key)) {
            metadata.set(key, {
                date: group.date,
                cellId: group.cellId,
                cellX: group.cellX,
                cellY: group.cellY,
                centerLat: group.centerLat,
                centerLng: group.centerLng,
                south: group.south,
                north: group.north,
                west: group.west,
                east: group.east
            });
        }
    }

    // Conjuntos de celdas-día activas, para buscar vecinas rápido.
    const activeSetA = new Set(groupsA.map(g => `${g.date}|${g.cellX}|${g.cellY}`));
    const activeSetB = new Set(groupsB.map(g => `${g.date}|${g.cellX}|${g.cellY}`));

    // ¿Hay actividad en la celda (x, y) o en sus vecinas a distancia
    // <= neighborRadius (distancia de Chebyshev) el mismo día?
    const hasNeighbor = (set, date, x, y) => {
        for (let dx = -neighborRadius; dx <= neighborRadius; dx++) {
            for (let dy = -neighborRadius; dy <= neighborRadius; dy++) {
                if (set.has(`${date}|${x + dx}|${y + dy}`)) return true;
            }
        }
        return false;
    };

    // Clasificar cada celda-día.
    const cells = [...keys].map(key => {
        const info = metadata.get(key);
        const countA = mapA.get(key) ?? 0;
        const countB = mapB.get(key) ?? 0;

        let status;
        if (countA > 0 && countB > 0) status = 'coincidence';
        else if (countA > 0)          status = 'onlyA';
        else                          status = 'onlyB';

        // nearMatch: el otro sensor vio algo en esta celda o en una vecina.
        // Para 'coincidence' siempre es true; es útil para 'onlyA'/'onlyB':
        // distingue discrepancias reales de simples bordes de celda.
        const nearMatch =
            (countA > 0 && hasNeighbor(activeSetB, info.date, info.cellX, info.cellY)) ||
            (countB > 0 && hasNeighbor(activeSetA, info.date, info.cellX, info.cellY));

        return { key, ...info, countA, countB, status, nearMatch };
    });

    // Estadísticas.
    const activeA    = cells.filter(c => c.countA > 0).length;
    const activeB    = cells.filter(c => c.countB > 0).length;
    const bothActive = cells.filter(c => c.status === 'coincidence').length;
    const onlyA      = cells.filter(c => c.status === 'onlyA').length;
    const onlyB      = cells.filter(c => c.status === 'onlyB').length;

    // |A ∪ B| = |A| + |B solo|  (la intersección ya está dentro de A).
    const unionActive = activeA + onlyB;

    const totalA = cells.reduce((sum, c) => sum + c.countA, 0);
    const totalB = cells.reduce((sum, c) => sum + c.countB, 0);

    // Con tolerancia: celdas de un sensor que tienen alguna del otro
    // en su vecindad. Un par puede contarse en ambos sentidos, por eso
    // se reportan como cobertura y Dice, no como Jaccard.
    const matchedA = groupsA.filter(g => hasNeighbor(activeSetB, g.date, g.cellX, g.cellY)).length;
    const matchedB = groupsB.filter(g => hasNeighbor(activeSetA, g.date, g.cellX, g.cellY)).length;

    return {
        cellSizeKm,
        cellsCompared: cells.length,

        activeA,
        activeB,
        bothActive,
        onlyA,
        onlyB,

        // Jaccard = intersección / unión.
        jaccard: unionActive ? bothActive / unionActive : null,

        // Cobertura: fracción de celdas activas de un sensor que el otro
        // también vio. Más interpretable que Pearson en este contexto.
        coverageOfA: activeA ? bothActive / activeA : null,
        coverageOfB: activeB ? bothActive / activeB : null,

        // Dice (celda exacta) = 2·|A∩B| / (|A| + |B|).
        dice: (activeA + activeB) ? (2 * bothActive) / (activeA + activeB) : null,

        // Métricas con tolerancia de vecindad (radius 0 = igual a exacta).
        tolerance: {
            radius: neighborRadius,
            matchedA,
            matchedB,
            coverageOfA: activeA ? matchedA / activeA : null,
            coverageOfB: activeB ? matchedB / activeB : null,
            dice: (activeA + activeB) ? (matchedA + matchedB) / (activeA + activeB) : null
        },

        // Pearson sobre celdas con actividad (sesgo de selección).
        correlation: pearson(
            cells.map(c => c.countA),
            cells.map(c => c.countB)
        ),

        totalA,
        totalB,

        groupsA,
        groupsB,
        cells
    };
}


// ---------------------------------------------------------------------
// 11. VALIDACIÓN DE LA ARMONIZACIÓN
// Dos controles para saber si lo que mide la comparación espacial es
// una propiedad de los sensores o un artefacto del método.
// ---------------------------------------------------------------------

// Copia las detecciones desplazando su fecha `days` días (puede ser negativo).
// Desplazamiento LINEAL: lo que sale del período se pierde. Se conserva
// por compatibilidad; el control de azar usa la versión circular de abajo.
function shiftDetections(detections, days) {
    return detections.map(d => (d.date ? { ...d, date: addDaysISO(d.date, days) } : d));
}

// Desplazamiento CIRCULAR dentro de [startDate, endDate]: lo que sale por
// un extremo reentra por el otro, así B nunca pierde detecciones y la
// distribución nula no queda artificialmente baja.
// Las detecciones fuera del período se dejan sin tocar.
function shiftDetectionsCircular(detections, days, startDate, endDate) {
    const length = daysBetween(startDate, endDate) + 1;

    return detections.map(d => {
        if (!d.date) return d;

        const offset = daysBetween(startDate, d.date);
        if (offset < 0 || offset >= length) return d;

        // Módulo que funciona también con desplazamientos negativos.
        const newOffset = (((offset + days) % length) + length) % length;
        return { ...d, date: addDaysISO(startDate, newOffset) };
    });
}

// ---------------------------------------------------------------------
// 11a. SENSIBILIDAD AL TAMAÑO DE CELDA
// Repite la comparación con celdas de 1, 2 y 3 km. Si la coincidencia
// sube mucho al agrandar la celda, parte de la discrepancia viene de la
// grilla y no de los sensores.
// Nota: jaccard/dice/coverage son de celda exacta; tolDice usa vecindad
// 3×3 (a 2 km eso equivale a una ventana de ~6 km).
// ---------------------------------------------------------------------
function sensitivityByCellSize(detectionsA, detectionsB, referenceLat, sizes = [1, 2, 3]) {
    return sizes.map(size => {
        const r = compareSpatialDetections(
            detectionsA, detectionsB, referenceLat, size, { neighborRadius: 1 }
        );

        return {
            cellSizeKm: size,
            cellsCompared: r.cellsCompared,
            activeA: r.activeA,
            activeB: r.activeB,
            bothActive: r.bothActive,
            jaccard: r.jaccard,
            dice: r.dice,
            coverageOfA: r.coverageOfA,
            coverageOfB: r.coverageOfB,
            tolDice: r.tolerance.dice
        };
    });
}

// ---------------------------------------------------------------------
// 11b. CONTROL DE AZAR (prueba de permutación por desplazamiento temporal)
//
// Pregunta: ¿la coincidencia observada es mayor que la esperable si B
// tuviera la MISMA estructura espacial pero NO estuviera alineada en
// el tiempo con A?
//
// Método: se desplaza la fecha de todas las detecciones de B entre
// minShift y maxShift días (en ambos sentidos), se recalcula la métrica
// y se obtiene una distribución nula. Se descartan desplazamientos
// chicos porque un incendio dura varios días y se "auto-coincidiría".
//
//   pValue = (1 + #{nulos >= observado}) / (1 + N)
//
// DESPLAZAMIENTO CIRCULAR: si se pasan startDate y endDate en options,
// lo que sale por un extremo del período reentra por el otro. Sin esto,
// B perdería detecciones al desplazarse fuera del rango de A y el azar
// quedaría subestimado (p-value optimista). Con período corto, maxShift
// se limita a la mitad del período; si queda menor que minShift no hay
// desplazamientos y el resultado es null (N/D) en vez de un valor falso.
//
// Limitaciones: conserva la estacionalidad aproximada (los incendios
// se agrupan en agosto-septiembre), lo que hace la prueba conservadora.
// Los desplazamientos consecutivos no son independientes, así que el
// p-value es aproximado. No prueba precisión de detección, solo
// alineación temporal.
// ---------------------------------------------------------------------
function chanceControl(detectionsA, detectionsB, referenceLat, cellSizeKm = 1, options = {}) {
    const { neighborRadius = 1, minShift = 10, startDate = null, endDate = null } = options;
    let maxShift = options.maxShift ?? 60;

    const circular = Boolean(startDate && endDate);
    if (circular) {
        const length = daysBetween(startDate, endDate) + 1;
        // Con ±k y k <= (L-1)/2 no se repiten desplazamientos equivalentes.
        maxShift = Math.min(maxShift, Math.floor((length - 1) / 2));
    }

    const metrics = (a, b) => {
        const r = compareSpatialDetections(a, b, referenceLat, cellSizeKm, { neighborRadius });
        return { dice: r.dice, tolDice: r.tolerance.dice, jaccard: r.jaccard };
    };

    const observed = metrics(detectionsA, detectionsB);

    const nulls = [];
    for (let k = minShift; k <= maxShift; k++) {
        for (const sign of [-1, 1]) {
            const shifted = circular
                ? shiftDetectionsCircular(detectionsB, sign * k, startDate, endDate)
                : shiftDetections(detectionsB, sign * k);
            nulls.push(metrics(detectionsA, shifted));
        }
    }

    const summarize = key => {
        const obs = observed[key];
        if (!Number.isFinite(obs)) return null;

        const vals = nulls.map(n => n[key]).filter(Number.isFinite);
        if (vals.length === 0) return null;

        const nullMean = mean(vals);
        const nullStd = std(vals);

        return {
            observed: obs,
            nullMean,
            nullStd,
            nullMax: Math.max(...vals),
            z: nullStd > 0 ? (obs - nullMean) / nullStd : null,
            pValue: (1 + vals.filter(v => v >= obs).length) / (1 + vals.length),
            nShifts: vals.length
        };
    };

    return {
        cellSizeKm,
        neighborRadius,
        minShift,
        maxShift,
        circular,
        shiftsUsed: nulls.length,
        exactDice: summarize('dice'),
        tolerantDice: summarize('tolDice'),
        jaccard: summarize('jaccard')
    };
}