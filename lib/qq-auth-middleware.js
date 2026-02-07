const { qqUserOps } = require('./db');

function qqAuth(req, res, next) {
  const token = req.headers['x-qq-token'] || req.query.qqtoken;
  if (!token) {
    return res.status(401).json({ success: false, message: '请先登录QQ音乐' });
  }

  const user = qqUserOps.getByToken.get(token);
  if (!user) {
    return res.status(401).json({ success: false, message: 'QQ音乐登录已过期' });
  }

  req.qqUser = user;
  req.qqToken = token;
  next();
}

module.exports = {
  qqAuth
};
