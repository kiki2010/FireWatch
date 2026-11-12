//Configuración del mapa
const map = L.map('map', {
    worldCopyJump: true
}).setView([15, 0], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

// Grupos de Elementos
const drawnItens = new L.featureGroup();
map.addLayer(drawnItens);

const hotspotLayer = L.layerGroup().addTo(map);

// Herramientas de Dibujo
const drawControl = new L.Control.Draw({
    position: 'topleft',

    draw: {
        rectangle: {
            shapeOptions: {
                color: '#f59e0b',
                weight: 2
            }
        },

        polygon: {
            allowIntersection: false,
            showArea: true,
            shapeOptions: {
                color: '#f59e0b',
                weight: 2
            }
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

// Referencias HTML
let selectedPayload = null;
let lastDetections = [];

const boundsEl = document.getElementById('bounds');
const geometryEl = document.getElementById('geometry');

const copyBtn = document.getElementById('copy');
const clearBtn = document.getElementById('clear');

const sensorSelect = document.getElementById('sensor');
const dayRangeSelect = document.getElementById('dayRange');

const queryFirmsBtn = document.getElementById('queryFirms');
const clearFirmsBtn = document.getElementById('clearFirms');

const firmsStatus = document.getElementById('firmsStatus');
const firmsCount = document.getElementById('firmsCount');

const FIRMS_FUNCTION_URL = 'http://127.0.0.1:5001/mr-firewatch/us-central1/getFirmsData';

//Funciones de selección geográfica
function rounded(value) {
    return Number(value.toFixed(5));
}

function updateSelection(layer) {
    const b = layer.getBounds();

    const bounds = {
        west: rounded(b.getWest()),
        south: rounded(b.getSouth()),
        east: rounded(b.getEast()),
        north: rounded(b.getNorth())
    };

    const geojson = layer.toGeoJSON();

    selectedPayload = {
        bounds,
        geometry: geojson.geometry
    };

    boundsEl.textContent =
        `${bounds.west}, ${bounds.south}, ${bounds.east}, ${bounds.north}`;

    geometryEl.textContent = geojson.geometry.type;

    boundsEl.classList.remove('empty');
    geometryEl.classList.remove('empty');

    copyBtn.disabled = false;
    clearBtn.disabled = false;
    queryFirmsBtn.disabled = false;

    //evitar mostrar resultados de una selección anterior
    clearFirmsData();

    firmsStatus.textContent = 'Área lista para consultar Nasa FIRMS';
}

function resetSelection() {
    drawnItens.clearLayers();
    selectedPayload = null;

    boundsEl.textContent = 'Todavía no hay un área seleccionada';
    geometryEl.textContent = 'Dibujá un área en el mapa';

    boundsEl.classList.add('empty');
    geometryEl.classList.add('empty');

    copyBtn.disabled = true;
    clearBtn.disabled = true;
    queryFirmsBtn.disabled = true;

    clearFirmsData();

    firmsStatus.textContent = 'Esperando un área seleccionada'
}

//Elementos de Leaflet.draw
map.on(L.Draw.Event.CREATED, event => {
    drawnItens.clearLayers();

    const layer = event.layer;
    drawnItens.addLayer(layer);

    updateSelection(layer);
});

map.on(L.Draw.Event.EDITED, event => {
    event.layers.eachLayer(updateSelection);
});

map.on(L.Draw.Event.DELETED, resetSelection);

//Copiar GEOJson
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

// Corregir dimensiones de Leaflet después de cargar el diseño
window.addEventListener('load', () => {
    setTimeout(() => map.invalidateSize(), 250);
});

window.addEventListener('resize', () => {
    map.invalidateSize();
});

//Limpiar Detecciones
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

//procesamiento del CSV de Nasa Firms

function parseCSV(csv) {
    if (!csv || !csv.trim()) return [];

    const lines = csv.trim().split(/\r?\n/);

    if (lines.length < 2) return [];

    function splitCSVLine(line) {
        const result = [];
        let current = '';
        let insideQuotes = false;
      
        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (insideQuotes && line[i + 1] === '"') {
                    current += '"';
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

//normalizar datos

const CONFIDENCE_LEVELS = { l: 'low', n: 'nominal', h: 'high' };

function toNumberOrNull(value) {
    const n = Number(value);
    return value !== '' && Number.isFinite(n) ? n : null;
}

function normalizeDetection(raw, sensor) {
    const lat = toNumberOrNull(raw.latitude);
    const lng = toNumberOrNull(raw.longitude);
    if (lat === null || lng === null) return null;

    const isModis = sensor.startsWith('MODIS');

    // acq_time viene como "130" o "0130" (HHMM, UTC)
    const time = String(raw.acq_time ?? '').padStart(4, '0');
    const hh = time.slice(0, 2);
    const mm = time.slice(2, 4);

    // Confianza: MODIS = 0-100, VIIRS = l/n/h
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
        sensor                                        // producto consultado, ej. VIIRS_SNPP_NRT
    };
}

// Consulta histórica por tramos de 5 días
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

async function fetchFirmsChunk(bounds, sensor, chunk, retries = 2) {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetch(FIRMS_FUNCTION_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bounds,
                    sensor,
                    dayRange: chunk.dayRange,
                    startDate: chunk.startDate
                })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Error al consultar NASA FIRMS');
            }

            return parseCSV(result.csv || '')
                .map(item => normalizeDetection(item, sensor))
                .filter(Boolean);

        } catch (error) {
            if (attempt >= retries) throw error;
            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
    }
}

async function fetchFirmsRange({
    bounds, geometry, sensor, startDate, endDate,
    concurrency = 3, onProgress
}) {
    const chunks = buildChunks(startDate, endDate);
    const results = new Array(chunks.length);
    let next = 0;
    let done = 0;

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

    // Aplanar, filtrar por geometría y eliminar duplicados
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

//Filtro Geográfico
function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;

    for (
        let i = 0, j = ring.length - 1;
        i < ring.length;
        j = i++
    ) {
        const xi = ring[i][0];
        const yi = ring[i][1];

        const xj = ring[j][0];
        const yj = ring[j][1];

        const intersects =
            ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

        if (intersects) inside = !inside;
    }

    return inside
}

//Comprobar puntos dentro de polígonos, incluidos sus huecos.
function pointInGeometry(lng, lat, geometry) {
    if (!geometry) return false;

    const point = [lng, lat];

    if (geometry.type === 'Polygon') {
        const rings = geometry.coordinates;

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

//Crear marcadores
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

//Consultar NASA FIRMS
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

            headers: {
                'Content-Type': 'application/json'
            },

            body: JSON.stringify({
                bounds: selectedPayload.bounds,
                sensor,
                dayRange
            })
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(
                result.error || 'Error al consultar NASA FIRMS'
            );
        }

        const detections = parseCSV(result.csv || '')
            .map(item => normalizeDetection(item, sensor))
            .filter(Boolean);

        // Filtrar detecciones por la geometría seleccionada.
        const filteredDetections = detections.filter(item =>
            pointInGeometry(item.lng, item.lat, selectedPayload.geometry)
        );

        lastDetections = filteredDetections;

        // Dibujar detecciones.
        filteredDetections.forEach(item => {
            const marker = createHotspotMarker(item);

            if (marker) {
                hotspotLayer.addLayer(marker);
            }
        });

        firmsCount.textContent = filteredDetections.length;
        clearFirmsBtn.disabled = filteredDetections.length === 0;

        if (filteredDetections.length === 0) {
            firmsStatus.textContent =
                'Consulta completada. No se encontraron detecciones dentro del área seleccionada.';
        } else {
            firmsStatus.textContent =
                `Consulta completada · ${sensor}`;
        }

    } catch (error) {
        console.error('Error NASA FIRMS:', error);

        firmsStatus.textContent =
            `Error: ${error.message}`;

    } finally {
        queryFirmsBtn.disabled = !selectedPayload;
        queryFirmsBtn.textContent = 'Consultar NASA FIRMS';
    }
});

//Ajustar Mapa
window.addEventListener('load', () => {
    setTimeout(() => map.invalidateSize(), 250);
});

window.addEventListener('resize', () => {
    map.invalidateSize();
});