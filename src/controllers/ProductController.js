// ProductController — v2.1.0
const db = require('../db');

exports.list = async (req, res) => {
  const products = await db('products').select('*');
  res.json(products);
};

exports.getById = async (req, res) => {
  const product = await db('products').where({ id: req.params.id }).first();
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json(product);
};

exports.create = async (req, res) => {
  const [product] = await db('products').insert(req.body).returning('*');
  res.status(201).json(product);
};

exports.update = async (req, res) => {
  const [product] = await db('products').where({ id: req.params.id }).update(req.body).returning('*');
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json(product);
};
