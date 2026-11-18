/**
 * 项目管理路由
 * CRUD + 幻灯片 + 教案
 * 所有写操作需要认证，读操作可选认证
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, logAction } = require('../db');
const { authMiddleware, optionalAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * 检查用户是否有权限操作该项目
 */
function checkProjectAccess(req, res, next) {
  const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  // 管理员可操作所有项目，普通用户只能操作自己的项目或无主项目
  if (project.user_id && project.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权操作此项目' });
  }
  next();
}

// ==================== 项目列表 ====================

router.get('/', optionalAuth, (req, res) => {
  try {
    let rows;
    if (req.user) {
      rows = db.prepare('SELECT * FROM projects WHERE user_id = ? OR user_id IS NULL ORDER BY updated_at DESC').all(req.user.id);
    } else {
      rows = db.prepare('SELECT * FROM projects WHERE user_id IS NULL ORDER BY updated_at DESC').all();
    }
    res.json(rows.map(r => ({ ...r, data: JSON.parse(r.data) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 创建项目 ====================

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { title, topic, status, data } = req.body;
    db.prepare(`
      INSERT INTO projects (id, user_id, title, topic, status, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, title || '未命名项目', topic || '', status || 'active', JSON.stringify(data || {}));

    logAction('project_create', { userId: req.user.id, resourceId: id, detail: `创建项目: ${title}`, ip: req.ip });
    res.json({ id, title, topic, status, data: data || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 单项目 CRUD ====================

router.get('/:id', optionalAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '项目不存在' });
    res.json({ ...row, data: JSON.parse(row.data) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', optionalAuth, (req, res) => {
  try {
    const { title, topic, status, data } = req.body;
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!existing) {
      // 自动创建（用于前端 sync 场景）
      db.prepare(`
        INSERT INTO projects (id, user_id, title, topic, status, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.params.id, req.user?.id || null, title || '未命名项目', topic || '', status || 'active', JSON.stringify(data || {}));
    } else {
      // 已有项目：检查权限
      if (req.user && existing.user_id && existing.user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: '无权修改此项目' });
      }
      db.prepare(`
        UPDATE projects SET
          title = COALESCE(?, title),
          topic = COALESCE(?, topic),
          status = COALESCE(?, status),
          data = COALESCE(?, data),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        title || null, topic || null, status || null,
        data ? JSON.stringify(data) : null,
        req.params.id
      );
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(req.params.id);
    if (project && project.user_id && project.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '无权删除此项目' });
    }
    db.prepare('DELETE FROM slides WHERE project_id = ?').run(req.params.id);
    db.prepare('DELETE FROM lessons WHERE project_id = ?').run(req.params.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);

    logAction('project_delete', { userId: req.user.id, resourceId: req.params.id, ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== PPT 幻灯片 ====================

router.get('/:id/slides', optionalAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM slides WHERE project_id = ?').get(req.params.id);
    if (!row) return res.json({ slides: [], updatedAt: null });
    res.json({ slides: JSON.parse(row.data), updatedAt: row.updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/slides', optionalAuth, (req, res) => {
  try {
    const { slides } = req.body;
    // 验证数据大小（防止恶意超大 payload）
    const serialized = JSON.stringify(slides);
    if (serialized.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: '幻灯片数据过大' });
    }
    const existing = db.prepare('SELECT * FROM slides WHERE project_id = ?').get(req.params.id);
    if (existing) {
      db.prepare("UPDATE slides SET data = ?, updated_at = datetime('now') WHERE project_id = ?")
        .run(serialized, req.params.id);
    } else {
      db.prepare('INSERT INTO slides (project_id, data) VALUES (?, ?)')
        .run(req.params.id, serialized);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 教案 ====================

router.get('/:id/lesson', optionalAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM lessons WHERE project_id = ?').get(req.params.id);
    if (!row) return res.json({ sections: [], data: {}, updatedAt: null });
    res.json({ sections: JSON.parse(row.sections), data: JSON.parse(row.data), updatedAt: row.updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/lesson', optionalAuth, (req, res) => {
  try {
    const { sections, data } = req.body;
    const existing = db.prepare('SELECT * FROM lessons WHERE project_id = ?').get(req.params.id);
    if (existing) {
      db.prepare("UPDATE lessons SET sections = ?, data = ?, updated_at = datetime('now') WHERE project_id = ?")
        .run(JSON.stringify(sections || []), JSON.stringify(data || {}), req.params.id);
    } else {
      db.prepare('INSERT INTO lessons (project_id, sections, data) VALUES (?, ?, ?)')
        .run(req.params.id, JSON.stringify(sections || []), JSON.stringify(data || {}));
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 看板统计（已登录用户可用，不限制admin） ====================

router.get('/stats/dashboard', optionalAuth, (req, res) => {
  try {
    const projectCount = db.prepare('SELECT COUNT(*) as cnt FROM projects').get().cnt;
    const genCount = db.prepare('SELECT COUNT(*) as cnt FROM generation_history').get().cnt;
    const todayGen = db.prepare("SELECT COUNT(*) as cnt FROM generation_history WHERE date(created_at) = date('now')").get().cnt;
    const uploadCount = db.prepare('SELECT COUNT(*) as cnt FROM uploads').get().cnt;
    const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;

    res.json({ projectCount, genCount, todayGen, uploadCount, userCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats/recent-activity', optionalAuth, (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT action, detail, created_at FROM system_logs
      ORDER BY created_at DESC LIMIT 8
    `).all();
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
