const crypto = require('crypto');
const {
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  captcha_sent,
  login_cellphone,
  user_playlist,
  user_subcount,
  playlist_detail,
  song_url
} = require('NeteaseCloudMusicApi');

function normalizeCookie(cookie) {
  if (!cookie) return '';
  if (Array.isArray(cookie)) return cookie.join('; ');
  return String(cookie);
}

function getArtists(track) {
  const artists = track?.ar || track?.artists || [];
  return artists.map(a => a?.name).filter(Boolean).join('/');
}

function getDurationSeconds(track) {
  const ms = track?.dt ?? track?.duration ?? 0;
  const sec = Math.round(Number(ms) / 1000);
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

function getTrackCoverUrl(track) {
  const url =
    track?.al?.picUrl ??
    track?.album?.picUrl ??
    track?.picUrl ??
    track?.cover ??
    '';
  return url ? String(url) : '';
}

/**
 * 获取登录二维码
 * @returns {Promise<{ key: string, qrimg: string }>}
 */
async function createQRCode() {
  const keyRes = await login_qr_key({ timestamp: Date.now() });
  if (keyRes?.body?.code !== 200 || !keyRes?.body?.data?.unikey) {
    throw new Error(keyRes?.body?.message || '获取二维码 key 失败');
  }

  const key = keyRes.body.data.unikey;
  const createRes = await login_qr_create({ key, qrimg: true, timestamp: Date.now() });
  if (createRes?.body?.code !== 200 || !createRes?.body?.data?.qrimg) {
    throw new Error(createRes?.body?.message || '生成二维码失败');
  }

  return { key, qrimg: createRes.body.data.qrimg };
}

/**
 * 检查二维码状态
 * @param {string} key
 * @returns {Promise<{ code: number, message: string, cookie?: string }>}
 */
async function checkQRCode(key) {
  const res = await login_qr_check({ key, timestamp: Date.now() });
  const body = res?.body || {};
  return {
    code: body.code,
    message: body.message,
    cookie: normalizeCookie(body.cookie || res?.cookie)
  };
}

/**
 * 检查登录状态（根据 cookie 获取用户信息）
 * @param {string} cookie
 * @returns {Promise<{ logged: boolean, userId?: string|number, nickname?: string, avatar?: string, vipType?: number }>}
 */
async function checkLoginStatus(cookie) {
  const res = await login_status({ cookie: normalizeCookie(cookie), timestamp: Date.now() });
  const data = res?.body?.data || {};
  const profile = data.profile;
  const account = data.account;

  if (!profile || !account) {
    return { logged: false };
  }

  return {
    logged: true,
    userId: profile.userId ?? account.id,
    nickname: profile.nickname,
    avatar: profile.avatarUrl,
    vipType: profile.vipType ?? 0
  };
}

/**
 * 发送验证码
 * @param {string} phone
 * @returns {Promise<boolean>}
 */
async function sendCaptcha(phone) {
  const res = await captcha_sent({ phone, timestamp: Date.now() });
  return res?.body?.code === 200;
}

/**
 * 手机验证码登录
 * @param {string} phone
 * @param {string} captcha
 * @returns {Promise<{ cookie: string }>}
 */
async function loginWithCaptcha(phone, captcha) {
  const res = await login_cellphone({ phone, captcha, timestamp: Date.now() });
  const body = res?.body || {};
  if (body.code !== 200) {
    throw new Error(body.message || '验证码登录失败');
  }
  const cookie = normalizeCookie(res?.cookie || body.cookie);
  if (!cookie) throw new Error('登录成功但未获取到 cookie');
  return { cookie };
}

/**
 * 手机密码登录（使用 MD5）
 * @param {string} phone
 * @param {string} password
 * @returns {Promise<{ cookie: string }>}
 */
async function loginWithPassword(phone, password) {
  const md5 = crypto.createHash('md5').update(String(password)).digest('hex');
  const res = await login_cellphone({ phone, md5_password: md5, timestamp: Date.now() });
  const body = res?.body || {};
  if (body.code !== 200) {
    throw new Error(body.message || '密码登录失败');
  }
  const cookie = normalizeCookie(res?.cookie || body.cookie);
  if (!cookie) throw new Error('登录成功但未获取到 cookie');
  return { cookie };
}

/**
 * 获取用户歌单
 */
async function getUserPlaylists(uid, cookie = '', offset = 0, limit = 30) {
  const res = await user_playlist({
    uid,
    limit,
    offset,
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  });

  if (res?.body?.code !== 200) {
    throw new Error(res?.body?.message || '获取用户歌单失败');
  }

  const playlists = res.body.playlist?.map(p => ({
    id: p.id,
    name: p.name,
    cover: p.coverImgUrl,
    trackCount: p.trackCount,
    creator: p.creator?.nickname,
    userId: p.userId,
    playCount: p.playCount
  })) || [];

  // 计算总数：优先使用 API 返回的 playlistCount，否则用当前数据估算
  let total = 0;
  
  // user_playlist API 会返回 playlistCount 字段（如果有的话）
  if (res.body.playlistCount !== undefined) {
    total = res.body.playlistCount;
  } else if (res.body.more) {
    // 如果有更多，估算总数：当前偏移 + 当前页数量 + 至少还有1页
    total = offset + playlists.length + limit;
  } else {
    // 没有更多了，当前偏移 + 当前页数量就是总数
    total = offset + playlists.length;
  }

  return {
    playlists,
    hasMore: res.body.more,
    count: total
  };
}

/**
 * 获取歌单详情（含曲目）
 * @param {string|number} playlistId
 * @param {string} cookie
 * @returns {Promise<{ id: string|number, name: string, cover: string, songCount: number, tracks: Array<{id:number,name:string,artist:string,duration:number,cover?:string}> }>}
 */
async function getPlaylistDetail(playlistId, cookie = '') {
  const res = await playlist_detail({
    id: playlistId,
    s: 8,
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  });

  if (res?.body?.code !== 200 || !res?.body?.playlist) {
    throw new Error(res?.body?.message || '获取歌单失败');
  }

  const p = res.body.playlist;
  const tracks = (p.tracks || []).map(t => ({
    id: t.id,
    name: t.name,
    artist: getArtists(t),
    duration: getDurationSeconds(t),
    cover: getTrackCoverUrl(t)
  }));

  return {
    id: p.id,
    name: p.name,
    cover: p.coverImgUrl,
    songCount: p.trackCount || tracks.length,
    tracks
  };
}

/**
 * 音质级别（bitrate）
 * - 128000: 标准音质 (128kbps MP3)
 * - 192000: 较高音质 (192kbps MP3)
 * - 320000: 极高音质 (320kbps MP3)
 * - 999000: 无损/Hi-Res (FLAC/Hi-Res，文件较大)
 */
const QUALITY_LEVELS = {
  low: 128000,
  medium: 192000,
  high: 320000,
  lossless: 999000
};

/**
 * 获取歌曲播放 URL
 * @param {string|number} songId
 * @param {string} cookie
 * @param {number} [bitrate] - 音质，默认从环境变量读取或使用 128000
 * @returns {Promise<string|null>}
 */
async function getSongUrl(songId, cookie = '', bitrate) {
  // 优先使用传入的 bitrate，否则读取环境变量，最后默认 128000（标准音质）
  let br = bitrate;
  if (!br) {
    const envQuality = (process.env.MUSIC_QUALITY || '').toLowerCase().trim();
    br = QUALITY_LEVELS[envQuality] || parseInt(process.env.MUSIC_BITRATE) || 128000;
  }

  const res = await song_url({
    id: songId,
    br,
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  });

  if (res?.body?.code !== 200) return null;
  const url = res?.body?.data?.[0]?.url;
  return url ? String(url) : null;
}

module.exports = {
  createQRCode,
  checkQRCode,
  checkLoginStatus,
  sendCaptcha,
  loginWithCaptcha,
  loginWithPassword,
  getUserPlaylists,
  getPlaylistDetail,
  getSongUrl,
  QUALITY_LEVELS
};
