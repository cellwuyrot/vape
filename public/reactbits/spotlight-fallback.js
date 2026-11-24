/**
 * Progressive enhancement fallback for server-rendered spotlight wrappers.
 * The official React Bits component is bundled locally by storefront-react after `npm run setup:storefront`.
 * This fallback keeps product pages readable and adds a lightweight pointer glow before that build exists.
 */
(() => {
  const finePointer = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!finePointer || reducedMotion) return;

  document.querySelectorAll('[data-reactbits-spotlight]').forEach((host) => {
    if (host.dataset.spotlightFallback === '1') return;
    host.dataset.spotlightFallback = '1';
    host.classList.add('card-spotlight', 'rb-spotlight-card', 'has-spotlight-fallback');
    host.addEventListener('pointermove', (event) => {
      const rect = host.getBoundingClientRect();
      host.style.setProperty('--mouse-x', `${event.clientX - rect.left}px`);
      host.style.setProperty('--mouse-y', `${event.clientY - rect.top}px`);
      host.style.setProperty('--spotlight-color', 'rgba(44, 145, 231, .17)');
    }, { passive: true });
  });
})();
