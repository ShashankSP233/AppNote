import session from 'express-session';

/** Persist browser sessions in AppNote's PostgreSQL database across restarts. */
export class PgSessionStore extends session.Store {
  constructor({ pool, ttlMs = 12 * 60 * 60 * 1000, pruneIntervalMs = 60 * 60 * 1000 }) {
    super();
    this.pool = pool;
    this.ttlMs = ttlMs;
    this.pruneTimer = setInterval(() => {
      this.pool.query('DELETE FROM app_sessions WHERE expire <= now()').catch((error) => {
        console.error('[session] expired-session cleanup failed:', error.message);
      });
    }, pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  expiryFor(sess) {
    const cookieExpiry = sess?.cookie?.expires ? new Date(sess.cookie.expires) : null;
    return cookieExpiry && Number.isFinite(cookieExpiry.getTime())
      ? cookieExpiry
      : new Date(Date.now() + this.ttlMs);
  }

  get(sid, callback = () => {}) {
    this.pool.query('SELECT sess FROM app_sessions WHERE sid = $1 AND expire > now()', [sid])
      .then(({ rows }) => callback(null, rows[0]?.sess || null))
      .catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    this.pool.query(
      `INSERT INTO app_sessions (sid, sess, expire)
       VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, sess, this.expiryFor(sess)],
    ).then(() => callback(null)).catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    this.pool.query(
      `UPDATE app_sessions SET sess = $2, expire = $3 WHERE sid = $1`,
      [sid, sess, this.expiryFor(sess)],
    ).then(() => callback(null)).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.pool.query('DELETE FROM app_sessions WHERE sid = $1', [sid])
      .then(() => callback(null)).catch(callback);
  }

  length(callback = () => {}) {
    this.pool.query('SELECT count(*)::int AS count FROM app_sessions WHERE expire > now()')
      .then(({ rows }) => callback(null, rows[0].count)).catch(callback);
  }

  clear(callback = () => {}) {
    this.pool.query('DELETE FROM app_sessions')
      .then(() => callback(null)).catch(callback);
  }

  close() {
    clearInterval(this.pruneTimer);
  }
}
