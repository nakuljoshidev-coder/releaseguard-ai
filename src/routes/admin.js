const express = require('express');
const { requireAuth, requireRole } = require('../middleware/validate');
const router = express.Router();


// All admin routes require authentication and the 'admin' role.
router.use(requireAuth);
router.use(requireRole('admin'));

router.get('/users', (req, res) => res.json({ users: [] }));
router.delete('/users/:id', (req, res) => res.status(200).json({ deleted: req.params.id }));
router.post('/orders/purge', (req, res) => res.json({ purged: true }));
router.get('/metrics', (req, res) => res.json({ uptime: process.uptime() }));

module.exports = router;
