export function applyStoredTheme() {
  const scheme = localStorage.getItem('pf-color-scheme') || 'dark';
  const theme = localStorage.getItem('pf-theme') || 'default';
  const contrast = localStorage.getItem('pf-contrast-mode') || 'default';

  const isDark = scheme === 'dark' || (scheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const root = document.documentElement;
  root.classList.toggle('pf-v6-theme-dark', isDark);
  root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  if (theme === 'felt') root.classList.add('pf-v6-theme-felt');
  if (contrast === 'high-contrast') root.classList.add('pf-v6-theme-high-contrast');
  if (contrast === 'glass') root.classList.add('pf-v6-theme-glass');
}
