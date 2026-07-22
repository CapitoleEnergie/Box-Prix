'use strict';
/**
 * Point d'entrée serverless Vercel (catch-all sur /api/*).
 * Routes définies dans lib/api-handler.js — code partagé avec server.js (dev local).
 */
const apiHandler = require('../lib/api-handler');

module.exports = async (req, res) => {
  const handled = await apiHandler.handle(req, res);
  if (handled) return;
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: 'route inconnue' }));
};
