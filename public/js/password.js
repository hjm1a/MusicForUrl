// 初始化主题
(function() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

function handleSubmit(e) {
  e.preventDefault();
  
  const password = document.getElementById('passwordInput').value;
  const errorMessage = document.getElementById('errorMessage');
  
  if (!password) {
    errorMessage.textContent = '请输入密码';
    errorMessage.classList.add('show');
    return false;
  }
  
  // 保存密码到 sessionStorage
  sessionStorage.setItem('sitePassword', password);
  
  // 重新请求当前页面，带上密码
  const currentPath = window.location.pathname + window.location.search;
  
  fetch(currentPath, {
    headers: {
      'X-Site-Password': password
    }
  })
  .then(response => {
    if (response.ok) {
      // 密码正确，刷新页面（会通过 interceptor 自动带上密码）
      window.location.reload();
    } else {
      // 密码错误
      errorMessage.textContent = '密码错误，请重试';
      errorMessage.classList.add('show');
      document.getElementById('passwordInput').value = '';
      document.getElementById('passwordInput').focus();
    }
  })
  .catch(() => {
    errorMessage.textContent = '网络错误，请重试';
    errorMessage.classList.add('show');
  });
  
  return false;
}

// 如果已有保存的密码，自动尝试验证
(function() {
  const savedPassword = sessionStorage.getItem('sitePassword');
  if (savedPassword) {
    // 自动添加密码到所有后续请求
    const originalFetch = window.fetch;
    window.fetch = function(url, options = {}) {
      options.headers = options.headers || {};
      options.headers['X-Site-Password'] = savedPassword;
      return originalFetch(url, options);
    };
  }
})();
