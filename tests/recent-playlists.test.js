const test = require('node:test');
const assert = require('node:assert/strict');

const { mapRecentPlaylistRows } = require('../lib/history');

test('maps recent playlist rows to api view model', () => {
  const rows = [
    {
      playlist_id: '12345',
      playlist_name: 'My Mix',
      playlist_cover: 'https://example.com/cover.jpg',
      played_at: '2026-02-06 12:00:00',
      play_count: 8
    }
  ];

  const result = mapRecentPlaylistRows(rows);
  assert.deepEqual(result, [
    {
      playlistId: '12345',
      name: 'My Mix',
      cover: 'https://example.com/cover.jpg',
      playedAt: '2026-02-06 12:00:00',
      playCount: 8
    }
  ]);
});

test('falls back when playlist name is missing', () => {
  const rows = [{ playlist_id: '67890', play_count: 1, played_at: '2026-02-06 10:00:00' }];
  const result = mapRecentPlaylistRows(rows);
  assert.equal(result[0].name, '歌单 67890');
});
