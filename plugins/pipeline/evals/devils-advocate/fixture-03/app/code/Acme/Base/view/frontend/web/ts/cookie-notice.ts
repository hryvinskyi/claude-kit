import { jsonAttribute, str } from './parse.ts';

const STORAGE_KEY = 'acme-cookie-notice-dismissed';

function mount(root: HTMLElement): void {
  const config = jsonAttribute(root, 'data-config');
  const dismissLabel = str(config.dismissLabel, 'dismissLabel');
  const button = root.querySelector<HTMLButtonElement>('[data-action="dismiss"]');
  if (button === null) return;
  button.textContent = dismissLabel;
  button.addEventListener('click', () => {
    root.hidden = true;
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      root.dataset.persisted = 'false';
    }
  }, { once: true });
}

function start(): void {
  document.querySelectorAll<HTMLElement>('[data-cookie-notice]').forEach(mount);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
