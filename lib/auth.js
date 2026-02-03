const { userOps } = require('./db');

/**
 * 认证中间件
 * 验证请求头或查询参数中的 token，并将用户信息附加到 req 对象
 */
function auth(req, res, next) {
  const token = req.headers['x-token'] || req.query.token;
  
  if (!token) {
    return res.status(401).json({ success: false, message: '请先登录' });
  }
  
  const user = userOps.getByToken.get(token);
  if (!user) {
    return res.status(401).json({ success: false, message: '登录已过期' });
  }
  
  req.user = user;
  req.token = token;
  next();
}

module.exports = { auth };
