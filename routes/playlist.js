const express = require('express');
const router = express.Router();
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { playlistOps, userOps } = require('../lib/db');
const { auth } = require('../lib/auth');

function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

function isValidToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{32}$/i.test(token);
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '');
  }
  
  return `${req.protocol}://${req.get('host')}`;
}

function parsePlaylistId(input) {
  if (!input) return null;
  const str = String(input).trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return str;

  const m1 = str.match(/(?:\?|&)id=(\d{1,20})/);
  if (m1) return m1[1];

  const m2 = str.match(/\/playlist\/(\d{1,20})/);
  if (m2) return m2[1];

  return null;
}

function toSqliteDatetime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function sanitizeM3uTitle(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildLiteM3u8(baseUrl, token, playlistId, tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const durations = list
    .map(t => Math.floor(Number(t?.duration) || 0))
    .filter(n => Number.isFinite(n) && n > 0);

  const target = Math.max(10, ...durations);

  let out = '';
  out += '#EXTM3U\n';
  out += '#EXT-X-VERSION:3\n';
  out += `#EXT-X-TARGETDURATION:${target}\n`;
  out += '#EXT-X-MEDIA-SEQUENCE:0\n';
  out += '#EXT-X-PLAYLIST-TYPE:VOD\n';

  for (const track of list) {
    const id = track && track.id != null ? String(track.id) : '';
    if (!/^\d+$/.test(id)) continue;

    const duration = Math.max(0, Math.floor(Number(track.duration) || 0));
    const title = sanitizeM3uTitle(`${track.artist ? track.artist + ' - ' : ''}${track.name || id}`);
    const url =
      `${baseUrl}/api/song/${encodeURIComponent(token)}/${encodeURIComponent(id)}?playlist=${encodeURIComponent(playlistId)}`;
    out += `#EXTINF:${duration},${title}\n`;
    out += `${url}\n`;
  }

  out += '#EXT-X-ENDLIST\n';
  return out;
}

async function ensurePlaylistCached(playlistId, cookie) {
  try {
    playlistOps.clearExpired.run();
  } catch (_) {}

  const cached = playlistOps.get.get(playlistId);
  if (cached) {
    try {
      const songs = JSON.parse(cached.songs || '[]');
      if (Array.isArray(songs)) {
        return { playlist: cached, tracks: songs };
      }
    } catch (_) {}
  }

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

  return { playlist: { playlist_id: String(playlistId), name: playlist.name, cover: playlist.cover }, tracks: playlist.tracks || [] };
}

router.get('/m3u8/:token/:playlistId/lite.m3u8', async (req, res) => {
  const token = String(req.params.token || '');
  const playlistId = String(req.params.playlistId || '');

  if (!isValidToken(token)) {
    return res.status(400).type('text/plain').send('Invalid token');
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).type('text/plain').send('Invalid playlist id');
  }

  const user = userOps.getByToken.get(token);
  if (!user) {
    return res.status(401).type('text/plain').send('Token expired');
  }

  try {
    const cookie = decrypt(user.cookie);
    const { tracks } = await ensurePlaylistCached(playlistId, cookie);

    const baseUrl = getBaseUrl(req);
    const m3u8 = buildLiteM3u8(baseUrl, token, playlistId, tracks);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(m3u8);
  } catch (e) {
    console.error('生成 lite m3u8 失败:', e);
    res.status(500).type('text/plain').send('Failed to build m3u8');
  }
});

router.get('/user', auth, async (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 30;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  
  try {
    const cookie = decrypt(req.user.cookie);
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

router.get('/parse', auth, async (req, res) => {
  const input = req.query.url;
  const playlistId = parsePlaylistId(input);

  if (!playlistId || !isValidNumericId(playlistId)) {
    return res.status(400).json({ success: false, message: '无效的歌单链接或ID' });
  }

  try {
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

router.get('/url', auth, (req, res) => {
  const playlistId = String(req.query.id || '');

  if (!isValidNumericId(playlistId)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  const baseUrl = getBaseUrl(req);
  const hlsUrl = `${baseUrl}/api/hls/${req.token}/${playlistId}/stream.m3u8`;
  const liteUrl = `${baseUrl}/api/playlist/m3u8/${req.token}/${playlistId}/lite.m3u8`;

  res.json({
    success: true,
    data: {
      url: hlsUrl,
      urls: [
        {
          type: 'lite',
          label: '轻量 M3U8（直链列表，省资源）',
          url: liteUrl,
          note: '更省服务器资源；在部分播放器/环境（含部分 VRChat 播放器）可用，但不保证兼容；如遇不播放请切换 HLS'
        },
        {
          type: 'hls',
          label: 'HLS（转码分片，VRChat/播放器推荐）',
          url: hlsUrl,
          note: '更吃 CPU/磁盘，但播放器更稳'
        }
      ],
      default: 'lite'
    }
  });

  const preloadParam = String(req.query.preload || '').toLowerCase();
  const doPreload = preloadParam === '1' || preloadParam === 'true';
  if (!doPreload) return;

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
