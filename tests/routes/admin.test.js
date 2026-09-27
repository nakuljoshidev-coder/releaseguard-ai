const request = require('supertest');
const app = require('../../src/app');

describe('Admin API — security', () => {
  const ADMIN_TOKEN = 'Bearer valid-admin-token';

  describe('GET /internal/admin/users', () => {
    it('should return 401 without credentials', async () => {
      const res = await request(app).get('/internal/admin/users');
      expect(res.status).toBe(401);
    });

    it('should return 401 with malformed Authorization header', async () => {
      const res = await request(app)
        .get('/internal/admin/users')
        .set('Authorization', 'notabearer');
      expect(res.status).toBe(401);
    });

    it('should return 200 with a valid Bearer token', async () => {
      const res = await request(app)
        .get('/internal/admin/users')
        .set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('users');
    });
  });

  describe('DELETE /internal/admin/users/:id', () => {
    it('should return 401 without credentials', async () => {
      const res = await request(app).delete('/internal/admin/users/1');
      expect(res.status).toBe(401);
    });

    it('should return 200 with a valid Bearer token', async () => {
      const res = await request(app)
        .delete('/internal/admin/users/1')
        .set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('deleted');
    });
  });

  describe('POST /internal/admin/orders/purge', () => {
    it('should return 401 without credentials', async () => {
      const res = await request(app).post('/internal/admin/orders/purge');
      expect(res.status).toBe(401);
    });

    it('should return 200 with a valid Bearer token', async () => {
      const res = await request(app)
        .post('/internal/admin/orders/purge')
        .set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('purged', true);
    });
  });

  describe('GET /internal/admin/metrics', () => {
    it('should return 401 without credentials', async () => {
      const res = await request(app).get('/internal/admin/metrics');
      expect(res.status).toBe(401);
    });

    it('should return 200 with a valid Bearer token', async () => {
      const res = await request(app)
        .get('/internal/admin/metrics')
        .set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('uptime');
    });
  });
});
