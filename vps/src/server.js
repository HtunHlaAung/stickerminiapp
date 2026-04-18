'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');
const winston    = require('winston');

// ── Logger ─────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: '/var/log/stickerminiapp/error.log', level: 'error' }),
    new winston.transports.File({ filename: '/var/log/stickerminiapp/combined.log' }),
  ],
});

// ── Ensure directories ──────────────────────────────────────────────────────
[
  process.env.TEMPLATES_DIR || '/var/stickerminiapp/templates',
  process.env.EXPORTS_DIR   || '/var/stickerminiapp/exports',
  '/var/log/stickerminiapp',
].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

// ── App ────────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  message:  { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use(limiter);

// ── Auth Middleware ──────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  const secret = req.headers['x-secret'];
  if (!secret || secret !== process.env.VPS_SECRET) {
    logger.warn(`Unauthorized VPS access from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Routes ──────────────────────────────────────────────────────────────────
const generateRoute   = require('./routes/generate');
const templatesRoute  = require('./routes/templates');
const notifyRoute     = require('./routes/notify');

app.use('/generate',  requireSecret, generateRoute);
app.use('/templates', requireSecret, templatesRoute);
app.use('/notify',    requireSecret, notifyRoute);

// Health check (no auth)
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Error handler
app.use((err, req, res, next) => {
  logger.error(`${err.message}\n${err.stack}`);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`VPS server running on port ${PORT}`);
  // Init bot
  require('./bot').init();
});

module.exports = app;
