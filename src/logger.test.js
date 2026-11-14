const request = require('supertest');
const config = require('./config.js');
const logger = require('./logger.js');
const app = require('./service.js');
const { DB, Role } = require('./database/database.js');

// Every log event is a Loki push body: { streams: [{ stream: labels, values: [[timestampNs, line]] }] }
let capturedLogs;

function captureLogs() {
  capturedLogs = [];
  jest.spyOn(logger, 'sendLogToGrafana').mockImplementation((event) => {
    for (const stream of event.streams) {
      for (const [timestamp, line] of stream.values) {
        capturedLogs.push({ labels: stream.stream, timestamp, line, data: JSON.parse(line) });
      }
    }
  });
}

function logsOfType(type) {
  return capturedLogs.filter((log) => log.labels.type === type);
}

let adminUser, adminToken, dinerUser, dinerToken, menuItem, franchise, store;

beforeAll(async () => {
  adminUser = await createUser([{ role: Role.Admin }]);
  adminToken = await login(adminUser);
  dinerUser = await createUser([{ role: Role.Diner }]);
  dinerToken = await login(dinerUser);

  const menuRes = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: randomName(), description: 'log test pizza', image: 'pizza1.png', price: 0.05 });
  menuItem = menuRes.body[menuRes.body.length - 1];

  const franchiseRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: randomName(), admins: [{ email: adminUser.email }] });
  franchise = franchiseRes.body;

  const storeRes = await request(app).post(`/api/franchise/${franchise.id}/store`).set('Authorization', `Bearer ${adminToken}`).send({ name: randomName() });
  store = storeRes.body;
});

beforeEach(() => {
  captureLogs();
});

afterEach(() => {
  jest.restoreAllMocks();
  logger.stop();
});

describe('log event format', () => {
  test('events carry component, level, and type labels with a nanosecond timestamp', () => {
    logger.log('info', 'test', { hello: 'world' });

    expect(capturedLogs).toHaveLength(1);
    const [log] = capturedLogs;
    expect(log.labels).toEqual({ component: config.logging.source, level: 'info', type: 'test' });
    expect(log.timestamp).toMatch(/^\d{19}$/);
    expect(log.data).toEqual({ hello: 'world' });
  });
});

describe('http logging', () => {
  test('logs method, path, status, auth header presence, and bodies', async () => {
    const res = await request(app).get('/api/order/menu');
    expect(res.status).toBe(200);

    const [log] = logsOfType('http');
    expect(log.labels.level).toBe('info');
    expect(log.data).toMatchObject({ method: 'GET', path: '/api/order/menu', statusCode: 200, authorized: false });
    expect(log.data).toHaveProperty('reqBody');
    expect(log.data.resBody).toEqual(res.body);
    expect(log.data.user).toBeUndefined();
  });

  test('logs the authenticated user', async () => {
    await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);

    const [log] = logsOfType('http');
    expect(log.data.authorized).toBe(true);
    expect(log.data.user).toMatchObject({ id: dinerUser.id, email: dinerUser.email });
  });

  test('logs the request body', async () => {
    await request(app).post('/api/auth').send({ name: 'no email' });

    const [log] = logsOfType('http');
    expect(log.data.reqBody).toEqual({ name: 'no email' });
  });

  test('4xx responses log at warn level', async () => {
    await request(app).get('/api/nope');

    const [log] = logsOfType('http');
    expect(log.data.statusCode).toBe(404);
    expect(log.labels.level).toBe('warn');
  });

  test('5xx responses log at error level', async () => {
    jest.spyOn(DB, 'getMenu').mockRejectedValue(new Error('menu exploded'));
    await request(app).get('/api/order/menu');

    const [log] = logsOfType('http');
    expect(log.data.statusCode).toBe(500);
    expect(log.labels.level).toBe('error');
  });
});

describe('database logging', () => {
  test('logs sql queries', async () => {
    await request(app).get('/api/order/menu');

    const sqls = logsOfType('db').map((log) => log.data.sql);
    expect(sqls).toContain('SELECT * FROM menu');
  });

  test('logs the authenticated user making the query', async () => {
    await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);

    const orderQuery = logsOfType('db').find((log) => log.data.sql.includes('FROM dinerOrder'));
    expect(orderQuery.data.user).toMatchObject({ id: dinerUser.id });
  });

  test('does not log query parameters', async () => {
    await login(dinerUser);

    for (const log of logsOfType('db')) {
      expect(log.data).not.toHaveProperty('params');
    }
  });
});

describe('factory logging', () => {
  test('logs the factory request, response, and user', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ reportUrl: 'http://report', jwt: 'factory.signed.jwt' }) });
    const items = [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }];

    await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send({ franchiseId: franchise.id, storeId: store.id, items });

    const [log] = logsOfType('factory');
    expect(log.data.user).toMatchObject({ id: dinerUser.id });
    expect(log.data.reqBody.order.items).toEqual([expect.objectContaining({ menuId: menuItem.id })]);
    expect(log.data.statusCode).toBe(200);
    expect(log.data.resBody.reportUrl).toBe('http://report');
    expect(log.data.resBody.jwt).toBe('*****');
  });

  test('failed factory requests log at error level', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({ message: 'too many pizzas', reportUrl: 'http://report' }) });
    const items = [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }];

    await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send({ franchiseId: franchise.id, storeId: store.id, items });

    const [log] = logsOfType('factory');
    expect(log.labels.level).toBe('error');
    expect(log.data.statusCode).toBe(500);
    expect(log.data.resBody.message).toBe('too many pizzas');
  });
});

describe('unhandled exception logging', () => {
  test('errors reaching the express error handler are logged', async () => {
    jest.spyOn(DB, 'getMenu').mockRejectedValue(new Error('menu exploded'));
    await request(app).get('/api/order/menu');

    const [log] = logsOfType('unhandledError');
    expect(log.labels.level).toBe('error');
    expect(log.data).toMatchObject({ message: 'menu exploded', statusCode: 500 });
    expect(log.data.stack).toEqual(expect.any(String));
  });

  test('unhandledErrorLogger can be called directly', () => {
    logger.unhandledErrorLogger(new Error('process level failure'));

    const [log] = logsOfType('unhandledError');
    expect(log.data.message).toBe('process level failure');
  });
});

describe('sanitizing', () => {
  test('masks sensitive keys at any depth, case-insensitively', () => {
    const sanitized = logger.sanitize({
      email: 'd@jwt.com',
      password: 'diner',
      token: 'abc',
      nested: { apiKey: 'k', Authorization: 'Bearer x', jwtSecret: 's', list: [{ jwt: 'j', name: 'keep me' }] },
    });

    expect(sanitized).toEqual({
      email: 'd@jwt.com',
      password: '*****',
      token: '*****',
      nested: { apiKey: '*****', Authorization: '*****', jwtSecret: '*****', list: [{ jwt: '*****', name: 'keep me' }] },
    });
  });

  test('masks JWT-shaped strings wherever they appear', () => {
    const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2lnbmF0dXJlLWJ5dGVz';
    expect(logger.sanitize({ note: `token was ${jwtLike}` })).toEqual({ note: 'token was *****' });
  });

  test('does not modify the original object', () => {
    const original = { password: 'diner' };
    logger.sanitize(original);
    expect(original.password).toBe('diner');
  });

  test('login and register logs do not contain passwords or tokens', async () => {
    const registerUser = { name: 'log tester', email: randomName() + '@test.com', password: 'super-secret-pw' };
    const registerRes = await request(app).post('/api/auth').send(registerUser);
    await request(app).put('/api/auth').send({ email: registerUser.email, password: registerUser.password });

    const allLines = capturedLogs.map((log) => log.line).join('\n');
    expect(allLines).not.toContain('super-secret-pw');
    expect(allLines).not.toContain(registerRes.body.token);

    const [registerLog] = logsOfType('http');
    expect(registerLog.data.reqBody.password).toBe('*****');
    expect(registerLog.data.resBody.token).toBe('*****');
  });

  test('logs never contain configured secrets', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ reportUrl: 'http://report', jwt: 'x.y.z' }) });
    const items = [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }];
    await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send({ franchiseId: franchise.id, storeId: store.id, items });
    await request(app).get('/api/docs');
    await login(adminUser);

    const secrets = {
      jwtSecret: config.jwtSecret,
      'factory.apiKey': config.factory.apiKey,
      'logging.apiKey': config.logging.apiKey,
      'metrics.apiKey': config.metrics.apiKey,
      'db.connection.password': config.db.connection.password,
    };
    // An empty secret means a missing CI secret, and would make every not.toContain check below meaningless.
    const emptySecrets = Object.keys(secrets).filter((name) => !secrets[name]);
    expect(emptySecrets).toEqual([]);

    const allLines = capturedLogs.map((log) => log.line).join('\n');
    const leakedSecrets = Object.keys(secrets).filter((name) => allLines.includes(secrets[name]));
    expect(leakedSecrets).toEqual([]);
    expect(allLines).not.toContain(dinerToken);
    expect(allLines).not.toContain(adminToken);
  });
});

describe('sending to grafana', () => {
  test('nothing is sent until the logger is started', async () => {
    jest.restoreAllMocks(); // use the real sendLogToGrafana
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });

    expect(logger.isSending()).toBe(false);
    logger.log('info', 'test', { quiet: true });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('once started, pushes events to loki with account credentials', async () => {
    jest.restoreAllMocks();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });

    logger.start();
    expect(logger.isSending()).toBe(true);
    logger.log('info', 'test', { loud: true });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(config.logging.endpointUrl);
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe(`Bearer ${config.logging.accountId}:${config.logging.apiKey}`);
    const body = JSON.parse(options.body);
    expect(body.streams[0].stream).toEqual({ component: config.logging.source, level: 'info', type: 'test' });
    expect(JSON.parse(body.streams[0].values[0][1])).toEqual({ loud: true });
  });

  test('a failed push does not throw', async () => {
    jest.restoreAllMocks();
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('loki down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    logger.start();
    expect(() => logger.log('info', 'test', {})).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

async function createUser(roles) {
  const user = { name: randomName(), email: randomName() + '@test.com', password: 'toomanysecrets', roles };
  const createdUser = await DB.addUser(user);
  return { ...createdUser, password: user.password };
}

async function login(user) {
  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  return loginRes.body.token;
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}
