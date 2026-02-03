const express = require('express');
const router = express.Router();
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { playlistOps } = require('../lib/db');
const { auth } = require('../lib/auth');

// 参数校验：纯数字ID（防路径穿越）
function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

/**
 * 获取正确的 baseUrl（支持反向代理环境）
 * 优先级：环境变量 BASE_URL > Express 默认处理（依赖 TRUST_PROXY）
 * 
 * 注意：不再直接信任 X-Forwarded-Host，避免客户端伪造导致 URL 注入。
 * 反向代理场景请正确配置 TRUST_PROXY（如 1/2/loopback）并设置 BASE_URL。
 */
function getBaseUrl(req) {
  // 1. 优先使用环境变量中配置的 BASE_URL（最可靠）
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, ''); // 移除末尾斜杠
  }
  
  // 2. 使用 Express 默认处理（需要正确配置 TRUST_PROXY 才能识别反代后的 protocol/host）
  return `${req.protocol}://${req.get('host')}`;
}

// 从输入中提取歌单ID（支持链接/纯数字）
function parsePlaylistId(input) {
  if (!input) return null;
  const str = String(input).trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return str;

  // 常见 URL: https://music.163.com/playlist?id=123
  // https://music.163.com/#/playlist?id=123
  // https://y.music.163.com/m/playlist?id=123
  const m1 = str.match(/(?:\?|&)id=(\d{1,20})/);
  if (m1) return m1[1];

  // 兜底：/playlist/123
  const m2 = str.match(/\/playlist\/(\d{1,20})/);
  if (m2) return m2[1];

  return null;
}

function toSqliteDatetime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// 获取用户歌单列表
router.get('/user', auth, async (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 30;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  
  try {
    const cookie = decrypt(req.user.cookie);
    // 兼容：部分情况下上游接口不严格遵守 limit/offset，这里统一由服务端做分页切片
    // 一次性拉取较大数量（通常用户歌单远小于该值），再按 offset/limit 返回
    const result = await netease.getUserPlaylists(req.user.netease_id, cookie, 0, 1000);
    const all = Array.isArray(result.playlists) ? result.playlists : [];
    const total = Number.isFinite(result.count) ? result.count : all.length;
    const pageData = all.slice(offset, offset + limit);
    
    res.json({
      success: true,
      data: pageData,
      total
    });
  } catch (e) {
    console.error('获取用户歌单失败:', e);
    res.status(500).json({ success: false, message: e.message || '获取歌单失败' });
  }
});

// 解析歌单链接/ID，缓存歌单详情
router.get('/parse', auth, async (req, res) => {
  const input = req.query.url;
  const playlistId = parsePlaylistId(input);

  if (!playlistId || !isValidNumericId(playlistId)) {
    return res.status(400).json({ success: false, message: '无效的歌单链接或ID' });
  }

  try {
    // 清理过期缓存（轻量）
    try {
      playlistOps.clearExpired.run();
    } catch (_) {}

    const cached = playlistOps.get.get(playlistId);
    if (cached) {
      return res.json({
        success: true,
        data: {
          id: cached.playlist_id,
          name: cached.name,
          cover: cached.cover,
          songCount: cached.song_count
        }
      });
    }

    const cookie = decrypt(req.user.cookie);
    const playlist = await netease.getPlaylistDetail(playlistId, cookie);

    const ttlSec = parseInt(process.env.CACHE_TTL) || 86400;
    const expiresAt = toSqliteDatetime(new Date(Date.now() + ttlSec * 1000));

    playlistOps.set.run({
      playlist_id: String(playlistId),
      name: playlist.name || '',
      cover: playlist.cover || '',
      song_count: playlist.songCount || 0,
      songs: JSON.stringify(playlist.tracks || []),
      expires_at: expiresAt
    });

    res.json({
      success: true,
      data: {
        id: String(playlistId),
        name: playlist.name,
        cover: playlist.cover,
        songCount: playlist.songCount
      }
    });
  } catch (e) {
    console.error('解析歌单失败:', e);
    res.status(500).json({ success: false, message: e.message || '解析歌单失败' });
  }
});

// 获取可播放的 m3u8 链接（返回给 VRChat 播放器）
router.get('/url', auth, (req, res) => {
  const playlistId = String(req.query.id || '');

  if (!isValidNumericId(playlistId)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  const baseUrl = getBaseUrl(req);
  const url = `${baseUrl}/api/hls/${req.token}/${playlistId}/stream.m3u8`;

  res.json({ success: true, data: { url } });

  // 在“生成链接”时就后台预加载第一首，提升首次播放起播速度
  // 使用本机回环地址避免走外网/反代，且不阻塞当前响应
  try {
    const token = req.token;
    const port = process.env.PORT || 3000;
    const preloadBase = process.env.PRELOAD_BASE_URL || `http://127.0.0.1:${port}`;
    setImmediate(() => {
      try {
        fetch(`${preloadBase}/api/hls/${encodeURIComponent(token)}/${encodeURIComponent(playlistId)}/preload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 1 })
        }).catch(() => {});
      } catch (_) {}
    });
  } catch (_) {}
});

module.exports = router;
