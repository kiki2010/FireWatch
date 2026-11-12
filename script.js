
const map = L.map('map', {
    worldCopyJump: true
}).setView([15, 0], 2);

// OpenStreetMap: mismo método original
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

// Grupo de elementos dibujados
const drawnItens = new L.featureGroup();
map.addLayer(drawnItens);

// Herramientas de dibujo
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

let selectedPayload = null;

const boundsEl = document.getElementById('bounds');
const geometryEl = document.getElementById('geometry');
const copyBtn = document.getElementById('copy');
const clearBtn = document.getElementById('clear');

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
}

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
