const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 确保 data 目录存在
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'database.sqlite'));

// 启用 WAL 模式，提高并发性能
// 注意：某些文件系统/挂载方式（例如 Windows Docker bind mount）可能不支持 WAL 的 shm 文件，
// 会抛 SQLITE_IOERR_SHMOPEN。此时自动回退到 DELETE，保证服务可启动。
try {
  db.pragma('journal_mode = WAL');
} catch (e) {
  console.warn('[DB] WAL 不可用，已回退到 journal_mode=DELETE：', e?.message || e);
  try {
    db.pragma('journal_mode = DELETE');
  } catch (_) {}
}

// 初始化数据库表
function initDatabase() {
  // 用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      netease_id TEXT UNIQUE NOT NULL,
      nickname TEXT,
      avatar TEXT,
      vip_type INTEGER DEFAULT 0,
      cookie TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 歌单缓存表
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      playlist_id TEXT PRIMARY KEY,
      name TEXT,
      cover TEXT,
      song_count INTEGER,
      songs TEXT,
      cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    )
  `);

  // 收藏歌单表
  db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      playlist_id TEXT NOT NULL,
      playlist_name TEXT,
      playlist_cover TEXT,
      nickname TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, playlist_id)
    )
  `);

  // 播放统计表
  db.exec(`
    CREATE TABLE IF NOT EXISTS play_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      playlist_id TEXT,
      song_id TEXT,
      song_name TEXT,
      artist TEXT,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 常用查询索引（提升分页/排序性能）
  // favorites: WHERE user_id=? ORDER BY created_at DESC
  db.exec('CREATE INDEX IF NOT EXISTS idx_favorites_user_created_at ON favorites(user_id, created_at)');
  // play_logs: WHERE user_id=? ORDER BY played_at DESC
  db.exec('CREATE INDEX IF NOT EXISTS idx_play_logs_user_played_at ON play_logs(user_id, played_at)');
  // play_logs: WHERE user_id=? GROUP BY song_id
  db.exec('CREATE INDEX IF NOT EXISTS idx_play_logs_user_song_id ON play_logs(user_id, song_id)');

  console.log('数据库初始化完成');
}

// 先初始化数据库
initDatabase();

// 用户相关操作
const userOps = {
  // 创建或更新用户
  upsert: db.prepare(`
    INSERT INTO users (netease_id, nickname, avatar, vip_type, cookie, token, last_login)
    VALUES (@netease_id, @nickname, @avatar, @vip_type, @cookie, @token, CURRENT_TIMESTAMP)
    ON CONFLICT(netease_id) DO UPDATE SET
      nickname = @nickname,
      avatar = @avatar,
      vip_type = @vip_type,
      cookie = @cookie,
      token = @token,
      last_login = CURRENT_TIMESTAMP
  `),

  // 根据 token 获取用户
  getByToken: db.prepare('SELECT * FROM users WHERE token = ?'),

  // 根据网易云ID获取用户
  getByNeteaseId: db.prepare('SELECT * FROM users WHERE netease_id = ?'),

  // 更新 Cookie
  updateCookie: db.prepare('UPDATE users SET cookie = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?'),

  // 旋转 token 并清空 cookie（用于退出登录，保留用户记录/收藏/历史）
  rotateToken: db.prepare('UPDATE users SET token = ?, cookie = ? WHERE id = ?'),

  // 删除用户（谨慎使用，会导致收藏/历史成为孤儿数据）
  delete: db.prepare('DELETE FROM users WHERE id = ?')
};

// 歌单缓存相关操作
const playlistOps = {
  // 获取缓存
  get: db.prepare('SELECT * FROM playlists WHERE playlist_id = ? AND expires_at > CURRENT_TIMESTAMP'),

  // 设置缓存
  set: db.prepare(`
    INSERT INTO playlists (playlist_id, name, cover, song_count, songs, cached_at, expires_at)
    VALUES (@playlist_id, @name, @cover, @song_count, @songs, CURRENT_TIMESTAMP, @expires_at)
    ON CONFLICT(playlist_id) DO UPDATE SET
      name = @name,
      cover = @cover,
      song_count = @song_count,
      songs = @songs,
      cached_at = CURRENT_TIMESTAMP,
      expires_at = @expires_at
  `),

  // 清除过期缓存
  clearExpired: db.prepare('DELETE FROM playlists WHERE expires_at <= CURRENT_TIMESTAMP')
};

// 收藏相关操作
const favoriteOps = {
  // 获取用户的收藏列表 (支持分页)
  getByUser: db.prepare('SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),

  // 添加收藏
  add: db.prepare(`
    INSERT INTO favorites (user_id, playlist_id, playlist_name, playlist_cover, nickname)
    VALUES (@user_id, @playlist_id, @playlist_name, @playlist_cover, @nickname)
    ON CONFLICT(user_id, playlist_id) DO UPDATE SET
      playlist_name = @playlist_name,
      playlist_cover = @playlist_cover,
      nickname = COALESCE(@nickname, nickname)
  `),

  // 删除收藏
  remove: db.prepare('DELETE FROM favorites WHERE user_id = ? AND playlist_id = ?'),

  // 检查是否已收藏
  check: db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND playlist_id = ?'),

  // 获取收藏总数
  count: db.prepare('SELECT COUNT(*) as count FROM favorites WHERE user_id = ?')
};

// 播放记录相关操作
const playLogOps = {
  // 记录播放
  log: db.prepare(`
    INSERT INTO play_logs (user_id, playlist_id, song_id, song_name, artist)
    VALUES (@user_id, @playlist_id, @song_id, @song_name, @artist)
  `),

  // 获取用户最近播放
  getRecent: db.prepare(`
    SELECT * FROM play_logs 
    WHERE user_id = ? 
    ORDER BY played_at DESC 
    LIMIT ? OFFSET ?
  `),

  // 获取最近播放总数
  count: db.prepare('SELECT COUNT(*) as count FROM play_logs WHERE user_id = ?'),

  // 获取用户播放最多的歌曲
  getTopSongs: db.prepare(`
    SELECT song_id, song_name, artist, COUNT(*) as play_count
    FROM play_logs
    WHERE user_id = ?
    GROUP BY song_id
    ORDER BY play_count DESC
    LIMIT ?
  `)
};

module.exports = {
  db,
  initDatabase,
  userOps,
  playlistOps,
  favoriteOps,
  playLogOps
};
