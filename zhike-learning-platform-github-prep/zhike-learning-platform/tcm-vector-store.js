/**
 * 向量存储引擎 - 基于 IndexedDB
 * 存储 embedding 向量 + 文档元数据，支持余弦相似度检索
 * 特点：
 * 1. IndexedDB 持久化，刷新页面不丢失
 * 2. 余弦相似度计算（纯JS，无需后端）
 * 3. 支持增量更新：新增文档只向量化新增部分
 * 4. 混合检索：向量语义 + 关键词倒排索引双路召回
 */
class TCMVectorStore {
    constructor() {
        this.dbName = 'tcm_vector_db';
        this.dbVersion = 2;
        this.vectorStore = 'vectors';
        this.configStore = 'config';
        this.db = null;
    }

    /**
     * 初始化 IndexedDB
     */
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                // 向量存储
                if (!db.objectStoreNames.contains(this.vectorStore)) {
                    const store = db.createObjectStore(this.vectorStore, { keyPath: 'id' });
                    store.createIndex('category', 'metadata.category', { unique: false });
                }
                // 配置存储
                if (!db.objectStoreNames.contains(this.configStore)) {
                    db.createObjectStore(this.configStore, { keyPath: 'key' });
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                console.log('[VectorStore] IndexedDB 初始化完成');
                resolve();
            };

            request.onerror = (e) => {
                console.error('[VectorStore] IndexedDB 初始化失败:', e.target.error);
                reject(e.target.error);
            };
        });
    }

    // ==================== 向量存储操作 ====================

    /**
     * 添加/更新一条向量记录
     */
    async addVector(id, embedding, metadata) {
        const record = {
            id,
            embedding,
            metadata,
            updatedAt: Date.now()
        };

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.vectorStore, 'readwrite');
            const store = tx.objectStore(this.vectorStore);
            const request = store.put(record);

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * 批量添加向量
     */
    async addBatch(records) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.vectorStore, 'readwrite');
            const store = tx.objectStore(this.vectorStore);

            records.forEach(record => {
                store.put({
                    id: record.id,
                    embedding: record.embedding,
                    metadata: record.metadata,
                    updatedAt: Date.now()
                });
            });

            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * 获取单条记录
     */
    async getVector(id) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.vectorStore, 'readonly');
            const store = tx.objectStore(this.vectorStore);
            const request = store.get(id);

            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * 获取所有向量记录
     */
    async getAll() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.vectorStore, 'readonly');
            const store = tx.objectStore(this.vectorStore);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * 获取文档数量
     */
    async count() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.vectorStore, 'readonly');
            const store = tx.objectStore(this.vectorStore);
            const request = store.count();

            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * 删除单条记录
     */
    async deleteVector(id) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.vectorStore, 'readwrite');
            const store = tx.objectStore(this.vectorStore);
            const request = store.delete(id);

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * 清空所有向量
     */
    async clear() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.vectorStore, 'readwrite');
            const store = tx.objectStore(this.vectorStore);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // ==================== 向量检索 ====================

    /**
     * 余弦相似度检索
     * @param {Array<number>} queryEmbedding - 查询向量
     * @param {number} topK - 返回前K个结果
     * @param {Object} options - 可选过滤条件
     * @returns {Array<{id, score, metadata}>} - 按相似度排序的结果
     */
    async search(queryEmbedding, topK = 5, options = {}) {
        const allDocs = await this.getAll();
        const { category = null, minScore = 0 } = options;

        const scored = [];
        for (const doc of allDocs) {
            // 分类过滤
            if (category && doc.metadata?.category !== category) continue;

            const score = this.cosineSimilarity(queryEmbedding, doc.embedding);
            if (score >= minScore) {
                scored.push({
                    id: doc.id,
                    score: Math.round(score * 10000) / 10000, // 保留4位小数
                    metadata: doc.metadata
                });
            }
        }

        // 按相似度降序排序
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }

    /**
     * 混合检索：向量语义 + 关键词匹配双路召回
     * @param {Array<number>} queryEmbedding - 查询向量
     * @param {string} queryText - 原始查询文本
     * @param {number} topK - 返回数量
     */
    async hybridSearch(queryEmbedding, queryText, topK = 5) {
        // 路1：向量语义检索
        const vectorResults = await this.search(queryEmbedding, topK * 2);

        // 路2：关键词匹配（在metadata中搜索）
        const allDocs = await this.getAll();
        const keywords = this._extractKeywords(queryText);
        const keywordScores = {};

        for (const kw of keywords) {
            for (const doc of allDocs) {
                const text = (doc.metadata?.title || '') + (doc.metadata?.content || '') +
                             (doc.metadata?.keywords || []).join('');
                if (text.includes(kw)) {
                    keywordScores[doc.id] = (keywordScores[doc.id] || 0) + 2;
                }
            }
        }

        // 融合两路结果（RRF - Reciprocal Rank Fusion）
        const fusedMap = {};

        vectorResults.forEach((r, i) => {
            if (!fusedMap[r.id]) fusedMap[r.id] = { id: r.id, metadata: r.metadata, score: 0 };
            fusedMap[r.id].score += 1.0 / (i + 1); // 向量路权重
            fusedMap[r.id].vectorScore = r.score;
        });

        Object.entries(keywordScores).forEach(([id, score], i) => {
            if (!fusedMap[id]) {
                const doc = allDocs.find(d => d.id === id);
                if (doc) fusedMap[id] = { id, metadata: doc.metadata, score: 0 };
            }
            if (fusedMap[id]) {
                fusedMap[id].score += 0.5 / (i + 1); // 关键词路权重
                fusedMap[id].keywordScore = score;
            }
        });

        const results = Object.values(fusedMap);
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }

    // ==================== 工具方法 ====================

    /**
     * 余弦相似度
     */
    cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length) return 0;

        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom < 1e-8 ? 0 : dot / denom;
    }

    /**
     * 简单关键词提取（中文2-3字滑窗）
     */
    _extractKeywords(text) {
        const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
        const kws = new Set();
        for (let i = 0; i < clean.length; i++) {
            if (i < clean.length - 1) kws.add(clean.substr(i, 2));
            if (i < clean.length - 2) kws.add(clean.substr(i, 3));
        }
        return Array.from(kws);
    }

    // ==================== 配置管理 ====================

    async setConfig(key, value) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.configStore, 'readwrite');
            const store = tx.objectStore(this.configStore);
            const request = store.put({ key, value });

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async getConfig(key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.configStore, 'readonly');
            const store = tx.objectStore(this.configStore);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * 获取分类统计
     */
    async getCategoryStats() {
        const allDocs = await this.getAll();
        const stats = {};
        allDocs.forEach(doc => {
            const cat = doc.metadata?.category || '未分类';
            stats[cat] = (stats[cat] || 0) + 1;
        });
        return stats;
    }
}

// 导出
window.TCMVectorStore = TCMVectorStore;
