/**
 * WebSocket 连接与房间管理
 * 按 projectId 分组，支持实时协作
 */
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

const rooms = new Map(); // projectId -> Set<ws>
const userMap = new Map(); // ws -> { userId, username, projectId }

/**
 * 初始化 WebSocket 服务器
 * @param {import('http').Server} server
 */
function initWebSocket(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024 * 1024, // 限制消息大小 1MB
  });

  // 心跳检测
  const heartbeat = function () {
    this.isAlive = true;
  };

  const pingInterval = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) {
        const info = userMap.get(ws);
        if (info) {
          leaveRoom(ws, info.projectId);
          userMap.delete(ws);
        }
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    // 从 query 解析 token
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        ws.userId = decoded.userId;
        ws.username = decoded.username;
      } catch {
        // token无效，允许匿名连接
        ws.userId = null;
        ws.username = '匿名用户';
      }
    } else {
      ws.userId = null;
      ws.username = '匿名用户';
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg);
      } catch (e) {
        console.error('[WS] 消息解析失败:', e.message);
      }
    });

    ws.on('error', (err) => {
      console.warn('[WS] 连接错误:', err.message);
    });

    ws.on('close', () => {
      const info = userMap.get(ws);
      if (info) {
        leaveRoom(ws, info.projectId);
        userMap.delete(ws);
      }
    });

    // 发送连接成功
    ws.send(JSON.stringify({ type: 'connected', userId: ws.userId }));
  });

  console.log('[WS] WebSocket 服务器已初始化');
}

/**
 * 处理客户端消息
 */
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'join_project':
      joinRoom(ws, msg.projectId);
      break;
    case 'leave_project':
      leaveRoom(ws, msg.projectId);
      break;
    case 'slide_update':
      // 数据校验
      if (!msg.projectId || !Array.isArray(msg.slides) || msg.slides.length > 100) return;
      broadcastToRoom(ws, msg.projectId, {
        type: 'remote_update',
        projectId: msg.projectId,
        slides: msg.slides,
        from: ws.username,
        timestamp: Date.now()
      });
      break;
    case 'cursor_move':
      broadcastToRoom(ws, msg.projectId, {
        type: 'cursor_move',
        from: ws.username,
        slideIndex: msg.slideIndex,
        position: msg.position,
        timestamp: Date.now()
      });
      break;
    case 'chat_message':
      broadcastToRoom(ws, msg.projectId, {
        type: 'chat_message',
        from: ws.username,
        content: msg.content,
        timestamp: Date.now()
      });
      break;
    default:
      console.warn('[WS] 未知消息类型:', msg.type);
  }
}

/**
 * 加入房间
 */
function joinRoom(ws, projectId) {
  if (!projectId) return;

  // 先离开之前的房间
  const prev = userMap.get(ws);
  if (prev && prev.projectId) {
    leaveRoom(ws, prev.projectId);
  }

  if (!rooms.has(projectId)) {
    rooms.set(projectId, new Set());
  }
  rooms.get(projectId).add(ws);
  userMap.set(ws, { userId: ws.userId, username: ws.username, projectId });

  // 通知房间内其他人
  broadcastToRoom(ws, projectId, {
    type: 'user_joined',
    userId: ws.userId,
    username: ws.username,
    projectId,
    memberCount: rooms.get(projectId).size,
    timestamp: Date.now()
  });

  // 发送当前房间成员给自己
  const members = [];
  rooms.get(projectId).forEach(client => {
    members.push({ userId: client.userId, username: client.username });
  });
  ws.send(JSON.stringify({
    type: 'room_info',
    projectId,
    members,
    memberCount: members.length
  }));
}

/**
 * 离开房间
 */
function leaveRoom(ws, projectId) {
  if (!projectId || !rooms.has(projectId)) return;

  const room = rooms.get(projectId);
  room.delete(ws);

  broadcastToRoom(ws, projectId, {
    type: 'user_left',
    username: ws.username,
    projectId,
    memberCount: room.size,
    timestamp: Date.now()
  });

  if (room.size === 0) {
    rooms.delete(projectId);
  }
}

/**
 * 向房间广播（不发送给 sender）
 */
function broadcastToRoom(senderWs, projectId, message) {
  if (!rooms.has(projectId)) return;

  const data = JSON.stringify(message);
  rooms.get(projectId).forEach(client => {
    if (client !== senderWs && client.readyState === 1) {
      client.send(data);
    }
  });
}

module.exports = { initWebSocket };
