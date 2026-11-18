/**
 * 统一错误处理中间件
 */

// 404 处理
function notFound(req, res, next) {
  res.status(404).json({ error: '接口不存在' });
}

// 全局错误处理
function errorHandler(err, req, res, next) {
  console.error(`[Error] ${req.method} ${req.url}:`, err.message);

  // Multer 文件大小超限
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '文件过大，最大允许50MB' });
  }

  // JWT 错误
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Token无效' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token已过期' });
  }

  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: err.message || '服务器内部错误',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}

module.exports = { notFound, errorHandler };
