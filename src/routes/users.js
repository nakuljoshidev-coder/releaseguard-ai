const express = require('express');
const router = express.Router();
const UserController = require('../controllers/UserController');
const { validateIntId } = require('../middleware/validate');

// GET /api/v1/users/:id
router.get('/:id', validateIntId, UserController.getById);

// POST /api/v1/users — requires { username, email, role }
router.post('/', UserController.create);

// PATCH /api/v1/users/:id
router.patch('/:id', validateIntId, UserController.update);

// DELETE /api/v1/users/:id — returns 204 No Content per REST convention
router.delete('/:id', validateIntId, UserController.remove);

module.exports = router;
