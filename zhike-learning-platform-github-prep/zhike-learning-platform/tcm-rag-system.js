/**
 * 中医知识库 RAG 系统 V3.0 - 向量语义检索版
 *
 * 核心升级：关键词搜索 → 向量语义检索（Transformers.js + IndexedDB）
 * 流程：Query → Embedding → 向量检索TopK → 拼接Prompt → LLM生成回答
 *
 * 知识库覆盖7大类：基础理论、诊断四诊、方剂、穴位经络、中药、经典条文、教学案例
 * 支持外部知识库文件扩展 + 自定义文档增删
 * 支持多AI提供商：Anthropic / OpenAI / 百度 / 讯飞
 */

// ==================== 知识库数据（兼容旧版加载方式） ====================
const TCM_KNOWLEDGE_BASE = (function() {
    const base = (typeof TCM_KNOWLEDGE_BASE_FULL !== 'undefined') ? TCM_KNOWLEDGE_BASE_FULL : [];
    const part2 = (typeof TCM_KNOWLEDGE_BASE_PART2 !== 'undefined') ? TCM_KNOWLEDGE_BASE_PART2 : [];
    const merged = [...base, ...part2];
    if (merged.length === 0) {
        return [
            { id: 'yy_001', category: '基础理论', title: '阴阳的基本概念',
              content: '阴阳是中国古代哲学的一对范畴，是对自然界相互关联的某些事物或现象对立双方属性的概括。',
              keywords: ['阴阳','概念','属性','对立','哲学','基本'],
              source: '《中医基础理论》第一章', relevance: 10 },
            { id: 'wx_001', category: '基础理论', title: '五行特性',
              content: '木曰曲直、火曰炎上、土爰稼穑、金曰从革、水曰润下。',
              keywords: ['五行','特性','木','火','土','金','水'],
              source: '《中医基础理论》第二章', relevance: 10 },
            { id: 'zd_001', category: '诊断四诊', title: '八纲辨证',
              content: '八纲即阴阳、表里、寒热、虚实八类辨证纲领。',
              keywords: ['八纲','辨证','阴阳','表里','寒热','虚实'],
              source: '《中医诊断学》第二章', relevance: 10 }
        ];
    }
    return merged;
})();

// ==================== RAG 系统主类 ====================
class TCMRAGSystem {
    constructor() {
        // 三个核心组件
        this.embedder = null;       // TCMEmbedder 实例（向量化引擎）
        this.vectorStore = null;    // TCMVectorStore 实例（向量存储）
        this.knowledgeDocs = [];    // 原始知识库文档

        // 状态
        this.isVectorized = false;  // 知识库是否已完成向量化
        this.isInitialized = false;

        // API配置
        this.apiConfig = {
            enabled: false,
            endpoint: '',
            apiKey: '',
            model: 'claude-sonnet-4-20250514',
            provider: 'anthropic'
        };

        // 历史记录
        this.history = [];
        this.maxHistory = 20;
    }

    /**
     * 初始化整个 RAG 系统
     * @param {Function} onProgress - 进度回调 {stage, progress, message}
     */
    async init(onProgress) {
        const report = (stage, progress, message) => {
            if (onProgress) onProgress({ stage, progress, message });
        };

        try {
            // Step 1: 加载知识库数据
            report('knowledge', 5, '正在加载知识库数据...');
            const customDocs = this._loadCustomDocs();
            this.knowledgeDocs = [...TCM_KNOWLEDGE_BASE, ...customDocs];
            report('knowledge', 15, `已加载 ${this.knowledgeDocs.length} 条知识条目`);

            // Step 2: 初始化向量存储
            report('store', 20, '正在初始化向量数据库...');
            this.vectorStore = new TCMVectorStore();
            await this.vectorStore.init();
            const existingCount = await this.vectorStore.count();
            report('store', 30, `向量数据库已有 ${existingCount} 条向量`);

            // Step 3: 检查是否需要向量化
            if (existingCount >= this.knowledgeDocs.length) {
                report('vectorize', 35, '知识库已向量化，跳过');
                this.isVectorized = true;
            } else {
                report('vectorize', 35, '需要向量化知识库（将在首次提问时自动执行）');
            }

            // Step 4: 加载API配置（优先后端，降级 localStorage）
            try {
                const resp = await fetch('/api/llm/config');
                if (resp.ok) {
                    const cfg = await resp.json();
                    this.apiConfig = { ...this.apiConfig, ...cfg };
                }
            } catch {
                const savedConfig = localStorage.getItem('tcm_api_config');
                if (savedConfig) {
                    this.apiConfig = { ...this.apiConfig, ...JSON.parse(savedConfig) };
                }
            }

            // Step 5: 加载历史记录
            this._loadHistory();

            this.isInitialized = true;
            report('done', 100, 'RAG系统就绪');

            console.log(`[TCMRAG] 系统初始化完成 | 知识库: ${this.knowledgeDocs.length}条 | 向量化: ${this.isVectorized ? '是' : '待执行'}`);

        } catch (error) {
            console.error('[TCMRAG] 初始化失败:', error);
            report('error', 0, '初始化失败: ' + error.message);
            throw error;
        }
    }

    /**
     * 加载 Embedding 模型 + 向量化知识库
     * @param {Function} onProgress - 进度回调
     */
    async vectorizeKnowledge(onProgress) {
        const report = (stage, progress, message) => {
            if (onProgress) onProgress({ stage, progress, message });
        };

        // Step 1: 初始化 Embedder（即使已向量化也需要加载embedder来做查询向量化）
        if (!this.embedder || !this.embedder.isLoaded) {
            report('model', 0, '正在加载 Embedding 模型...');
            this.embedder = new TCMEmbedder();
            await this.embedder.init((progress, status) => {
                report('model', Math.round(progress * 0.6), status);
            });
        }

        // 如果知识库已全部向量化，直接返回
        if (this.isVectorized) {
            report('vectorize', 100, '知识库已向量化，模型已就绪');
            return;
        }

        // Step 2: 检查已有的向量化进度
        const existingCount = await this.vectorStore.count();
        const docsToVectorize = this.knowledgeDocs.slice(existingCount);

        if (docsToVectorize.length === 0) {
            this.isVectorized = true;
            report('vectorize', 100, '知识库已全部向量化');
            return;
        }

        // Step 3: 批量向量化
        report('vectorize', 60, `开始向量化 ${docsToVectorize.length} 条文档...`);

        for (let i = 0; i < docsToVectorize.length; i++) {
            const doc = docsToVectorize[i];

            // 构建用于向量化的文本（标题 + 内容摘要）
            const textForEmbed = doc.title + '。' + (doc.content || '').substring(0, 500);

            try {
                const embedding = await this.embedder.embed(textForEmbed);

                await this.vectorStore.addVector(doc.id, embedding, {
                    id: doc.id,
                    title: doc.title,
                    category: doc.category,
                    content: doc.content,
                    source: doc.source,
                    keywords: doc.keywords || []
                });
            } catch (e) {
                console.warn(`[TCMRAG] 文档 ${doc.id} 向量化失败:`, e);
            }

            const pct = 60 + Math.round((i + 1) / docsToVectorize.length * 35);
            report('vectorize', pct, `向量化进度: ${i + 1}/${docsToVectorize.length}`);

            // 每处理5条让出主线程
            if (i % 5 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        this.isVectorized = true;
        report('done', 100, `向量化完成！共 ${this.knowledgeDocs.length} 条`);

        // 保存向量化标记
        await this.vectorStore.setConfig('vectorized_count', this.knowledgeDocs.length);
        await this.vectorStore.setConfig('vectorized_at', Date.now());
    }

    /**
     * RAG 问答核心方法
     * @param {string} question - 用户问题
     * @param {Object} options - {topK, category, useAPI}
     * @returns {{answer, sources, confidence, method}}
     */
    async generateAnswer(question, options = {}) {
        const { topK = 5, category = null, useAPI = this.apiConfig.enabled } = options;

        // 如果还没向量化，先执行向量化
        if (!this.isVectorized) {
            await this.vectorizeKnowledge();
        }

        // 如果已向量化但embedder未加载（页面刷新后的情况），按需加载embedder
        if (this.isVectorized && !this.embedder) {
            try {
                this.embedder = new TCMEmbedder();
                await this.embedder.init((progress, status) => {
                    console.log(`[TCMRAG] Embedder加载: ${progress}% - ${status}`);
                });
            } catch (e) {
                console.warn('[TCMRAG] Embedder加载失败，降级为关键词检索:', e);
                this.embedder = null;
            }
        }

        let searchResults;

        if (this.isVectorized && this.embedder && this.embedder.isLoaded) {
            // ===== 向量语义检索 =====
            const queryEmbedding = await this.embedder.embed(question);
            searchResults = await this.vectorStore.hybridSearch(queryEmbedding, question, topK);
            searchResults = searchResults.map(r => ({
                document: {
                    id: r.id,
                    title: r.metadata?.title || '',
                    content: r.metadata?.content || '',
                    source: r.metadata?.source || '',
                    category: r.metadata?.category || '',
                    keywords: r.metadata?.keywords || []
                },
                score: r.score,
                vectorScore: r.vectorScore || 0
            }));
        } else {
            // ===== 降级：关键词检索 =====
            searchResults = this._keywordSearch(question, topK);
        }

        if (searchResults.length === 0) {
            return {
                answer: '抱歉，在知识库中没有找到与您问题相关的内容。请尝试换一种方式描述您的问题。',
                sources: [],
                confidence: 0,
                method: this.isVectorized ? 'vector' : 'keyword'
            };
        }

        // 构建上下文
        const context = searchResults.map(r => ({
            title: r.document.title,
            content: r.document.content,
            source: r.document.source,
            category: r.document.category,
            score: r.score
        }));

        // 构建提示词
        const prompt = this._buildPrompt(question, context);

        // 生成回答
        let answer;
        if (useAPI && this.apiConfig.endpoint) {
            try {
                answer = await this._callAPI(prompt);
            } catch (e) {
                console.warn('[TCMRAG] API调用失败，降级为本地回答:', e);
                answer = this._generateLocalAnswer(question, context);
            }
        } else {
            answer = this._generateLocalAnswer(question, context);
        }

        // 保存历史
        this._addToHistory(question, answer, context);

        return {
            answer,
            sources: context,
            confidence: this._calculateConfidence(searchResults),
            method: this.isVectorized ? 'vector' : 'keyword',
            retrievedCount: searchResults.length
        };
    }

    // ==================== 提示词构建 ====================

    _buildPrompt(question, context) {
        let prompt = '你是一位经验丰富的中医专家和教师。请严格基于以下知识库检索结果回答学生的问题。\n\n';
        prompt += '【检索到的知识库内容】\n';
        prompt += '---\n';
        context.forEach((ctx, i) => {
            prompt += `[文档${i + 1}] ${ctx.title}\n`;
            prompt += `来源: ${ctx.source}\n`;
            prompt += `相关度: ${Math.round(ctx.score * 100)}%\n`;
            prompt += `内容: ${ctx.content}\n`;
            prompt += '---\n';
        });
        prompt += `\n【学生问题】\n${question}\n\n`;
        prompt += '【回答要求】\n';
        prompt += '1. 综合多个文档内容，给出完整准确的回答\n';
        prompt += '2. 使用专业中医术语，但要注意解释清楚\n';
        prompt += '3. 引用时标注来源文献\n';
        prompt += '4. 如果检索结果不足以完全回答问题，请说明并给出已知部分\n';
        prompt += '5. 回答要有教学逻辑，适合课堂讲解\n\n';
        prompt += '请回答：';
        return prompt;
    }

    // ==================== 本地回答生成 ====================

    _generateLocalAnswer(question, context) {
        if (context.length === 0) return '抱歉，知识库中没有找到相关内容。';

        const sorted = [...context].sort((a, b) => b.score - a.score);
        let answer = '';

        // 主答案
        answer += `📚 根据知识库检索（共匹配 ${sorted.length} 条相关内容），为您解答：\n\n`;
        answer += `【${sorted[0].title}】\n\n`;
        answer += sorted[0].content + '\n\n';

        // 补充内容
        if (sorted.length > 1) {
            answer += '📋 **相关扩展知识：**\n\n';
            for (let i = 1; i < sorted.length; i++) {
                const preview = sorted[i].content.length > 80
                    ? sorted[i].content.substring(0, 80) + '...'
                    : sorted[i].content;
                answer += `${i}. **${sorted[i].title}**（${sorted[i].source}）\n   ${preview}\n\n`;
            }
        }

        // 来源标注
        answer += `---\n📎 主要来源：${sorted[0].source}`;

        return answer;
    }

    // ==================== 关键词检索（降级方案） ====================

    _keywordSearch(query, topK = 5) {
        const clean = query.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
        const tokens = new Set();
        for (let i = 0; i < clean.length; i++) {
            if (i < clean.length - 1) tokens.add(clean.substr(i, 2));
            if (i < clean.length - 2) tokens.add(clean.substr(i, 3));
        }

        const scores = {};
        this.knowledgeDocs.forEach(doc => {
            const text = (doc.title || '') + (doc.content || '') + (doc.keywords || []).join('');
            let score = 0;
            tokens.forEach(token => {
                if (text.includes(token)) score += 1;
                if ((doc.keywords || []).includes(token)) score += 3;
            });
            if (score > 0) {
                scores[doc.id] = { document: doc, score };
            }
        });

        return Object.values(scores)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    // ==================== API 调用 ====================

    async _callAPI(prompt) {
        // 优先后端代理，降级直连
        try {
            const resp = await fetch('/api/llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: this.apiConfig.provider,
                    model: this.apiConfig.model,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 2000
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                return data.content || '';
            }
            throw new Error('后端代理返回 ' + resp.status);
        } catch {
            // 降级：直连 LLM API（兼容无后端场景）
            const { provider, endpoint, apiKey, model } = this.apiConfig;
            if (!endpoint || !apiKey) throw new Error('API 未配置');

            const headers = { 'Content-Type': 'application/json' };
            let body;
            if (provider === 'anthropic') {
                headers['x-api-key'] = apiKey;
                headers['anthropic-version'] = '2023-06-01';
            } else {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
            body = JSON.stringify({
                model, max_tokens: 2000,
                messages: [{ role: 'user', content: prompt }]
            });

            const response = await fetch(endpoint, { method: 'POST', headers, body });
            if (!response.ok) throw new Error(`API ${response.status}`);
            const data = await response.json();

            if (provider === 'anthropic') return data.content?.[0]?.text || '';
            if (provider === 'openai') return data.choices?.[0]?.message?.content || '';
            return data.result || data.choices?.[0]?.message?.content || 'API返回格式异常';
        }
    }

    // ==================== 配置管理 ====================

    configureAPI(config) {
        this.apiConfig = { ...this.apiConfig, ...config, enabled: true };
        // 优先后端存储
        fetch('/api/llm/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.apiConfig)
        }).catch(() => {
            localStorage.setItem('tcm_api_config', JSON.stringify(this.apiConfig));
        });
    }

    disableAPI() {
        this.apiConfig.enabled = false;
        fetch('/api/llm/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.apiConfig)
        }).catch(() => {
            localStorage.setItem('tcm_api_config', JSON.stringify(this.apiConfig));
        });
    }

    // ==================== 自定义文档管理 ====================

    _loadCustomDocs() {
        try {
            const saved = localStorage.getItem('tcm_custom_docs');
            return saved ? JSON.parse(saved) : [];
        } catch { return []; }
    }

    async addDocument(doc) {
        if (!doc.id || !doc.content) throw new Error('文档必须包含id和content字段');

        let customDocs = this._loadCustomDocs();
        if (customDocs.find(d => d.id === doc.id)) throw new Error(`文档ID ${doc.id} 已存在`);

        customDocs.push(doc);
        localStorage.setItem('tcm_custom_docs', JSON.stringify(customDocs));
        this.knowledgeDocs.push(doc);

        // 如果已向量化，对新文档也做向量化
        if (this.isVectorized && this.embedder?.isLoaded) {
            const text = (doc.title || '') + '。' + doc.content.substring(0, 500);
            const embedding = await this.embedder.embed(text);
            await this.vectorStore.addVector(doc.id, embedding, {
                id: doc.id, title: doc.title, category: doc.category,
                content: doc.content, source: doc.source, keywords: doc.keywords || []
            });
        }

        return doc;
    }

    async removeDocument(docId) {
        let customDocs = this._loadCustomDocs();
        customDocs = customDocs.filter(d => d.id !== docId);
        localStorage.setItem('tcm_custom_docs', JSON.stringify(customDocs));
        this.knowledgeDocs = this.knowledgeDocs.filter(d => d.id !== docId);

        if (this.vectorStore) {
            await this.vectorStore.deleteVector(docId);
        }
    }

    getCustomDocuments() {
        return this._loadCustomDocs();
    }

    // ==================== 历史记录 ====================

    _loadHistory() {
        try {
            const saved = localStorage.getItem('tcm_rag_history');
            if (saved) this.history = JSON.parse(saved);
        } catch { /* ignore */ }
    }

    _addToHistory(question, answer, sources) {
        this.history.unshift({
            timestamp: new Date().toISOString(),
            question,
            answer,
            sourceCount: sources.length,
            topSource: sources[0]?.title || ''
        });
        if (this.history.length > this.maxHistory) {
            this.history = this.history.slice(0, this.maxHistory);
        }
        try {
            localStorage.setItem('tcm_rag_history', JSON.stringify(this.history));
        } catch { /* ignore */ }
    }

    clearHistory() {
        this.history = [];
        localStorage.removeItem('tcm_rag_history');
    }

    // ==================== 统计与状态 ====================

    _calculateConfidence(results) {
        if (results.length === 0) return 0;
        const maxScore = Math.max(...results.map(r => r.score || 0));
        // 向量相似度一般在 0~1 之间，关键词分数一般 > 1
        if (maxScore <= 1) {
            return Math.round(maxScore * 100);
        }
        return Math.min(100, Math.round(maxScore * 10));
    }

    async getStats() {
        let vectorCount = 0;
        let categoryStats = {};
        if (this.vectorStore) {
            vectorCount = await this.vectorStore.count();
            categoryStats = await this.vectorStore.getCategoryStats();
        }

        return {
            totalDocs: this.knowledgeDocs.length,
            vectorizedDocs: vectorCount,
            isVectorized: this.isVectorized,
            embedderLoaded: this.embedder?.isLoaded || false,
            modelName: this.embedder?.modelName || '未加载',
            categories: categoryStats,
            apiEnabled: this.apiConfig.enabled,
            historyCount: this.history.length
        };
    }

    /**
     * 向量相似度测试：比较两段文本的相似度
     */
    async similarity(textA, textB) {
        if (!this.embedder?.isLoaded) throw new Error('Embedding模型未加载');
        const embA = await this.embedder.embed(textA);
        const embB = await this.embedder.embed(textB);
        return this.vectorStore.cosineSimilarity(embA, embB);
    }
}

// ==================== 导出 ====================
window.TCMRAG = new TCMRAGSystem();
window.TCMRAGSystem = TCMRAGSystem;
