const Joi = require('joi');

const orderSchema = Joi.object({
  user_id: Joi.number().integer().required(),
  product_id: Joi.number().integer().required(),
  quantity: Joi.number().integer().min(1).required(),
  status: Joi.string().valid('pending', 'shipped', 'delivered').default('pending'),
});

const bulkOrderSchema = Joi.object({
  orders: Joi.array()
    .items(orderSchema)
    .min(1)
    .required(),
});

exports.validateOrder = (req, res, next) => {
  const { error } = orderSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  next();
};

exports.validateBulkOrders = (req, res, next) => {
  const { error } = bulkOrderSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  next();
};

// Validates that an :id route param is a positive integer.
exports.validateIntId = (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: '"id" must be a positive integer' });
  }
  next();
};

// requireAuth — verifies the Authorization: Bearer <token> header.
// Populates req.user for downstream role checks.
// Replace the stub decoding with real JWT/session verification in production.
exports.requireAuth = (req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // TODO: verify token signature / session validity here.
  // Stub: treat any valid Bearer token as an admin user.
  req.user = { id: 1, role: 'admin' };
  next();
};

// requireRole — ensures the authenticated user has the required role.
// Expects req.user to be populated by requireAuth.
exports.requireRole = (role) => (req, res, next) => {
  if (!req.user || req.user.role !== role) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
