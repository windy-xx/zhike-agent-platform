/**
 * 游戏分数路由
 * POST /api/games/score  — 提交分数
 * GET  /api/games/scores — 查询分数列表
 * GET  /api/games/stats  — 汇总统计
 */
const express = require('express');
const router = express.Router();
const { db, logAction } = require('../db');
const { optionalAuth } = require('../middleware/auth');

// 游戏类型白名单
const VALID_GAMES = [
  'wuxing', 'tongue', 'memory', 'acupoint', 'herb', 'prescription'
];

// 提交游戏分数
router.post('/score', optionalAuth, (req, res) => {
  const userId = req.user?.id || null;
  const { gameType, score, accuracy, durationSeconds, detail } = req.body;

  if (!gameType || !VALID_GAMES.includes(gameType)) {
    return res.status(400).json({ error: '无效的游戏类型' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO game_scores (user_id, game_type, score, accuracy, duration_seconds, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      gameType,
      Math.max(0, parseInt(score) || 0),
      Math.max(0, Math.min(100, parseFloat(accuracy) || 0)),
      Math.max(0, parseInt(durationSeconds) || 0),
      JSON.stringify(detail || {})
    );

    logAction('game_score_submit', {
      userId,
      resourceType: 'game',
      resourceId: gameType,
      detail: `score=${score}, accuracy=${accuracy}%`
    });

    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    console.error('[Games] 提交分数失败:', e.message);
    res.status(500).json({ error: '提交失败' });
  }
});

// 查询用户游戏记录
router.get('/scores', optionalAuth, (req, res) => {
  const userId = req.user?.id || null;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

  if (!userId) {
    return res.json({ scores: [], total: 0 });
  }

  try {
    const scores = db.prepare(`
      SELECT id, game_type, score, accuracy, duration_seconds, detail, created_at
      FROM game_scores
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, limit);

    const { total } = db.prepare('SELECT COUNT(*) as total FROM game_scores WHERE user_id = ?').get(userId);

    res.json({ scores, total });
  } catch (e) {
    console.error('[Games] 查询分数失败:', e.message);
    res.status(500).json({ error: '查询失败' });
  }
});

// 汇总统计
router.get('/stats', optionalAuth, (req, res) => {
  const userId = req.user?.id || null;

  if (!userId) {
    return res.json({
      points: 0, gamesPlayed: 0, bestScore: 0, streak: 0,
      accuracy: 0, history: [], gameBreakdown: {}
    });
  }

  try {
    // 总体统计
    const stats = db.prepare(`
      SELECT
        COUNT(*) as gamesPlayed,
        COALESCE(SUM(score), 0) as points,
        COALESCE(MAX(score), 0) as bestScore,
        COALESCE(AVG(accuracy), 0) as avgAccuracy
      FROM game_scores
      WHERE user_id = ?
    `).get(userId);

    // 连续天数（简单版：最近有记录的连续日期数）
    const streakResult = db.prepare(`
      SELECT COUNT(DISTINCT DATE(created_at)) as streak
      FROM game_scores
      WHERE user_id = ?
        AND DATE(created_at) >= DATE('now', '-30 days')
    `).get(userId);

    // 按游戏类型统计
    const breakdown = db.prepare(`
      SELECT game_type,
        COUNT(*) as count,
        COALESCE(SUM(score), 0) as totalScore,
        COALESCE(MAX(score), 0) as bestScore,
        COALESCE(AVG(accuracy), 0) as avgAccuracy
      FROM game_scores
      WHERE user_id = ?
      GROUP BY game_type
    `).all(userId);

    const gameBreakdown = {};
    breakdown.forEach(b => { gameBreakdown[b.game_type] = b; });

    // 最近记录
    const history = db.prepare(`
      SELECT game_type, score, accuracy, duration_seconds, created_at
      FROM game_scores
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(userId);

    res.json({
      points: stats.points,
      gamesPlayed: stats.gamesPlayed,
      bestScore: stats.bestScore,
      streak: streakResult.streak,
      accuracy: Math.round(stats.avgAccuracy),
      history,
      gameBreakdown
    });
  } catch (e) {
    console.error('[Games] 统计查询失败:', e.message);
    res.status(500).json({ error: '查询失败' });
  }
});

module.exports = router;
