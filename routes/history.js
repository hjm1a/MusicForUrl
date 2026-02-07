const express = require('express');
const router = express.Router();
const { playLogOps } = require('../lib/db');
const { mapRecentPlaylistRows } = require('../lib/history');
const { auth } = require('../lib/auth');

router.get('/recent', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const rawOffset = parseInt(req.query.offset, 10);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  
  try {
    const rows = playLogOps.getRecentPlaylistsNetease.all(req.user.id, limit, offset);
    const totalResult = playLogOps.countRecentPlaylistsNetease.get(req.user.id);
    const total = totalResult ? totalResult.count : 0;

    res.json({
      success: true,
      data: mapRecentPlaylistRows(rows),
      total
    });
  } catch (e) {
    console.error('获取播放历史失败:', e);
    res.status(500).json({ success: false, message: '获取播放历史失败' });
  }
});

router.get('/top', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  
  try {
    const songs = playLogOps.getTopSongs.all(req.user.id, limit);
    res.json({
      success: true,
      data: songs.map(s => ({
        songId: s.song_id,
        songName: s.song_name,
        artist: s.artist,
        playCount: s.play_count
      }))
    });
  } catch (e) {
    console.error('获取热门歌曲失败:', e);
    res.status(500).json({ success: false, message: '获取热门歌曲失败' });
  }
});

module.exports = router;
