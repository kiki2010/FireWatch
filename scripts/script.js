// script.js
// =====================================================================
// Lógica principal de FireWatch: mapa, selección de AOI, consultas a
// NASA FIRMS, comparación de sensores y visualización de celdas
// armonizadas.
//
// El análisis temporal histórico (cobertura, IAICD, anomalías) vive en
// activity.js y calendar-ui.js. El "Análisis histórico" antiguo de este
// archivo fue retirado: rellenaba con ceros, no distinguía "sin datos"
// de 0 y calculaba el z-score incluyendo el mes evaluado.
//
// Orden de carga en index.html (obligatorio):
//   1. config.js     -> define FIRMS_FUNCTION_URL
//   2. harmonize.js  -> addDaysISO, daysBetween, resolveRange, etc.
//   3. script.js     -> este archivo
// =====================================================================


// =====================================================================
// 1. MAPA BASE
// =====================================================================
const map = L.map('map', {
    worldCopyJump: true
}).setView([15, 0], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);


// =====================================================================
// 2. CAPAS (grupos de elementos)
// Cada capa es independiente: se puede mostrar/ocultar sin afectar a las demás.
// =====================================================================

// Figuras dibujadas por el usuario (el AOI).
const drawnItens = new L.featureGroup();
map.addLayer(drawnItens);

// Puntos de detección originales de la consulta simple a FIRMS.
const hotspotLayer = L.layerGroup().addTo(map);

// Celdas armonizadas de la comparación A vs B (independiente de hotspotLayer).
const harmonizedLayer = L.layerGroup().addTo(map);


// =====================================================================
// 3. HERRAMIENTAS DE DIBUJO (Leaflet.draw)
// =====================================================================
const drawControl = new L.Control.Draw({
    position: 'topleft',

    draw: {
        rectangle: {
            shapeOptions: { color: '#9ca3af', weight: 2, fillOpacity: 0.06 }
        },
        polygon: {
            allowIntersection: false,
            showArea: true,
            shapeOptions: { color: '#9ca3af', weight: 2, fillOpacity: 0.06 }
        },
        polyline: false,
        circle: false,
        circlemarker: false,
        marker: false
    },

    edit: {
        featureGroup: drawnItens,
        edit: true,
        remove: true
    }
});

map.addControl(drawControl);


// =====================================================================
// 4. ESTADO GLOBAL Y REFERENCIAS AL HTML
// =====================================================================

// Estado de la aplicación.
let selectedPayload = null;   // { bounds, geometry } del AOI actual
let lastDetections = [];

// Datos de la última comparación (ya filtrados) para validar sin volver a descargar.
let lastComparisonData = null;

// Último resultado de comparación espacial (también en window para
// poder inspeccionarlo desde la consola del navegador).
let resultadoEspacial = null;
window.resultadoEspacial = null;

// Panel de selección.
const boundsEl = document.getElementById('bounds');
const geometryEl = document.getElementById('geometry');

const copyBtn = document.getElementById('copy');
const clearBtn = document.getElementById('clear');

// Consulta simple a FIRMS.
const sensorSelect = document.getElementById('sensor');
const dayRangeSelect = document.getElementById('dayRange');

const queryFirmsBtn = document.getElementById('queryFirms');
const clearFirmsBtn = document.getElementById('clearFirms');

const firmsStatus = document.getElementById('firmsStatus');
const firmsCount = document.getElementById('firmsCount');

// Fechas (compartidas con la comparación de sensores).
const startDateEl = document.getElementById('startDate');
const endDateEl = document.getElementById('endDate');

// Comparación de sensores.
const sensorBSelect = document.getElementById('sensorB');
const compareBtn = document.getElementById('compareBtn');
const compareResults = document.getElementById('compareResults');

// Visualización de celdas armonizadas.
const showCellsEl = document.getElementById('showCells');
const showHotspotsEl = document.getElementById('showHotspots');
const cellDateEl = document.getElementById('cellDate');
const cellPrevBtn = document.getElementById('cellPrev');
const cellNextBtn = document.getElementById('cellNext');
const cellSummaryEl = document.getElementById('cellSummary');
const cellLegendEl = document.getElementById('cellLegend');

// Opciones de la comparación.
const neighborRadiusEl = document.getElementById('neighborRadius');
const filterStaticEl = document.getElementById('filterStatic');

// Validación.
const validateBtn = document.getElementById('validateBtn');
const validateResultsEl = document.getElementById('validateResults');

// FIRMS_FUNCTION_URL se define en config.js.
// addDaysISO / daysBetween / resolveRange se definen en harmonize.js.


// =====================================================================
// 5. SELECCIÓN GEOGRÁFICA (AOI)
// =====================================================================

// Redondea a 5 decimales (~1 m) para mostrar coordenadas limpias.
function rounded(value) {
    return Number(value.toFixed(5));
}

// Se ejecuta cuando el usuario dibuja o edita un área.
function updateSelection(layer) {
    const b = layer.getBounds();

    const bounds = {
        west: rounded(b.getWest()),
        south: rounded(b.getSouth()),
        east: rounded(b.getEast()),
        north: rounded(b.getNorth())
    };

    const geojson = layer.toGeoJSON();

    // Guardamos bounds (para pedir a FIRMS) y geometría (para filtrar puntos).
    selectedPayload = {
        bounds,
        geometry: geojson.geometry
    };

    // El AOI cambió: la comparación anterior ya no corresponde.
    resultadoEspacial = null;
    window.resultadoEspacial = null;
    clearHarmonizedView();

    boundsEl.textContent =
        `${bounds.west}, ${bounds.south}, ${bounds.east}, ${bounds.north}`;

    geometryEl.textContent = geojson.geometry.type;

    boundsEl.classList.remove('empty');
    geometryEl.classList.remove('empty');

    copyBtn.disabled = false;
    clearBtn.disabled = false;
    queryFirmsBtn.disabled = false;
    compareBtn.disabled = false;

    // Evitar mostrar resultados de una selección anterior.
    clearFirmsData();

    firmsStatus.textContent = 'Área lista para consultar Nasa FIRMS';
}

// Quita el AOI y deja todo en estado inicial.
function resetSelection() {
    drawnItens.clearLayers();
    selectedPayload = null;

    // Sin AOI no hay comparación válida.
    resultadoEspacial = null;
    window.resultadoEspacial = null;
    clearHarmonizedView();

    boundsEl.textContent = 'Todavía no hay un área seleccionada';
    geometryEl.textContent = 'Dibujá un área en el mapa';

    boundsEl.classList.add('empty');
    geometryEl.classList.add('empty');

    copyBtn.disabled = true;
    clearBtn.disabled = true;
    queryFirmsBtn.disabled = true;
    compareBtn.disabled = true;

    clearFirmsData();

    firmsStatus.textContent = 'Esperando un área seleccionada';
}

// Eventos de Leaflet.draw.
map.on(L.Draw.Event.CREATED, event => {
    drawnItens.clearLayers();          // solo un AOI a la vez

    const layer = event.layer;
    drawnItens.addLayer(layer);

    updateSelection(layer);
});

map.on(L.Draw.Event.EDITED, event => {
    event.layers.eachLayer(updateSelection);
});

map.on(L.Draw.Event.DELETED, resetSelection);

// Copiar bounds + geometría como JSON al portapapeles.
copyBtn.addEventListener('click', async () => {
    if (!selectedPayload) return;

    try {
        await navigator.clipboard.writeText(
            JSON.stringify(selectedPayload, null, 2)
        );

        copyBtn.textContent = 'Copiado';

        setTimeout(() => {
            copyBtn.textContent = 'Copiar coordenadas';
        }, 1400);

    } catch {
        copyBtn.textContent = 'No se pudo copiar';
    }
});

clearBtn.addEventListener('click', resetSelection);


// =====================================================================
// 6. LIMPIEZA DE DETECCIONES (consulta simple)
// =====================================================================
function clearFirmsData() {
    lastDetections = [];
    hotspotLayer.clearLayers();

    firmsCount.textContent = '0';
    clearFirmsBtn.disabled = true;
}

clearFirmsBtn.addEventListener('click', () => {
    clearFirmsData();
    firmsStatus.textContent = 'Detecciones eliminadas del mapa';
});


// =====================================================================
// 7. PROCESAMIENTO DEL CSV DE NASA FIRMS
// =====================================================================

// Convierte el texto CSV en un array de objetos { columna: valor }.
// Maneja comillas y comas dentro de campos entre comillas.
function parseCSV(csv) {
    if (!csv || !csv.trim()) return [];

    const lines = csv.trim().split(/\r?\n/);

    if (lines.length < 2) return [];

    // Divide una línea respetando las comillas.
    function splitCSVLine(line) {
        const result = [];
        let current = '';
        let insideQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (insideQuotes && line[i + 1] === '"') {
                    current += '"';   // comilla escapada ("")
                    i++;
                } else {
                    insideQuotes = !insideQuotes;
                }
            } else if (char === ',' && !insideQuotes) {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }

        result.push(current);
        return result;
    }

    // Encabezados en minúscula y sin BOM.
    const headers = splitCSVLine(lines[0]).map(
        column => column.trim().replace(/^\uFEFF/, '').toLowerCase()
    );

    return lines.slice(1)
        .filter(line => line.trim() !== '')
        .map(line => {
            const values = splitCSVLine(line);
            const item = {};

            headers.forEach((header, index) => {
                item[header] = values[index]?.trim() ?? '';
            });

            return item;
        });
}


// =====================================================================
// 8. NORMALIZACIÓN DE DETECCIONES
// MODIS y VIIRS vienen con columnas y escalas distintas; se unifican
// en un solo formato para poder compararlos.
// =====================================================================
const CONFIDENCE_LEVELS = { l: 'low', n: 'nominal', h: 'high' };

// Convierte a número o devuelve null si está vacío/inválido.
function toNumberOrNull(value) {
    const n = Number(value);
    return value !== '' && Number.isFinite(n) ? n : null;
}

function normalizeDetection(raw, sensor) {
    const lat = toNumberOrNull(raw.latitude);
    const lng = toNumberOrNull(raw.longitude);
    if (lat === null || lng === null) return null;

    const isModis = sensor.startsWith('MODIS');

    // acq_time viene como "130" o "0130" (HHMM, UTC).
    const time = String(raw.acq_time ?? '').padStart(4, '0');
    const hh = time.slice(0, 2);
    const mm = time.slice(2, 4);

    // Confianza: MODIS = 0-100 (%), VIIRS = l/n/h.
    let confidencePct = null;
    let confidenceLevel = null;

    if (isModis) {
        confidencePct = toNumberOrNull(raw.confidence);
        if (confidencePct !== null) {
            confidenceLevel =
                confidencePct >= 80 ? 'high' :
                confidencePct >= 30 ? 'nominal' : 'low';
        }
    } else {
        confidenceLevel = CONFIDENCE_LEVELS[String(raw.confidence).toLowerCase()] ?? null;
    }

    return {
        lat,
        lng,
        date: raw.acq_date,                           // "YYYY-MM-DD"
        time: `${hh}:${mm}`,                          // "HH:MM" UTC
        datetime: `${raw.acq_date}T${hh}:${mm}:00Z`,  // ISO, útil para agregaciones
        frp: toNumberOrNull(raw.frp),                 // MW
        brightness: toNumberOrNull(isModis ? raw.brightness : raw.bright_ti4),
        confidencePct,
        confidenceLevel,
        satellite: raw.satellite ?? '',
        instrument: raw.instrument ?? (isModis ? 'MODIS' : 'VIIRS'),
        daynight: raw.daynight ?? '',
        sensor                                        // producto consultado, ej. VIIRS_SNPP_SP
    };
}


// =====================================================================
// 9. CONSULTA HISTÓRICA POR TRAMOS DE 5 DÍAS
// FIRMS limita los días por consulta, así que un rango largo se parte
// en tramos y se descargan en paralelo (con límite de concurrencia).
// =====================================================================

// Parte [startDate, endDate] en tramos de `size` días.
function buildChunks(startDate, endDate, size = 5) {
    const chunks = [];
    let cursor = startDate;

    while (cursor <= endDate) {
        const days = Math.min(size, daysBetween(cursor, endDate) + 1);
        chunks.push({ startDate: cursor, dayRange: days });
        cursor = addDaysISO(cursor, days);
    }

    return chunks;
}

// NRT solo guarda los últimos meses. Para fechas más viejas hay que usar SP.
const NRT_WINDOW_DAYS = 60; // margen conservador

function productForDate(sensor, isoDate) {
    if (!sensor.endsWith('_NRT')) return sensor;

    const today = new Date().toISOString().slice(0, 10);
    const ageDays = daysBetween(isoDate, today);
    return ageDays > NRT_WINDOW_DAYS ? sensor.replace('_NRT', '_SP') : sensor;
}

// Descarga UN tramo, con reintentos si falla.
// Solo se reintenta lo que puede arreglarse solo: errores de red y 5xx.
// Los 4xx (incluido el 429 de límite de transacciones de FIRMS) NO se
// reintentan: no se van a resolver y cada intento gasta cuota.
async function fetchFirmsChunk(bounds, sensor, chunk, retries = 2) {
    const product = productForDate(sensor, chunk.startDate);

    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetch(FIRMS_FUNCTION_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bounds,
                    sensor: product,
                    dayRange: chunk.dayRange,
                    startDate: chunk.startDate
                })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                const failure = new Error(result.error || 'Error al consultar NASA FIRMS');
                failure.retryable = response.status >= 500;
                throw failure;
            }

            return parseCSV(result.csv || '')
                .map(item => normalizeDetection(item, product))
                .filter(Boolean);

        } catch (error) {
            if (error.retryable === false || attempt >= retries) throw error;
            // Espera creciente antes de reintentar.
            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
    }
}

// Descarga TODO el rango: reparte los tramos entre `concurrency` workers.
async function fetchFirmsRange({
    bounds, geometry, sensor, startDate, endDate,
    concurrency = 3, onProgress
}) {
    const chunks = buildChunks(startDate, endDate);
    const results = new Array(chunks.length);
    let next = 0;
    let done = 0;

    // Cada worker toma el siguiente tramo pendiente hasta que no quedan.
    async function worker() {
        while (next < chunks.length) {
            const i = next++;
            results[i] = await fetchFirmsChunk(bounds, sensor, chunks[i]);
            done++;
            onProgress?.(done, chunks.length);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, chunks.length) }, worker)
    );

    // Aplanar, filtrar por geometría exacta y eliminar duplicados
    // (los tramos pueden solapar en sus bordes).
    const seen = new Set();
    const output = [];

    for (const item of results.flat()) {
        if (geometry && !pointInGeometry(item.lng, item.lat, geometry)) continue;

        const key = `${item.lat},${item.lng},${item.datetime},${item.satellite}`;
        if (seen.has(key)) continue;

        seen.add(key);
        output.push(item);
    }

    return output;
}


// =====================================================================
// 10. FILTRO GEOGRÁFICO (punto dentro de polígono)
// FIRMS devuelve un rectángulo; si el AOI es un polígono, hay que
// descartar los puntos que caen fuera.
// =====================================================================

// Algoritmo ray casting: cuenta cuántas veces un rayo horizontal
// desde el punto cruza el borde del anillo. Impar = adentro.
function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];

        const xj = ring[j][0];
        const yj = ring[j][1];

        const intersects =
            ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

        if (intersects) inside = !inside;
    }

    return inside;
}

// Comprueba puntos dentro de polígonos, incluidos sus huecos.
function pointInGeometry(lng, lat, geometry) {
    if (!geometry) return false;

    const point = [lng, lat];

    if (geometry.type === 'Polygon') {
        const rings = geometry.coordinates;

        // El primer anillo es el exterior.
        if (!pointInRing(point, rings[0])) return false;

        // Los anillos interiores representan huecos.
        for (let i = 1; i < rings.length; i++) {
            if (pointInRing(point, rings[i])) return false;
        }

        return true;
    }

    if (geometry.type === 'MultiPolygon') {
        return geometry.coordinates.some(polygon => {
            if (!pointInRing(point, polygon[0])) return false;

            for (let i = 1; i < polygon.length; i++) {
                if (pointInRing(point, polygon[i])) return false;
            }

            return true;
        });
    }

    return false;
}


// =====================================================================
// 11. MARCADORES DE DETECCIÓN (consulta simple)
// =====================================================================

// Escapa HTML para evitar inyectar texto en popups y tablas.
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

const CONFIDENCE_TEXT = { low: 'Baja', nominal: 'Nominal', high: 'Alta' };

function createHotspotMarker(item) {
    // La clase CSS cambia según la intensidad (FRP en MW).
    let intensityClass = 'hotspot-marker';
    if (item.frp !== null && item.frp >= 50) intensityClass += ' extreme';
    else if (item.frp !== null && item.frp >= 10) intensityClass += ' high';

    const icon = L.divIcon({
        className: '',
        html: `<div class="${intensityClass}"></div>`,
        iconSize: [15, 15],
        iconAnchor: [7, 7]
    });

    const confidence = item.confidenceLevel
        ? CONFIDENCE_TEXT[item.confidenceLevel] +
          (item.confidencePct !== null ? ` (${item.confidencePct}%)` : '')
        : 'No disponible';

    const popup = `
        <div style="min-width:180px">
            <strong>Detección NASA FIRMS</strong>
            <hr>
            <b>Latitud:</b> ${item.lat}<br>
            <b>Longitud:</b> ${item.lng}<br>
            <b>Fecha:</b> ${escapeHTML(item.date)}<br>
            <b>Hora:</b> ${escapeHTML(item.time)} UTC<br>
            <b>FRP:</b> ${item.frp ?? 'N/D'} MW<br>
            <b>Confianza:</b> ${escapeHTML(confidence)}<br>
            <b>Satélite:</b> ${escapeHTML(item.satellite)}<br>
            <b>Instrumento:</b> ${escapeHTML(item.instrument)}<br>
            <b>Momento:</b> ${item.daynight === 'D' ? 'Día' : item.daynight === 'N' ? 'Noche' : 'N/D'}
        </div>
    `;

    return L.marker([item.lat, item.lng], { icon }).bindPopup(popup);
}


// =====================================================================
// 12. CONSULTA SIMPLE A NASA FIRMS (últimos 1-5 días)
// =====================================================================
queryFirmsBtn.addEventListener('click', async () => {
    if (!selectedPayload) {
        firmsStatus.textContent = 'Primero seleccioná un área en el mapa';
        return;
    }

    const sensor = sensorSelect.value;
    const dayRange = Number(dayRangeSelect.value);

    queryFirmsBtn.disabled = true;
    queryFirmsBtn.textContent = 'Consultando...';

    firmsStatus.textContent = 'Conectando con NASA FIRMS...';

    clearFirmsData();

    try {
        const response = await fetch(FIRMS_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bounds: selectedPayload.bounds,
                sensor,
                dayRange
            })
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Error al consultar NASA FIRMS');
        }

        const detections = parseCSV(result.csv || '')
            .map(item => normalizeDetection(item, sensor))
            .filter(Boolean);

        // Filtrar detecciones por la geometría seleccionada.
        const filteredDetections = detections.filter(item =>
            pointInGeometry(item.lng, item.lat, selectedPayload.geometry)
        );

        lastDetections = filteredDetections;

        // Dibujar detecciones en hotspotLayer.
        filteredDetections.forEach(item => {
            hotspotLayer.addLayer(createHotspotMarker(item));
        });

        firmsCount.textContent = filteredDetections.length;
        clearFirmsBtn.disabled = filteredDetections.length === 0;

        if (filteredDetections.length === 0) {
            firmsStatus.textContent =
                'Consulta completada. No se encontraron detecciones dentro del área seleccionada.';
        } else {
            firmsStatus.textContent = `Consulta completada · ${sensor}`;
        }

    } catch (error) {
        console.error('Error NASA FIRMS:', error);
        firmsStatus.textContent = `Error: ${error.message}`;

    } finally {
        queryFirmsBtn.disabled = !selectedPayload;
        queryFirmsBtn.textContent = 'Consultar NASA FIRMS';
    }
});


// =====================================================================
// 13. ANÁLISIS HISTÓRICO LEGADO: RETIRADO
// El análisis mensual antiguo (relleno con ceros, sin distinguir
// "sin datos" de 0, z-score que incluía el mes evaluado) fue reemplazado
// por el calendario IAICD de activity.js / calendar-ui.js, que separa
// no-data / partial / full y calcula anomalías contra referencias
// históricas. Para que no convivan dos metodologías en pantalla, se
// ocultan los controles viejos si todavía existen en index.html.
// (Una vez borrados del HTML, este bloque se puede eliminar.)
// =====================================================================
['analyzeBtn', 'analysisStatus', 'analysisResults'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    el.style.display = 'none';
});


// =====================================================================
// 14. COMPARACIÓN TEMPORAL Y ESPACIAL DE SENSORES
// Flujo: validar -> descargar A -> descargar B -> comparar en el tiempo
// -> comparar en el espacio -> guardar resultado -> mostrar texto
// -> dibujar celdas en el mapa.
// =====================================================================
compareBtn.addEventListener('click', async () => {

    if (!selectedPayload) {
        compareResults.textContent = 'Primero seleccioná un área en el mapa.';
        return;
    }

    // Reiniciar resultados anteriores (y la capa de celdas).
    resultadoEspacial = null;
    window.resultadoEspacial = null;
    clearHarmonizedView();

    const startDate = startDateEl.value;
    const endDate = endDateEl.value;
    const today = new Date().toISOString().slice(0, 10);

    if (!startDate || !endDate || startDate > endDate || endDate > today) {
        compareResults.classList.remove('empty');
        compareResults.textContent = 'Revisá las fechas: inicio ≤ fin ≤ hoy.';
        return;
    }

    const sensorA = sensorSelect.value;
    const sensorB = sensorBSelect.value;

    if (sensorA === sensorB) {
        compareResults.classList.remove('empty');
        compareResults.textContent = 'Elegí dos sensores distintos.';
        return;
    }

    // Período común: arranca cuando AMBOS sensores ya existían.
    const range = resolveRange([sensorA, sensorB], startDate, endDate);

    if (range.error) {
        compareResults.textContent = range.error;
        return;
    }

    compareBtn.disabled = true;

    compareResults.classList.remove('empty');
    compareResults.textContent = 'Preparando comparación...';

    // Descarga las detecciones de un sensor y arma su serie diaria.
    const loadSensor = async (sensor, label) => {
        const detections = await fetchFirmsRange({
            bounds: selectedPayload.bounds,
            geometry: selectedPayload.geometry,
            sensor,
            startDate: range.startDate,
            endDate,
            onProgress: (done, total) => {
                compareResults.textContent =
                    `${label}: descargando tramo ${done} de ${total}...`;
            }
        });

        return {
            detections,
            daily: aggregateDaily(detections, range.startDate, endDate)
        };
    };

    try {
        console.log('[FireWatch] Iniciando comparación...');

        // 1. Descargar sensores (en secuencia, para no saturar FIRMS).
        let resultA = await loadSensor(sensorA, `A (${sensorA})`);
        let resultB = await loadSensor(sensorB, `B (${sensorB})`);

        // Parámetros espaciales: latitud central del AOI y celda de 1 km.
        const referenceLat =
            (selectedPayload.bounds.south + selectedPayload.bounds.north) / 2;
        const cellSizeKm = 1;

        // Filtro opcional de fuentes de calor persistentes (ver harmonize.js).
        // Se aplica ANTES de las comparaciones temporal y espacial, para
        // que ambas trabajen con los mismos datos.
        let persistentCells = new Set();

        if (filterStaticEl?.checked) {
            persistentCells = findPersistentCells(
                [resultA.detections, resultB.detections],
                referenceLat,
                cellSizeKm
            );

            if (persistentCells.size > 0) {
                const rebuild = r => {
                    const detections = excludeCells(
                        r.detections, persistentCells, referenceLat, cellSizeKm
                    );
                    return {
                        detections,
                        daily: aggregateDaily(detections, range.startDate, endDate)
                    };
                };
                resultA = rebuild(resultA);
                resultB = rebuild(resultB);
            }
        }

        console.log('[FireWatch] Datos descargados:', {
            deteccionesA: resultA.detections.length,
            deteccionesB: resultB.detections.length
        });

        // 2. Comparación temporal (series diarias).
        const cmp = compareSensors(resultA.daily, resultB.daily);
        const zeros = coincidentZeroDays(resultA.daily, resultB.daily);

        // 4. Comparación espacial sobre la grilla común.
        console.log('[FireWatch] Iniciando comparación espacial...');

        const spatial = compareSpatialDetections(
            resultA.detections,
            resultB.detections,
            referenceLat,
            cellSizeKm,
            { neighborRadius: Number(neighborRadiusEl?.value ?? 1) }
        );

        // 5. Validar que harmonize.js devolvió la estructura esperada.
        if (!spatial || !Array.isArray(spatial.cells)) {
            throw new Error(
                'compareSpatialDetections no devolvió un resultado válido. Revisar harmonize.js.'
            );
        }

        // 6. Metadatos para etiquetar sensores en leyenda y popups.
        spatial.meta = {
            sensorA: productForDate(sensorA, range.startDate),
            sensorB: productForDate(sensorB, range.startDate),
            startDate: range.startDate,
            endDate,
            persistentCells: persistentCells.size,
            neighborRadius: spatial.tolerance.radius
        };

        // 7. Guardar resultado global y preparar la vista en el mapa.
        resultadoEspacial = spatial;
        window.resultadoEspacial = spatial;

        setupHarmonizedView(spatial);

        // Guardar los datos ya filtrados para el botón de validación.
        // startDate/endDate permiten que el control de azar desplace B de
        // forma circular dentro del período (ver chanceControl en harmonize.js).
        lastComparisonData = {
            detectionsA: resultA.detections,
            detectionsB: resultB.detections,
            referenceLat,
            cellSizeKm,
            startDate: range.startDate,
            endDate
        };
        if (validateBtn) validateBtn.disabled = false;
        if (validateResultsEl) {
            validateResultsEl.textContent = 'Listo para validar';
            validateResultsEl.classList.add('empty');
        }

        console.log('[FireWatch] Comparación espacial completada:', spatial);
        console.log('[FireWatch] Celdas comparadas:', spatial.cells.length);

        // 8. Formatos de salida.
        const fmt = (value, decimals = 2) =>
            Number.isFinite(value) ? value.toFixed(decimals) : 'N/D';

        const fmtPercent = value =>
            Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'N/D';

        // 9. Mostrar resultados en el panel.
        compareResults.innerHTML = `

            <b>A:</b>
            ${escapeHTML(describeSensor(productForDate(sensorA, range.startDate)))}
            <br>

            <b>B:</b>
            ${escapeHTML(describeSensor(productForDate(sensorB, range.startDate)))}
            <br>

            <b>Período:</b>
            ${escapeHTML(range.startDate)} → ${escapeHTML(endDate)}

            <hr>

            <b>Comparación temporal</b>
            <br>

            <b>Días analizados:</b> ${cmp.days}
            <br>

            <b>Focos A:</b> ${cmp.totalA} · <b>Focos B:</b> ${cmp.totalB}
            <br>

            <b>Ratio A/B:</b> ${fmt(cmp.ratioAB)}
            <br>

            <b>Correlación diaria general (Pearson):</b> ${fmt(cmp.correlation)}
            <br>

            <b>Correlación en días activos:</b> ${fmt(cmp.correlationActiveDays)}
            <br>

            <b>Días activos:</b> ${cmp.activeDays} de ${cmp.days}
            <br>

            <b>Días con cero focos en ambos:</b>
            ${zeros.length}
            (${cmp.days ? fmtPercent(zeros.length / cmp.days) : 'N/D'})

            ${cmp.correlation === null
                ? '<br><i>No hay variabilidad suficiente para calcular la correlación general.</i>'
                : ''}

            ${cmp.correlationActiveDays === null
                ? '<br><i>No hay variabilidad suficiente para calcular la correlación en días activos.</i>'
                : ''}

            <hr>

            <b>Comparación espacial</b>
            <br>

            <b>Tamaño de celda:</b> ${cellSizeKm} km × ${cellSizeKm} km
            <br>

            <b>Celdas-día comparadas:</b> ${spatial.cellsCompared}
            <br>

            <b>Activas en A:</b> ${spatial.activeA}
            <br>

            <b>Activas en B:</b> ${spatial.activeB}
            <br>

            <b>Coincidencias:</b> ${spatial.bothActive}
            <br>

            <b>Solo A:</b> ${spatial.onlyA} · <b>Solo B:</b> ${spatial.onlyB}
            <br>

            <b>Índice Jaccard:</b> ${fmtPercent(spatial.jaccard)}
            <br>

            <b>Celdas de A también vistas por B:</b> ${fmtPercent(spatial.coverageOfA)}
            <br>

            <b>Celdas de B también vistas por A:</b> ${fmtPercent(spatial.coverageOfB)}
            <br>

            <b>Dice (celda exacta):</b> ${fmtPercent(spatial.dice)}
            <br>

            <b>Con tolerancia de ${spatial.tolerance.radius === 0 ? '0 celdas (exacta)' : spatial.tolerance.radius + ' celda(s) de vecindad'}:</b>
            <br>

            &nbsp;&nbsp;Celdas de A con B cerca: ${fmtPercent(spatial.tolerance.coverageOfA)}
            <br>

            &nbsp;&nbsp;Celdas de B con A cerca: ${fmtPercent(spatial.tolerance.coverageOfB)}
            <br>

            &nbsp;&nbsp;Dice con tolerancia: ${fmtPercent(spatial.tolerance.dice)}
            <br>

            <b>Celdas de fuentes persistentes excluidas:</b>
            ${filterStaticEl?.checked ? persistentCells.size : 'filtro desactivado'}
            <br>

            <b>Correlación espacial (Pearson, solo celdas con actividad):</b>
            ${fmt(spatial.correlation)}

            <hr>

            <i>
                La coincidencia espacial indica presencia de detecciones
                en una misma celda y día. No representa por sí sola
                igualdad de precisión entre sensores.
            </i>

            ${range.notes.length
                ? '<br><br><i>' + range.notes.map(escapeHTML).join('<br>') + '</i>'
                : ''}
        `;

        console.log('[FireWatch] Comparación finalizada correctamente.');

    } catch (error) {
        console.error('[FireWatch] Error en comparación:', error);
        compareResults.textContent = `Error en comparación: ${error.message}`;

    } finally {
        compareBtn.disabled = !selectedPayload;
    }
});


// =====================================================================
// 14b. VALIDACIÓN: sensibilidad al tamaño de celda + control de azar
// Usa los datos de la última comparación (lastComparisonData); no
// descarga nada de nuevo.
// =====================================================================
function renderValidation(sens, chance) {
    const pct = v => Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'N/D';
    const num = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : 'N/D';

    const rows = sens.map(r => `<tr>
        <td>${r.cellSizeKm} km</td>
        <td>${r.cellsCompared}</td>
        <td>${r.activeA}</td>
        <td>${r.activeB}</td>
        <td>${r.bothActive}</td>
        <td>${pct(r.jaccard)}</td>
        <td>${pct(r.dice)}</td>
        <td>${pct(r.tolDice)}</td>
    </tr>`).join('');

    // p mínimo alcanzable = 1 / (1 + nº de desplazamientos). Si el observado
    // supera a TODOS los nulos, p vale exactamente ese piso: se informa como
    // "≤ piso" y no como un valor exacto. No se muestra z: con un nulo pegado
    // a cero (desvío ≈ 0) el cociente da valores enormes sin interpretación.
    const chanceRow = (label, c) => {
        if (!c) {
            return `<tr><td>${label}</td><td colspan="4">N/D (sin actividad o período demasiado corto)</td></tr>`;
        }

        const minP = 1 / (1 + c.nShifts);
        const pText = c.pValue <= minP + 1e-12
            ? `≤ ${minP.toFixed(3)}`
            : c.pValue.toFixed(3);

        return `<tr>
            <td>${label}</td>
            <td>${pct(c.observed)}</td>
            <td>${pct(c.nullMean)} ± ${pct(c.nullStd)}</td>
            <td>${pct(c.nullMax)}</td>
            <td>${pText}</td>
        </tr>`;
    };

    const t = chance.tolerantDice;
    let verdict = 'No se pudo evaluar el azar con estos datos (período demasiado corto o sin actividad).';
    if (t) {
        verdict = t.pValue < 0.05
            ? 'La coincidencia con tolerancia supera lo esperable por alineación casual (p < 0,05).'
            : 'Con estos datos, la coincidencia con tolerancia no se distingue del azar (p ≥ 0,05). Probar con más detecciones o un período más largo.';
    }

    validateResultsEl.classList.remove('empty');
    validateResultsEl.innerHTML = `
        <b>Sensibilidad al tamaño de celda</b>
        <table class="result-table">
            <thead><tr>
                <th>Celda</th><th>Cel-día</th><th>A</th><th>B</th><th>A∩B</th>
                <th>Jacc.</th><th>Dice</th><th>Dice 3×3</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>

        <hr>

        <b>Control de azar</b>
        ${chance.shiftsUsed === 0
            ? `(período demasiado corto: se necesitan al menos ${2 * chance.minShift + 1} días para desplazar B ${chance.minShift} días en ambos sentidos)`
            : `(celda de ${chance.cellSizeKm} km, B desplazada ${chance.minShift}–${chance.maxShift} días${chance.circular ? ' (circular)' : ''},
        ${chance.shiftsUsed} desplazamientos)`}
        <table class="result-table">
            <thead><tr>
                <th>Métrica</th><th>Obs.</th><th>Azar</th><th>Máx.</th><th>p</th>
            </tr></thead>
            <tbody>
                ${chanceRow('Dice exacto', chance.exactDice)}
                ${chanceRow('Dice 3×3', chance.tolerantDice)}
                ${chanceRow('Jaccard', chance.jaccard)}
            </tbody>
        </table>

        <i>${escapeHTML(verdict)}</i>
        <br><br>
        <i>El control de azar evalúa si la alineación temporal entre sensores supera
        lo esperable con la misma distribución espacial; no mide la precisión de cada sensor.</i>
    `;
}

validateBtn?.addEventListener('click', () => {
    if (!lastComparisonData) {
        validateResultsEl.textContent = 'Ejecutá una comparación primero';
        return;
    }

    const {
        detectionsA, detectionsB, referenceLat, cellSizeKm, startDate, endDate
    } = lastComparisonData;

    validateBtn.disabled = true;
    validateResultsEl.classList.remove('empty');
    validateResultsEl.textContent = 'Calculando sensibilidad y control de azar...';

    // setTimeout deja que el navegador pinte el mensaje antes del cálculo.
    setTimeout(() => {
        try {
            const sens = sensitivityByCellSize(detectionsA, detectionsB, referenceLat);
            const chance = chanceControl(detectionsA, detectionsB, referenceLat, cellSizeKm, {
                neighborRadius: Number(neighborRadiusEl?.value ?? 1),
                startDate,
                endDate
            });

            renderValidation(sens, chance);
            console.log('[FireWatch] Validación:', { sens, chance });

        } catch (error) {
            console.error('[FireWatch] Error en validación:', error);
            validateResultsEl.textContent = `Error en validación: ${error.message}`;

        } finally {
            validateBtn.disabled = !lastComparisonData;
        }
    }, 30);
});


// =====================================================================
// 15. CAPA DE CELDAS ARMONIZADAS
// Dibuja en Leaflet las celdas de resultadoEspacial.cells, de UNA fecha
// a la vez (para no superponer días distintos).
// =====================================================================

// Colores Okabe-Ito (distinguibles con daltonismo).
const CELL_STYLES = {
    coincidence: { color: '#009E73' },   // verde: ambos sensores
    onlyA:       { color: '#E69F00' },   // naranja: solo A
    onlyB:       { color: '#0072B2' }    // azul: solo B
};

// Texto de la clasificación, con el nombre real del sensor.
function cellStatusLabel(status, meta) {
    if (status === 'coincidence') return 'Coincidencia (A y B)';
    if (status === 'onlyA') return `Solo A (${meta?.sensorA ?? 'A'})`;
    return `Solo B (${meta?.sensorB ?? 'B'})`;
}

// Deja la vista de celdas en estado inicial (capa vacía, controles apagados).
function clearHarmonizedView() {
    harmonizedLayer.clearLayers();

    // La validación depende de la comparación: se invalida junto con ella.
    lastComparisonData = null;
    if (validateBtn) validateBtn.disabled = true;
    if (validateResultsEl) {
        validateResultsEl.textContent = 'Ejecutá una comparación primero';
        validateResultsEl.classList.add('empty');
    }

    if (cellDateEl) {
        cellDateEl.innerHTML = '';
        cellDateEl.disabled = true;
    }
    if (cellPrevBtn) cellPrevBtn.disabled = true;
    if (cellNextBtn) cellNextBtn.disabled = true;
    if (cellSummaryEl) cellSummaryEl.textContent = 'Ejecutá una comparación para ver las celdas';
    if (cellLegendEl) cellLegendEl.innerHTML = '';
}

// HTML del popup de una celda.
function buildCellPopup(cell, meta) {
    return `
        <div style="min-width:200px">
            <strong>Celda armonizada</strong>
            <hr>
            <b>Fecha:</b> ${escapeHTML(cell.date)}<br>
            <b>Celda:</b> ${escapeHTML(cell.cellId)}<br>
            <b>Centro:</b> ${cell.centerLat.toFixed(5)}, ${cell.centerLng.toFixed(5)}<br>
            <b>Límites:</b> S ${cell.south.toFixed(5)} · N ${cell.north.toFixed(5)}<br>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;O ${cell.west.toFixed(5)} · E ${cell.east.toFixed(5)}<br>
            <b>Detecciones A${meta ? ` (${escapeHTML(meta.sensorA)})` : ''}:</b> ${cell.countA}<br>
            <b>Detecciones B${meta ? ` (${escapeHTML(meta.sensorB)})` : ''}:</b> ${cell.countB}<br>
            <b>Clasificación:</b> ${escapeHTML(cellStatusLabel(cell.status, meta))}<br>
            ${cell.status !== 'coincidence'
                ? `<b>Detección del otro sensor en celdas vecinas:</b> ${cell.nearMatch ? 'Sí' : 'No'}`
                : ''}
        </div>
    `;
}

// Dibuja las celdas de UNA fecha (reemplaza las anteriores).
function renderHarmonizedCells(date) {
    harmonizedLayer.clearLayers();

    if (!resultadoEspacial || !date) return;

    const meta = resultadoEspacial.meta;
    const cells = resultadoEspacial.cells.filter(c => c.date === date);

    const counts = { coincidence: 0, onlyA: 0, onlyB: 0 };

    for (const cell of cells) {
        counts[cell.status]++;

        const style = CELL_STYLES[cell.status];

        // Leaflet espera [[sur, oeste], [norte, este]].
        const rect = L.rectangle(
            [[cell.south, cell.west], [cell.north, cell.east]],
            {
                color: style.color,
                weight: 1.5,
                fillColor: style.color,
                fillOpacity: 0.35,
                // Borde punteado: exclusiva por celda, pero con el otro
                // sensor en una celda vecina (posible efecto de borde).
                dashArray: (cell.status !== 'coincidence' && cell.nearMatch) ? '4 3' : null
            }
        );

        rect.bindPopup(buildCellPopup(cell, meta));
        harmonizedLayer.addLayer(rect);
    }

    if (cellSummaryEl) {
        cellSummaryEl.textContent =
            `${date}: ${cells.length} celdas · ` +
            `${counts.coincidence} coincidencias · ` +
            `${counts.onlyA} solo A · ${counts.onlyB} solo B`;
    }

    // Respetar el interruptor de visibilidad.
    if (showCellsEl && !showCellsEl.checked) {
        map.removeLayer(harmonizedLayer);
    }
}

// Prepara selector de fechas, leyenda y primera vista tras una comparación.
function setupHarmonizedView(spatial) {
    if (!cellDateEl) {
        console.warn('[FireWatch] Falta #cellDate en index.html: no se muestran las celdas.');
        return;
    }

    // Resumen de celdas por fecha (para el selector).
    const byDate = new Map();

    for (const c of spatial.cells) {
        let s = byDate.get(c.date);
        if (!s) {
            s = { coincidence: 0, onlyA: 0, onlyB: 0, total: 0 };
            byDate.set(c.date, s);
        }
        s[c.status]++;
        s.total++;
    }

    const dates = [...byDate.keys()].sort();

    if (dates.length === 0) {
        clearHarmonizedView();
        if (cellSummaryEl) cellSummaryEl.textContent = 'No hay celdas con actividad en el período.';
        return;
    }

    // Opciones del selector: fecha + resumen.
    cellDateEl.innerHTML = dates.map(d => {
        const s = byDate.get(d);
        return `<option value="${escapeHTML(d)}">` +
            `${escapeHTML(d)} · ${s.coincidence} coinc. · ${s.onlyA} A · ${s.onlyB} B` +
            `</option>`;
    }).join('');

    // Fecha inicial: la de más coincidencias (desempata por total de celdas).
    let bestDate = dates[0];
    let bestScore = -1;

    for (const d of dates) {
        const s = byDate.get(d);
        const score = s.coincidence * 1e6 + s.total;
        if (score > bestScore) {
            bestScore = score;
            bestDate = d;
        }
    }

    cellDateEl.value = bestDate;
    cellDateEl.disabled = false;
    if (cellPrevBtn) cellPrevBtn.disabled = false;
    if (cellNextBtn) cellNextBtn.disabled = false;

    // Leyenda con los nombres reales de los sensores.
    if (cellLegendEl) {
        const m = spatial.meta;
        const item = (color, text) =>
            `<div><span style="display:inline-block;width:12px;height:12px;` +
            `background:${color};opacity:.7;border:1px solid ${color};margin-right:6px"></span>` +
            `${escapeHTML(text)}</div>`;

        cellLegendEl.innerHTML =
            item(CELL_STYLES.coincidence.color, 'Coincidencia A + B') +
            item(CELL_STYLES.onlyA.color, `Solo A: ${m.sensorA}`) +
            item(CELL_STYLES.onlyB.color, `Solo B: ${m.sensorB}`) +
            `<div style="margin-top:4px;font-size:.85em;opacity:.8">` +
            `Borde punteado: el otro sensor detectó en una celda vecina</div>`;
    }

    // Celdas de 1 km no se ven con zoom global: acercar al AOI.
    if (map.getZoom() < 8 && drawnItens.getLayers().length > 0) {
        map.fitBounds(drawnItens.getBounds());
    }

    // Asegurar que la capa esté en el mapa si el interruptor está activo.
    if (showCellsEl && showCellsEl.checked && !map.hasLayer(harmonizedLayer)) {
        map.addLayer(harmonizedLayer);
    }

    renderHarmonizedCells(bestDate);
}

// Mueve el selector una fecha atrás/adelante.
function stepCellDate(delta) {
    if (!cellDateEl || cellDateEl.options.length === 0) return;

    const next = Math.min(
        Math.max(cellDateEl.selectedIndex + delta, 0),
        cellDateEl.options.length - 1
    );

    cellDateEl.selectedIndex = next;
    renderHarmonizedCells(cellDateEl.value);
}

// Controles (con ?. por si falta el HTML correspondiente).
cellDateEl?.addEventListener('change', () => renderHarmonizedCells(cellDateEl.value));
cellPrevBtn?.addEventListener('click', () => stepCellDate(-1));
cellNextBtn?.addEventListener('click', () => stepCellDate(1));

showCellsEl?.addEventListener('change', () => {
    if (showCellsEl.checked) map.addLayer(harmonizedLayer);
    else map.removeLayer(harmonizedLayer);
});

showHotspotsEl?.addEventListener('change', () => {
    if (showHotspotsEl.checked) map.addLayer(hotspotLayer);
    else map.removeLayer(hotspotLayer);
});


// =====================================================================
// 16. AJUSTE DEL MAPA
// Leaflet calcula mal su tamaño si el contenedor cambia después de
// crearse; invalidateSize() lo recalcula.
// =====================================================================
window.addEventListener('load', () => {
    setTimeout(() => map.invalidateSize(), 250);
});

window.addEventListener('resize', () => {
    map.invalidateSize();
});