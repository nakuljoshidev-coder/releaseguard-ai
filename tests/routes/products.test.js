const request = require('supertest');
const app = require('../../src/app');

describe('Products API', () => {
  describe('GET /api/v1/products', () => {
    it('should return 200', async () => {
      const res = await request(app).get('/api/v1/products');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v1/products/:id', () => {
    it('should return 404 for unknown id', async () => {
      const res = await request(app).get('/api/v1/products/9999');
      expect(res.status).toBe(404);
    });
  });
});
