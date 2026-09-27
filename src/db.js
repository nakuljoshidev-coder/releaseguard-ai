// Stub DB — supports both db('table') and db.table knex-style call patterns.
// Real app would use knex connection pool.
const queryBuilder = () => ({
  select: () => Promise.resolve([]),
  where: () => ({
    first: () => Promise.resolve(null),
    update: () => ({ returning: () => Promise.resolve([]) }),
    delete: () => Promise.resolve(1),
  }),
  insert: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }),
});

// db('tableName') call style used by controllers
const db = new Proxy(queryBuilder, {
  get: (_target, prop) => {
    // Allow db.raw, db.destroy, etc. to exist as no-ops for knex compat
    if (prop === 'destroy') return () => Promise.resolve();
    return queryBuilder;
  },
});

module.exports = db;
