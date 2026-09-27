const express = require('express');
const router = express.Router();
const OrderController = require('../controllers/OrderController');
const { validateOrder, validateBulkOrders, validateIntId } = require('../middleware/validate');

// GET /api/v1/orders — returns all orders
router.get('/', OrderController.list);

// GET /api/v1/orders/export/csv — must be registered before /:id to avoid param capture
router.get('/export/csv', OrderController.exportCsv);

// GET /api/v1/orders/:id
router.get('/:id', validateIntId, OrderController.getById);

// POST /api/v1/orders — create new order
router.post('/', validateOrder, OrderController.create);

// POST /api/v1/orders/bulk — bulk create with full validation
router.post('/bulk', validateBulkOrders, OrderController.bulkCreate);

// PUT /api/v1/orders/:id — full update
router.put('/:id', validateIntId, validateOrder, OrderController.update);

// DELETE /api/v1/orders/:id
router.delete('/:id', validateIntId, OrderController.remove);

module.exports = router;
