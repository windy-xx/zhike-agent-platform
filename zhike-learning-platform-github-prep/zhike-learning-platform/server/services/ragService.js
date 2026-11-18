/**
 * 服务端 RAG 辅助
 * 在已有向量检索结果基础上做后处理/增强
 */

/**
 * 格式化 RAG 检索结果为 prompt 文本
 * @param {Array} results - 向量检索结果
 * @returns {string}
 */
function formatRAGResults(results) {
  if (!results || results.length === 0) return '';

  return results.slice(0, 5).map((r, i) => {
    const item = r.item || r;
    return `[${i + 1}] ${item.title || '未命名'}\n${item.content || item.text || JSON.stringify(item).slice(0, 500)}`;
  }).join('\n\n');
}

/**
 * 从知识库中做简单关键词匹配（备用方案）
 * @param {string} query - 用户查询
 * @param {Array} knowledgeBase - 知识库条目
 * @returns {Array}
 */
function keywordSearch(query, knowledgeBase) {
  if (!query || !knowledgeBase) return [];

  const keywords = query.replace(/[，。？！、；：""''（）\[\]{}]/g, ' ').split(/\s+/).filter(k => k.length >= 2);
  const scored = knowledgeBase.map(item => {
    const text = `${item.title || ''} ${item.content || ''} ${item.category || ''}`;
    let score = 0;
    keywords.forEach(kw => {
      if (text.includes(kw)) score += 1;
    });
    return { item, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  return scored.slice(0, 5).map(s => s.item);
}

module.exports = { formatRAGResults, keywordSearch };
