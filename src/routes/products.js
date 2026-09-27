const express = require('express');
const router = express.Router();
const ProductController = require('../controllers/ProductController');

// GET /api/v1/products
router.get('/', ProductController.list);

// GET /api/v1/products/:id
router.get('/:id', ProductController.getById);

// POST /api/v1/products
router.post('/', ProductController.create);

// PATCH /api/v1/products/:id
router.patch('/:id', ProductController.update);

module.exports = router;
