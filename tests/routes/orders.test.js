const request = require('supertest');
const app = require('../../src/app');

describe('Orders API', () => {
  describe('GET /api/v1/orders', () => {
    it('should return 200 with array', async () => {
      const res = await request(app).get('/api/v1/orders');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/v1/orders/:id', () => {
    it('should return 404 for unknown id', async () => {
      const res = await request(app).get('/api/v1/orders/9999');
      expect(res.status).toBe(404);
    });

    it('should return 400 for non-integer id', async () => {
      const res = await request(app).get('/api/v1/orders/abc');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/orders/export/csv', () => {
    it('should return 200 with text/csv content-type', async () => {
      const res = await request(app).get('/api/v1/orders/export/csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
    });
  });

  describe('POST /api/v1/orders', () => {
    it('should return 400 when body is missing required fields', async () => {
      const res = await request(app).post('/api/v1/orders').send({});
      expect(res.status).toBe(400);
    });

    it('should return 201 with valid body', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .send({ user_id: 1, product_id: 1, quantity: 2 });
      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/v1/orders/bulk', () => {
    it('should return 400 when orders array is missing', async () => {
      const res = await request(app).post('/api/v1/orders/bulk').send({});
      expect(res.status).toBe(400);
    });

    it('should return 400 when orders array is empty', async () => {
      const res = await request(app)
        .post('/api/v1/orders/bulk')
        .send({ orders: [] });
      expect(res.status).toBe(400);
    });

    it('should return 400 when an order in the batch is invalid', async () => {
      const res = await request(app)
        .post('/api/v1/orders/bulk')
        .send({ orders: [{ user_id: 1 }] }); // missing product_id and quantity
      expect(res.status).toBe(400);
    });

    it('should return 201 with a valid batch', async () => {
      const res = await request(app)
        .post('/api/v1/orders/bulk')
        .send({
          orders: [
            { user_id: 1, product_id: 1, quantity: 2 },
            { user_id: 2, product_id: 3, quantity: 1 },
          ],
        });
      expect(res.status).toBe(201);
    });
  });

  describe('DELETE /api/v1/orders/:id', () => {
    it('should return 200 on delete', async () => {
      const res = await request(app).delete('/api/v1/orders/1');
      expect(res.status).toBe(200);
    });

    it('should return 400 for non-integer id', async () => {
      const res = await request(app).delete('/api/v1/orders/abc');
      expect(res.status).toBe(400);
    });
  });
});
