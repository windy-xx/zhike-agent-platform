/**
 * 数据库初始化与迁移
 * SQLite + better-sqlite3，WAL模式
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// 使用 process.cwd() 兼容 pkg 打包（__dirname 在 snapshot 中只读）
const baseDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const dbPath = path.join(baseDir, 'data', 'zhike.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==================== 建表 ====================
db.exec(`
  -- API 配置（单行配置表）
  CREATE TABLE IF NOT EXISTS api_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT DEFAULT 'openai',
    endpoint TEXT DEFAULT '',
    api_key TEXT DEFAULT '',
    model TEXT DEFAULT 'gpt-3.5-turbo',
    enabled INTEGER DEFAULT 0
  );

  -- 用户系统
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    role TEXT DEFAULT 'student' CHECK(role IN ('admin','teacher','student')),
    avatar TEXT DEFAULT '',
    status TEXT DEFAULT 'active' CHECK(status IN ('active','disabled')),
    last_login TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- 用户会话
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    device_info TEXT DEFAULT '',
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- 项目
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    title TEXT NOT NULL,
    topic TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    data TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- PPT幻灯片
  CREATE TABLE IF NOT EXISTS slides (
    project_id TEXT PRIMARY KEY,
    data TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  -- 教案
  CREATE TABLE IF NOT EXISTS lessons (
    project_id TEXT PRIMARY KEY,
    sections TEXT DEFAULT '[]',
    data TEXT DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  -- 文件上传
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    raw_text TEXT DEFAULT '',
    analysis TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- LLM生成历史
  CREATE TABLE IF NOT EXISTS generation_history (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    project_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('ppt','lesson','cases','quiz','knowledge','chat')),
    prompt TEXT DEFAULT '',
    response TEXT DEFAULT '',
    parsed_result TEXT,
    model TEXT DEFAULT '',
    token_usage TEXT DEFAULT '{}',
    duration_ms INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- 系统日志
  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT DEFAULT '',
    resource_id TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- 游戏分数
  CREATE TABLE IF NOT EXISTS game_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    game_type TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    accuracy REAL DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    detail TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- 用户反馈
  CREATE TABLE IF NOT EXISTS feedbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    category TEXT DEFAULT 'general',
    comment TEXT DEFAULT '',
    page TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ==================== 迁移：为旧表添加新列 ====================
const migrations = [
  { table: 'projects', column: 'user_id', type: 'TEXT', after: 'id' },
  { table: 'uploads', column: 'user_id', type: 'TEXT', after: 'id' },
];

migrations.forEach(m => {
  try {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all().map(c => c.name);
    if (!cols.includes(m.column)) {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`);
      console.log(`[DB Migration] ${m.table}.${m.column} 已添加`);
    }
  } catch (e) {
    console.warn(`[DB Migration] ${m.table}.${m.column} 跳过:`, e.message);
  }
});

// ==================== 索引 ====================
const indexes = [
  'CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_generation_user_type ON generation_history(user_id, type)',
  'CREATE INDEX IF NOT EXISTS idx_logs_action_time ON system_logs(action, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_logs_user ON system_logs(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_game_scores_user ON game_scores(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_game_scores_user_type ON game_scores(user_id, game_type)',
];
indexes.forEach(sql => {
  try { db.exec(sql); } catch {}
});

// ==================== 安全初始化 ====================
// API配置只创建空白记录，密钥不提交到版本库。
const configRow = db.prepare('SELECT COUNT(*) AS cnt FROM api_config').get();
if (configRow.cnt === 0) {
  db.prepare('INSERT INTO api_config (id) VALUES (1)').run();
}

// 首次部署时，通过环境变量提供管理员账号和安全密码。
// 已存在同名管理员时不更新密码；生产部署应另行启用HTTPS和访问控制。
const { v4: uuidv4 } = require('uuid');
const adminUsername = (process.env.ADMIN_USERNAME || '').trim();
const adminPassword = process.env.ADMIN_PASSWORD || '';
if (adminUsername && adminPassword) {
  if (adminPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD 至少需要12个字符');
  }
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
  if (!adminExists) {
    const passwordHash = bcrypt.hashSync(adminPassword, 10);
    db.prepare(`INSERT INTO users (id, username, password_hash, display_name, role, status)
                VALUES (?, ?, ?, ?, 'admin', 'active')`)
      .run(uuidv4(), adminUsername, passwordHash, '系统管理员');
    console.log('[DB] 管理员账号已初始化（密码未输出）');
  }
}

/**
 * 记录系统日志
 */
function logAction(action, { userId, resourceType, resourceId, detail, ip } = {}) {
  try {
    db.prepare(`
      INSERT INTO system_logs (user_id, action, resource_type, resource_id, detail, ip)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId || null, action, resourceType || '', resourceId || '', detail || '', ip || '');
  } catch (e) {
    console.error('[DB Log Error]', e.message);
  }
}

module.exports = { db, logAction };
