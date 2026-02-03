// Page specific init
document.addEventListener('DOMContentLoaded', () => {
  // Load tabs
  if (typeof switchPersonalTab === 'function') {
    switchPersonalTab('playlists');
  }
});
// No more scroll listener needed for pagination
