/**
 * JWT 认证中间件 + Token 黑名单管理
 * 策略：正常 JWT 验证 + 登出时写入黑名单
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('请先设置长度至少32字符的 JWT_SECRET 环境变量');
}
const JWT_EXPIRES = '7d';

/**
 * 计算 token 的唯一 hash（用于黑名单查询）
 */
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/**
 * 签发 JWT
 */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

/**
 * 使 token 失效（登出时调用）— 写入黑名单
 */
function revokeToken(token) {
  try {
    const decoded = jwt.decode(token);
    if (!decoded) return;
    const hash = tokenHash(token);
    // 用 sessions 表作为黑名单存储
    const { v4: uuidv4 } = require('uuid');
    db.prepare(`
      INSERT OR IGNORE INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(uuidv4(), decoded.userId || '', hash, new Date(decoded.exp * 1000).toISOString());
  } catch (e) {
    console.warn('[Auth] Token revoke 写入失败:', e.message);
  }
}

/**
 * 检查 token 是否已被撤销（在黑名单中）
 */
function isTokenRevoked(token) {
  const hash = tokenHash(token);
  const row = db.prepare('SELECT id FROM sessions WHERE token_hash = ?').get(hash);
  return !!row; // 存在记录 = 已被撤销
}

/**
 * 清理过期 session 记录
 */
function cleanExpiredSessions() {
  try {
    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  } catch {}
}

// 启动时清理一次
cleanExpiredSessions();

/**
 * 验证 JWT（强制）
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // 检查是否已登出（在黑名单中）
    if (isTokenRevoked(token)) {
      return res.status(401).json({ error: '登录已失效，请重新登录' });
    }

    const user = db.prepare('SELECT id, username, display_name, role, avatar, status FROM users WHERE id = ?').get(decoded.userId);
    if (!user || user.status === 'disabled') {
      return res.status(401).json({ error: '账号已禁用或不存在' });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

/**
 * 可选认证（不强制，用于降级场景）
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      // 可选认证不查黑名单（性能优先）
      const user = db.prepare('SELECT id, username, display_name, role, avatar, status FROM users WHERE id = ?').get(decoded.userId);
      if (user && user.status !== 'disabled') {
        req.user = user;
      }
    } catch {}
  }
  next();
}

/**
 * 角色检查中间件工厂
 */
function roleCheck(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: '未登录' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

module.exports = { signToken, authMiddleware, optionalAuth, roleCheck, revokeToken, cleanExpiredSessions, JWT_SECRET };
