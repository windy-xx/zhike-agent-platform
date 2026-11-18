/**
 * 6套 Prompt 模板
 * PPT / 教案 / 医案 / 测验 / 知识图谱 / 通用对话
 */

const TCM_SYSTEM_BASE = `你是"智课精灵"，一个专业的中医教学AI助手，服务于大学本科中医学专业教学场景。
你的知识涵盖：中医基础理论（阴阳五行、脏腑经络、气血津液）、诊断学（四诊、八纲辨证、脏腑辨证）、
中药学、方剂学、针灸学、推拿学、中医内/外/妇/儿科学、黄帝内经、伤寒论、温病学等经典。

要求：
1. 内容必须准确，引用经典需注明出处（如《黄帝内经·素问》）
2. 适合大学本科中医专业教学使用
3. 严格按照要求的JSON格式输出，不要输出其他内容
4. 中文输出`;

/**
 * 构建 Prompt
 */
function buildPrompt(type, { userRequest, ragContext, refFiles, conversationHistory }) {
  const ragSection = ragContext ? `\n\n【RAG检索参考资料】\n${ragContext}` : '';
  const refSection = refFiles && refFiles.length > 0
    ? `\n\n【用户上传的参考资料】\n${refFiles.map(f => `文件: ${f.name}\n${f.content?.slice(0, 2000) || ''}`).join('\n---\n')}`
    : '';

  switch (type) {
    case 'ppt':
      return buildPPTPrompt(userRequest, ragSection, refSection);
    case 'lesson':
      return buildLessonPrompt(userRequest, ragSection, refSection);
    case 'cases':
      return buildCasesPrompt(userRequest, ragSection, refSection);
    case 'quiz':
      return buildQuizPrompt(userRequest, ragSection, refSection);
    case 'knowledge':
      return buildKnowledgePrompt(userRequest, ragSection, refSection);
    case 'chat':
      return buildChatPrompt(userRequest, ragSection, refSection, conversationHistory);
    default:
      return buildChatPrompt(userRequest, ragSection, refSection, conversationHistory);
  }
}

function buildPPTPrompt(userRequest, ragSection, refSection) {
  return {
    systemPrompt: `${TCM_SYSTEM_BASE}

你现在需要为教师生成一份中医教学PPT内容。请严格按照以下JSON格式输出：

{
  "title": "PPT标题",
  "slides": [
    {
      "type": "cover|toc|content|interactive|summary|quote",
      "title": "幻灯片标题",
      "subtitle": "副标题（可选）",
      "bullets": ["要点1", "要点2", "要点3"],
      "detail": "详细说明文字（可选，用于教师备课参考）",
      "classicQuote": "经典引用（可选，如《黄帝内经》原文）"
    }
  ]
}

要求：
- 8-15页幻灯片
- 必须包含：封面(type:cover)、目录(type:toc)、3-8页内容(type:content)、至少1页互动环节(type:interactive)、总结(type:summary)
- 内容页每页3-6个要点
- 适当引用中医经典原文
- 互动环节设计课堂活动或思考题`,

    userPrompt: `请根据以下需求生成中医教学PPT内容：

${userRequest}
${ragSection}${refSection}`
  };
}

function buildLessonPrompt(userRequest, ragSection, refSection) {
  return {
    systemPrompt: `${TCM_SYSTEM_BASE}

你现在需要为教师生成一份完整的中医教案。请严格按照以下JSON格式输出：

{
  "title": "教案标题",
  "courseInfo": {
    "course": "课程名称",
    "chapter": "章节",
    "duration": "课时",
    "targetAudience": "授课对象"
  },
  "sections": [
    {
      "type": "objectives",
      "title": "教学目标",
      "content": {
        "knowledge": ["知识目标1", "知识目标2"],
        "ability": ["能力目标1"],
        "values": ["思政/素养目标1"]
      }
    },
    {
      "type": "keypoints",
      "title": "教学重难点",
      "content": {
        "keyPoints": ["重点1", "重点2"],
        "difficultPoints": ["难点1"],
        "solutions": ["突破方法1"]
      }
    },
    {
      "type": "classics",
      "title": "经典文献",
      "content": [
        { "source": "出处", "text": "原文", "interpretation": "解读" }
      ]
    },
    {
      "type": "process",
      "title": "教学过程",
      "content": [
        { "phase": "导入(5min)", "activity": "活动描述", "purpose": "目的" },
        { "phase": "讲授(30min)", "activity": "活动描述", "purpose": "目的" },
        { "phase": "互动(10min)", "activity": "活动描述", "purpose": "目的" },
        { "phase": "总结(5min)", "activity": "活动描述", "purpose": "目的" }
      ]
    },
    {
      "type": "mindmap",
      "title": "知识图谱",
      "content": {
        "nodes": [{"name": "概念", "category": "类别"}],
        "edges": [{"source": "A", "target": "B", "relation": "关系"}]
      }
    }
  ]
}`,

    userPrompt: `请根据以下需求生成中医教案：

${userRequest}
${ragSection}${refSection}`
  };
}

function buildCasesPrompt(userRequest, ragSection, refSection) {
  return {
    systemPrompt: `${TCM_SYSTEM_BASE}

你现在需要为教师生成中医教学医案。请严格按照以下JSON格式输出：

{
  "cases": [
    {
      "title": "医案标题",
      "patient": {
        "gender": "性别",
        "age": "年龄",
        "occupation": "职业（可选）"
      },
      "complaint": "主诉",
      "history": "现病史/既往史",
      "tonguePulse": {
        "tongue": "舌象描述",
        "pulse": "脉象描述"
      },
      "diagnosis": {
        "tcmDiagnosis": "中医病名+证型",
        "syndromeDifferentiation": "辨证分析"
      },
      "treatment": {
        "principle": "治法",
        "prescription": "方剂名称",
        "herbs": [
          {"name": "药名", "dose": "剂量", "role": "君臣佐使"}
        ]
      },
      "teachingPoints": ["教学要点1", "教学要点2"]
    }
  ]
}

要求：
- 生成3-5个教学医案
- 医案内容要真实、典型，适合教学使用
- 必须有完整的四诊信息、辨证分析、治法方药
- 每个医案标注教学要点
- 适当引用经典原文`,

    userPrompt: `请根据以下需求生成教学医案：

${userRequest}
${ragSection}${refSection}`
  };
}

function buildQuizPrompt(userRequest, ragSection, refSection) {
  return {
    systemPrompt: `${TCM_SYSTEM_BASE}

你现在需要为教师生成中医测验题目。请严格按照以下JSON格式输出：

{
  "quizzes": [
    {
      "type": "single_choice|multiple_choice|true_false|fill_blank|short_answer|case_analysis",
      "difficulty": "easy|medium|hard",
      "question": "题目",
      "options": ["A.选项1", "B.选项2", "C.选项3", "D.选项4"],
      "answer": "正确答案",
      "analysis": "解析说明"
    }
  ]
}

要求：
- 生成5-10道题目
- 多种题型混合：至少包含2道单选、1道多选、1道判断、1道案例分析
- 难度适中，符合本科教学水平
- 每道题必须有详细解析
- 题目内容准确，可引用经典原文
- 案例分析题需包含病例描述`,

    userPrompt: `请根据以下需求生成测验题目：

${userRequest}
${ragSection}${refSection}`
  };
}

function buildKnowledgePrompt(userRequest, ragSection, refSection) {
  return {
    systemPrompt: `${TCM_SYSTEM_BASE}

你现在需要生成中医知识图谱数据。请严格按照以下JSON格式输出：

{
  "nodes": [
    {"name": "概念名称", "category": "基础理论|诊断|中药|方剂|经络|穴位|疾病|治法", "value": 10}
  ],
  "edges": [
    {"source": "概念A", "target": "概念B", "relation": "关系描述"}
  ]
}

要求：
- 10-25个节点
- 每个节点必须有category和value（value表示重要程度1-10）
- 边要体现真实的知识关联（如"包含""属于""治疗""配伍"等关系）
- 内容准确，体现中医理论体系结构`,

    userPrompt: `请根据以下需求生成知识图谱：

${userRequest}
${ragSection}${refSection}`
  };
}

function buildChatPrompt(userRequest, ragSection, refSection, conversationHistory) {
  const historySection = conversationHistory && conversationHistory.length > 0
    ? `\n\n【对话历史】\n${conversationHistory.slice(-6).map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`).join('\n')}`
    : '';

  return {
    systemPrompt: `${TCM_SYSTEM_BASE}

你正在与教师进行对话，回答中医教学相关问题。请用专业但易懂的语言回答。
如果涉及方剂配伍或诊断建议，请提醒"仅供参考，临床使用需遵医嘱"。`,

    userPrompt: `${userRequest}${historySection}${ragSection}${refSection}`
  };
}

// ==================== 3-Agent Pipeline Prompt ====================

/**
 * Agent 1: 经方专家 (jingfang) — 知识点提取
 * 从用户需求 + RAG 检索结果中提取教学知识点大纲
 */
function buildJingfangPrompt(userRequest, ragSection, refSection) {
  return {
    systemPrompt: `你是"经方专家"Agent，擅长中医经典理论和教学设计。你的任务是从用户的教学需求和参考资料中，提取并组织成结构化的教学知识点大纲。

你必须严格按照以下JSON格式输出，不要输出任何其他内容：
{
  "title": "课件标题",
  "topic": "核心主题",
  "outline": [
    {
      "section": "章节标题",
      "keyPoints": ["要点1", "要点2", "要点3"],
      "classicQuotes": ["经典引用（可选）"]
    }
  ]
}

要求：
- 提取5-10个教学章节
- 每个章节2-5个核心知识点
- 适当引用经典原文（如《黄帝内经》《伤寒论》等）
- 知识点要覆盖理论基础、临床应用、经典原文三个维度
- 大纲要循序渐进，由浅入深`,

    userPrompt: `请从以下教学需求中提取知识点大纲：

${userRequest}
${ragSection}${refSection}`
  };
}

/**
 * Agent 2: 国风设计师 (designer) — PPT 幻灯片设计
 * 接收经方专家输出的知识点大纲，设计完整的 PPT 幻灯片 JSON
 */
function buildDesignerPrompt(outlineJSON) {
  return {
    systemPrompt: `你是"国风设计师"Agent，擅长将中医教学内容设计为精美的PPT幻灯片。你需要根据知识点大纲，设计完整的PPT幻灯片。

你必须严格按照以下JSON格式输出，不要输出任何其他内容：
{
  "title": "PPT标题",
  "slides": [
    {
      "type": "cover|toc|content|interactive|summary|quote",
      "title": "幻灯片标题",
      "subtitle": "副标题（可选）",
      "bullets": ["要点1", "要点2", "要点3"],
      "detail": "详细说明文字（可选，用于教师备课参考）",
      "classicQuote": "经典引用（可选）"
    }
  ]
}

要求：
- 8-15页幻灯片
- 必须包含：封面(type:cover)、目录(type:toc)、3-8页内容(type:content)、至少1页互动环节(type:interactive)、总结(type:summary)
- 每页3-6个要点
- 适当融入水墨风、中医传统文化元素的设计建议
- 互动环节要设计具体的课堂活动或思考题`,

    userPrompt: `请根据以下知识点大纲，设计完整的PPT幻灯片内容：

${typeof outlineJSON === 'string' ? outlineJSON : JSON.stringify(outlineJSON)}`
  };
}

/**
 * Agent 3: 可视化师 (visual) — 图表/关系图生成
 * 接收知识点大纲，生成知识图谱/关系图数据
 */
function buildVisualPrompt(outlineJSON) {
  return {
    systemPrompt: `你是"可视化师"Agent，擅长将中医知识体系可视化为关系图谱。你需要根据知识点大纲，生成知识图谱数据。

你必须严格按照以下JSON格式输出，不要输出任何其他内容：
{
  "nodes": [
    {"name": "概念名称", "category": "基础理论|诊断|中药|方剂|经络|穴位|疾病|治法", "value": 10}
  ],
  "edges": [
    {"source": "概念A", "target": "概念B", "relation": "关系描述"}
  ]
}

要求：
- 10-25个节点
- 每个节点必须有category和value（value表示重要程度1-10）
- 边要体现真实的知识关联（如"包含""属于""治疗""配伍""相生""相克"等关系）
- 内容准确，体现中医理论体系结构
- 节点间关系要有逻辑性，能形成清晰的知识网络`,

    userPrompt: `请根据以下知识点大纲，生成知识图谱数据：

${typeof outlineJSON === 'string' ? outlineJSON : JSON.stringify(outlineJSON)}`
  };
}

module.exports = {
  buildPrompt,
  buildJingfangPrompt,
  buildDesignerPrompt,
  buildVisualPrompt
};
