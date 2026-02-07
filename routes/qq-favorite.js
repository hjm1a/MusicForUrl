const express = require('express');
const router = express.Router();

const { favoriteOps } = require('../lib/db');
const { qqAuth } = require('../lib/qq-auth-middleware');
const {
  isValidNumericId,
  toQQScopedPlaylistId,
  mapQQFavoriteRows
} = require('../lib/qq-center');

router.get('/', qqAuth, (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  try {
    const favorites = favoriteOps.getByUserQQ.all(req.qqUser.id, limit, offset);
    const totalResult = favoriteOps.countQQ.get(req.qqUser.id);
    const total = totalResult ? totalResult.count : 0;

    res.json({
      success: true,
      data: mapQQFavoriteRows(favorites),
      total
    });
  } catch (e) {
    console.error('获取QQ收藏失败:', e);
    res.status(500).json({ success: false, message: '获取QQ收藏失败' });
  }
});

router.post('/', qqAuth, (req, res) => {
  const { playlistId, playlistName, playlistCover, nickname } = req.body;
  const pid = String(playlistId || '').trim();
  if (!isValidNumericId(pid)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  const scopedPlaylistId = toQQScopedPlaylistId(pid);
  if (!scopedPlaylistId) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  try {
    favoriteOps.add.run({
      user_id: req.qqUser.id,
      playlist_id: scopedPlaylistId,
      playlist_name: playlistName || '',
      playlist_cover: playlistCover || '',
      nickname: nickname || null
    });

    res.json({ success: true, message: '收藏成功' });
  } catch (e) {
    console.error('添加QQ收藏失败:', e);
    res.status(500).json({ success: false, message: '添加QQ收藏失败' });
  }
});

router.delete('/:playlistId', qqAuth, (req, res) => {
  const pid = String(req.params.playlistId || '').trim();
  if (!isValidNumericId(pid)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  const scopedPlaylistId = toQQScopedPlaylistId(pid);
  if (!scopedPlaylistId) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  try {
    favoriteOps.remove.run(req.qqUser.id, scopedPlaylistId);
    res.json({ success: true, message: '已取消收藏' });
  } catch (e) {
    console.error('删除QQ收藏失败:', e);
    res.status(500).json({ success: false, message: '删除QQ收藏失败' });
  }
});

router.get('/check/:playlistId', qqAuth, (req, res) => {
  const pid = String(req.params.playlistId || '').trim();
  if (!isValidNumericId(pid)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  const scopedPlaylistId = toQQScopedPlaylistId(pid);
  if (!scopedPlaylistId) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  try {
    const exists = favoriteOps.check.get(req.qqUser.id, scopedPlaylistId);
    res.json({ success: true, data: { favorited: !!exists } });
  } catch (e) {
    console.error('检查QQ收藏失败:', e);
    res.status(500).json({ success: false, message: '检查QQ收藏失败' });
  }
});

module.exports = router;
