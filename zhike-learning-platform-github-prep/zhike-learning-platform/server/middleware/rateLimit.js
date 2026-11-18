/**
 * 速率限制中间件
 */
const rateLimit = require('express-rate-limit');

// 通用限制：每15分钟500次
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 认证限制：每15分钟30次（防暴力破解）
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: '登录尝试过多，请15分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// LLM生成限制：每分钟10次
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '生成请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { apiLimiter, authLimiter, generateLimiter };
