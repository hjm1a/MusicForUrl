const express = require('express');
const router = express.Router();
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { userOps, playLogOps, playlistOps } = require('../lib/db');

// 参数校验：纯数字ID（防路径穿越）
function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

// 参数校验：token格式（32位hex）
function isValidToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{32}$/i.test(token);
}

// 歌曲 URL 缓存（短期，带上限防止内存泄漏）
const urlCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10分钟
const URL_CACHE_MAX = 2000; // 最大缓存条目数

// 缓存超限时清理最旧的条目
function evictOldestUrlCache() {
  if (urlCache.size <= URL_CACHE_MAX) return;
  
  // 找出最旧的 20% 条目并删除
  const toEvict = Math.ceil(urlCache.size * 0.2);
  const entries = Array.from(urlCache.entries())
    .sort((a, b) => a[1].expires - b[1].expires)
    .slice(0, toEvict);
  
  for (const [key] of entries) {
    urlCache.delete(key);
  }
}

// 歌曲重定向
router.get('/:token/:songId', async (req, res) => {
  const { token, songId } = req.params;
  const { playlist } = req.query; // 可选的歌单ID，用于记录播放
  
  // 参数校验
  if (!isValidToken(token)) {
    return res.status(400).json({ error: '无效的token格式' });
  }
  if (!isValidNumericId(songId)) {
    return res.status(400).json({ error: '无效的歌曲ID' });
  }
  // playlist 参数是可选的，如果提供了也需要校验
  if (playlist && !isValidNumericId(playlist)) {
    return res.status(400).json({ error: '无效的歌单ID' });
  }
  
  // 验证用户
  const user = userOps.getByToken.get(token);
  if (!user) {
    return res.status(401).json({ error: '无效的访问令牌' });
  }
  
  try {
    // 检查缓存
    const cacheKey = `${user.id}:${songId}`;
    const cached = urlCache.get(cacheKey);
    
    if (cached && cached.expires > Date.now()) {
      // 记录播放（异步，不影响响应速度）
      logPlay(user.id, songId, playlist);
      return res.redirect(302, cached.url);
    }
    
    // 获取歌曲 URL
    const cookie = decrypt(user.cookie);
    const url = await netease.getSongUrl(songId, cookie);
    
    if (!url) {
      return res.status(404).json({ error: '无法获取歌曲，可能无版权或需要VIP' });
    }
    
    // 缓存 URL（超限时清理旧条目）
    urlCache.set(cacheKey, {
      url,
      expires: Date.now() + CACHE_DURATION
    });
    evictOldestUrlCache();
    
    // 记录播放
    logPlay(user.id, songId, playlist);
    
    // 重定向到真实 URL
    res.redirect(302, url);
  } catch (e) {
    console.error('获取歌曲URL失败:', e);
    res.status(500).json({ error: '获取歌曲失败' });
  }
});

// 记录播放（异步）
async function logPlay(userId, songId, playlistId) {
  try {
    // 从缓存中获取歌曲信息
    let songName = '未知';
    let artist = '未知';
    
    if (playlistId) {
      const cached = playlistOps.get.get(playlistId);
      if (cached) {
        try {
          const songs = JSON.parse(cached.songs);
          const song = Array.isArray(songs) ? songs.find(s => String(s.id) === String(songId)) : null;
          if (song) {
            songName = song.name || songName;
            artist = song.artist || artist;
          }
        } catch (parseErr) {
          // 缓存损坏，使用默认值
          console.error(`[播放记录] 歌单缓存损坏 ${playlistId}:`, parseErr.message);
        }
      }
    }

    playLogOps.log.run({
      user_id: userId,
      playlist_id: playlistId || null,
      song_id: songId,
      song_name: songName,
      artist: artist
    });
  } catch (e) {
    console.error('记录播放失败:', e);
  }
}

// 定期清理过期缓存
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of urlCache.entries()) {
    if (value.expires < now) {
      urlCache.delete(key);
    }
  }
}, 5 * 60 * 1000); // 每5分钟清理一次

module.exports = router;
