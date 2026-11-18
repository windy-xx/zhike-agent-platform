# 智课精灵 · 智能中医课程学习平台

这是根据现有项目源码整理的**GitHub上传候选版**，用于展示中医课程知识问答、AI内容生成、课件制作、互动教学及教师/学生/管理员等功能。仓库代码来自本项目的Node.js/Express版本，不应将未包含的Spring Boot/Flask/LangChain/FAISS等模块写成该仓库已实现功能。

## 已核对的技术架构

| 部分 | 已包含的实现 |
|---|---|
| Web前端 | HTML、JavaScript |
| 后端 | Node.js、Express |
| 数据 | SQLite (`better-sqlite3`)、浏览器IndexedDB |
| 身份认证 | JWT、bcryptjs |
| 模型调用 | 多模型提供商API适配器，可在管理界面配置 |
| 检索 | Transformers.js向量化、本地向量检索、关键词混合召回 |
| 向量模型 | `Xenova/all-MiniLM-L6-v2`（模型权重未随仓库打包） |
| 实时协作 | WebSocket |
| 部署相关 | Nginx、PM2配置示例 |

> 本仓库是代码整理版。未经运行完整验证或第三方安全审计，请勿将其直接当成安全的公共互联网生产部署方案。简历提到的实验准确率需以独立实验记录为依据。

## 本地启动（Windows 11 / VS Code）

要求：Node.js 20.6+（推荐Node.js 22），安装npm。

1. 解压仓库，在项目根目录打开VS Code终端。
2. 复制 `.env.example` 为 `.env`。设置**随机的JWT_SECRET**（至少32字符），并自行设置**独立的管理员密码**（至少12字符）。不要直接使用示例占位字符串，也不要使用线上服务器正在使用的凭据。
3. 安装依赖：`npm install`
4. 启动：`npm start`
5. 浏览器访问：`http://localhost:3000`，或 `http://localhost:3000/tcm-login.html`。
6. 验证服务状态：`http://localhost:3000/api/health`。

本地首次启动时，如果`.env`设置了 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`，会初始化管理员账号；系统**不会自动创建固定口令的演示用户**。新用户可以通过注册页面创建学生账号。LLM功能需要配置可用的第三方模型服务账号及对应密钥。若需要生成内容或加载向量模型，需要网络或自行下载相关模型。

> 注意：此候选版保留了原项目的主要源码，但没有实际完成端到端联调。Node.js能解析脚本并不代表第三方API和所有页面功能均已验证。

## 目录结构

```text
.
├── server/                  # Express后端：鉴权、数据、API、WebSocket
│   ├── routes/
│   ├── middleware/
│   ├── services/
│   └── ws/
├── tcm-*.html               # 登录、教学、RAG、PPT、互动等页面
├── tcm-*.js                 # 客户端检索、向量化、知识库
├── server.js                # Node.js启动入口
├── package.json
├── nginx.conf               # Nginx反向代理参考配置
├── ecosystem.config.js     # PM2配置（环境变量提供凭据）
└── docs/
    ├── OPEN_SOURCE_REVIEW.md
    └── legacy-setup.sh.txt # 仅保留原脚本供参考，不建议直接执行
```

## 开源范围与第三方资源

- 未包含 `server-bundle.js`（旧版构建产物，可能包含旧敏感配置）。
- 未包含 `models/` 下的第三方模型权重。请在确认对应模型许可后，从模型官方仓库取得所需模型文件；部分前端逻辑也支持从CDN加载模型库。
- 未包含数据库、用户上传文件、真实API密钥与服务器凭据。
- 内置知识库文本可能含有教材/讲义等内容，**发布前需要人工核对引用来源及授权**。
- **尚未添加LICENSE**：请在确认个人或团队对全部代码拥有发布权后，再选择MIT、Apache-2.0等协议。

## GitHub提交

在确认 `docs/OPEN_SOURCE_REVIEW.md` 中的事项后：

```bash
git init -b main
git add .
git diff --cached --name-only
git commit -m "Initial open-source release"
git remote add origin https://github.com/YOUR_USERNAME/zhike-learning-platform.git
git push -u origin main
```

注意：GitHub仓库建立时可先创建空仓库，不要自动生成README以避免初始冲突。请不要将 `.env` 提交到仓库。
