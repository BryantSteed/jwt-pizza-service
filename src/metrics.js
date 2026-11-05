const os = require('os');
const config = require('./config.js');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const startTimeUnixNano = toUnixNano(Date.now());

let state;
let reportTimer = null;

function reset() {
  state = {
    httpRequests: Object.fromEntries([...HTTP_METHODS, 'ALL'].map((method) => [method, 0])),
    activeUsers: new Map(), // userId -> last seen (ms)
    authAttempts: { success: 0, failure: 0 },
    pizzasSold: 0,
    pizzaFailures: 0,
    revenue: 0,
    // Latencies are averaged over each reporting period, then cleared.
    serviceLatency: newAverage(),
    pizzaLatency: newAverage(),
  };
}
reset();

// Express middleware: counts requests, endpoint latency, and active users.
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();
  if (req.user?.id !== undefined) {
    state.activeUsers.set(req.user.id, Date.now());
  }

  res.on('finish', () => {
    const method = req.method?.toUpperCase();
    if (method in state.httpRequests) {
      state.httpRequests[method]++;
    }
    state.httpRequests.ALL++;
    addToAverage(state.serviceLatency, Number(process.hrtime.bigint() - start) / 1e6);
  });

  next();
}

function authAttempt(success) {
  state.authAttempts[success ? 'success' : 'failure']++;
}

function pizzaPurchase(success, latencyMs, price, count) {
  if (success) {
    state.pizzasSold += count;
    state.revenue += price;
  } else {
    state.pizzaFailures++;
  }
  addToAverage(state.pizzaLatency, latencyMs);
}

// Current value of every metric: [{ name, value, type, unit, attributes }]
function snapshot() {
  const cutoff = Date.now() - ACTIVE_USER_WINDOW_MS;
  for (const [id, lastSeen] of state.activeUsers) {
    if (lastSeen <= cutoff) state.activeUsers.delete(id);
  }

  return [
    ...Object.entries(state.httpRequests).map(([method, value]) => sum('http_requests', value, '1', { method })),
    gauge('active_users', state.activeUsers.size, '1'),
    sum('auth_attempts', state.authAttempts.success, '1', { status: 'success' }),
    sum('auth_attempts', state.authAttempts.failure, '1', { status: 'failure' }),
    gauge('cpu_usage', getCpuUsagePercentage(), '%'),
    gauge('memory_usage', getMemoryUsagePercentage(), '%'),
    sum('pizzas_sold', state.pizzasSold, '1'),
    sum('pizza_creation_failures', state.pizzaFailures, '1'),
    sum('pizza_revenue', state.revenue, 'BTC'),
    gauge('service_latency', averageOf(state.serviceLatency), 'ms'),
    gauge('pizza_creation_latency', averageOf(state.pizzaLatency), 'ms'),
  ];
}

async function sendMetrics() {
  const body = JSON.stringify(buildOtlpPayload(snapshot()));
  state.serviceLatency = newAverage();
  state.pizzaLatency = newAverage();

  try {
    const res = await fetch(config.metrics.endpointUrl, {
      method: 'POST',
      body,
      headers: { Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.error(`Failed to push metrics to Grafana: ${res.status} ${await res.text()}`);
    }
  } catch (error) {
    console.error('Error pushing metrics to Grafana:', error.message);
  }
}

function startReporting(periodMs = 10000) {
  if (!reportTimer) {
    reportTimer = setInterval(sendMetrics, periodMs);
    reportTimer.unref();
  }
}

function stopReporting() {
  clearInterval(reportTimer);
  reportTimer = null;
}

function isReporting() {
  return reportTimer !== null;
}

// --- helpers ---

function buildOtlpPayload(metrics) {
  const now = toUnixNano(Date.now());
  const metricsByName = new Map();
  for (const metric of metrics) {
    if (!metricsByName.has(metric.name)) {
      const data = { dataPoints: [] };
      if (metric.type === 'sum') {
        data.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
        data.isMonotonic = true;
      }
      metricsByName.set(metric.name, { name: metric.name, unit: metric.unit, [metric.type]: data });
    }
    const point = {
      timeUnixNano: now,
      attributes: Object.entries(metric.attributes).map(([key, value]) => ({ key, value: { stringValue: value } })),
      ...(metric.type === 'sum' && metric.unit !== 'BTC' ? { asInt: metric.value } : { asDouble: metric.value }),
    };
    if (metric.type === 'sum') point.startTimeUnixNano = startTimeUnixNano;
    metricsByName.get(metric.name)[metric.type].dataPoints.push(point);
  }

  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: config.metrics.source } }] },
        scopeMetrics: [{ metrics: [...metricsByName.values()] }],
      },
    ],
  };
}

function sum(name, value, unit, attributes = {}) {
  return { name, value, type: 'sum', unit, attributes };
}

function gauge(name, value, unit, attributes = {}) {
  return { name, value, type: 'gauge', unit, attributes };
}

function newAverage() {
  return { total: 0, count: 0 };
}

function addToAverage(avg, value) {
  avg.total += value;
  avg.count++;
}

function averageOf(avg) {
  return avg.count ? avg.total / avg.count : 0;
}

function getCpuUsagePercentage() {
  const usage = (os.loadavg()[0] / os.cpus().length) * 100;
  return clampPercent(usage);
}

function getMemoryUsagePercentage() {
  return clampPercent(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value.toFixed(2))));
}

function toUnixNano(ms) {
  return (BigInt(ms) * 1000000n).toString();
}

module.exports = { requestTracker, authAttempt, pizzaPurchase, snapshot, sendMetrics, startReporting, stopReporting, isReporting, reset };
