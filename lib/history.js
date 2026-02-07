function mapRecentPlaylistRows(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const stripPrefix = typeof options.stripPrefix === 'string' ? options.stripPrefix : '';

  return list.map((row) => {
    const rawPlaylistId = String(row?.playlist_id || '');
    const playlistId = stripPrefix && rawPlaylistId.startsWith(stripPrefix)
      ? rawPlaylistId.slice(stripPrefix.length)
      : rawPlaylistId;
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
