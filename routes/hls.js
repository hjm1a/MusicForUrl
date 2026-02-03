const express = require('express');
const router = express.Router();
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { userOps, playlistOps, playLogOps } = require('../lib/db');

// 参数校验：纯数字ID（防路径穿越）
function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

// 参数校验：token格式（32位hex）
function isValidToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{32}$/i.test(token);
}

// 参数校验：segment索引（非负整数，合理范围）
function isValidSegmentIndex(index) {
  const num = parseInt(index);
  return !isNaN(num) && num >= 0 && num < 10000; // 一首歌不可能有10000个segment
}

// 管理员鉴权中间件
function adminAuth(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  
  // 生产环境未配置管理员密码时，禁用管理接口
  if (!adminPassword) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ 
        error: '管理接口已禁用', 
        message: '生产环境需要配置 ADMIN_PASSWORD 才能使用管理接口' 
      });
    }
    // 开发环境允许无密码访问（方便调试）
    return next();
  }
  
  // 检查请求头中的管理员密码
  const providedPassword = req.headers['x-admin-password'];
  if (providedPassword !== adminPassword) {
    return res.status(401).json({ error: '管理员密码错误或未提供' });
  }
  
  next();
}

// HLS输出目录
const HLS_DIR = path.join(__dirname, '..', 'data', 'hls');

// TS分片缓存目录
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');

// 确保目录存在
if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 缓存配置
function envNumber(key) {
  const raw = process.env[key];
  if (raw == null || raw === '') return NaN;
  const num = Number(raw);
  return Number.isFinite(num) ? num : NaN;
}

// 说明：
// - HLS_CACHE_MAX_SIZE（字节）优先级高于 HLS_CACHE_MAX_SIZE_GB（GB）
// - 其它参数使用更易读的 hours/minutes 配置
const maxSizeBytesFromEnv = envNumber('HLS_CACHE_MAX_SIZE');
const maxSizeGBFromEnv = envNumber('HLS_CACHE_MAX_SIZE_GB');
const maxAgeHoursFromEnv = envNumber('HLS_CACHE_MAX_AGE_HOURS');
const cleanupIntervalMinutesFromEnv = envNumber('HLS_CACHE_CLEANUP_INTERVAL_MINUTES');
const cleanupTargetRatioFromEnv = envNumber('HLS_CACHE_CLEANUP_TARGET_RATIO');

const CACHE_CONFIG = {
  maxAge: (Number.isFinite(maxAgeHoursFromEnv) && maxAgeHoursFromEnv > 0)
    ? Math.floor(maxAgeHoursFromEnv * 60 * 60 * 1000)
    : 24 * 60 * 60 * 1000, // 缓存有效期 24 小时
  maxSize: (Number.isFinite(maxSizeBytesFromEnv) && maxSizeBytesFromEnv > 0)
    ? Math.floor(maxSizeBytesFromEnv)
    : ((Number.isFinite(maxSizeGBFromEnv) && maxSizeGBFromEnv > 0)
      ? Math.floor(maxSizeGBFromEnv * 1024 * 1024 * 1024)
      : 5 * 1024 * 1024 * 1024), // 默认最大缓存 5GB（GiB）
  cleanupInterval: (Number.isFinite(cleanupIntervalMinutesFromEnv) && cleanupIntervalMinutesFromEnv > 0)
    ? Math.floor(cleanupIntervalMinutesFromEnv * 60 * 1000)
    : 60 * 60 * 1000, // 默认每小时清理一次
  cleanupToRatio: (Number.isFinite(cleanupTargetRatioFromEnv) && cleanupTargetRatioFromEnv > 0 && cleanupTargetRatioFromEnv < 1)
    ? cleanupTargetRatioFromEnv
    : 0.8, // 超限时清理到 maxSize * 0.8 以下
  autoPreloadCount: parseInt(process.env.HLS_AUTO_PRELOAD_COUNT, 10) || 1, // 自动预加载前N首歌
  segmentDuration: 10, // 每个HLS分片10秒（推荐6-10秒）
};

// 日志级别控制
// LOG_HLS_VERBOSE=1 时输出详细日志（分片命中、预加载进度等），否则仅输出错误和关键事件
const LOG_VERBOSE = process.env.LOG_HLS_VERBOSE === '1' || process.env.LOG_HLS_VERBOSE === 'true';

// 缓存版本：变更分片输出或封面策略时递增，自动让旧缓存失效
const CACHE_VERSION = 2;

// 默认封面（兜底）
const DEFAULT_COVER_URL =
  process.env.DEFAULT_COVER_URL ||
  'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg';

// 封面视频输出分辨率（VRChat 视频播放器更偏好 16:9）
const COVER_OUTPUT = {
  width: parseInt(process.env.COVER_WIDTH) || 1920,
  height: parseInt(process.env.COVER_HEIGHT) || 1080
};

// 封面视频帧率：静态图不需要高帧率，降低可显著减少转码压力
// - 不配置时保持 FFmpeg 默认行为（通常是 25fps），确保兼容性
// - 建议弱服务器设置为 1~5
const COVER_FPS = (() => {
  const raw = process.env.COVER_FPS;
  if (raw == null || raw === '') return 25;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
  return 25;
})();

// 限制单个 FFmpeg 进程线程数，避免并发时把 CPU 打满；0 表示由 FFmpeg 自动决定
const HLS_FFMPEG_THREADS = (() => {
  const raw = process.env.HLS_FFMPEG_THREADS;
  if (raw == null || raw === '') return 0;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 64) return n;
  return 0;
})();

function optimizeNeteaseCoverUrl(rawUrl, size = 1080) {
  const url = (rawUrl == null) ? '' : String(rawUrl).trim();
  if (!/^https?:\/\//i.test(url)) return '';
  // 仅对网易云 CDN 做 param 提升清晰度，其它域名保持原样
  try {
    const u = new URL(url);
    if (!/^p\d+\.music\.126\.net$/i.test(u.hostname)) return url;
    u.searchParams.set('param', `${size}y${size}`);
    return u.toString();
  } catch (_) {
    return url;
  }
}

function pickCoverUrlForSong(song, playlistCoverUrl) {
  const songCover = song && song.cover ? String(song.cover) : '';
  const base = songCover || playlistCoverUrl || DEFAULT_COVER_URL;
  // 1080 作为图片下载尺寸，最终输出用 ffmpeg 缩放到 1920x1080
  return optimizeNeteaseCoverUrl(base, 1080) || DEFAULT_COVER_URL;
}

// 任务限制配置（从环境变量读取，提供合理默认值）
const JOB_LIMITS = {
  maxConcurrentJobs: parseInt(process.env.HLS_MAX_CONCURRENT_JOBS) || 2,  // 最大并发转码任务
  maxQueueSize: parseInt(process.env.HLS_MAX_QUEUE) || 10,                // 最大等待队列长度
  downloadTimeout: parseInt(process.env.HLS_DOWNLOAD_TIMEOUT) || 60000,   // 下载超时 60秒
  downloadMaxSize: parseInt(process.env.HLS_DOWNLOAD_MAX_SIZE) || 100 * 1024 * 1024, // 下载最大 100MB
  downloadMaxRedirects: 5, // 最大重定向次数
  ffmpegTimeout: parseInt(process.env.HLS_FFMPEG_TIMEOUT) || 180000,      // FFmpeg 超时 3分钟
};

// 下载 URL 允许的 host 模式（防止 SSRF）
// 默认允许网易云音频/封面 CDN；可通过 HLS_DOWNLOAD_ALLOW_HOSTS 环境变量扩展（逗号分隔的正则）
const DEFAULT_DOWNLOAD_ALLOW_PATTERNS = [
  /^m\d+[a-z]*\.music\.126\.net$/i,  // 音频 CDN: m7.music.126.net, m701.music.126.net 等
  /^p\d+\.music\.126\.net$/i,        // 封面 CDN: p1.music.126.net, p2.music.126.net 等
  /^music\.126\.net$/i,              // 主域名
];

// 从环境变量解析额外允许的 host 模式
function parseExtraAllowPatterns() {
  const extra = process.env.HLS_DOWNLOAD_ALLOW_HOSTS;
  if (!extra) return [];
  return extra.split(',').map(s => s.trim()).filter(Boolean).map(pattern => {
    try {
      return new RegExp(pattern, 'i');
    } catch (e) {
      console.warn(`[HLS] 无效的 HLS_DOWNLOAD_ALLOW_HOSTS 模式: ${pattern}`);
      return null;
    }
  }).filter(Boolean);
}

const DOWNLOAD_ALLOW_PATTERNS = [...DEFAULT_DOWNLOAD_ALLOW_PATTERNS, ...parseExtraAllowPatterns()];

/**
 * 检查下载 URL 是否在允许列表内（协议 + host）
 * @param {string} urlStr - 要检查的 URL
 * @returns {{ allowed: boolean, reason?: string }}
 */
function isDownloadUrlAllowed(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return { allowed: false, reason: 'Invalid URL' };
  }
  
  // 仅允许 http/https 协议
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { allowed: false, reason: `Protocol not allowed: ${u.protocol}` };
  }
  
  // 检查 host 是否匹配允许列表
  const hostname = u.hostname.toLowerCase();
  const matched = DOWNLOAD_ALLOW_PATTERNS.some(pattern => pattern.test(hostname));
  if (!matched) {
    return { allowed: false, reason: `Host not allowed: ${hostname}` };
  }
  
  return { allowed: true };
}

// 简易信号量实现（用于并发控制）
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return true;
    }
    
    // 检查队列是否已满
    if (this.queue.length >= JOB_LIMITS.maxQueueSize) {
      return false; // 队列已满，拒绝请求
    }
    
    // 加入等待队列
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  
  release() {
    this.current--;
    if (this.queue.length > 0 && this.current < this.max) {
      this.current++;
      const next = this.queue.shift();
      next(true);
    }
  }
  
  get waiting() {
    return this.queue.length;
  }
  
  get running() {
    return this.current;
  }
}

// 转码任务信号量
const jobSemaphore = new Semaphore(JOB_LIMITS.maxConcurrentJobs);

// 正在生成中的文件锁（防止重复生成）
const generatingLocks = new Map();

// 正在进行的预加载任务（防止重复预加载）
const preloadingPlaylists = new Set();

// 歌曲segment信息缓存（songId -> { count, durations }）
const songSegmentInfo = new Map();
const SEGMENT_INFO_MAX = 1000; // 内存中最多缓存1000首歌的分片信息

// 定期清理内存缓存中过期或超量的条目
setInterval(() => {
  // 清理超过1小时未更新的 generatingLocks（防止泄漏）
  const now = Date.now();
  for (const [key, promise] of generatingLocks.entries()) {
    // 如果 Promise 已解决且超过1小时，清理
    if (promise._createdAt && now - promise._createdAt > 60 * 60 * 1000) {
      generatingLocks.delete(key);
    }
  }
  
  // 清理 preloadingPlaylists（超过100个时清空，因为这些应该是短暂的）
  if (preloadingPlaylists.size > 100) {
    preloadingPlaylists.clear();
  }
  
  // 限制 songSegmentInfo 大小
  if (songSegmentInfo.size > SEGMENT_INFO_MAX) {
    // 随机删除 20% 的条目（简单策略）
    const toDelete = Math.ceil(songSegmentInfo.size * 0.2);
    let deleted = 0;
    for (const key of songSegmentInfo.keys()) {
      if (deleted >= toDelete) break;
      songSegmentInfo.delete(key);
      deleted++;
    }
    console.log(`[HLS] songSegmentInfo 超限，已清理 ${deleted} 条`);
  }
}, 10 * 60 * 1000); // 每10分钟检查一次

// 查找FFmpeg路径
function findFFmpeg() {
  // 1. 检查环境变量中是否有
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch (e) {}
  
  // 2. Windows: 检查winget安装位置
  if (os.platform() === 'win32') {
    const wingetPath = path.join(
      process.env.LOCALAPPDATA || '',
      'Microsoft', 'WinGet', 'Packages'
    );
    if (fs.existsSync(wingetPath)) {
      const searchFFmpeg = (dir) => {
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              const result = searchFFmpeg(fullPath);
              if (result) return result;
            } else if (item === 'ffmpeg.exe') {
              return fullPath;
            }
          }
        } catch (e) {}
        return null;
      };
      const found = searchFFmpeg(wingetPath);
      if (found) return found;
    }
    
    // 3. 检查常见安装位置
    const commonPaths = [
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin', 'ffmpeg.exe')
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  
  return 'ffmpeg'; // 默认使用PATH中的
}

const FFMPEG_PATH = findFFmpeg();
console.log('FFmpeg路径:', FFMPEG_PATH);

// 临时文件目录
const TEMP_DIR = path.join(__dirname, '..', 'data', 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 获取歌曲缓存目录
function getSongCacheDir(songId) {
  return path.join(CACHE_DIR, String(songId));
}

// 获取segment缓存文件路径
function getSegmentPath(songId, segmentIndex) {
  return path.join(getSongCacheDir(songId), `seg_${String(segmentIndex).padStart(4, '0')}.ts`);
}

// 获取歌曲的segment信息文件路径
function getSegmentInfoPath(songId) {
  return path.join(getSongCacheDir(songId), 'info.json');
}

// 检查歌曲是否已完整缓存
function isSongCached(songId) {
  try {
    const infoPath = getSegmentInfoPath(songId);
    if (!fs.existsSync(infoPath)) return false;
    
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    // 缓存版本或输出规格不匹配则判定为无效缓存
    if (info.version !== CACHE_VERSION) return false;
    if (!info.video || info.video.width !== COVER_OUTPUT.width || info.video.height !== COVER_OUTPUT.height) return false;
    const age = Date.now() - info.timestamp;
    if (age > CACHE_CONFIG.maxAge) return false;
    
    // 检查所有segment文件是否存在
    for (let i = 0; i < info.segmentCount; i++) {
      if (!fs.existsSync(getSegmentPath(songId, i))) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// 获取歌曲的segment信息（优先使用内存缓存，减少频繁磁盘读取）
function getSongSegmentInfo(songId) {
  const key = String(songId);
  const cached = songSegmentInfo.get(key);
  if (cached) return cached;

  try {
    const infoPath = getSegmentInfoPath(key);
    if (!fs.existsSync(infoPath)) return null;
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    songSegmentInfo.set(key, info);
    return info;
  } catch (e) {
    return null;
  }
}

// 检查单个segment是否有效
function isSegmentValid(songId, segmentIndex) {
  try {
    const segPath = getSegmentPath(songId, segmentIndex);
    const stat = fs.statSync(segPath);
    return stat.isFile() && stat.size > 1024;
  } catch (e) {
    return false;
  }
}

// 计算歌曲目录大小（遍历目录内所有文件）
function getSongDirSize(songDir) {
  try {
    const files = fs.readdirSync(songDir);
    let totalSize = 0;
    for (const file of files) {
      const filePath = path.join(songDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        totalSize += stat.size;
      }
    }
    return totalSize;
  } catch (e) {
    return 0;
  }
}

// 获取缓存目录总大小（遍历所有歌曲目录）
function getCacheSize() {
  try {
    const songDirs = fs.readdirSync(CACHE_DIR);
    let totalSize = 0;
    for (const songId of songDirs) {
      const songDir = path.join(CACHE_DIR, songId);
      const stat = fs.statSync(songDir);
      if (stat.isDirectory()) {
        totalSize += getSongDirSize(songDir);
      }
    }
    return totalSize;
  } catch (e) {
    return 0;
  }
}

// 清理过期或过大的缓存（按歌曲目录为单位）
let cacheCleanupRunning = false;
let cacheCleanupScheduled = false;

function cleanupCache(reason = 'interval') {
  if (cacheCleanupRunning) return;
  cacheCleanupRunning = true;
  try {
    const songDirs = fs.readdirSync(CACHE_DIR);
    const songInfos = [];
    let totalSize = 0;
    
    // 收集所有歌曲目录的信息
    for (const songIdRaw of songDirs) {
      const songId = String(songIdRaw);
      // 避免在转码/写入过程中被清理掉
      if (generatingLocks.has(songId)) continue;
      
      const songDir = path.join(CACHE_DIR, songId);
      try {
        const stat = fs.statSync(songDir);
        if (!stat.isDirectory()) continue;
        
        // 读取 info.json 获取缓存时间戳
        const infoPath = path.join(songDir, 'info.json');
        let timestamp = stat.mtimeMs; // 默认使用目录修改时间
        
        if (fs.existsSync(infoPath)) {
          try {
            const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
            timestamp = info.timestamp || timestamp;
          } catch (e) {}
        }
        
        const size = getSongDirSize(songDir);
        songInfos.push({
          songId,
          path: songDir,
          size,
          timestamp
        });
        totalSize += size;
      } catch (e) {}
    }
    
    const now = Date.now();
    let deleted = 0;
    let freedSize = 0;
    
    // 删除过期的歌曲缓存
    for (const info of songInfos) {
      if (now - info.timestamp > CACHE_CONFIG.maxAge) {
        try {
          fs.rmSync(info.path, { recursive: true, force: true });
          // 同步清理内存缓存
          songSegmentInfo.delete(info.songId);
          totalSize -= info.size;
          freedSize += info.size;
          deleted++;
        } catch (e) {
          console.error(`删除过期缓存失败 ${info.songId}:`, e.message);
        }
      }
    }
    
    // 如果还是太大，按时间删除最旧的
    if (totalSize > CACHE_CONFIG.maxSize) {
      const targetSize = CACHE_CONFIG.maxSize * CACHE_CONFIG.cleanupToRatio;
      
      // 按时间戳排序（最旧的在前）
      const remaining = songInfos
        .filter(s => fs.existsSync(s.path))
        .sort((a, b) => a.timestamp - b.timestamp);
      
      for (const info of remaining) {
        if (totalSize <= targetSize) break;
        // 双保险：不要清理正在生成中的
        if (generatingLocks.has(info.songId)) continue;
        try {
          fs.rmSync(info.path, { recursive: true, force: true });
          // 同步清理内存缓存
          songSegmentInfo.delete(info.songId);
          totalSize -= info.size;
          freedSize += info.size;
          deleted++;
        } catch (e) {}
      }
    }
    
    if (deleted > 0) {
      console.log(`缓存清理完成(${reason})，删除了 ${deleted} 首歌曲缓存，释放 ${(freedSize / 1024 / 1024).toFixed(2)} MB`);
    }
  } catch (e) {
    console.error('缓存清理失败:', e.message);
  } finally {
    cacheCleanupRunning = false;
  }
}

function scheduleCacheCleanup(reason = 'scheduled') {
  if (cacheCleanupScheduled) return;
  cacheCleanupScheduled = true;
  setTimeout(() => {
    cacheCleanupScheduled = false;
    cleanupCache(reason);
  }, 1000);
}

// 启动定期清理
setInterval(cleanupCache, CACHE_CONFIG.cleanupInterval);
// 启动后延迟触发一次清理，避免旧缓存长期堆积
setTimeout(() => scheduleCacheCleanup('startup'), 5000);

// 生成歌曲的HLS segments并缓存（带并发控制和超时）
async function generateSongSegments(songId, audioUrl, coverUrl, songDuration) {
  // 尝试获取信号量（并发控制）
  const acquired = await jobSemaphore.acquire();
  if (!acquired) {
    throw new Error('服务繁忙，请稍后重试');
  }
  
  const timestamp = Date.now();
  const tempAudio = path.join(TEMP_DIR, `${songId}_${timestamp}.mp3`);
  const tempCover = path.join(TEMP_DIR, `${songId}_${timestamp}.jpg`);
  const songCacheDir = getSongCacheDir(songId);
  const tempM3u8 = path.join(TEMP_DIR, `${songId}_${timestamp}.m3u8`);
  const tempSegmentPattern = path.join(TEMP_DIR, `${songId}_${timestamp}_seg_%04d.ts`);
  
  const cleanup = () => {
    // 清理临时文件
    fs.unlink(tempAudio, () => {});
    fs.unlink(tempCover, () => {});
    fs.unlink(tempM3u8, () => {});
    // 清理临时segment文件
    try {
      const tempFiles = fs.readdirSync(TEMP_DIR);
      for (const f of tempFiles) {
        if (f.startsWith(`${songId}_${timestamp}_seg_`)) {
          fs.unlinkSync(path.join(TEMP_DIR, f));
        }
      }
    } catch (e) {}
  };
  
  const releaseAndCleanup = () => {
    cleanup();
    jobSemaphore.release();
  };
  
  try {
    // 确保歌曲缓存目录存在
    if (!fs.existsSync(songCacheDir)) {
      fs.mkdirSync(songCacheDir, { recursive: true });
    }
    
    // 下载音频和封面
    if (LOG_VERBOSE) console.log(`[分片缓存] 正在下载: ${songId} (并发: ${jobSemaphore.running}/${JOB_LIMITS.maxConcurrentJobs}, 等待: ${jobSemaphore.waiting})`);
    await Promise.all([
      downloadFile(audioUrl, tempAudio),
      downloadFile(coverUrl, tempCover)
    ]);
    
    if (LOG_VERBOSE) console.log(`[分片缓存] 正在转码并分片: ${songId}`);
    
    // 使用FFmpeg生成HLS segments（封装为Promise）
    const info = await runFFmpegTranscode({
      songId,
      timestamp,
      tempAudio,
      tempCover,
      tempM3u8,
      tempSegmentPattern,
      songCacheDir
    });
    
    // 转码完成后异步触发一次清理（防止缓存短时间快速膨胀）
    scheduleCacheCleanup('after-generate');
    
    releaseAndCleanup();
    return info;
    
  } catch (e) {
    releaseAndCleanup();
    throw e;
  }
}

// FFmpeg 转码处理（封装事件回调为 Promise）
function runFFmpegTranscode({ songId, timestamp, tempAudio, tempCover, tempM3u8, tempSegmentPattern, songCacheDir }) {
  return new Promise((resolve, reject) => {
    const segmentDuration = CACHE_CONFIG.segmentDuration;
    // 对齐 GOP 到分片时长，避免低 FPS 时导致分片无法按 hls_time 切分
    const gop = Math.max(1, Math.round(COVER_FPS * segmentDuration));
    let ffmpegTimeout = null;
    let ffmpegKilled = false;
    let ffmpegError = '';
    
    const vf = [
      `scale=${COVER_OUTPUT.width}:${COVER_OUTPUT.height}:force_original_aspect_ratio=decrease`,
      `pad=${COVER_OUTPUT.width}:${COVER_OUTPUT.height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1'
    ].join(',');

    const ffmpegArgs = [
      '-loop', '1',
      // 静态封面图按指定 FPS 生成视频帧，降低 CPU
      '-framerate', String(COVER_FPS),
      '-i', tempCover,
      '-i', tempAudio,
    ];

    if (HLS_FFMPEG_THREADS > 0) {
      ffmpegArgs.push('-threads', String(HLS_FFMPEG_THREADS));
    }

    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'stillimage',
      '-crf', '28',
      // 输出恒定帧率，避免播放器对极低/变化帧率兼容性问题
      '-r', String(COVER_FPS),
      // 关键帧对齐分片边界（否则低 FPS 时 hls_time 可能切不出预期的 10s 分片）
      '-g', String(gop),
      '-keyint_min', String(gop),
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${segmentDuration})`,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-pix_fmt', 'yuv420p',
      '-vf', vf,
      '-shortest',
      '-f', 'hls',
      '-hls_time', String(segmentDuration),
      '-hls_list_size', '0',           // 包含所有segment
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', tempSegmentPattern,
      '-y',
      tempM3u8
    );

    const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs);
    
    ffmpegProcess.stderr.on('data', (data) => {
      ffmpegError += data.toString();
    });
    
    // FFmpeg 超时控制
    ffmpegTimeout = setTimeout(() => {
      if (ffmpegProcess && !ffmpegKilled) {
        ffmpegKilled = true;
        ffmpegProcess.kill('SIGKILL');
        console.error(`[分片缓存] FFmpeg超时被终止: ${songId}`);
      }
    }, JOB_LIMITS.ffmpegTimeout);
    
    ffmpegProcess.on('error', (err) => {
      clearTimeout(ffmpegTimeout);
      reject(err);
    });
    
    ffmpegProcess.on('close', (code) => {
      clearTimeout(ffmpegTimeout);
      
      if (ffmpegKilled) {
        reject(new Error('FFmpeg处理超时'));
        return;
      }
      
      if (code !== 0) {
        reject(new Error(`FFmpeg退出码: ${code}, 错误: ${ffmpegError.substring(0, 300)}`));
        return;
      }
      
      try {
        // 解析生成的m3u8获取segment信息
        const m3u8Content = fs.readFileSync(tempM3u8, 'utf8');
        const segmentDurations = [];
        const lines = m3u8Content.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXTINF:')) {
            const duration = parseFloat(lines[i].replace('#EXTINF:', '').split(',')[0]);
            segmentDurations.push(duration);
          }
        }
        
        // 移动segment文件到缓存目录
        const tempFiles = fs.readdirSync(TEMP_DIR);
        const segmentFiles = tempFiles
          .filter(f => f.startsWith(`${songId}_${timestamp}_seg_`) && f.endsWith('.ts'))
          .sort();
        
        for (let i = 0; i < segmentFiles.length; i++) {
          const srcPath = path.join(TEMP_DIR, segmentFiles[i]);
          const destPath = getSegmentPath(songId, i);
          fs.renameSync(srcPath, destPath);
        }
        
        // 保存segment信息
        const info = {
          version: CACHE_VERSION,
          songId: songId,
          segmentCount: segmentFiles.length,
          segmentDurations: segmentDurations,
          totalDuration: segmentDurations.reduce((a, b) => a + b, 0),
          video: { width: COVER_OUTPUT.width, height: COVER_OUTPUT.height },
          timestamp: Date.now()
        };
        fs.writeFileSync(getSegmentInfoPath(songId), JSON.stringify(info));
        
        // 更新内存缓存
        songSegmentInfo.set(String(songId), info);
        
        if (LOG_VERBOSE) console.log(`[分片缓存] 完成: ${songId}, ${segmentFiles.length}个分片`);
        resolve(info);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * 后台自动预加载函数（不阻塞响应）
 * @param {Array} songs - 歌曲列表
 * @param {string} cookie - 用户cookie
 * @param {string} coverUrl - 封面URL
 * @param {string} playlistId - 歌单ID（用于防重复）
 */
async function autoPreloadInBackground(songs, cookie, coverUrl, playlistId) {
  // 防止同一歌单重复预加载
  const preloadKey = `${playlistId}_${songs[0]?.id}`;
  if (preloadingPlaylists.has(preloadKey)) {
    return;
  }
  preloadingPlaylists.add(preloadKey);
  
  const toPreload = songs.slice(0, CACHE_CONFIG.autoPreloadCount);
  console.log(`[自动预加载] 开始预加载 ${toPreload.length} 首歌`);
  
  // 逐个预加载（避免同时占用太多资源）
  for (const song of toPreload) {
    // 跳过已缓存的
    if (isSongCached(song.id)) {
      continue;
    }
    
    // 跳过正在生成的
    if (generatingLocks.has(String(song.id))) {
      continue;
    }
    
    try {
      const audioUrl = await netease.getSongUrl(song.id, cookie);
      if (!audioUrl) {
        console.log(`[自动预加载] 跳过 ${song.id}：无法获取URL`);
        continue;
      }
      
      // 创建生成锁
      const perSongCover = pickCoverUrlForSong(song, coverUrl);
      const generatePromise = generateSongSegments(song.id, audioUrl, perSongCover, song.duration);
      // 标记创建时间，便于后台清理异常遗留的锁
      generatePromise._createdAt = Date.now();
      generatingLocks.set(String(song.id), generatePromise);
      
      await generatePromise;
      generatingLocks.delete(String(song.id));
      
      console.log(`[自动预加载] 完成: ${song.name}`);
    } catch (e) {
      generatingLocks.delete(String(song.id));
      console.error(`[自动预加载] 失败 ${song.id}:`, e.message);
    }
  }
  
  preloadingPlaylists.delete(preloadKey);
  console.log(`[自动预加载] 全部完成`);
}

/**
 * 边播边缓存：预加载当前歌曲后面的几首
 * @param {string} playlistId - 歌单ID
 * @param {string} currentSongId - 当前播放的歌曲ID
 * @param {string} cookie - 用户cookie
 */
async function preloadNextSongs(playlistId, currentSongId, cookie) {
  try {
    // 获取歌单
    const cached = playlistOps.get.get(playlistId);
    if (!cached) return;
    
    let songs;
    try {
      songs = JSON.parse(cached.songs);
    } catch (parseErr) {
      console.error(`[边播边缓存] 歌单缓存损坏 ${playlistId}:`, parseErr.message);
      // 清理损坏的缓存
      try { playlistOps.clearExpired.run(); } catch (_) {}
      return;
    }
    if (!Array.isArray(songs)) return;
    
    const coverUrl = cached.cover || DEFAULT_COVER_URL;
    
    // 找到当前歌曲的位置
    const currentIndex = songs.findIndex(s => String(s.id) === String(currentSongId));
    if (currentIndex === -1) return;
    
    // 获取后面的2首歌（减少预加载数量，因为现在每首歌要生成多个segment）
    const nextSongs = songs.slice(currentIndex + 1, currentIndex + 3);
    if (nextSongs.length === 0) return;
    
    // 防止重复预加载
    const preloadKey = `next_${currentSongId}`;
    if (preloadingPlaylists.has(preloadKey)) return;
    preloadingPlaylists.add(preloadKey);
    
    if (LOG_VERBOSE) console.log(`[边播边缓存] 预加载接下来 ${nextSongs.length} 首`);
    
    for (const song of nextSongs) {
      if (isSongCached(song.id) || generatingLocks.has(String(song.id))) {
        continue;
      }
      
      try {
        const audioUrl = await netease.getSongUrl(song.id, cookie);
        if (!audioUrl) continue;
        
        const perSongCover = pickCoverUrlForSong(song, coverUrl);
        const generatePromise = generateSongSegments(song.id, audioUrl, perSongCover, song.duration);
        // 标记创建时间，便于后台清理异常遗留的锁
        generatePromise._createdAt = Date.now();
        generatingLocks.set(String(song.id), generatePromise);
        
        await generatePromise;
        generatingLocks.delete(String(song.id));
        
        if (LOG_VERBOSE) console.log(`[边播边缓存] 完成: ${song.name}`);
      } catch (e) {
        generatingLocks.delete(String(song.id));
      }
    }
    
    preloadingPlaylists.delete(preloadKey);
  } catch (e) {
    console.error('[边播边缓存] 错误:', e.message);
  }
}

// 下载文件到临时目录（带超时、大小限制、重定向限制、SSRF 防护）
function downloadFile(url, filePath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    // 检查重定向次数
    if (redirectCount >= JOB_LIMITS.downloadMaxRedirects) {
      return reject(new Error('Too many redirects'));
    }
    
    // SSRF 防护：校验 URL 协议和 host
    const urlCheck = isDownloadUrlAllowed(url);
    if (!urlCheck.allowed) {
      return reject(new Error(`Download blocked: ${urlCheck.reason}`));
    }
    
    const protocol = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/'
      },
      timeout: JOB_LIMITS.downloadTimeout
    };
    
    const file = fs.createWriteStream(filePath);
    let downloadedSize = 0;
    let aborted = false;
    
    const req = protocol.get(url, options, (response) => {
      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume(); // 丢弃响应体，避免泄漏
        file.close();
        fs.unlink(filePath, () => {});
        
        // 重定向目标也需要校验
        const redirectLocation = response.headers.location;
        if (!redirectLocation) {
          return reject(new Error('Redirect without location'));
        }

        let redirectUrl = '';
        try {
          redirectUrl = new URL(redirectLocation, url).toString();
        } catch (_) {
          return reject(new Error('Redirect with invalid location'));
        }

        const redirectCheck = isDownloadUrlAllowed(redirectUrl);
        if (!redirectCheck.allowed) {
          return reject(new Error(`Redirect blocked: ${redirectCheck.reason}`));
        }
        
        return downloadFile(redirectUrl, filePath, redirectCount + 1).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(filePath, () => {});
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      
      // 检查 Content-Length（如果提供）
      const contentLength = parseInt(response.headers['content-length']);
      if (contentLength && contentLength > JOB_LIMITS.downloadMaxSize) {
        req.destroy();
        file.close();
        fs.unlink(filePath, () => {});
        return reject(new Error(`File too large: ${contentLength} bytes`));
      }
      
      // 监控下载大小
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (downloadedSize > JOB_LIMITS.downloadMaxSize) {
          aborted = true;
          req.destroy();
          file.close();
          fs.unlink(filePath, () => {});
          reject(new Error(`Download exceeded max size: ${downloadedSize} bytes`));
        }
      });
      
      response.pipe(file);
      file.on('finish', () => {
        if (!aborted) {
          file.close();
          resolve(filePath);
        }
      });
    });
    
    // 超时处理
    req.on('timeout', () => {
      req.destroy();
      file.close();
      fs.unlink(filePath, () => {});
      reject(new Error('Download timeout'));
    });
    
    req.on('error', (err) => {
      file.close();
      fs.unlink(filePath, () => {});
      reject(err);
    });
  });
}

/**
 * 获取正确的 baseUrl（支持反向代理环境）
 * 优先级：环境变量 BASE_URL > Express 默认处理（依赖 TRUST_PROXY）
 * 
 * 注意：不再直接信任 X-Forwarded-Host，避免客户端伪造导致 URL 注入。
 * 反向代理场景请正确配置 TRUST_PROXY（如 1/2/loopback）并设置 BASE_URL。
 */
function getBaseUrl(req) {
  // 1. 优先使用环境变量中配置的 BASE_URL（最可靠）
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, ''); // 移除末尾斜杠
  }
  
  // 2. 使用 Express 默认处理（需要正确配置 TRUST_PROXY 才能识别反代后的 protocol/host）
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * 生成HLS视频流 - 音频+封面
 * 用法: /api/hls/:token/:playlistId/stream.m3u8
 * 
 * 每首歌分成多个10秒的segment，歌曲之间使用DISCONTINUITY标记
 */
router.get('/:token/:playlistId/stream.m3u8', async (req, res) => {
  const { token, playlistId } = req.params;
  const startIndex = parseInt(req.query.start) || 0;
  
  // 参数校验
  if (!isValidToken(token)) {
    return res.status(400).send('#EXTM3U\n#EXT-X-ERROR:Invalid token format');
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).send('#EXTM3U\n#EXT-X-ERROR:Invalid playlist ID');
  }
  
  // 验证用户
  const user = userOps.getByToken.get(token);
  if (!user) {
    return res.status(401).send('#EXTM3U\n#EXT-X-ERROR:Invalid token');
  }
  
  const cookie = decrypt(user.cookie);
  
  // 获取歌单
  let songs, playlistCover;
  const cached = playlistOps.get.get(playlistId);
  
  if (cached) {
    // 解析缓存的歌曲列表（加容错）
    let cacheParseOk = true;
    try {
      songs = JSON.parse(cached.songs);
      if (!Array.isArray(songs)) {
        throw new Error('songs is not an array');
      }
    } catch (parseErr) {
      console.error(`[HLS] 歌单缓存损坏 ${playlistId}:`, parseErr.message);
      cacheParseOk = false;
    }
    
    if (!cacheParseOk) {
      // 缓存损坏，尝试刷新
      try {
        const playlist = await netease.getPlaylistDetail(playlistId, cookie);
        songs = playlist.tracks;
        playlistCover = playlist.cover;
      } catch (refreshErr) {
        return res.status(500).send('#EXTM3U\n#EXT-X-ERROR:Cache corrupted and refresh failed');
      }
    } else {
      playlistCover = cached.cover;
    }
    // 旧缓存可能缺少单曲封面字段：强制刷新一次，保证“切歌切封面”
    const hasCover = Array.isArray(songs) && songs.some(s => s && s.cover);
    if (!hasCover) {
      try {
        const playlist = await netease.getPlaylistDetail(playlistId, cookie);
        songs = playlist.tracks;
        playlistCover = playlist.cover;
      } catch (_) {
        // 刷新失败则继续用旧缓存（封面退化为歌单封面）
      }
    }
  } else {
    try {
      const playlist = await netease.getPlaylistDetail(playlistId, cookie);
      songs = playlist.tracks;
      playlistCover = playlist.cover;
    } catch (e) {
      return res.status(500).send('#EXTM3U\n#EXT-X-ERROR:Failed to get playlist');
    }
  }
  
  songs = songs.slice(startIndex);
  
  if (songs.length === 0) {
    return res.status(404).send('#EXTM3U\n#EXT-X-ERROR:Empty playlist');
  }
  
  const baseUrl = getBaseUrl(req);
  const segmentDuration = CACHE_CONFIG.segmentDuration;
  
  // 生成M3U8播放列表
  let m3u8 = '#EXTM3U\n';
  m3u8 += '#EXT-X-VERSION:3\n';
  m3u8 += `#EXT-X-TARGETDURATION:${segmentDuration + 1}\n`; // 比segment稍大一点
  m3u8 += '#EXT-X-PLAYLIST-TYPE:VOD\n';
  m3u8 += '#EXT-X-MEDIA-SEQUENCE:0\n';
  m3u8 += '#EXT-X-ALLOW-CACHE:YES\n';
  
  // 为每首歌生成segment条目
  for (let songIndex = 0; songIndex < songs.length; songIndex++) {
    const song = songs[songIndex];
    const songId = song.id;
    const songDuration = song.duration || 240;
    
    // 获取歌曲的segment信息（如果已缓存）
    let segmentInfo = getSongSegmentInfo(songId);
    
    if (segmentInfo && segmentInfo.segmentDurations) {
      // 使用实际的segment信息
      if (songIndex > 0) {
        m3u8 += '#EXT-X-DISCONTINUITY\n'; // 歌曲之间的分界标记
      }
      m3u8 += `#EXT-X-PROGRAM-DATE-TIME:${new Date().toISOString()}\n`;
      
      for (let segIndex = 0; segIndex < segmentInfo.segmentCount; segIndex++) {
        const segDuration = segmentInfo.segmentDurations[segIndex] || segmentDuration;
        m3u8 += `#EXTINF:${segDuration.toFixed(6)},\n`;
        m3u8 += `${baseUrl}/api/hls/${token}/${playlistId}/seg/${songId}/${segIndex}.ts\n`;
      }
    } else {
      // 歌曲未缓存，生成预估的segment条目
      if (songIndex > 0) {
        m3u8 += '#EXT-X-DISCONTINUITY\n';
      }
      
      const estimatedSegments = Math.ceil(songDuration / segmentDuration);
      for (let segIndex = 0; segIndex < estimatedSegments; segIndex++) {
        // 最后一个segment可能较短
        const isLastSeg = segIndex === estimatedSegments - 1;
        const segDur = isLastSeg 
          ? (songDuration % segmentDuration) || segmentDuration 
          : segmentDuration;
        m3u8 += `#EXTINF:${segDur.toFixed(6)},\n`;
        m3u8 += `${baseUrl}/api/hls/${token}/${playlistId}/seg/${songId}/${segIndex}.ts\n`;
      }
    }
  }
  
  m3u8 += '#EXT-X-ENDLIST\n';
  
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache'); // m3u8不缓存，segment可能会更新
  res.send(m3u8);
  
  // 触发后台自动预加载（不阻塞响应）
  const coverUrl = playlistCover || DEFAULT_COVER_URL;
  setImmediate(() => {
    autoPreloadInBackground(songs, cookie, coverUrl, playlistId).catch(e => {
      console.error('[自动预加载] 错误:', e.message);
    });
  });
});

/**
 * 获取歌曲的特定segment
 * 路径: /api/hls/:token/:playlistId/seg/:songId/:segmentIndex.ts
 */
router.get('/:token/:playlistId/seg/:songId/:segmentIndex.ts', async (req, res) => {
  const { token, playlistId, songId, segmentIndex } = req.params;
  const segIndex = parseInt(segmentIndex);
  
  // 参数校验
  if (!isValidToken(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).json({ error: 'Invalid playlist ID' });
  }
  if (!isValidNumericId(songId)) {
    return res.status(400).json({ error: 'Invalid song ID' });
  }
  if (!isValidSegmentIndex(segmentIndex)) {
    return res.status(400).json({ error: 'Invalid segment index' });
  }
  
  // 验证用户
  const user = userOps.getByToken.get(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const cookie = decrypt(user.cookie);

  // 记录最近播放：当请求该歌曲第一个分片时，认为开始播放
  if (segIndex === 0) {
    try {
      let songName = '未知';
      let artist = '未知';

      const cached = playlistOps.get.get(playlistId);
      if (cached && cached.songs) {
        try {
          const songs = JSON.parse(cached.songs);
          const song = Array.isArray(songs) ? songs.find(s => String(s?.id) === String(songId)) : null;
          if (song) {
            if (song.name) songName = String(song.name);
            if (song.artist) artist = String(song.artist);
          }
        } catch (_) {}
      }

      playLogOps.log.run({
        user_id: user.id,
        playlist_id: String(playlistId),
        song_id: String(songId),
        song_name: songName,
        artist
      });
    } catch (e) {
      // 不影响播放链路
      console.error('记录播放失败:', e?.message || e);
    }
  }
  
  // 设置响应头
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  
  // 检查segment是否已缓存
  const segmentPath = getSegmentPath(songId, segIndex);
  
  if (isSegmentValid(songId, segIndex)) {
    if (LOG_VERBOSE) console.log(`[分片命中] ${songId}/${segIndex}`);
    const stat = fs.statSync(segmentPath);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(segmentPath);
    stream.pipe(res);
    
    // 如果是第一个segment，触发预加载下一首
    if (segIndex === 0) {
      setImmediate(() => preloadNextSongs(playlistId, songId, cookie));
    }
    return;
  }
  
  // 检查整首歌是否正在生成中
  const lockKey = String(songId);
  if (generatingLocks.has(lockKey)) {
    console.log(`[等待分片生成] ${songId}`);
    try {
      await generatingLocks.get(lockKey);
      // 生成完成后返回segment
      if (isSegmentValid(songId, segIndex)) {
        const stat = fs.statSync(segmentPath);
        res.setHeader('Content-Length', stat.size);
        const stream = fs.createReadStream(segmentPath);
        stream.pipe(res);

        // 如果是第一个segment，触发预加载下一首
        // 注意：这里是“等待后台预加载生成完成”的分支，若不触发将导致只预加载了第一首，
        // 下一首可能在切歌时才开始生成，从而在弱服务器/高延迟场景下大概率断播。
        if (segIndex === 0) {
          setImmediate(() => preloadNextSongs(playlistId, songId, cookie));
        }
        return;
      }
    } catch (e) {
      // 生成失败
    }
  }
  
  try {
    // 需要生成整首歌的segments
    const audioUrl = await netease.getSongUrl(songId, cookie);
    if (!audioUrl) {
      return res.status(404).json({ error: 'Cannot get song URL' });
    }
    
    let coverUrl = DEFAULT_COVER_URL;
    const cached = playlistOps.get.get(playlistId);
    if (cached) {
      if (cached.cover) coverUrl = cached.cover;
      // 优先使用歌曲自己的封面（如果歌单缓存里有）
      try {
        const songs = JSON.parse(cached.songs || '[]');
        const song = Array.isArray(songs) ? songs.find(s => String(s?.id) === String(songId)) : null;
        if (song && song.cover) coverUrl = song.cover;
      } catch (_) {}
    }
    
    if (LOG_VERBOSE) console.log(`[分片未命中] 生成歌曲所有分片: ${songId}`);
    
    // 生成整首歌的segments
    const perSongCover = pickCoverUrlForSong({ id: songId, cover: coverUrl }, coverUrl);
    const generatePromise = generateSongSegments(songId, audioUrl, perSongCover);
    // 标记创建时间，便于后台清理异常遗留的锁
    generatePromise._createdAt = Date.now();
    generatingLocks.set(lockKey, generatePromise);
    
    try {
      await generatePromise;
      generatingLocks.delete(lockKey);
      
      // 返回请求的segment
      if (isSegmentValid(songId, segIndex)) {
        const stat = fs.statSync(segmentPath);
        res.setHeader('Content-Length', stat.size);
        const stream = fs.createReadStream(segmentPath);
        stream.pipe(res);
        
        if (segIndex === 0) {
          setImmediate(() => preloadNextSongs(playlistId, songId, cookie));
        }
      } else {
        throw new Error(`Segment ${segIndex} not found after generation`);
      }
    } catch (e) {
      generatingLocks.delete(lockKey);
      throw e;
    }
    
  } catch (e) {
    console.error('Segment error:', e);
    if (!res.headersSent) {
      // 如果是服务繁忙（队列满），返回 503
      if (e.message === '服务繁忙，请稍后重试') {
        res.status(503).json({ 
          error: e.message, 
          retryAfter: 10,
          queueInfo: {
            running: jobSemaphore.running,
            waiting: jobSemaphore.waiting,
            maxConcurrent: JOB_LIMITS.maxConcurrentJobs
          }
        });
      } else {
        res.status(500).json({ error: e.message });
      }
    }
  }
});

/**
 * [兼容旧版] 获取单首歌的完整TS - 重定向到第一个segment
 */
router.get('/:token/:playlistId/song/:songId.ts', (req, res) => {
  const { token, playlistId, songId } = req.params;
  
  // 参数校验
  if (!isValidToken(token) || !isValidNumericId(playlistId) || !isValidNumericId(songId)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  
  // 重定向到新的segment格式
  res.redirect(`/api/hls/${token}/${playlistId}/seg/${songId}/0.ts`);
});

/**
 * 预加载API - 提前生成指定歌曲或歌单的缓存
 * POST /api/hls/:token/:playlistId/preload
 * Body: { count: 5 } 预加载前N首歌
 */
router.post('/:token/:playlistId/preload', async (req, res) => {
  const { token, playlistId } = req.params;
  const count = Math.min(parseInt(req.body.count) || 5, 20); // 最多预加载20首
  
  // 参数校验
  if (!isValidToken(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).json({ error: 'Invalid playlist ID' });
  }
  
  const user = userOps.getByToken.get(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const cookie = decrypt(user.cookie);
  
  try {
    // 获取歌单
    let songs;
    const cached = playlistOps.get.get(playlistId);
    
    if (cached) {
      let cacheParseOk = true;
      try {
        songs = JSON.parse(cached.songs);
        if (!Array.isArray(songs)) {
          throw new Error('songs is not an array');
        }
      } catch (parseErr) {
        console.error(`[预加载] 歌单缓存损坏 ${playlistId}:`, parseErr.message);
        cacheParseOk = false;
      }
      
      if (!cacheParseOk) {
        // 缓存损坏，重新获取
        const playlist = await netease.getPlaylistDetail(playlistId, cookie);
        songs = playlist.tracks;
      } else {
        // 旧缓存缺少单曲封面时，刷新一次（否则预加载也会用歌单封面）
        const hasCover = Array.isArray(songs) && songs.some(s => s && s.cover);
        if (!hasCover) {
          try {
            const playlist = await netease.getPlaylistDetail(playlistId, cookie);
            songs = playlist.tracks;
          } catch (_) {}
        }
      }
    } else {
      const playlist = await netease.getPlaylistDetail(playlistId, cookie);
      songs = playlist.tracks;
    }
    
    const toPreload = songs.slice(0, count);
    const results = [];
    
    // 获取封面
    let coverUrl = (cached && cached.cover) ? cached.cover : DEFAULT_COVER_URL;
    
    if (LOG_VERBOSE) console.log(`[预加载] 开始预加载 ${toPreload.length} 首歌`);
    
    // 逐个预加载（避免同时下载太多）
    for (const song of toPreload) {
      if (isSongCached(song.id)) {
        const info = getSongSegmentInfo(song.id);
        results.push({ id: song.id, name: song.name, status: 'cached', segments: info?.segmentCount || 0 });
        continue;
      }
      
      try {
        const audioUrl = await netease.getSongUrl(song.id, cookie);
        if (!audioUrl) {
          results.push({ id: song.id, name: song.name, status: 'no_url' });
          continue;
        }
        
        const perSongCover = pickCoverUrlForSong(song, coverUrl);
        const info = await generateSongSegments(song.id, audioUrl, perSongCover, song.duration);
        results.push({ id: song.id, name: song.name, status: 'generated', segments: info.segmentCount });
      } catch (e) {
        results.push({ id: song.id, name: song.name, status: 'error', error: e.message });
      }
    }
    
    if (LOG_VERBOSE) console.log(`[预加载] 完成`);
    res.json({ success: true, results });
    
  } catch (e) {
    console.error('预加载错误:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 获取缓存状态
 * GET /api/hls/cache/status
 * 需要管理员密码（X-Admin-Password 请求头）
 */
router.get('/cache/status', adminAuth, (req, res) => {
  try {
    const songDirs = fs.readdirSync(CACHE_DIR);
    let totalSize = 0;
    const cachedSongs = [];
    
    for (const songId of songDirs) {
      const songDir = path.join(CACHE_DIR, songId);
      const stat = fs.statSync(songDir);
      
      if (stat.isDirectory()) {
        const infoPath = path.join(songDir, 'info.json');
        let segmentCount = 0;
        let songSize = 0;
        let age = 0;
        
        if (fs.existsSync(infoPath)) {
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          segmentCount = info.segmentCount || 0;
          age = Math.round((Date.now() - info.timestamp) / 1000 / 60);
        }
        
        // 计算目录大小
        const files = fs.readdirSync(songDir);
        for (const f of files) {
          const fStat = fs.statSync(path.join(songDir, f));
          songSize += fStat.size;
        }
        totalSize += songSize;
        
        cachedSongs.push({
          songId,
          segments: segmentCount,
          size: (songSize / 1024 / 1024).toFixed(2) + ' MB',
          age: age + ' minutes'
        });
      }
    }
    
    res.json({
      // 缓存状态
      cache: {
        totalSongs: cachedSongs.length,
        totalSize: (totalSize / 1024 / 1024).toFixed(2) + ' MB',
        maxSize: (CACHE_CONFIG.maxSize / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      },
      // 任务队列状态
      jobs: {
        running: jobSemaphore.running,
        waiting: jobSemaphore.waiting,
        maxConcurrent: JOB_LIMITS.maxConcurrentJobs,
        maxQueue: JOB_LIMITS.maxQueueSize
      },
      // 配置信息
      config: {
        downloadTimeout: JOB_LIMITS.downloadTimeout + 'ms',
        downloadMaxSize: (JOB_LIMITS.downloadMaxSize / 1024 / 1024).toFixed(2) + ' MB',
        ffmpegTimeout: JOB_LIMITS.ffmpegTimeout + 'ms'
      },
      songs: cachedSongs.slice(0, 50)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 清理缓存
 * DELETE /api/hls/cache
 * 需要管理员密码（X-Admin-Password 请求头）
 */
router.delete('/cache', adminAuth, (req, res) => {
  try {
    const songDirs = fs.readdirSync(CACHE_DIR);
    let deleted = 0;
    
    for (const songId of songDirs) {
      const songDir = path.join(CACHE_DIR, songId);
      const stat = fs.statSync(songDir);
      
      if (stat.isDirectory()) {
        // 递归删除目录
        fs.rmSync(songDir, { recursive: true, force: true });
        deleted++;
      }
    }
    
    // 清理内存缓存
    songSegmentInfo.clear();
    
    res.json({ success: true, deletedSongs: deleted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
