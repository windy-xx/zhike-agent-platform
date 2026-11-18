/**
 * 认证路由
 * POST /api/auth/register  注册
 * POST /api/auth/login     登录
 * POST /api/auth/logout    登出
 * GET  /api/auth/me        获取当前用户
 * PUT  /api/auth/me        更新个人信息
 * PUT  /api/auth/password  修改密码
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db, logAction } = require('../db');
const { signToken, authMiddleware, revokeToken } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// ==================== 注册 ====================
router.post('/register', authLimiter, (req, res) => {
  try {
    const { username, password, displayName, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: '用户名需3-20个字符' });
    }
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
      return res.status(400).json({ error: '用户名只能包含字母、数字、下划线或中文' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少6个字符' });
    }

    // 检查用户名是否已存在
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: '用户名已存在' });
    }

    // 如果指定了角色（teacher/admin），必须是admin操作
    const targetRole = role || 'student';
    if (targetRole !== 'student' && (!req.user || req.user.role !== 'admin')) {
      return res.status(403).json({ error: '仅管理员可创建教师/管理员账号' });
    }

    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, display_name, role, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(id, username, hash, displayName || username, targetRole);

    const token = signToken({ userId: id, username, role: targetRole });
    const user = { id, username, displayName: displayName || username, role: targetRole, avatar: '' };

    logAction('user_register', { userId: id, detail: `注册用户 ${username}`, ip: req.ip });

    res.json({ token, user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 登录 ====================
router.post('/login', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (user.status === 'disabled') {
      return res.status(403).json({ error: '账号已被禁用' });
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 更新最后登录时间
    db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(user.id);

    const token = signToken({ userId: user.id, username: user.username, role: user.role });
    const userInfo = {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      role: user.role,
      avatar: user.avatar || ''
    };

    logAction('user_login', { userId: user.id, detail: `${username} 登录`, ip: req.ip });

    res.json({ token, user: userInfo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 登出 ====================
router.post('/logout', authMiddleware, (req, res) => {
  // 撤销 token（删除 session 记录）
  const token = req.headers.authorization?.slice(7);
  if (token) revokeToken(token);
  logAction('user_logout', { userId: req.user.id, detail: `${req.user.username} 登出`, ip: req.ip });
  res.json({ success: true });
});

// ==================== 获取当前用户 ====================
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, display_name, role, avatar, status, last_login, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    avatar: user.avatar || '',
    status: user.status,
    lastLogin: user.last_login,
    createdAt: user.created_at
  });
});

// ==================== 更新个人信息 ====================
router.put('/me', authMiddleware, (req, res) => {
  try {
    const { displayName, avatar } = req.body;
    db.prepare(`
      UPDATE users SET
        display_name = COALESCE(?, display_name),
        avatar = COALESCE(?, avatar)
      WHERE id = ?
    `).run(displayName || null, avatar || null, req.user.id);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 修改密码 ====================
router.put('/password', authMiddleware, (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '请输入旧密码和新密码' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码至少6个字符' });
    }

    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
      return res.status(401).json({ error: '旧密码错误' });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);

    logAction('password_change', { userId: req.user.id, ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
