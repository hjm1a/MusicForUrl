const express = require('express');
const router = express.Router();

const { playLogOps } = require('../lib/db');
const { qqAuth } = require('../lib/qq-auth-middleware');
const { mapRecentPlaylistRows } = require('../lib/history');

router.get('/recent', qqAuth, (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  try {
    const rows = playLogOps.getRecentPlaylistsQQ.all(req.qqUser.id, limit, offset);
    const totalResult = playLogOps.countRecentPlaylistsQQ.get(req.qqUser.id);
    const total = totalResult ? totalResult.count : 0;

    res.json({
      success: true,
      data: mapRecentPlaylistRows(rows, { stripPrefix: 'qq:' }),
      total
    });
  } catch (e) {
    console.error('获取QQ播放历史失败:', e);
    res.status(500).json({ success: false, message: '获取QQ播放历史失败' });
  }
});

module.exports = router;
