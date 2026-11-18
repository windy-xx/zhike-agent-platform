/**
 * LLM 多 Provider 调用服务
 * 统一封装 anthropic / openai / baidu / xunfei 差异
 * 支持主备双 API 自动切换
 */

/**
 * 掩码 API Key
 */
function maskKey(key) {
  if (!key || key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/**
 * 备用 API 配置列表
 * 主 API 失败（限流/报错）时自动尝试备用
 */
const FALLBACK_CONFIGS = [
  {
    provider: 'openai',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    api_key: process.env.ZHIKE_FALLBACK_API_KEY || '',
    model: 'glm-4v-flash'
  }
];

/**
 * 单次 LLM 调用（不含降级逻辑）
 */
async function callSingleLLM(config, params) {
  const { provider, model, messages, maxTokens = 2000, test = false } = params;
  const headers = { 'Content-Type': 'application/json' };
  let body;
  let endpoint = config.endpoint;

  if (provider === 'anthropic') {
    headers['x-api-key'] = config.api_key;
    headers['anthropic-version'] = '2023-06-01';
    body = JSON.stringify({ model, max_tokens: maxTokens, messages }); // content 支持多模态数组格式
  } else if (provider === 'baidu') {
    if (config.api_key && config.api_key.includes('|')) {
      // 旧版 AK|SK
      const [ak, sk] = config.api_key.split('|');
      const tokenResp = await fetch(
        `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${ak}&client_secret=${sk}`,
        { method: 'POST' }
      );
      const tokenData = await tokenResp.json();
      if (!tokenData.access_token) {
        if (test) return { success: false, message: '百度 access_token 获取失败' };
        throw new Error('百度 access_token 获取失败，请检查 AK/SK');
      }
      if (test) return { success: true, message: '百度 AK/SK 验证成功' };

      const modelEndpointMap = {
        'ernie-4.0-8k': 'completions_pro',
        'ernie-3.5-8k': 'completions',
        'ernie-speed-128k': 'ernie-speed-128k',
        'ernie-lite-8k': 'eb-instant',
        'deepseek-v3': 'deepseek_v3',
        'deepseek-r1': 'deepseek_r1'
      };
      const apiPath = modelEndpointMap[model] || 'completions_pro';
      endpoint = `https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/${apiPath}?access_token=${tokenData.access_token}`;
      delete headers['Authorization'];
      body = JSON.stringify({ model, messages });
    } else {
      // 千帆 v2 / BCE 鉴权
      headers['Authorization'] = `Bearer ${config.api_key}`;
      body = JSON.stringify({ model, max_tokens: maxTokens, messages });
    }
  } else {
    // openai / xunfei 兼容格式
    headers['Authorization'] = `Bearer ${config.api_key}`;
    // glm-4v-flash 等视觉模型不支持 max_tokens 参数
    const bodyObj = { model, messages };
    if (!model.includes('4v')) bodyObj.max_tokens = maxTokens;
    body = JSON.stringify(bodyObj);
  }

  const timeout = test ? 30000 : 120000;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeout)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    if (test) return { success: false, message: `HTTP ${response.status}: ${errText.slice(0, 200)}` };
    throw new Error(`LLM API ${response.status}: ${errText}`);
  }

  const data = await response.json();

  // 百度限流检测：HTTP 200 但 body 中有 error_code
  if (provider === 'baidu' && data.error_code) {
    const errMsg = data.error_msg || `error_code: ${data.error_code}`;
    console.warn(`[LLM] 百度API错误: ${errMsg}`);
    if (test) return { success: false, message: `百度: ${errMsg}` };
    throw new Error(`百度API: ${errMsg}`);
  }

  if (test) return { success: true, message: '连接成功' };

  // 按 provider 解析响应
  let content = '';
  if (provider === 'anthropic') {
    content = data.content?.[0]?.text || '';
  } else if (provider === 'baidu') {
    content = data.result || data.choices?.[0]?.message?.content || '';
  } else {
    content = data.choices?.[0]?.message?.content || data.result || '';
  }

  return { content, usage: data.usage || null, usedProvider: provider, usedModel: model };
}

/**
 * 统一调用 LLM（含自动降级）
 * 主 API 失败时自动尝试备用 API
 */
async function callLLM(config, params) {
  try {
    // 第一次尝试：用主配置
    const result = await callSingleLLM(config, params);
    return result;
  } catch (primaryError) {
    console.warn(`[LLM] 主API失败(${config.provider}): ${primaryError.message}`);

    // 测试模式不降级
    if (params.test) {
      return { success: false, message: `主API失败: ${primaryError.message}` };
    }

    // 尝试备用 API
    for (const fallback of FALLBACK_CONFIGS) {
      if (!fallback.api_key) continue; // 未配置备用密钥则不尝试备用API
      // 跳过和主配置相同的
      if (fallback.endpoint === config.endpoint) continue;
      try {
        console.log(`[LLM] 尝试备用API: ${fallback.provider}/${fallback.model}`);
        const result = await callSingleLLM(fallback, {
          ...params,
          provider: fallback.provider,
          model: fallback.model || params.model
        });
        console.log(`[LLM] 备用API成功: ${fallback.provider}`);
        return result;
      } catch (fbError) {
        console.warn(`[LLM] 备用API也失败(${fallback.provider}): ${fbError.message}`);
      }
    }

    // 全部失败，抛出原始错误
    throw primaryError;
  }
}

module.exports = { callLLM, maskKey };
