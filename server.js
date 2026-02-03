require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
// db 模块在加载时自动初始化数据库
require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

// 信任代理（用于在 Nginx/Cloudflare 后面正确获取真实 IP）
// express-rate-limit v8 在收到 X-Forwarded-For 但 trust proxy=false 时会抛错（ERR_ERL_UNEXPECTED_X_FORWARDED_FOR）。
// 为避免被任意客户端伪造 X-Forwarded-For，同时兼容“本机 Nginx 反代”场景，这里默认仅信任 loopback。
// 如存在多层反代（Cloudflare + Nginx）/ Docker 网络 / 异机代理，请显式设置 TRUST_PROXY=1/2/3... 或指定代理 IP/子网。
// 不要使用 true（等同“信任所有代理”，存在安全风险，且 express-rate-limit 会拒绝该配置）
const trustProxy = process.env.TRUST_PROXY;
let proxyValue = 'loopback';

if (trustProxy !== undefined && trustProxy !== null && String(trustProxy).trim() !== '') {
  const normalized = String(trustProxy).trim();

  if (normalized === 'false' || normalized === '0') {
    // 注意：将 trust proxy 设置为 false 会导致 express-rate-limit 在收到 X-Forwarded-For 时抛错
    //（ERR_ERL_UNEXPECTED_X_FORWARDED_FOR）。因此这里把 false/0 视为“未配置”，继续使用安全默认值 loopback。
    console.warn(`[WARN] TRUST_PROXY=${normalized} 会触发 express-rate-limit 的 X-Forwarded-For 校验错误，已按安全默认值 trust proxy=loopback 处理；如需正确识别真实 IP，请设置 TRUST_PROXY=1/2/3... 或指定代理 IP/子网。`);
  } else if (normalized === 'true') {
    // 兼容旧配置：TRUST_PROXY=true 在新版本 express-rate-limit 下会报错
    // 默认按“单层反代”处理；如有多层代理请设置为 2/3... 或指定 IP/子网
    proxyValue = 1;
    console.warn('[WARN] TRUST_PROXY=true 不安全且会导致限流报错，已自动改用 TRUST_PROXY=1；请按实际代理层数设置 TRUST_PROXY=1/2/3... 或指定代理 IP/子网。');
  } else if (/^\d+$/.test(normalized)) {
    proxyValue = parseInt(normalized, 10);
  } else {
    proxyValue = normalized;
  }
}

app.set('trust proxy', proxyValue);

// 中间件
app.use(cors());
// 压缩：显著提升服务器上 JS/CSS/HTML 加载速度
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================
// 限流配置
// =====================

// 通用限流（全局，较宽松）
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: parseInt(process.env.RATE_LIMIT_GLOBAL) || 200, // 每分钟最多200次
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '请求过于频繁，请稍后再试' }
});

// 认证接口限流（严格，防止暴力破解）
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: parseInt(process.env.RATE_LIMIT_AUTH) || 10, // 每分钟最多10次
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '登录尝试过于频繁，请稍后再试' }
});

// 歌单解析限流（中等）
const parseLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: parseInt(process.env.RATE_LIMIT_PARSE) || 30, // 每分钟最多30次
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '解析请求过于频繁，请稍后再试' }
});

// HLS stream.m3u8 限流（中等，这个触发歌单解析）
const hlsStreamLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: parseInt(process.env.RATE_LIMIT_HLS_STREAM) || 60, // 每分钟最多60次
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // 跳过 .ts segment 请求（这些已经有并发控制）
    return req.path.endsWith('.ts');
  },
  message: '#EXTM3U\n#EXT-X-ERROR:Rate limit exceeded'
});

// 应用全局限流
app.use('/api/', globalLimiter);

// 健康检查端点（用于 Docker 容器健康检测）
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 可选的站点密码保护
if (process.env.SITE_PASSWORD) {
  const SITE_COOKIE_NAME = 'site_auth';
  const SITE_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7天

  function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader) return out;
    const parts = String(cookieHeader).split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (!k) continue;
      out[k] = decodeURIComponent(v);
    }
    return out;
  }

  function signSiteCookieValue(password) {
    return crypto.createHmac('sha256', password).update('site-auth-v1').digest('hex');
  }

  const expectedCookieValue = signSiteCookieValue(process.env.SITE_PASSWORD);

  function isPublicAssetPath(p) {
    // 允许密码页自身及其依赖静态资源访问（否则密码页会加载失败）
    if (p === '/password.html') return true;
    if (p === '/placeholder.svg' || p === '/favicon.ico') return true;
    if (p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/includes/')) return true;
    return false;
  }

  app.use((req, res, next) => {
    // 允许播放相关的 API（通过 token 验证，不需要站点密码）
    if (req.path.startsWith('/api/playlist/') && req.path.endsWith('.m3u8')) {
      return next();
    }
    if (req.path.startsWith('/api/song/')) {
      return next();
    }
    // 允许 HLS 相关请求（通过 token 验证）
    if (req.path.startsWith('/api/hls/') && !req.path.startsWith('/api/hls/cache')) {
      return next();
    }

    // 允许密码页相关静态资源
    if (isPublicAssetPath(req.path)) {
      return next();
    }

    // 通过 cookie 免重复输入（优先）
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SITE_COOKIE_NAME] && cookies[SITE_COOKIE_NAME] === expectedCookieValue) {
      return next();
    }
    
    // 检查密码
    const provided = req.headers['x-site-password'] || req.query.sitePassword;
    if (provided !== process.env.SITE_PASSWORD) {
      // 前端页面返回密码输入页
      if (req.accepts('html') && !req.path.startsWith('/api/')) {
        return res.sendFile(path.join(__dirname, 'public', 'password.html'));
      }
      return res.status(401).json({ success: false, message: '需要站点密码' });
    }

    // 密码正确：写入 HttpOnly cookie，后续请求无需再带 header/query
    res.cookie(SITE_COOKIE_NAME, expectedCookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SITE_COOKIE_MAX_AGE_MS
    });

    next();
  });
}

// 静态文件（放在站点密码保护之后，确保 HTML 不会绕过密码）
app.use(express.static(path.join(__dirname, 'public')));

// 路由（应用特定限流）
// 认证限流：仅对“可暴力破解”的入口更严格（二维码轮询不应命中该限流）
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/captcha', authLimiter);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/playlist/parse', parseLimiter); // 对 parse 接口单独限流
app.use('/api/playlist', require('./routes/playlist'));

app.use('/api/song', require('./routes/song'));
app.use('/api/img', require('./routes/img'));
app.use('/api/hls', hlsStreamLimiter, require('./routes/hls'));  // HLS视频流（音频+封面）
app.use('/api/favorites', require('./routes/favorite'));
app.use('/api/history', require('./routes/history'));

// API 404 处理（在 SPA 兜底之前）
app.use('/api', (req, res) => {
  res.status(404).json({ 
    success: false, 
    message: '接口不存在',
    path: req.path,
    method: req.method
  });
});

// 前端路由（SPA 兜底，仅非 API 请求）
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ success: false, message: '服务器内部错误' });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║   🎵 网易云歌单 → VRChat 播放链接                      ║
║                                                        ║
║   服务已启动: http://localhost:${PORT}                   ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
