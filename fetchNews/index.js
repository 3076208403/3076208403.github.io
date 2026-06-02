/**
 * 云函数：fetchNews
 * 聚合多个免费数据源的 AI 相关资讯，去重并按热度排序返回。
 *
 * 调用方式：
 *   wx.cloud.callFunction({ name: 'fetchNews', data: { limit: 20 } })
 *
 * 数据源：
 *   1. Hacker News API (top stories → 关键词过滤 AI/ML)
 *   2. 可扩展 RSS / NewsAPI 等源
 *
 * 返回：
 *   { code: 0, articles: [{ id, title, summary, url, source, date, score }] }
 */

// ─── AI 关键词过滤器 ────────────────────────────────────────────
const AI_KEYWORDS = [
  'ai', 'artificial intelligence', 'machine learning', 'deep learning',
  'gpt', 'chatgpt', 'llm', 'large language model', 'llama',
  'openai', 'anthropic', 'claude', 'gemini', 'copilot',
  'neural network', 'transformer', 'diffusion', 'stable diffusion',
  'midjourney', 'dall-e', 'sora', 'generative ai', 'gen ai',
  'reinforcement learning', 'rlhf', 'rag', 'vector database',
  'nlp', 'computer vision', 'speech recognition', 'tts', 'stt',
  'fine-tuning', 'prompt engineering', 'agent', 'multi-modal',
  'robotics', 'self-driving', 'autonomous', 'tesla bot',
  'deepmind', 'microsoft ai', 'google ai', 'meta ai', 'apple ai',
  'nvidia', 'gpu', 'tpu', 'chip', 'h100', 'b200',
  'coder', 'codex', 'copilot', 'devin', 'cursor',
  'benchmark', 'mmlu', 'human eval', 'swe-bench'
];

function matchAIKeywords(title = '') {
  const lower = title.toLowerCase();
  return AI_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── Hacker News API 封装 ────────────────────────────────────────
const HN_BASE = 'https://hacker-news.firebaseio.com/v0';

async function hnFetch(https, path) {
  return new Promise((resolve, reject) => {
    https.get(`${HN_BASE}${path}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * 从 Hacker News top stories 中筛选 AI 相关文章
 */
async function fetchFromHN(https, limit = 200) {
  // 1. 获取 top 故事 ID 列表 (最多 500 条)
  const ids = await hnFetch(https, '/v0/topstories.json');
  const candidateIds = ids.slice(0, Math.min(limit, ids.length));

  // 2. 并发获取每个故事的详情（分批并发避免过载）
  const BATCH_SIZE = 10;
  const articles = [];

  for (let i = 0; i < candidateIds.length; i += BATCH_SIZE) {
    const batch = candidateIds.slice(i, i + BATCH_SIZE);
    const details = await Promise.allSettled(
      batch.map(id => hnFetch(https, `/v0/item/${id}.json`))
    );

    for (const result of details) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const item = result.value;

      // 只保留故事类型 (story)，排除问答/招聘等
      if (item.type !== 'story' || !item.title) continue;

      // 关键词过滤
      if (!matchAIKeywords(item.title)) continue;

      articles.push({
        id: `hn-${item.id}`,
        title: item.title,
        summary: '', // HN 没有摘要，用 score+descendants 代替
        url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
        source: item.url ? new URL(item.url).hostname.replace('www.', '') : 'Hacker News',
        date: new Date(item.time * 1000).toISOString().split('T')[0],
        score: item.score || 0,
        comments: item.descendants || 0
      });
    }
  }

  return articles;
}

// ─── 排序 & 去重 ────────────────────────────────────────────────
function dedupeAndRank(articles) {
  const seen = new Set();
  return articles
    .filter(a => {
      const key = a.title.toLowerCase().slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

// ─── 主入口 ──────────────────────────────────────────────────────
exports.main = async (event) => {
  const limit = Math.min(event.limit || 20, 50); // 最多 50 条
  const https = require('https');

  try {
    console.log('[fetchNews] 开始聚合 AI 新闻…');

    // 从 HN 获取并筛选
    const hnArticles = await fetchFromHN(https, 200);

    console.log(`[fetchNews] HN 筛选后: ${hnArticles.length} 篇`);

    // 去重 & 排序
    const articles = dedupeAndRank(hnArticles).slice(0, limit);

    console.log(`[fetchNews] 最终返回: ${articles.length} 篇`);

    return {
      code: 0,
      articles,
      total: articles.length,
      updatedAt: new Date().toISOString()
    };
  } catch (e) {
    console.error('[fetchNews] 获取失败:', e);
    return {
      code: -1,
      error: e.message || '获取 AI 新闻失败',
      articles: [],
      total: 0
    };
  }
};
