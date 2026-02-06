(function initToastModule(globalObj) {
  function shouldDisplayToast(message) {
    if (message == null) return false;
    return String(message).trim().length > 0;
  }

  globalObj.shouldDisplayToast = shouldDisplayToast;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { shouldDisplayToast };
  }
})(typeof window !== 'undefined' ? window : globalThis);
