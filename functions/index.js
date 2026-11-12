const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

setGlobalOptions({ maxInstances: 5 });

// El secreto se configura desde Firebase; nunca se escribe aquí.
const FIRMS_MAP_KEY = defineSecret("FIRMS_MAP_KEY");

// Fuentes permitidas de NASA FIRMS.
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

exports.getFirmsData = onRequest(
  {
    cors: true,
    secrets: [FIRMS_MAP_KEY],
    maxInstances: 5,
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({
        success: false,
        error: "Método no permitido. Usá POST.",
      });
    }

    try {
      const { bounds, sensor, dayRange, startDate } = req.body || {};

      // Validar sensor.
      if (!ALLOWED_SENSORS.has(sensor)) {
        return res.status(400).json({
          success: false,
          error: "Sensor no válido.",
        });
      }

      // Validar límites geográficos.
      if (
        !bounds ||
        !["west", "south", "east", "north"].every(
          (key) => Number.isFinite(Number(bounds[key]))
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
        `${FIRMS_MAP_KEY.value()}/${sensor}/${area}/${days}${datePart}`;

      const firmsResponse = await fetch(url, {
        signal: AbortSignal.timeout(100000),
      });

      const csv = await firmsResponse.text();

      if (!firmsResponse.ok) {
        logger.error("NASA FIRMS respondió con un error", {
          status: firmsResponse.status,
        });

        return res.status(502).json({
          success: false,
          error: "No se pudieron obtener los datos de NASA FIRMS.",
          upstreamStatus: firmsResponse.status,
        });
      }

      // NUEVO: FIRMS puede responder 200 con un mensaje de error en texto
      // (key inválida, límite de transacciones, etc.) en lugar del CSV.
      const looksLikeCsv = csv.trim() === "" || /^latitude,/i.test(csv.trim());

      if (!looksLikeCsv) {
        logger.error("NASA FIRMS devolvió un contenido inesperado", {
          preview: csv.slice(0, 200),
        });

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
      logger.error("Error al consultar NASA FIRMS", error);

      return res.status(500).json({
        success: false,
        error: "Ocurrió un error al procesar la consulta.",
      });
    }
  }
);