// A paint hint only; IndexedDB remains the authoritative preference.
try {
  const theme = localStorage.getItem('mono-theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#000000' : '#ffffff';
  if (theme === 'dark') document.querySelector('link[rel="manifest"]').setAttribute('href', '/manifest-dark.webmanifest');
} catch { /* The default light theme does not depend on this optional hint. */ }
