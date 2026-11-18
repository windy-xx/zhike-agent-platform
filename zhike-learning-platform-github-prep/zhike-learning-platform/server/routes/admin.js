/**
 * 管理后台路由
 * 用户管理 + 统计 + 日志
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db, logAction } = require('../db');
const { authMiddleware, roleCheck } = require('../middleware/auth');

const router = express.Router();

// 所有admin路由需要管理员权限
router.use(authMiddleware, roleCheck('admin'));

// ==================== 用户管理 ====================

router.get('/users', (req, res) => {
  try {
    const { page = 1, pageSize = 20, search, role } = req.query;
    const offset = (page - 1) * pageSize;

    let where = '1=1';
    const params = [];
    if (search) {
      where += ' AND (username LIKE ? OR display_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (role) {
      where += ' AND role = ?';
      params.push(role);
    }

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE ${where}`).get(...params).cnt;
    const rows = db.prepare(`
      SELECT id, username, display_name, role, avatar, status, last_login, created_at
      FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({ total, page: Number(page), pageSize: Number(pageSize), list: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/users', (req, res) => {
  try {
    const { username, password, displayName, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: '用户名已存在' });
    }

    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, display_name, role, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(id, username, hash, displayName || username, role || 'student');

    logAction('admin_create_user', { userId: req.user.id, resourceId: id, detail: `创建用户 ${username}`, ip: req.ip });
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id', (req, res) => {
  try {
    const { displayName, role, status } = req.body;
    db.prepare(`
      UPDATE users SET
        display_name = COALESCE(?, display_name),
        role = COALESCE(?, role),
        status = COALESCE(?, status)
      WHERE id = ?
    `).run(displayName || null, role || null, status || null, req.params.id);

    logAction('admin_update_user', { userId: req.user.id, resourceId: req.params.id, detail: `更新用户 ${req.params.id}`, ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/users/:id', (req, res) => {
  try {
    // 不能删除自己
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: '不能删除自己' });
    }
    // 级联清理关联数据
    const userProjects = db.prepare('SELECT id FROM projects WHERE user_id = ?').all(req.params.id);
    userProjects.forEach(p => {
      db.prepare('DELETE FROM slides WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM lessons WHERE project_id = ?').run(p.id);
    });
    db.prepare('DELETE FROM projects WHERE user_id = ?').run(req.params.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
    db.prepare('DELETE FROM uploads WHERE user_id = ?').run(req.params.id);
    db.prepare('DELETE FROM generation_history WHERE user_id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

    logAction('admin_delete_user', { userId: req.user.id, resourceId: req.params.id, ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id/reset-password', (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: '密码至少6个字符' });
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);

    logAction('admin_reset_password', { userId: req.user.id, resourceId: req.params.id, ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 统计 ====================

router.get('/stats/overview', (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
    const projectCount = db.prepare('SELECT COUNT(*) as cnt FROM projects').get().cnt;
    const genCount = db.prepare('SELECT COUNT(*) as cnt FROM generation_history').get().cnt;
    const todayGen = db.prepare("SELECT COUNT(*) as cnt FROM generation_history WHERE date(created_at) = date('now')").get().cnt;
    const uploadCount = db.prepare('SELECT COUNT(*) as cnt FROM uploads').get().cnt;

    res.json({ userCount, projectCount, genCount, todayGen, uploadCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats/generations', (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 7));
    const modifier = `-${days} days`;

    // 按类型统计
    const byType = db.prepare(`
      SELECT type, COUNT(*) as count
      FROM generation_history
      WHERE created_at >= datetime('now', ?)
      GROUP BY type
    `).all(modifier);

    // 按日期统计
    const byDate = db.prepare(`
      SELECT date(created_at) as date, COUNT(*) as count
      FROM generation_history
      WHERE created_at >= datetime('now', ?)
      GROUP BY date(created_at)
      ORDER BY date
    `).all(modifier);

    // 按模型统计
    const byModel = db.prepare(`
      SELECT model, COUNT(*) as count
      FROM generation_history
      WHERE created_at >= datetime('now', ?)
      GROUP BY model
    `).all(modifier);

    res.json({ byType, byDate, byModel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats/users', (req, res) => {
  try {
    // 角色分布
    const byRole = db.prepare('SELECT role, COUNT(*) as count FROM users GROUP BY role').all();

    // 最近7天活跃用户（有生成记录）
    const activeUsers = db.prepare(`
      SELECT u.id, u.username, u.display_name, COUNT(g.id) as gen_count,
             MAX(g.created_at) as last_active
      FROM users u
      LEFT JOIN generation_history g ON u.id = g.user_id
        AND g.created_at >= datetime('now', '-7 days')
      GROUP BY u.id
      ORDER BY gen_count DESC
      LIMIT 20
    `).all();

    res.json({ byRole, activeUsers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 系统日志 ====================

router.get('/logs', (req, res) => {
  try {
    const { page = 1, pageSize = 50, action, userId, startDate, endDate } = req.query;
    const offset = (page - 1) * pageSize;

    let where = '1=1';
    const params = [];
    if (action) {
      where += ' AND action = ?';
      params.push(action);
    }
    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }
    if (startDate) {
      where += ' AND created_at >= ?';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND created_at <= ?';
      params.push(endDate);
    }

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM system_logs WHERE ${where}`).get(...params).cnt;
    const rows = db.prepare(`
      SELECT * FROM system_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({ total, page: Number(page), pageSize: Number(pageSize), list: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
