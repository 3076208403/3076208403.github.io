/**
 * 小红书内容解析云函数 v1.0
 * 从分享链接中提取笔记内容：标题、正文、图片、作者、互动数据
 * 支持: xiaohongshu.com / xhslink.com
 * 方案: SSR HTML → __INITIAL_STATE__ 数据提取 + API 降级
 */
const https = require("https");
const http = require("http");

// ═══════════════════════════════════════════
// HTTP 请求封装
// ═══════════════════════════════════════════

function fetch(url, opts = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    mod.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 13; SM-G9980) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          ...(opts.headers || {}),
        },
        timeout: 20000,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode,
            location: res.headers.location || "",
            body,
            headers: res.headers,
          });
        });
      }
    ).on("error", (e) => resolve({ error: e.message }));
  });
}

// ═══════════════════════════════════════════
// Note ID 提取
// ═══════════════════════════════════════════

function extractNoteId(text) {
  // /explore/{noteId}  or /discovery/item/{noteId}
  let m = text.match(/\/explore\/([a-zA-Z0-9]{13,24})/);
  if (m) return m[1];
  m = text.match(/\/discovery\/item\/([a-zA-Z0-9]{13,24})/);
  if (m) return m[1];
  // noteId 参数
  m = text.match(/[?&]id=([a-zA-Z0-9]{13,24})/);
  if (m) return m[1];
  return null;
}

// ═══════════════════════════════════════════
// 短链解析: xhslink.com → 真实 URL
// ═══════════════════════════════════════════

async function resolveShortLink(shortUrl) {
  console.log("[xhs] Resolving short link:", shortUrl.substring(0, 60));
  const r = await fetch(shortUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    },
  });

  let noteId = null;

  // 从 302 Location 提取
  if (r.location) {
    console.log("[xhs] Redirect →", r.location.substring(0, 80));
    noteId = extractNoteId(r.location);
  }

  // 从响应体提取
  if (!noteId) {
    noteId = extractNoteId(r.body);
  }

  if (noteId) {
    console.log("[xhs] Resolved noteId:", noteId);
  }

  return noteId;
}

// ═══════════════════════════════════════════
// API 方式获取笔记数据（降级方案）
// ═══════════════════════════════════════════

async function fetchNoteByApi(noteId) {
  const apiUrl = `https://edith.xiaohongshu.com/api/sns/web/v1/feed?source_note_id=${noteId}&image_formats=jpg,webp,avif&extra=%7B%22need_body_topic%22:1%7D`;
  console.log("[xhs] API attempt:", apiUrl.substring(0, 80));

  const r = await fetch(apiUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      Referer: "https://www.xiaohongshu.com/",
      "X-S": "ZRcaG2A5a3B2dDRmf2V5YnBxYWVkZXxmZWU=",
      "X-T": Date.now().toString(),
      "Content-Type": "application/json;charset=UTF-8",
    },
  });

  if (r.error || r.status !== 200) return null;

  try {
    const json = JSON.parse(r.body);
    if (json.success && json.data?.items?.length > 0) {
      return parseApiItem(json.data.items[0]);
    }
  } catch (e) {
    console.log("[xhs] API parse error:", e.message);
  }
  return null;
}

function parseApiItem(item) {
  const note = item.note_card || {};
  return {
    noteId: note.note_id || "",
    title: note.title || note.display_title || "",
    desc: note.desc || "",
    type: note.type || "normal",
    images: (note.image_list || []).map((img) => ({
      url: (img.url_default || img.url || "").replace("http://", "https://"),
      width: img.width || 0,
      height: img.height || 0,
    })),
    video: note.video
      ? {
          url: note.video.media?.stream?.h264?.[0]?.master_url || "",
          cover: note.video.image?.first_frame_fileid || "",
          duration: note.video.media?.video_duration || 0,
        }
      : null,
    author: {
      userId: note.user?.user_id || "",
      nickname: note.user?.nickname || "",
      avatar: (note.user?.avatar || "").replace("http://", "https://"),
    },
    stats: {
      liked: note.interact_info?.liked_count || 0,
      collected: note.interact_info?.collected_count || 0,
      commented: note.interact_info?.comment_count || 0,
      shared: note.interact_info?.share_count || 0,
    },
    tags: (note.tag_list || []).map((t) => ({
      name: t.name || "",
      id: t.id || "",
      type: t.type || "",
    })),
    source: "api",
  };
}

// ═══════════════════════════════════════════
// SSR HTML 方式提取（主方案）
// ═══════════════════════════════════════════

async function fetchNoteBySSR(noteId) {
  const pageUrl = "https://www.xiaohongshu.com/explore/" + noteId;
  console.log("[xhs] Fetching SSR:", pageUrl);

  const r = await fetch(pageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      Referer: "https://www.xiaohongshu.com/",
    },
  });

  if (r.error) return { success: false, error: r.error };

  // 尝试提取 __INITIAL_STATE__
  let m = r.body.match(
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/
  );
  if (!m) {
    // 备用匹配
    m = r.body.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  }
  if (!m) {
    // 尝试 __INITIAL_SSR_STATE__
    m = r.body.match(
      /window\.__INITIAL_SSR_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/
    );
  }

  if (!m) {
    console.log("[xhs] No __INITIAL_STATE__ found, fallback to API");
    return { success: false, error: "SSR数据未找到", fallback: true };
  }

  let state;
  try {
    // 替换可能的 undefined 值
    const cleaned = m[1].replace(/undefined/g, "null");
    state = JSON.parse(cleaned);
  } catch (e) {
    console.log("[xhs] JSON parse error:", e.message.substring(0, 100));
    return { success: false, error: "数据解析失败", fallback: true };
  }

  const note = state?.note?.noteDetailMap?.[noteId]?.note;
  if (!note) {
    // 尝试其他路径
    const altNote =
      state?.note?.noteDetail ||
      state?.noteData ||
      state?.note;
    if (!altNote) {
      console.log("[xhs] Note not found in state, fallback to API");
      return { success: false, error: "笔记数据为空", fallback: true };
    }
    return { success: false, error: "笔记结构异常", fallback: true };
  }

  const result = parseSSRNote(note, noteId);
  result.source = "ssr";
  console.log("[xhs] SSR OK:", (result.title || "").substring(0, 30));
  return { success: true, data: result };
}

function parseSSRNote(note, noteId) {
  const imageList = (note.imageList || note.image_list || []).map((img) => ({
    url: (img.urlDefault || img.url_default || img.url || "").replace(
      "http://",
      "https://"
    ),
    traceId: img.traceId || img.trace_id || "",
    width: img.width || 0,
    height: img.height || 0,
    fileId: img.fileId || img.file_id || "",
  }));

  const user = note.user || {};
  const interactInfo = note.interactInfo || note.interact_info || {};

  const noteType = note.type || note.noteType || "normal";
  const isVideo = noteType === "video";

  return {
    noteId: noteId || note.noteId || note.note_id || "",
    title: note.title || note.displayTitle || note.display_title || "",
    desc: note.desc || note.description || "",
    type: noteType,
    images: imageList,
    video: isVideo
      ? {
          url:
            note.video?.media?.stream?.h264?.[0]?.masterUrl ||
            note.video?.media?.stream?.h264?.[0]?.master_url ||
            "",
          cover: note.video?.image?.firstFrameFileid ||
            note.video?.image?.first_frame_fileid || "",
          duration: note.video?.media?.videoDuration ||
            note.video?.media?.video_duration || 0,
        }
      : null,
    author: {
      userId: user.userId || user.user_id || "",
      nickname: user.nickname || user.nickName || user.nick_name || "",
      avatar: (user.avatar || user.images || "").replace(
        "http://",
        "https://"
      ),
    },
    stats: {
      liked: parseInt(interactInfo.likedCount) || interactInfo.liked_count || 0,
      collected:
        parseInt(interactInfo.collectedCount) ||
        interactInfo.collected_count ||
        0,
      commented:
        parseInt(interactInfo.commentCount) ||
        interactInfo.comment_count ||
        0,
      shared:
        parseInt(interactInfo.shareCount) || interactInfo.share_count || 0,
    },
    tags: (note.tagList || note.tag_list || note.tags || []).map((t) => ({
      name: t.name || "",
      id: t.id || "",
      type: t.type || "",
    })),
    ipLocation: note.ipLocation || note.ip_location || "",
    publishTime: note.time || note.publishTime || note.publish_time || 0,
  };
}

// ═══════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════

exports.main = async (event) => {
  let url = (event.url || "").trim();
  if (!url) return { code: -1, error: "请输入小红书链接" };
  if (!url.startsWith("http")) url = "https://" + url;

  console.log("[xhs] Input:", url);

  // Step 1: 提取或解析 Note ID
  let noteId = extractNoteId(url);

  if (!noteId && url.includes("xhslink.com")) {
    noteId = await resolveShortLink(url);
  }

  if (!noteId) {
    // 尝试直接通过短链重定向获取
    if (!url.includes("xhslink.com")) {
      const r = await fetch(url);
      noteId = extractNoteId(r.location) || extractNoteId(r.body);
    }
  }

  if (!noteId) {
    return {
      code: -1,
      error: "无法识别笔记ID，请确认是小红书分享链接（如 xhslink.com 短链或 xiaohongshu.com/explore/xxx）",
    };
  }

  console.log("[xhs] Note ID:", noteId);

  // Step 2: 优先使用 SSR 方式提取
  const ssrResult = await fetchNoteBySSR(noteId);
  if (ssrResult.success) {
    return { code: 0, data: ssrResult.data };
  }

  // Step 3: 降级到 API 方式
  console.log("[xhs] SSR failed, trying API fallback...");
  const apiResult = await fetchNoteByApi(noteId);
  if (apiResult) {
    return { code: 0, data: apiResult };
  }

  // Step 4: 返回基本的 noteId，让前端用 Firecrawl 兜底
  if (ssrResult.fallback) {
    return {
      code: 0,
      data: {
        noteId,
        title: "",
        desc: "",
        type: "normal",
        images: [],
        author: { userId: "", nickname: "", avatar: "" },
        stats: { liked: 0, collected: 0, commented: 0, shared: 0 },
        tags: [],
        source: "partial",
        url: "https://www.xiaohongshu.com/explore/" + noteId,
      },
      warning: "详细数据获取失败，请尝试在web-scraper中用Firecrawl抓取完整页面",
    };
  }

  return { code: -1, error: ssrResult.error || "解析失败，请稍后重试" };
};
