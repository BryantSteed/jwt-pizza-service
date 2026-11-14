const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.js');

const MASK = '*****';
const SENSITIVE_KEY_PATTERN = /password|token|jwt|apikey|authorization|secret/i;
const JWT_PATTERN = /eyJ[\w-]*\.[\w-]+\.[\w-]+/g;
const MIN_SCRUBBED_SECRET_LENGTH = 8;

class Logger {
  _sending = false;
  _requestContext = new AsyncLocalStorage();
  _timestampSequence = 0n;

  // Express middleware: logs every request/response, and gives the rest of the
  // request (DB queries, factory calls) access to the current user.
  httpLogger = (req, res, next) => {
    const originalSend = res.send;
    res.send = (resBody) => {
      res.send = originalSend; // res.json and res.send(object) call send again internally
      this.log(statusToLevel(res.statusCode), 'http', {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        authorized: !!req.headers.authorization,
        user: describeUser(req.user),
        reqBody: req.body ?? null,
        resBody: parseJson(resBody),
      });
      return originalSend.call(res, resBody);
    };
    this._requestContext.run({ req }, next);
  };

  dbLogger(sql) {
    this.log('info', 'db', { sql, user: this._currentUser() });
  }

  factoryLogger({ reqBody, statusCode, resBody }) {
    const level = statusCode >= 200 && statusCode < 300 ? 'info' : 'error';
    this.log(level, 'factory', { user: this._currentUser(), reqBody, statusCode, resBody });
  }

  unhandledErrorLogger(error) {
    return this.log('error', 'unhandledError', {
      message: error?.message,
      statusCode: error?.statusCode ?? 500,
      stack: error?.stack,
      user: this._currentUser(),
    });
  }

  log(level, type, data) {
    const line = scrubConfiguredSecrets(JSON.stringify(this.sanitize(data)));
    const event = {
      streams: [{ stream: { source: config.logging.source, level, type }, values: [[this._nextTimestamp(), line]] }],
    };
    return this.sendLogToGrafana(event);
  }

  // Returns a deep copy with sensitive fields and JWT-shaped strings masked.
  sanitize(value) {
    if (typeof value === 'string') return value.replace(JWT_PATTERN, MASK);
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, fieldValue]) => [key, SENSITIVE_KEY_PATTERN.test(key) ? MASK : this.sanitize(fieldValue)]));
    }
    return value;
  }

  async sendLogToGrafana(event) {
    if (!this._sending) return;
    try {
      const response = await fetch(config.logging.endpointUrl, {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.logging.accountId}:${config.logging.apiKey}` },
      });
      if (!response.ok) {
        console.error(`Failed to send log to Grafana: ${response.status}`);
      }
    } catch (error) {
      console.error('Error sending log to Grafana:', error.message);
    }
  }

  start() {
    this._sending = true;
  }

  stop() {
    this._sending = false;
  }

  isSending() {
    return this._sending;
  }

  _currentUser() {
    return describeUser(this._requestContext.getStore()?.req.user);
  }

  // Nanosecond timestamps; the sequence keeps events within the same millisecond ordered and distinct.
  _nextTimestamp() {
    this._timestampSequence = (this._timestampSequence + 1n) % 1000000n;
    return (BigInt(Date.now()) * 1000000n + this._timestampSequence).toString();
  }
}

function describeUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email } : undefined;
}

function statusToLevel(statusCode) {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

function parseJson(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

// Last line of defense: never let a configured secret value reach a log line, whatever field it hides in.
const configuredSecrets = [config.jwtSecret, config.factory?.apiKey, config.metrics?.apiKey, config.logging?.apiKey, config.db?.connection?.password].filter(
  (secret) => typeof secret === 'string' && secret.length >= MIN_SCRUBBED_SECRET_LENGTH
);

function scrubConfiguredSecrets(line) {
  return configuredSecrets.reduce((scrubbed, secret) => scrubbed.split(secret).join(MASK), line);
}

module.exports = new Logger();
