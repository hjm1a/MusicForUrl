const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldDisplayToast } = require('../public/js/toast');

test('should display error feedback messages', () => {
  assert.equal(shouldDisplayToast('登录失败'), true);
  assert.equal(shouldDisplayToast('获取失败'), true);
});

test('should not display empty messages', () => {
  assert.equal(shouldDisplayToast(''), false);
  assert.equal(shouldDisplayToast('   '), false);
});
