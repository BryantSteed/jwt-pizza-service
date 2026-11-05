const { EventEmitter } = require('events');
const request = require('supertest');
const config = require('./config.js');
const metrics = require('./metrics.js');

// snapshot() returns [{ name, value, type: 'sum' | 'gauge', unit, attributes }]
function find(name, attributes = {}) {
  return metrics.snapshot().find((m) => m.name === name && Object.entries(attributes).every(([k, v]) => m.attributes?.[k] === v));
}

function valueOf(name, attributes) {
  return find(name, attributes)?.value ?? 0;
}

// Drive requestTracker with a fake request/response pair.
function track(method, user = undefined) {
  const req = { method, user, originalUrl: '/api/test' };
  const res = new EventEmitter();
  res.statusCode = 200;
  const next = jest.fn();
  metrics.requestTracker(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  res.emit('finish');
}

beforeEach(() => {
  metrics.reset();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('http requests', () => {
  test('counts requests by method', () => {
    track('GET');
    track('GET');
    track('POST');
    track('PUT');
    track('DELETE');

    expect(valueOf('http_requests', { method: 'GET' })).toBe(2);
    expect(valueOf('http_requests', { method: 'POST' })).toBe(1);
    expect(valueOf('http_requests', { method: 'PUT' })).toBe(1);
    expect(valueOf('http_requests', { method: 'DELETE' })).toBe(1);
  });

  test('counts total requests', () => {
    track('GET');
    track('POST');
    track('DELETE');

    expect(valueOf('http_requests', { method: 'ALL' })).toBe(3);
  });

  test('records endpoint latency', () => {
    track('GET');

    const latency = find('service_latency');
    expect(latency).toBeDefined();
    expect(latency.type).toBe('gauge');
    expect(latency.unit).toBe('ms');
    expect(latency.value).toBeGreaterThanOrEqual(0);
  });

  test('service app is instrumented with requestTracker', async () => {
    const app = require('./service.js');
    await request(app).get('/');
    await require('./database/database.js').DB.initialized; // let background DB setup finish before jest tears down

    expect(valueOf('http_requests', { method: 'GET' })).toBe(1);
    expect(valueOf('http_requests', { method: 'ALL' })).toBe(1);
  });
});

describe('active users', () => {
  test('counts distinct authenticated users', () => {
    track('GET', { id: 1 });
    track('GET', { id: 2 });
    track('POST', { id: 1 });
    track('GET'); // anonymous requests do not count

    const active = find('active_users');
    expect(active.type).toBe('gauge');
    expect(active.value).toBe(2);
  });

  test('users expire after five minutes of inactivity', () => {
    jest.useFakeTimers({ now: new Date('2026-11-04T12:00:00Z') });
    track('GET', { id: 1 });
    jest.setSystemTime(new Date('2026-11-04T12:03:00Z'));
    track('GET', { id: 2 });

    jest.setSystemTime(new Date('2026-11-04T12:05:30Z'));
    expect(valueOf('active_users')).toBe(1);

    jest.setSystemTime(new Date('2026-11-04T12:08:30Z'));
    expect(valueOf('active_users')).toBe(0);
  });
});

describe('authentication attempts', () => {
  test('counts successful and failed attempts', () => {
    metrics.authAttempt(true);
    metrics.authAttempt(true);
    metrics.authAttempt(false);

    expect(valueOf('auth_attempts', { status: 'success' })).toBe(2);
    expect(valueOf('auth_attempts', { status: 'failure' })).toBe(1);
    expect(find('auth_attempts', { status: 'success' }).type).toBe('sum');
  });
});

describe('system', () => {
  test('reports cpu and memory usage percentages', () => {
    for (const name of ['cpu_usage', 'memory_usage']) {
      const m = find(name);
      expect(m).toBeDefined();
      expect(m.type).toBe('gauge');
      expect(m.unit).toBe('%');
      expect(m.value).toBeGreaterThanOrEqual(0);
      expect(m.value).toBeLessThanOrEqual(100);
    }
  });
});

describe('pizza purchases', () => {
  test('successful purchase records pizzas sold and revenue', () => {
    metrics.pizzaPurchase(true, 120, 0.05, 2);
    metrics.pizzaPurchase(true, 80, 0.0042, 1);

    expect(valueOf('pizzas_sold')).toBe(3);
    expect(valueOf('pizza_revenue')).toBeCloseTo(0.0542, 6);
    expect(valueOf('pizza_creation_failures')).toBe(0);
  });

  test('failed purchase records a failure and no revenue', () => {
    metrics.pizzaPurchase(false, 2500, 0, 22);

    expect(valueOf('pizza_creation_failures')).toBe(1);
    expect(valueOf('pizzas_sold')).toBe(0);
    expect(valueOf('pizza_revenue')).toBe(0);
  });

  test('records pizza creation latency for success and failure', () => {
    metrics.pizzaPurchase(true, 100, 0.05, 1);
    metrics.pizzaPurchase(false, 300, 0, 1);

    const latency = find('pizza_creation_latency');
    expect(latency.type).toBe('gauge');
    expect(latency.unit).toBe('ms');
    expect(latency.value).toBe(200); // average since last report
  });
});

describe('sending to grafana', () => {
  test('posts an OTLP payload tagged with the configured source', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => '' });
    metrics.authAttempt(true);

    await metrics.sendMetrics();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(config.metrics.endpointUrl);
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe(`Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`);

    const body = JSON.parse(options.body);
    const resourceAttrs = body.resourceMetrics[0].resource.attributes;
    expect(resourceAttrs).toContainEqual({ key: 'service.name', value: { stringValue: config.metrics.source } });

    const names = body.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['http_requests', 'active_users', 'auth_attempts', 'cpu_usage', 'memory_usage', 'pizzas_sold', 'pizza_creation_failures', 'pizza_revenue', 'service_latency', 'pizza_creation_latency']));
  });

  test('does not throw when grafana is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(metrics.sendMetrics()).resolves.not.toThrow();
  });

  test('does not start periodic reporting under jest', () => {
    expect(metrics.isReporting()).toBe(false);
  });
});
