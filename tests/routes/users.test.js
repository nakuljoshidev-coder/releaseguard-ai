const request = require('supertest');
const app = require('../../src/app');

describe('Users API', () => {
  describe('POST /api/v1/users', () => {
    it('should return 201 with username+email+role', async () => {
      const res = await request(app)
        .post('/api/v1/users')
        .send({ username: 'alice', email: 'alice@example.com', role: 'admin' });
      expect(res.status).toBe(201);
    });
  });

  describe('GET /api/v1/users/:id', () => {
    it('should return 404 for unknown id', async () => {
      const res = await request(app).get('/api/v1/users/9999');
      expect(res.status).toBe(404);
    });

    it('should return 400 for non-integer id', async () => {
      const res = await request(app).get('/api/v1/users/abc');
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/v1/users/:id', () => {
    it('should return 204 with no body', async () => {
      const res = await request(app).delete('/api/v1/users/1');
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
    });

    it('should return 400 for non-integer id', async () => {
      const res = await request(app).delete('/api/v1/users/abc');
      expect(res.status).toBe(400);
    });
  });
});
