/**
 * 智课精灵 - 模块化后端服务入口
 * Express + SQLite + WebSocket
 */
const express = require('express');
const helmet = require('helmet');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 中间件 ====================
// CORS: 生产环境限制域名，开发环境开放
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? (process.env.CORS_ORIGINS || '').split(',').filter(Boolean)
    : true,
  credentials: true
};
const cors = require('cors');
app.use(cors(corsOptions));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50mb' }));

// 信任反向代理
app.set('trust proxy', 1);

// 通用 API 速率限制
const { apiLimiter } = require('./middleware/rateLimit');
app.use('/api/', apiLimiter);

// ==================== 静态文件（必须在路由之前，在错误处理之前）====================
// 兼容 pkg 打包：pkg 环境下从 exe 同目录提供静态文件
const staticBase = process.pkg ? path.dirname(process.execPath) : __dirname;
if (process.env.NODE_ENV !== 'production') {
  const staticDirs = [
    path.join(staticBase, 'deploy'),
    path.join(staticBase, '..'),
    staticBase
  ];
  for (const dir of staticDirs) {
    if (fs.existsSync(dir)) {
      app.use(express.static(dir, { index: false }));
      console.log(`[Static] 开发模式，提供 ${dir} 目录静态文件`);
      break;
    }
  }
}

// ==================== 默认首页重定向到登录页 ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'tcm-login.html'));
});

// ==================== 健康检查 ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '2.0' });
});

// ==================== 路由挂载 ====================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/llm', require('./routes/llm'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/upload', require('./routes/uploads'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/games', require('./routes/games'));
app.use('/api/feedback', require('./routes/feedbacks'));

// ==================== 错误处理（必须在最后）====================
const { notFound, errorHandler } = require('./middleware/errorHandler');
app.use(notFound);
app.use(errorHandler);

// ==================== 创建 HTTP 服务器 ====================
const server = http.createServer(app);

// ==================== WebSocket ====================
const { initWebSocket } = require('./ws/handler');
initWebSocket(server);

// 定期清理过期 session（每小时）
const { cleanExpiredSessions } = require('./middleware/auth');
setInterval(cleanExpiredSessions, 60 * 60 * 1000);

// ==================== 启动 ====================
server.listen(PORT, () => {
  console.log('=========================================');
  console.log('  智课精灵后端服务 v2.0 已启动');
  console.log(`  端口: ${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  环境: ${process.env.NODE_ENV || 'development'}`);
  console.log('=========================================');
});

module.exports = { app, server };
