/**
 * 用户反馈路由
 * POST /api/feedback — 提交反馈
 * GET  /api/feedback — 查询反馈列表（管理员）
 * GET  /api/feedback/stats — 反馈统计（管理员）
 */
const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { optionalAuth, roleCheck } = require('../middleware/auth');

// 提交反馈（已登录或匿名均可）
router.post('/', optionalAuth, (req, res) => {
    const { rating, comment, category, page } = req.body;

    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: '评分必须为 1-5' });
    }

    try {
        db.prepare(`
            INSERT INTO feedbacks (user_id, rating, category, comment, page)
            VALUES (?, ?, ?, ?, ?)
        `).run(req.user?.id || null, rating, category || 'general', (comment || '').slice(0, 1000), page || '');

        res.json({ success: true });
    } catch (err) {
        console.error('[Feedback] 插入失败:', err.message);
        res.status(500).json({ error: '保存失败' });
    }
});

// 查询反馈列表（管理员）
router.get('/', optionalAuth, roleCheck('admin'), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    try {
        const list = db.prepare(`
            SELECT f.*, u.username
            FROM feedbacks f
            LEFT JOIN users u ON f.user_id = u.id
            ORDER BY f.created_at DESC
            LIMIT ? OFFSET ?
        `).all(limit, offset);

        const total = db.prepare('SELECT COUNT(*) as count FROM feedbacks').get().count;

        res.json({ list, total });
    } catch (err) {
        console.error('[Feedback] 查询失败:', err.message);
        res.status(500).json({ error: '查询失败' });
    }
});

// 反馈统计（管理员）
router.get('/stats', optionalAuth, roleCheck('admin'), (req, res) => {
    try {
        const total = db.prepare('SELECT COUNT(*) as count FROM feedbacks').get().count;
        const avgRating = db.prepare('SELECT AVG(rating) as avg FROM feedbacks').get().avg || 0;
        const byCategory = db.prepare(`
            SELECT category, COUNT(*) as count, AVG(rating) as avg_rating
            FROM feedbacks GROUP BY category ORDER BY count DESC
        `).all();
        const byRating = db.prepare(`
            SELECT rating, COUNT(*) as count FROM feedbacks GROUP BY rating ORDER BY rating
        `).all();
        const recent = db.prepare(`
            SELECT COUNT(*) as count FROM feedbacks
            WHERE created_at >= datetime('now', '-7 days')
        `).get().count;

        res.json({ total, avgRating: avgRating.toFixed(1), byCategory, byRating, recentWeek: recent });
    } catch (err) {
        console.error('[Feedback] 统计失败:', err.message);
        res.status(500).json({ error: '统计失败' });
    }
});

module.exports = router;
