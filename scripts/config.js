// config.js

const VERCEL_BASE = 'https://mr-firewatch.vercel.app';

const hostname = window.location.hostname;
const port = window.location.port;

const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(hostname);
const IS_VERCEL_HOST = hostname.endsWith('.vercel.app');

// Solo utilizar backend local si estamos ejecutando Vercel Dev.
const IS_VERCEL_DEV = IS_LOCAL && port === '3000';

const FUNCTIONS_BASE = IS_VERCEL_DEV
    ? ''
    : IS_VERCEL_HOST
        ? ''
        : VERCEL_BASE;

const FIRMS_FUNCTION_URL = `${FUNCTIONS_BASE}/api/getFirmsData`;

console.info(
    `[FireWatch] Backend: ${
        IS_VERCEL_DEV ? 'VERCEL DEV' :
        IS_VERCEL_HOST ? 'VERCEL PRODUCCIÓN' :
        IS_LOCAL ? 'BACKEND REMOTO' :
        'PRODUCCIÓN'
    } → ${FIRMS_FUNCTION_URL}`
);