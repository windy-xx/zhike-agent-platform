/**
 * LLM 代理 + 生成路由
 * 保留原有 config/proxy/test
 * 新增 6个生成端点
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, logAction } = require('../db');
const { optionalAuth, authMiddleware } = require('../middleware/auth');
const { generateLimiter } = require('../middleware/rateLimit');
const { callLLM, maskKey } = require('../services/llmService');

const router = express.Router();

// ==================== 原有 LLM 配置 ====================

router.get('/config', authMiddleware, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM api_config WHERE id = 1').get();
    res.json({
      provider: row.provider,
      endpoint: row.endpoint,
      apiKey: maskKey(row.api_key),
      model: row.model,
      enabled: !!row.enabled
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/config', authMiddleware, (req, res) => {
  try {
    const { provider, endpoint, apiKey, model, enabled } = req.body;
    const current = db.prepare('SELECT * FROM api_config WHERE id = 1').get();
    const realKey = (apiKey && apiKey.includes('****')) ? current.api_key : apiKey;

    db.prepare(`
      UPDATE api_config SET
        provider = ?, endpoint = ?, api_key = ?, model = ?, enabled = ?
      WHERE id = 1
    `).run(
      provider || current.provider,
      endpoint || current.endpoint,
      realKey !== undefined ? realKey : current.api_key,
      model || current.model,
      enabled !== undefined ? (enabled ? 1 : 0) : current.enabled
    );

    logAction('llm_config_update', { userId: req.user?.id, detail: `更新LLM配置 provider=${provider}`, ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== LLM 代理调用 ====================

router.post('/', optionalAuth, generateLimiter, async (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM api_config WHERE id = 1').get();
    if (!config.enabled || !config.api_key || !config.endpoint) {
      return res.status(400).json({ error: 'API 未配置或未启用' });
    }

    const { provider, model: reqModel, messages, max_tokens } = req.body;
    const result = await callLLM(config, {
      provider: provider || config.provider,
      model: reqModel || config.model,
      messages,
      maxTokens: max_tokens || 2000
    });

    res.json({ content: result.content, usage: result.usage || null });
  } catch (e) {
    console.error('[LLM Proxy Error]', e.message);
    res.status(502).json({ error: 'LLM 代理调用失败: ' + e.message });
  }
});

// ==================== 多模态视觉分析（舌诊等） ====================

router.post('/vision', optionalAuth, generateLimiter, async (req, res) => {
  try {
    const { image, prompt } = req.body;
    if (!image) {
      return res.status(400).json({ error: '请提供图片数据（base64）' });
    }

    const userPrompt = prompt || '请对这张舌象照片进行详细的中医舌诊分析。';

    const systemPrompt = `你是中医舌诊专家，请分析舌象：1.舌质(色/形/态) 2.舌苔(色/质/剥落) 3.舌下络脉 4.辨证结论 5.调理建议。如非舌象请友好提示。`;

    // 构造多模态消息：content 为数组格式
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: systemPrompt + '\n' + userPrompt }
        ]
      }
    ];

    // 优先使用数据库配置，失败则降级到备用 Vision 模型
    const config = db.prepare('SELECT * FROM api_config WHERE id = 1').get();
    const result = await callLLM(config, {
      provider: config.provider,
      model: config.model,
      messages,
      maxTokens: 3000
    });

    res.json({ content: result.content, usage: result.usage || null });
  } catch (e) {
    console.error('[LLM Vision Error]', e.message);
    res.status(502).json({ error: '视觉分析失败: ' + e.message });
  }
});

// ==================== 测试连通性 ====================

router.post('/test', authMiddleware, async (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM api_config WHERE id = 1').get();
    if (!config.api_key || !config.endpoint) {
      return res.json({ success: false, message: '请先配置 API 端点和密钥' });
    }

    const result = await callLLM(config, {
      provider: config.provider,
      model: config.model,
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 10,
      test: true
    });

    res.json({ success: result.success !== false, message: result.message || '连接成功' });
  } catch (e) {
    res.json({ success: false, message: '连接失败: ' + e.message });
  }
});

// ==================== 6个生成端点 ====================

const { buildPrompt, buildJingfangPrompt, buildDesignerPrompt, buildVisualPrompt } = require('../services/promptTemplates');
const { formatRAGResults } = require('../services/ragService');

const GENERATION_TYPES = ['ppt', 'lesson', 'cases', 'quiz', 'knowledge', 'chat'];

GENERATION_TYPES.forEach(type => {
  router.post(`/generate/${type}`, optionalAuth, generateLimiter, async (req, res) => {
    const startTime = Date.now();
    const genId = uuidv4();

    try {
      const config = db.prepare('SELECT * FROM api_config WHERE id = 1').get();
      if (!config.enabled || !config.api_key || !config.endpoint) {
        // 即使API未配置，也记录生成行为（标记为降级模式）
        db.prepare(`INSERT INTO generation_history (id, user_id, type, prompt, model, duration_ms) VALUES (?,?,?,?,?,?)`).run(
          genId, req.user?.id || null, type, (req.body.userRequest || '').slice(0, 2000), 'fallback', Date.now() - startTime
        );
        logAction(`generate_${type}_fallback`, { userId: req.user?.id, detail: `降级生成 ${type}（API未配置）`, ip: req.ip });
        return res.status(400).json({ error: 'API 未配置或未启用，请在设置中配置LLM API' });
      }

      const { userRequest, ragContext, refFiles, conversationHistory } = req.body;
      // 如果 ragContext 是数组（前端传来的原始检索结果），用 formatRAGResults 格式化
      const formattedRag = Array.isArray(ragContext) ? formatRAGResults(ragContext) : (ragContext || '');
      const { systemPrompt, userPrompt } = buildPrompt(type, { userRequest, ragContext: formattedRag, refFiles, conversationHistory });

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      const result = await callLLM(config, {
        provider: config.provider,
        model: config.model,
        messages,
        maxTokens: type === 'ppt' ? 4000 : type === 'chat' ? 2000 : 3000
      });

      // 尝试解析JSON
      let parsed = null;
      if (type !== 'chat') {
        try {
          // 提取JSON内容（可能被包裹在```json ... ```中）
          let jsonStr = result.content;
          const jsonMatch = jsonStr.match(/```json\s*([\s\S]*?)```/);
          if (jsonMatch) jsonStr = jsonMatch[1].trim();
          // 也尝试提取花括号/方括号包裹的内容
          if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
            const braceMatch = jsonStr.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
            if (braceMatch) jsonStr = braceMatch[1];
          }
          parsed = JSON.parse(jsonStr);
        } catch {
          parsed = null;
        }
      }

      const durationMs = Date.now() - startTime;

      // 存入生成历史
      db.prepare(`
        INSERT INTO generation_history (id, user_id, project_id, type, prompt, response, parsed_result, model, token_usage, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId,
        req.user?.id || null,
        req.body.projectId || null,
        type,
        userPrompt.slice(0, 2000),
        result.content.slice(0, 5000),
        parsed ? JSON.stringify(parsed) : null,
        config.model,
        JSON.stringify(result.usage || {}),
        durationMs
      );

      logAction(`generate_${type}`, {
        userId: req.user?.id,
        detail: `生成 ${type}，耗时 ${durationMs}ms`,
        ip: req.ip
      });

      res.json({
        id: genId,
        type,
        content: result.content,
        parsed,
        usage: result.usage,
        durationMs
      });
    } catch (e) {
      console.error(`[Generate ${type} Error]`, e.message);
      res.status(502).json({ error: `${type}生成失败: ${e.message}`, id: genId });
    }
  });
});

// 前端降级生成后的轻量上报接口
router.post('/generate/record', optionalAuth, (req, res) => {
  try {
    const { type, prompt } = req.body;
    const validTypes = ['ppt','lesson','cases','quiz','knowledge','chat'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid type' });
    const genId = uuidv4();
    db.prepare(`INSERT INTO generation_history (id, user_id, type, prompt, model, duration_ms) VALUES (?,?,?,?,?,?)`).run(
      genId, req.user?.id || null, type, (prompt || '').slice(0, 2000), 'local-template', 0
    );
    logAction(`generate_${type}_local`, { userId: req.user?.id, detail: `本地模板生成 ${type}`, ip: req.ip });
    res.json({ ok: true, id: genId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Pipeline JSON Schema 校验函数 ====================

/**
 * 校验 Agent 1 (经方专家) 输出结构
 * 规则：必须有 outline 数组，长度 >= 3，每项有 section 和 keyPoints
 */
function validateOutline(data) {
  if (!data || !Array.isArray(data.outline)) {
    return { valid: false, reason: '缺少 outline 数组' };
  }
  if (data.outline.length < 3) {
    return { valid: false, reason: `outline 长度 ${data.outline.length} < 3` };
  }
  for (let i = 0; i < data.outline.length; i++) {
    const item = data.outline[i];
    if (!item.section || !item.keyPoints) {
      return { valid: false, reason: `outline[${i}] 缺少 section 或 keyPoints` };
    }
  }
  return { valid: true };
}

/**
 * 校验 Agent 2 (国风设计师) 输出结构
 * 规则：必须有 slides 数组，长度 >= 5
 */
function validateSlides(data) {
  if (!data || !Array.isArray(data.slides)) {
    return { valid: false, reason: '缺少 slides 数组' };
  }
  if (data.slides.length < 5) {
    return { valid: false, reason: `slides 长度 ${data.slides.length} < 5` };
  }
  return { valid: true };
}

/**
 * 校验 Agent 3 (可视化师) 输出结构
 * 规则：必须有 nodes 数组和 edges 数组，nodes >= 3
 */
function validateGraph(data) {
  if (!data || !Array.isArray(data.nodes)) {
    return { valid: false, reason: '缺少 nodes 数组' };
  }
  if (!Array.isArray(data.edges)) {
    return { valid: false, reason: '缺少 edges 数组' };
  }
  if (data.nodes.length < 3) {
    return { valid: false, reason: `nodes 长度 ${data.nodes.length} < 3` };
  }
  return { valid: true };
}

// ==================== PPT 3-Agent Pipeline ====================

/**
 * POST /api/llm/generate/ppt-pipeline
 * 3-Agent 串行 Pipeline：经方专家 → 国风设计师 → 可视化师
 * 使用 SSE (Server-Sent Events) 流式推送每个 Agent 的完成状态
 * 每个 Agent 支持自动重试（最多 MAX_RETRIES 次），含 JSON Schema 校验
 */
router.post('/generate/ppt-pipeline', optionalAuth, generateLimiter, async (req, res) => {
  const startTime = Date.now();
  const MAX_RETRIES = 2;

  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'  // 禁止 Nginx 缓冲
  });

  // SSE 推送辅助函数
  function ssePush(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const config = db.prepare('SELECT * FROM api_config WHERE id = 1').get();
    if (!config.enabled || !config.api_key || !config.endpoint) {
      ssePush({ status: 'error', error: 'API 未配置或未启用' });
      res.end();
      return;
    }

    const { userRequest, ragContext, refFiles } = req.body;
    const formattedRag = Array.isArray(ragContext) ? formatRAGResults(ragContext) : (ragContext || '');
    const ragSection = formattedRag ? `\n\n【RAG检索参考资料】\n${formattedRag}` : '';
    const refSection = refFiles && refFiles.length > 0
      ? `\n\n【用户上传的参考资料】\n${refFiles.map(f => `文件: ${f.name}\n${f.content?.slice(0, 2000) || ''}`).join('\n---\n')}`
      : '';

    // ---- Agent 1: 经方专家 — 知识点提取 ----
    ssePush({ agent: 'jingfang', status: 'working', message: '正在提取知识点...' });

    const jingfangPrompt = buildJingfangPrompt(userRequest, ragSection, refSection);
    let outlineData = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const jingfangResult = await callLLM(config, {
          provider: config.provider,
          model: config.model,
          messages: [
            { role: 'system', content: jingfangPrompt.systemPrompt },
            { role: 'user', content: jingfangPrompt.userPrompt }
          ],
          maxTokens: 3000
        });

        // 解析 JSON
        outlineData = parseJSONFromLLM(jingfangResult.content);

        // 校验数据结构
        const validation = validateOutline(outlineData);
        if (!validation.valid) {
          console.warn(`[Pipeline] Agent1 经方专家校验不通过 (attempt ${attempt + 1}): ${validation.reason}`);
          if (attempt < MAX_RETRIES) {
            console.log(`[Pipeline] Agent1 将进行第 ${attempt + 1} 次重试...`);
            ssePush({ agent: 'jingfang', status: 'retry', attempt: attempt + 1, message: `校验不通过(${validation.reason})，正在重试...` });
            outlineData = null;
            continue;
          }
        }

        // 成功或校验通过（或达到最大重试次数后仍不通过，使用最后的结果）
        break;
      } catch (e) {
        console.warn(`[Pipeline] Agent1 经方专家调用失败 (attempt ${attempt + 1}):`, e.message);
        if (attempt < MAX_RETRIES) {
          console.log(`[Pipeline] Agent1 将进行第 ${attempt + 1} 次重试...`);
          ssePush({ agent: 'jingfang', status: 'retry', attempt: attempt + 1, message: `调用失败(${e.message})，正在重试...` });
          outlineData = null;
        } else {
          outlineData = null;
        }
      }
    }

    ssePush({ agent: 'jingfang', status: 'done', data: outlineData, fallback: !outlineData });

    // ---- Agent 2: 国风设计师 — PPT 幻灯片设计 ----
    ssePush({ agent: 'designer', status: 'working', message: '正在设计PPT幻灯片...' });

    let slidesData = null;

    if (outlineData) {
      const designerPrompt = buildDesignerPrompt(outlineData);

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const designerResult = await callLLM(config, {
            provider: config.provider,
            model: config.model,
            messages: [
              { role: 'system', content: designerPrompt.systemPrompt },
              { role: 'user', content: designerPrompt.userPrompt }
            ],
            maxTokens: 4000
          });

          slidesData = parseJSONFromLLM(designerResult.content);

          // 校验数据结构
          const validation = validateSlides(slidesData);
          if (!validation.valid) {
            console.warn(`[Pipeline] Agent2 国风设计师校验不通过 (attempt ${attempt + 1}): ${validation.reason}`);
            if (attempt < MAX_RETRIES) {
              console.log(`[Pipeline] Agent2 将进行第 ${attempt + 1} 次重试...`);
              ssePush({ agent: 'designer', status: 'retry', attempt: attempt + 1, message: `校验不通过(${validation.reason})，正在重试...` });
              slidesData = null;
              continue;
            }
          }

          break;
        } catch (e) {
          console.warn(`[Pipeline] Agent2 国风设计师调用失败 (attempt ${attempt + 1}):`, e.message);
          if (attempt < MAX_RETRIES) {
            console.log(`[Pipeline] Agent2 将进行第 ${attempt + 1} 次重试...`);
            ssePush({ agent: 'designer', status: 'retry', attempt: attempt + 1, message: `调用失败(${e.message})，正在重试...` });
            slidesData = null;
          }
        }
      }
    }

    // Agent 2 失败时回退到原有 PPT 生成
    if (!slidesData || !slidesData.slides) {
      try {
        const fallbackPrompt = buildPPTPrompt(userRequest, ragSection, refSection);
        const fallbackResult = await callLLM(config, {
          provider: config.provider,
          model: config.model,
          messages: [
            { role: 'system', content: fallbackPrompt.systemPrompt },
            { role: 'user', content: fallbackPrompt.userPrompt }
          ],
          maxTokens: 4000
        });
        slidesData = parseJSONFromLLM(fallbackResult.content);
      } catch (e) {
        console.warn('[Pipeline] Agent2 回退也失败:', e.message);
      }
    }

    ssePush({ agent: 'designer', status: 'done', data: slidesData });

    // ---- Agent 3: 可视化师 — 图谱生成 ----
    ssePush({ agent: 'visual', status: 'working', message: '正在生成知识图谱...' });

    let graphData = null;

    if (outlineData) {
      const visualPrompt = buildVisualPrompt(outlineData);

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const visualResult = await callLLM(config, {
            provider: config.provider,
            model: config.model,
            messages: [
              { role: 'system', content: visualPrompt.systemPrompt },
              { role: 'user', content: visualPrompt.userPrompt }
            ],
            maxTokens: 2000
          });

          graphData = parseJSONFromLLM(visualResult.content);

          // 校验数据结构
          const validation = validateGraph(graphData);
          if (!validation.valid) {
            console.warn(`[Pipeline] Agent3 可视化师校验不通过 (attempt ${attempt + 1}): ${validation.reason}`);
            if (attempt < MAX_RETRIES) {
              console.log(`[Pipeline] Agent3 将进行第 ${attempt + 1} 次重试...`);
              ssePush({ agent: 'visual', status: 'retry', attempt: attempt + 1, message: `校验不通过(${validation.reason})，正在重试...` });
              graphData = null;
              continue;
            }
          }

          break;
        } catch (e) {
          console.warn(`[Pipeline] Agent3 可视化师调用失败 (attempt ${attempt + 1}):`, e.message);
          if (attempt < MAX_RETRIES) {
            console.log(`[Pipeline] Agent3 将进行第 ${attempt + 1} 次重试...`);
            ssePush({ agent: 'visual', status: 'retry', attempt: attempt + 1, message: `调用失败(${e.message})，正在重试...` });
            graphData = null;
          }
        }
      }
    }

    ssePush({ agent: 'visual', status: 'done', data: graphData });

    // ---- 最终结果 ----
    const durationMs = Date.now() - startTime;
    const genId = uuidv4();

    // 存入生成历史
    try {
      db.prepare(`
        INSERT INTO generation_history (id, user_id, project_id, type, prompt, response, parsed_result, model, token_usage, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId,
        req.user?.id || null,
        req.body.projectId || null,
        'ppt-pipeline',
        userRequest?.slice(0, 2000),
        JSON.stringify({ outline: outlineData ? 'ok' : 'failed', slides: slidesData ? 'ok' : 'failed', graph: graphData ? 'ok' : 'failed' }),
        JSON.stringify({ outline: outlineData, slides: slidesData, graph: graphData }),
        config.model,
        JSON.stringify({ pipeline: '3-agent' }),
        durationMs
      );
    } catch (dbErr) {
      console.warn('[Pipeline] 写入历史失败:', dbErr.message);
    }

    logAction('generate_ppt_pipeline', {
      userId: req.user?.id,
      detail: `3-Agent Pipeline 完成，耗时 ${durationMs}ms`,
      ip: req.ip
    });

    ssePush({
      status: 'complete',
      slides: slidesData,
      graph: graphData,
      outline: outlineData,
      durationMs
    });

  } catch (e) {
    console.error('[Pipeline Error]', e.message);
    ssePush({ status: 'error', error: e.message });
  }

  res.end();
});

/**
 * 从 LLM 返回文本中解析 JSON
 */
function parseJSONFromLLM(text) {
  if (!text) return null;
  try {
    let jsonStr = text;
    const jsonMatch = jsonStr.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
      const braceMatch = jsonStr.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (braceMatch) jsonStr = braceMatch[1];
    }
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function buildPPTPrompt(userRequest, ragSection, refSection) {
  // 复用 promptTemplates 中的 PPT prompt 逻辑
  const { buildPrompt } = require('../services/promptTemplates');
  const { systemPrompt, userPrompt } = buildPrompt('ppt', { userRequest, ragContext: ragSection, refFiles: [] });
  return { systemPrompt, userPrompt };
}

module.exports = router;
