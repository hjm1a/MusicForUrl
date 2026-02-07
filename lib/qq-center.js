function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

function toQQScopedPlaylistId(id) {
  const value = String(id || '').trim();
  if (!isValidNumericId(value)) return '';
  return `qq:${value}`;
}

function stripQQScopedPlaylistId(id) {
  const value = String(id || '').trim();
  const match = value.match(/^qq:(\d{1,20})$/);
  return match ? match[1] : '';
}

function mapQQFavoriteRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const mapped = [];

  for (const row of list) {
    const playlistId = stripQQScopedPlaylistId(row?.playlist_id);
    if (!playlistId) continue;
    mapped.push({
      playlistId,
      name: String(row?.playlist_name || ''),
      cover: String(row?.playlist_cover || ''),
      nickname: row?.nickname || null,
      createdAt: row?.created_at || null
    });
  }

  return mapped;
}

module.exports = {
  isValidNumericId,
  toQQScopedPlaylistId,
  stripQQScopedPlaylistId,
  mapQQFavoriteRows
};
