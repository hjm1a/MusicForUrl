const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toQQScopedPlaylistId,
  stripQQScopedPlaylistId,
  mapQQFavoriteRows
} = require('../lib/qq-center');

test('toQQScopedPlaylistId 为纯数字ID添加 qq: 前缀', () => {
  assert.equal(toQQScopedPlaylistId('12345'), 'qq:12345');
  assert.equal(toQQScopedPlaylistId('00123'), 'qq:00123');
});

test('stripQQScopedPlaylistId 只去除合法 qq: 前缀', () => {
  assert.equal(stripQQScopedPlaylistId('qq:12345'), '12345');
  assert.equal(stripQQScopedPlaylistId('12345'), '');
  assert.equal(stripQQScopedPlaylistId('qq:abc'), '');
});

test('mapQQFavoriteRows 输出去前缀后的 playlistId', () => {
  const rows = [
    {
      playlist_id: 'qq:20001',
      playlist_name: 'QQ 收藏歌单',
      playlist_cover: 'https://example.com/cover.jpg',
      nickname: '测试用户',
      created_at: '2026-02-07 10:00:00'
    }
  ];

  assert.deepEqual(mapQQFavoriteRows(rows), [
    {
      playlistId: '20001',
      name: 'QQ 收藏歌单',
      cover: 'https://example.com/cover.jpg',
      nickname: '测试用户',
      createdAt: '2026-02-07 10:00:00'
    }
  ]);
});
