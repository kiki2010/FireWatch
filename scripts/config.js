// config.js
// Elige a qué backend (funciones de Vercel) llamar según dónde corre el front.
//
//  - En tu máquina (localhost / 127.0.0.1)  -> `vercel dev` en el puerto 3000
//  - Front servido desde *.vercel.app        -> mismo dominio (ruta relativa)
//  - Front en GitHub Pages u otro dominio    -> URL pública de tu proyecto en Vercel
//
// ⚠️ Cambiá VERCEL_BASE por la URL real que te asigne Vercel al desplegar.
const VERCEL_BASE = 'https://mr-firewatch.vercel.app';

const hostname = window.location.hostname;
const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(hostname);
const IS_VERCEL_HOST = hostname.endsWith('.vercel.app');

const FUNCTIONS_BASE = IS_LOCAL
    ? 'http://localhost:3000'
    : IS_VERCEL_HOST
        ? ''
        : VERCEL_BASE;

const FIRMS_FUNCTION_URL = `${FUNCTIONS_BASE}/api/getFirmsData`;
// Fase 4: const WEATHER_FUNCTION_URL = `${FUNCTIONS_BASE}/api/getWeatherData`;

// Aviso de consola para saber a qué backend está apuntando
console.info(`[FireWatch] Backend: ${IS_LOCAL ? 'LOCAL (vercel dev)' : 'PRODUCCIÓN'} → ${FIRMS_FUNCTION_URL}`);