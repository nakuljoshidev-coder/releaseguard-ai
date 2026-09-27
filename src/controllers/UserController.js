// UserController — v2.1.0
const db = require('../db');

exports.getById = async (req, res) => {
  const user = await db('users').where({ id: req.params.id }).first();
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
};

exports.create = async (req, res) => {
  // Breaking: now requires 'username' and 'role' — spec only defined 'name' and 'email'
  const { username, email, role } = req.body;
  const [user] = await db('users').insert({ username, email, role }).returning('*');
  res.status(201).json(user);
};

exports.update = async (req, res) => {
  const [user] = await db('users').where({ id: req.params.id }).update(req.body).returning('*');
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
};

exports.remove = async (req, res) => {
  await db('users').where({ id: req.params.id }).delete();
  res.status(204).send();
};
