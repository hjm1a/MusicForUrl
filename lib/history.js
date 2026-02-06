function mapRecentPlaylistRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const playlistId = String(row?.playlist_id || '');
    const fallbackName = playlistId ? `歌单 ${playlistId}` : '未知歌单';
    const rawName = String(row?.playlist_name || '').trim();
    const playCount = Number(row?.play_count || 0);

    return {
      playlistId,
      name: rawName || fallbackName,
      cover: String(row?.playlist_cover || ''),
      playedAt: row?.played_at || null,
      playCount: Number.isFinite(playCount) ? playCount : 0
    };
  });
}

module.exports = {
  mapRecentPlaylistRows
};
