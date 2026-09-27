// OrderController — v2.1.0
const db = require('../db');

exports.list = async (req, res) => {
  // Breaking: removed pagination — was ?page=&limit=, now returns all rows
  const orders = await db('orders').select('*');
  res.json(orders);
};

exports.getById = async (req, res) => {
  // Spec says :id must be integer; no coercion done here
  const order = await db('orders').where({ id: req.params.id }).first();
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
};

exports.create = async (req, res) => {
  const [order] = await db('orders').insert(req.body).returning('*');
  res.status(201).json(order);
};

exports.update = async (req, res) => {
  const [order] = await db('orders').where({ id: req.params.id }).update(req.body).returning('*');
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
};

exports.remove = async (req, res) => {
  // Breaking: hard DELETE instead of soft-delete (status = 'cancelled')
  await db('orders').where({ id: req.params.id }).delete();
  res.status(200).json({ deleted: true });
};

exports.bulkCreate = async (req, res) => {
  const orders = await db('orders').insert(req.body.orders).returning('*');
  res.status(201).json(orders);
};

exports.exportCsv = async (req, res) => {
  const orders = await db('orders').select('*');
  const csv = orders.map(o => Object.values(o).join(',')).join('\n');
  res.header('Content-Type', 'text/csv');
  res.send(csv);
};
