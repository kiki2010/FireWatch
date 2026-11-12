// harmonize.js

// Metadatos por producto FIRMS (NRT = tiempo casi real, SP = procesamiento estándar).
const SENSOR_META = {
    VIIRS_SNPP_NRT:   { instrument: 'VIIRS', resolutionM: 375,  since: 2012, confidence: 'l/n/h' },
    VIIRS_SNPP_SP:    { instrument: 'VIIRS', resolutionM: 375,  since: 2012, confidence: 'l/n/h' },
    VIIRS_NOAA20_NRT: { instrument: 'VIIRS', resolutionM: 375,  since: 2018, confidence: 'l/n/h' },
    VIIRS_NOAA20_SP:  { instrument: 'VIIRS', resolutionM: 375,  since: 2018, confidence: 'l/n/h' },
    VIIRS_NOAA21_NRT: { instrument: 'VIIRS', resolutionM: 375,  since: 2023, confidence: 'l/n/h' },
    VIIRS_NOAA21_SP:  { instrument: 'VIIRS', resolutionM: 375,  since: 2023, confidence: 'l/n/h' },
    MODIS_NRT:        { instrument: 'MODIS', resolutionM: 1000, since: 2000, confidence: '0-100' },
    MODIS_SP:         { instrument: 'MODIS', resolutionM: 1000, since: 2000, confidence: '0-100' }
};

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

// Agregación diaria
// FIRMS no devuelve filas para los días sin focos, así que rellenamos
// con ceros todo el rango. Si no, los promedios y anomalías quedan sesgados.
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

// Agregación mensual
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

// Anomalías estacionales
// Compara cada mes con el promedio de ese mismo mes en todos los años
// disponibles (incluido el mes evaluado). Necesita al menos 3 años;
// con menos, zscore queda en null.
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
        const enough = s.n >= 3 && s.std > 0;

        return {
            ...m,
            baseline: s.mean,
            n: s.n,
            anomaly: m[field] - s.mean,
            zscore: enough ? (m[field] - s.mean) / s.std : null
        };
    });
}

// Comparación de sensores
// Ambas series deben construirse con el mismo startDate/endDate.
// VIIRS (375 m) detecta muchos más focos que MODIS (1 km): los conteos
// absolutos no son comparables, pero la correlación y el ratio sí informan.
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