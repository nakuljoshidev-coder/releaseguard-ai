const express = require('express');
const ordersRouter = require('./routes/orders');
const usersRouter = require('./routes/users');
const productsRouter = require('./routes/products');
const adminRouter = require('./routes/admin');

const app = express();
app.use(express.json());

// Public API v1 routes
app.use('/api/v1/orders', ordersRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/products', productsRouter);

// Internal admin routes — NOT in OpenAPI spec (intentionally undocumented for audit demo)
app.use('/internal/admin', adminRouter);

// Health check — NOT in OpenAPI spec
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.1.0' }));

// Deprecated v1 endpoint kept for backwards compat — missing from spec
app.get('/api/v1/ping', (req, res) => res.json({ pong: true }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = app;
