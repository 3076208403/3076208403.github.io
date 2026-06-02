/**
 * 抖音视频解析云函数 v5.4
 * SSR方案: 从 iesdouyin.com/share/video/ID 页面的 ROUTER_DATA 提取数据
 * 下载: 支持多 CDN 重试 + 超时保护
 */
const https = require('https');
const http = require('http');

function fetch(url, opts = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      (u.protocol === 'https:' ? https : http).get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile',
          'Accept': 'text/html,application/xhtml+xml',
          ...(opts.headers || {}),
        },
        timeout: 20000,
        rejectUnauthorized: false,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, location: res.headers.location || '', body });
        });
      }).on('error', (e) => resolve({ error: e.message }));
    } catch (e) {
      resolve({ error: 'Invalid URL: ' + e.message });
    }
  });
}

function extractVideoId(text) {
  let m = text.match(/video\/(\d{15,25})/);
  if (m) return m[1];
  m = text.match(/(?:aweme_id|item_id)["']?\s*[:=]\s*["']?(\d+)/);
  if (m && m[1].length >= 15) return m[1];
  return null;
}

/** 从分享文案中提取纯 URL */
function extractUrl(text) {
  var m = text.match(/https?:\/\/[^\s\x00-\x1f\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/);
  return m ? m[0] : text;
}

async function resolveShortLink(shortUrl) {
  const r = await fetch(shortUrl);
  let videoId = extractVideoId(r.location);
  if (!videoId) videoId = extractVideoId(r.body);
  if (videoId) console.log('[douyin] Resolved:', videoId);
  return videoId;
}

async function getVideoFromSSR(videoId) {
  const pageUrl = 'https://www.iesdouyin.com/share/video/' + videoId + '/';
  console.log('[douyin] Fetching SSR:', pageUrl);

  const r = await fetch(pageUrl);
  if (r.error) return { success: false, error: r.error };

  const m = r.body.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (!m) return { success: false, error: '页面数据提取失败，请稍后重试' };

  let routerData;
  try { routerData = JSON.parse(m[1]); }
  catch (e) { return { success: false, error: '数据解析失败' }; }

  const pageData = routerData.loaderData && routerData.loaderData['video_(id)/page'];
  if (!pageData || !pageData.videoInfoRes || !pageData.videoInfoRes.item_list) {
    return { success: false, error: '视频数据为空，可能已删除或私密' };
  }

  const item = pageData.videoInfoRes.item_list[0];
  if (!item) return { success: false, error: '视频不存在' };

  const video = item.video || {};
  const playAddr = video.play_addr || {};
  const dlAddr = video.download_addr || {};
  let playUrl = (playAddr.url_list || [])[0] || (dlAddr.url_list || [])[0] || null;

  if (!playUrl && video.bit_rate && video.bit_rate.length > 0) {
    const best = video.bit_rate.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
    playUrl = ((best.play_addr || {}).url_list || [])[0] || null;
  }

  if (!playUrl) return { success: false, error: '未找到播放地址' };

  playUrl = playUrl.replace('playwm', 'play');

  const cover = video.cover || {};
  const originCover = video.origin_cover || {};
  const thumbnail = (originCover.url_list || cover.url_list || [])[0] || '';

  const formats = [];
  if (video.bit_rate && video.bit_rate.length > 0) {
    for (const br of video.bit_rate) {
      const u = ((br.play_addr || {}).url_list || [])[0];
      if (u) formats.push({ quality: br.gear_name || 'HD', ext: 'mp4', url: u.replace('playwm', 'play'), filesize: 0, sizeLabel: br.bit_rate ? Math.round(br.bit_rate / 1000) + 'kbps' : '' });
    }
  }
  if (formats.length === 0) {
    formats.push({ quality: 'HD', ext: 'mp4', url: playUrl, filesize: 0, sizeLabel: '' });
  }

  console.log('[douyin] OK:', (item.desc || '').substring(0, 30));

  return {
    success: true,
    title: item.desc || '',
    uploader: (item.author && item.author.nickname) || '',
    video_id: String(item.aweme_id || videoId),
    bestUrl: playUrl,
    thumbnail,
    duration: item.duration || 0,
    platform: 'douyin',
    formats,
  };
}

// ==================== 下载视频（带重试 + 多CDN） ====================
async function downloadBuffer(url, timeout) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/' },
      timeout: timeout || 60000,
      rejectUnauthorized: false,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        // 跟随重定向
        const nextMod = res.headers.location.startsWith('https') ? https : http;
        nextMod.get(res.headers.location, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/' },
          timeout: timeout || 60000,
          rejectUnauthorized: false,
        }, res2 => {
          const chunks = [];
          res2.on('data', c => chunks.push(c));
          res2.on('end', () => resolve(Buffer.concat(chunks)));
          res2.on('error', reject);
        }).on('error', reject);
      } else {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    });
    req.on('error', reject);
    req.setTimeout(timeout || 60000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function downloadAndUpload(videoUrl, videoId, altUrls) {
  // 准备尝试的 URL 列表
  var urls = [videoUrl];
  if (altUrls && altUrls.length) {
    for (var i = 0; i < altUrls.length; i++) {
      if (altUrls[i] && urls.indexOf(altUrls[i]) === -1) urls.push(altUrls[i]);
    }
  }

  var lastErr = '';
  for (var i = 0; i < urls.length; i++) {
    var tryUrl = urls[i];
    console.log('[douyin] Trying CDN [' + (i + 1) + '/' + urls.length + ']:', (tryUrl || '').substring(0, 60) + '...');

    try {
      // Step 1: 解析真实 CDN 地址
      const playResp = await new Promise(resolve => {
        try {
          const mod = tryUrl.startsWith('https') ? https : http;
          mod.get(tryUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/' },
            timeout: 15000, rejectUnauthorized: false,
          }, res => {
            resolve({ status: res.statusCode, location: res.headers.location || tryUrl });
          }).on('error', function(e) { resolve({ location: tryUrl }); });
        } catch (e) { resolve({ location: tryUrl }); }
      });
      var cdnUrl = playResp.location;

      // Step 2: 下载视频
      console.log('[douyin] Downloading from:', (cdnUrl || '').substring(0, 60) + '...');
      var videoBuffer = await downloadBuffer(cdnUrl, 120000);
      var sizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
      console.log('[douyin] Downloaded:', sizeMB, 'MB');

      if (videoBuffer.length > 1024) {
        // Step 3: 上传到云存储
        console.log('[douyin] Uploading to cloud storage...');
        const cloud = require('wx-server-sdk');
        cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

        const cloudPath = 'douyin_videos/' + videoId + '_' + Date.now() + '.mp4';
        const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: videoBuffer });

        console.log('[douyin] Uploaded, fileID:', uploadRes.fileID);
        return { fileID: uploadRes.fileID, sizeMB };
      }
      lastErr = '文件过小 (' + videoBuffer.length + ' bytes)';
    } catch (e) {
      lastErr = e.message || 'unknown error';
      console.log('[douyin] CDN [' + (i + 1) + '] failed:', lastErr);
    }
  }

  return { error: '所有CDN下载失败: ' + lastErr, cdnCount: urls.length };
}

// ==================== 主入口 ====================
exports.main = async (event) => {
  try {
    var raw = (event.url || '').trim();
    if (!raw) return { code: -1, error: '请输入抖音链接' };

    // 下载请求
    if (event.action === 'download') {
      console.log('[douyin] Download action');
      const altUrls = event.altUrls || [];
      const result = await downloadAndUpload(raw, event.videoId || '', altUrls);
      if (result.error) return { code: -1, error: result.error };
      return { code: 0, data: result };
    }

    // 解析请求
    var url = extractUrl(raw);
    if (!url.startsWith('http')) url = 'https://' + url;
    console.log('[douyin] Input:', url);

    var videoId = extractVideoId(url);

    if (!videoId && url.includes('v.douyin.com')) {
      videoId = await resolveShortLink(url);
    }

    if (!videoId) {
      return { code: -1, error: '无法识别视频链接，请确认是抖音分享链接' };
    }

    const result = await getVideoFromSSR(videoId);
    if (result.success) {
      return { code: 0, data: result };
    }
    return { code: -1, error: result.error || '解析失败，请稍后重试' };
  } catch (e) {
    console.log('[douyin] Unhandled error:', e.message);
    return { code: -1, error: '系统错误: ' + (e.message || 'unknown') };
  }
};
