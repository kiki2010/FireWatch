// api/getFirmsData.js  ·  Vercel Serverless Function (Node.js)
// Equivalente a la Cloud Function de Firebase. La key vive en la variable de
// entorno FIRMS_MAP_KEY (se configura en el panel de Vercel, nunca en el código).

const ALLOWED_SENSORS = new Set([
  "MODIS_NRT",
  "MODIS_SP",
  "VIIRS_SNPP_NRT",
  "VIIRS_SNPP_SP",
  "VIIRS_NOAA20_NRT",
  "VIIRS_NOAA20_SP",
  "VIIRS_NOAA21_NRT",
  "VIIRS_NOAA21_SP",
]);

// Orígenes que pueden llamar a la función desde un navegador.
// Se suman a los de la variable ALLOWED_ORIGINS (separados por coma), por ejemplo:
//   ALLOWED_ORIGINS=https://TUUSUARIO.github.io
const LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

const ALLOWED_ORIGINS = new Set([
  ...LOCAL_ORIGINS,
  ...(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  const origin = req.headers.origin;

  // Pedido desde un navegador con un origen no autorizado.
  if (origin && !ALLOWED_ORIGINS.has(origin) && !isSameOrigin(req, origin)) {
    return res.status(403).json({ success: false, error: "Origen no permitido." });
  }

  // Preflight del navegador.
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Método no permitido. Usá POST.",
    });
  }

  const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY;

  if (!FIRMS_MAP_KEY) {
    console.error("Falta la variable de entorno FIRMS_MAP_KEY");
    return res.status(500).json({
      success: false,
      error: "El servidor no está configurado (falta la key de FIRMS).",
    });
  }

  try {
    // Vercel parsea el JSON automáticamente si el Content-Type es application/json.
    const { bounds, sensor, dayRange, startDate } = req.body || {};

    // Validar sensor.
    if (!ALLOWED_SENSORS.has(sensor)) {
      return res.status(400).json({ success: false, error: "Sensor no válido." });
    }

    // Validar límites geográficos.
    if (
      !bounds ||
      !["west", "south", "east", "north"].every((key) =>
        Number.isFinite(Number(bounds[key]))
      )
    ) {
      return res.status(400).json({
        success: false,
        error: "Los límites geográficos no son válidos.",
      });
    }

    const west = Number(bounds.west);
    const south = Number(bounds.south);
    const east = Number(bounds.east);
    const north = Number(bounds.north);

    if (
      west < -180 ||
      east > 180 ||
      south < -90 ||
      north > 90 ||
      west >= east ||
      south >= north
    ) {
      return res.status(400).json({
        success: false,
        error: "El área seleccionada está fuera de los límites permitidos.",
      });
    }

    // Validar rango de días.
    const days = Number(dayRange);

    if (!Number.isInteger(days) || days < 1 || days > 5) {
      return res.status(400).json({
        success: false,
        error: "dayRange debe ser un número entero entre 1 y 5.",
      });
    }

    // Validar fecha opcional (AAAA-MM-DD).
    if (
      startDate !== undefined &&
      startDate !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate)
    ) {
      return res.status(400).json({
        success: false,
        error: "La fecha debe tener el formato AAAA-MM-DD.",
      });
    }

    const area = `${west},${south},${east},${north}`;
    const datePart = startDate ? `/${startDate}` : "";

    const url =
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/` +
      `${FIRMS_MAP_KEY}/${sensor}/${area}/${days}${datePart}`;

    const firmsResponse = await fetch(url, {
      signal: AbortSignal.timeout(50000),
    });

    const csv = await firmsResponse.text();

    if (!firmsResponse.ok) {
      console.error("NASA FIRMS respondió con un error", firmsResponse.status);

      return res.status(502).json({
        success: false,
        error: "No se pudieron obtener los datos de NASA FIRMS.",
        upstreamStatus: firmsResponse.status,
      });
    }

    // FIRMS puede responder 200 con un mensaje de error en texto
    // (key inválida, límite de transacciones, etc.) en lugar del CSV.
    const looksLikeCsv = csv.trim() === "" || /^latitude,/i.test(csv.trim());

    if (!looksLikeCsv) {
      console.error("NASA FIRMS devolvió un contenido inesperado:", csv.slice(0, 200));

      return res.status(502).json({
        success: false,
        error: "NASA FIRMS devolvió una respuesta inesperada: " + csv.slice(0, 120),
      });
    }

    return res.status(200).json({
      success: true,
      sensor,
      startDate: startDate || null,
      dayRange: days,
      bounds: { west, south, east, north },
      csv,
    });
  } catch (error) {
    console.error("Error al consultar NASA FIRMS", error);

    return res.status(500).json({
      success: false,
      error: "Ocurrió un error al procesar la consulta.",
    });
  }
};

// Si el front se sirve desde el mismo dominio de Vercel, el Origin coincide con el Host.
function isSameOrigin(req, origin) {
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}