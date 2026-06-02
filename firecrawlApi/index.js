/**
 * 云函数：firecrawlApi
 * 封装 Firecrawl v2 REST API + 百度文库直连抓取 + yt-dlp 视频解析 + 媒体直链下载
 * 支持：网页抓取(多格式) / 百度文库(无服务器直连) / 全网视频解析 / 图片下载 / 搜索
 */

const https = require("https");
const http = require("http");
const API_KEY = "fc-36e1ea004f014b98ba4b84c9eee2c6e5";
const BASE_URL = "api.firecrawl.dev";

// ─── yt-dlp API 地址 ───
const YTDLP_API = process.env.YTDLP_API_URL || "http://localhost:8765";
const WENKU_API = process.env.WENKU_API_URL || "http://127.0.0.1:8766";

// ─── Firecrawl 请求封装 ───
function firecrawlRequest(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: BASE_URL,
      path,
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("响应解析失败: " + body.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("Firecrawl 请求超时")); });
    req.write(data);
    req.end();
  });
}

// ─── 通用 HTTP 请求 ───
function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlPath);
    const mod = urlObj.protocol === "https:" ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (data) options.headers["Content-Length"] = Buffer.byteLength(data);
    const req = mod.request(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { resolve({ _raw: body }); }
      });
    });
    req.on("error", (e) => reject(new Error("HTTP 连接失败: " + e.message)));
    req.setTimeout(55000, () => { req.destroy(); reject(new Error("HTTP 请求超时")); });
    if (data) req.write(data);
    req.end();
  });
}

// ─── HTTP GET 原始请求（用于百度文库直连） ───
function httpGet(hostname, path, cookieStr, referer, ua) {
  return new Promise((resolve, reject) => {
    const mod = hostname.startsWith("https") ? https : http;
    const host = hostname.replace("https://", "").replace("http://", "");
    const options = {
      hostname: host,
      path: path,
      method: "GET",
      headers: {
        "User-Agent": ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/json,application/xhtml+xml,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
    };
    if (cookieStr) options.headers["Cookie"] = cookieStr;
    if (referer) options.headers["Referer"] = referer;

    const req = mod.request(options, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on("error", (e) => reject(new Error("请求失败: " + e.message)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("请求超时")); });
    req.end();
  });
}

// ─── HTTP 文件下载 ───
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error("下载失败 HTTP " + res.statusCode));
      }
      const contentType = res.headers["content-type"] || "";
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 10 * 1024 * 1024) {
          return reject(new Error("文件过大 (>10MB)"));
        }
        resolve({ buffer: buffer.toString("base64"), contentType, size: buffer.length });
      });
    }).on("error", reject).on("timeout", () => reject(new Error("下载超时")));
  });
}


// ═══════════════ 百度文库直连抓取（无服务器） ═══════════════

function normalizeWenkuUrl(url) {
  url = (url || "").trim();
  if (url.startsWith("http://")) url = url.replace("http://", "https://");
  if (url.includes("m.wenku")) url = url.replace("m.wenku", "wenku");
  // 分享链接 → 标准链接
  if (url.includes("from_appshare") || url.includes("from=share") || url.includes("share_token")) {
    const m = url.match(/\/view\/([a-f0-9]+)/);
    if (m) url = "https://wenku.baidu.com/view/" + m[1] + ".html";
  }
  // 去参数
  if (url.includes("/view/") && url.includes("?")) {
    let base = url.split("?")[0];
    if (!base.endsWith(".html")) base += ".html";
    url = base;
  }
  return url;
}

function extractDocId(url) {
  const m = url.match(/\/view\/([a-f0-9]+)/);
  return m ? m[1] : null;
}

function decodeCookieBase64(cookieBase64) {
  if (!cookieBase64) return "";
  try {
    return Buffer.from(cookieBase64, "base64").toString("utf-8").trim();
  } catch (e) {
    return cookieBase64;
  }
}

function extractTextsFromJson(obj, depth) {
  if (!depth) depth = 0;
  if (depth > 6) return [];
  const texts = [];
  if (typeof obj === "string" && obj.length > 50 && !obj.startsWith("http")) {
    const clean = obj.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (clean.length > 30) texts.push(clean);
  } else if (Array.isArray(obj)) {
    for (const item of obj.slice(0, 20)) {
      texts.push(...extractTextsFromJson(item, depth + 1));
    }
  } else if (obj && typeof obj === "object") {
    for (const key of ["content", "text", "body", "html", "txt", "description", "title"]) {
      const v = obj[key];
      if (typeof v === "string" && v.length > 30) {
        const clean = v.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (clean.length > 30) texts.push(clean);
      }
    }
    for (const v of Object.values(obj)) {
      texts.push(...extractTextsFromJson(v, depth + 1));
    }
  }
  return texts;
}

function parsePageHtml(html) {
  const result = { title: "", texts: [] };

  // 标题
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) result.title = titleMatch[1].replace(/[\s-]+百度文库.*$/, "").trim();

  // 提取 pageData / reader_config / window 变量中的 JSON
  const configPatterns = [
    /pageData\s*[:=]\s*(\{[\s\S]+?\})\s*[;,\n]/,
    /reader_config\s*[:=]\s*(\{[\s\S]+?\})\s*[;,\n]/,
    /window\.pageData\s*=\s*(\{[\s\S]+?\})\s*;/,
    /WenkuConfig\s*=\s*(\{[\s\S]+?\})\s*;/,
    /g_config\s*=\s*(\{[\s\S]+?\})\s*;/,
  ];
  for (const pat of configPatterns) {
    const m = html.match(pat);
    if (m) {
      try {
        const config = JSON.parse(m[1]);
        console.log("[wenku-direct] 发现页面配置:", Object.keys(config).join(", "));
        const texts = extractTextsFromJson(config);
        result.texts.push(...texts);
        if (!result.title && config.title) result.title = config.title;
        if (config.docInfo && config.docInfo.title) result.title = config.docInfo.title;
      } catch (e) { /* JSON 截断 */ }
    }
  }

  // JSON-LD
  const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/i);
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      if (ld.name && !result.title) result.title = ld.name;
      if (ld.description) result.texts.push(ld.description);
    } catch (e) {}
  }

  // 降级：body 可见文本
  if (result.texts.length === 0) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      const bodyText = bodyMatch[1]
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .replace(/[\n\r]+/g, "\n")
        .split("\n")
        .map(s => s.replace(/[ \t]+/g, " ").trim())
        .filter(s => s.length > 20)
        .slice(0, 50);
      result.texts.push(...bodyText);
    }
  }

  return result;
}

async function scrapeWenkuDirect(event) {
  const rawUrl = (event.url || "").trim();
  if (!rawUrl) return { code: -1, error: "请输入文库链接" };

  const url = normalizeWenkuUrl(rawUrl);
  const docId = extractDocId(url);
  if (!docId) return { code: -1, error: "无法识别文档ID，请检查链接格式" };

  const cookieStr = decodeCookieBase64(event.cookieBase64 || "");
  const maxPages = Math.min(Number(event.maxPages) || 10, 30);

  console.log("[wenku-direct] 直连抓取:", url);
  const mobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  console.log("[wenku-direct] docId:", docId, "maxPages:", maxPages, "hasCookie:", !!cookieStr);

  try {
    let allTexts = [];
    let title = "";
    let extractionMethod = "";
    let apiSuccess = false;

    // ═══ 策略1：直接调百度内容 API ═══
    const apiPaths = [
      `/api/getcontent?doc_id=${docId}&pn=1&rn=1&type=json`,
      `/view/api/pagecontent?doc_id=${docId}&pn=1`,
      `/api/doccontent?doc_id=${docId}&page=1`,
    ];

    for (const apiPath of apiPaths) {
      try {
        console.log("[wenku-direct] 尝试API:", apiPath);
        const resp = await httpGet("wenku.baidu.com", apiPath, cookieStr, url, mobileUA);
        if (resp.status === 200 && resp.body && resp.body.length > 50) {
          try {
            const json = JSON.parse(resp.body);
            const texts = extractTextsFromJson(json);
            if (texts.length > 0) {
              allTexts.push(...texts);
              extractionMethod = "api_direct";
              apiSuccess = true;
              console.log("[wenku-direct] API直连成功,", texts.length, "段文本");

              // 翻页
              for (let pn = 2; pn <= maxPages; pn++) {
                const pagePath = apiPath
                  .replace(/pn=\d+/, `pn=${pn}`)
                  .replace(/page=\d+/, `page=${pn}`);
                try {
                  const pageResp = await httpGet("wenku.baidu.com", pagePath, cookieStr, url);
                  if (pageResp.status === 200 && pageResp.body && pageResp.body.length > 50) {
                    const pageJson = JSON.parse(pageResp.body);
                    const pageTexts = extractTextsFromJson(pageJson);
                    if (pageTexts.length > 0) {
                      allTexts.push(...pageTexts);
                    } else break;
                  } else break;
                } catch (e) { break; }
              }
              break;
            }
          } catch (e) { /* JSON解析失败，继续 */ }
        }
      } catch (e) { /* API不可达，继续 */ }
    }

    // ═══ 策略2：加载页面 → 提取内嵌数据 ═══
    if (!apiSuccess) {
      console.log("[wenku-direct] API未命中，加载页面...");
      try {
        // Try mobile hostname first to avoid blocking
      let pageResp = await httpGet("m.wenku.baidu.com", `/view/${docId}.html`, cookieStr, "https://wenku.baidu.com/", mobileUA);
      if (pageResp.status !== 200 || !pageResp.body || pageResp.body.length < 500) {
        // Fallback to desktop
        pageResp = await httpGet(
          "wenku.baidu.com",
          `/view/${docId}.html`,
          cookieStr,
          "https://wenku.baidu.com/"
        );
      }
      if (pageResp.status === 200 && pageResp.body) { if (pageResp.body.indexOf("安全验证")>=0||pageResp.body.indexOf("captcha")>=0||pageResp.body.length<500) { return { code: -1, error: "百度安全验证拦截", wenkuBlocked: true, hint: "云函数IP被百度识别,请在手机浏览器中手动打开链接验证后再试" }; }
          const parsed = parsePageHtml(pageResp.body);
          title = parsed.title || title;
          if (parsed.texts.length > 0) {
            allTexts.push(...parsed.texts);
            extractionMethod = "page_parse";
            console.log("[wenku-direct] 页面解析成功,", parsed.texts.length, "段文本");
          }
      } else if (pageResp.status >= 300 && pageResp.status < 400) {
          return { code: -1, error: "百度安全验证拦截", wenkuBlocked: true, hint: "云函数IP被百度识别为机器人，请尝试在手机浏览器中手动打开该链接验证后再试" };
        }
      } catch (e) {
        console.log("[wenku-direct] 页面加载失败:", e.message);
      }
    }

    // ═══ 结果汇总 ═══
    if (allTexts.length === 0) {
      return {
        code: -1,
        error: cookieStr
          ? "内容提取失败，该文档可能为纯图片/PPT格式"
          : "缺少登录Cookie。付费/会员文档需提供 wenku.baidu.com 的登录Cookie",
      };
    }

    const uniqueTexts = [...new Set(allTexts.filter(t => t && t.trim().length > 10))];
    const fullText = uniqueTexts.join("\n\n");

    return {
      code: 0,
      data: {
        success: true,
        title: title || "百度文库文档",
        type: "text",
        pageCount: uniqueTexts.length,
        pages: uniqueTexts.map((t, i) => ({ pageNum: i + 1, text: t, imageBase64: "" })),
        fullText: fullText,
        extractionMethod: extractionMethod || "direct",
      },
    };
  } catch (e) {
    console.error("[wenku-direct] 异常:", e);
    return { code: -1, error: "抓取异常: " + (e.message || "").slice(0, 300) };
  }
}


// ═══════════════ 主入口 ═══════════════
exports.main = async (event) => {
  const { action } = event;

  try {
    // ==================== 搜索 ====================
    if (action === "search") {
      const query = (event.query || "").trim();
      if (!query) return { code: -1, error: "请输入搜索关键词" };
      const limit = Math.min(event.limit || 10, 20);
      const res = await firecrawlRequest("/v2/search", { query, limit });
      if (!res.success) return { code: -1, error: res.error || "搜索失败" };
      const articles = (res.data?.web || []).map((item, i) => ({
        id: `fc-${i}`,
        title: item.title || "未知标题",
        summary: item.description || "",
        url: item.url || "",
        source: item.url ? new URL(item.url).hostname.replace("www.", "") : "web",
        date: "", score: 0, comments: 0,
      }));
      return { code: 0, articles, creditsUsed: res.creditsUsed };
    }

    // ==================== 网页抓取 ====================
    if (action === "scrape") {
      const url = (event.url || "").trim();
      if (!url) return { code: -1, error: "请输入 URL" };
      const formats = event.formats || ["markdown"];
      const onlyMain = event.onlyMainContent !== false;
      try {
        const res = await firecrawlRequest("/v2/scrape", { url, formats, onlyMainContent: onlyMain });
        if (!res.success) {
          const msg = res.error || "Firecrawl 抓取失败";
          return { code: -1, error: msg, retryable: true };
        }
        const result = { code: 0, data: { url: res.data?.url || url, title: res.data?.metadata?.title || "", metadata: res.data?.metadata || {} } };
        if (res.data?.markdown) result.data.markdown = res.data.markdown;
        if (res.data?.html) result.data.html = res.data.html;
        if (res.data?.rawHtml) result.data.rawHtml = res.data.rawHtml;
        if (res.data?.screenshot) result.data.screenshot = res.data.screenshot;
        return result;
      } catch (err) {
        return { code: -1, error: "抓取服务异常: " + err.message, retryable: true };
      }
    }

    // ==================== 媒体下载 ====================
    if (action === "download") {
      const url = (event.url || "").trim();
      if (!url) return { code: -1, error: "请输入文件 URL" };
      const file = await downloadFile(url);
      return { code: 0, data: { url, base64: file.buffer, contentType: file.contentType, size: file.size } };
    }

    // ==================== 百度文库直连抓取（无服务器） ====================
    if (action === "wenku-direct") {
      return await scrapeWenkuDirect(event);
    }

    // ==================== 百度文库抓取（服务器模式，兼容） ====================
    if (action === "wenku") {
      const url = (event.url || "").trim();
      if (!url) return { code: -1, error: "请输入文库链接" };
      const maxPages = Number(event.maxPages) || 20;
      const payload = { url, maxPages };
      if (event.cookieBase64) payload.cookieBase64 = event.cookieBase64;

      console.log("[wenku] 调用 Wenku 服务:", WENKU_API + "/scrape");
      try {
        const result = await httpRequest("POST", WENKU_API + "/scrape", payload);
        if (result.success !== undefined) {
          return {
            code: result.success ? 0 : -1,
            data: result,
            error: result.success ? undefined : (result.error || "百度文库抓取失败"),
          };
        }
        return { code: -1, error: "百度文库服务返回异常", raw: result._raw ? result._raw.slice(0, 500) : "" };
      } catch (e) {
        console.log("[wenku] 服务器不可达，降级到直连模式:", e.message);
        return await scrapeWenkuDirect(event);
      }
    }

    // ==================== 视频解析（yt-dlp） ====================
    if (action === "parse") {
      const url = (event.url || "").trim();
      if (!url) return { code: -1, error: "请输入视频链接" };
      const quality = event.quality || "best";

      console.log("[parse] 调用 yt-dlp API:", YTDLP_API + "/parse");
      const ydPayload = { url, quality };
      if (event.cookieFile) ydPayload.cookieFile = event.cookieFile;
      if (event.cookieBase64) ydPayload.cookieBase64 = event.cookieBase64;
      if (event.cookieBrowser) ydPayload.cookieBrowser = event.cookieBrowser;
      const result = await httpRequest("POST", YTDLP_API + "/parse", ydPayload);

      if (result.success !== undefined) {
        return {
          code: result.success ? 0 : -1,
          data: result,
          error: result.success ? undefined : (result.error || "解析失败"),
        };
      }
      return { code: -1, error: "yt-dlp API 返回异常", raw: result._raw ? result._raw.slice(0, 500) : "" };
    }

    return { code: -1, error: "未知操作: " + action };
  } catch (e) {
    console.error("[firecrawlApi]", e);
    return { code: -1, error: e.message || "服务器内部错误" };
  }
};
