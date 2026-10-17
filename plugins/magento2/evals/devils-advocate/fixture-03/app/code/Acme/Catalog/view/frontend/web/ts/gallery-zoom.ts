import { int, jsonAttribute } from '../../../../../Base/view/frontend/web/ts/parse.ts';

function mount(root: HTMLElement): void {
  const config = jsonAttribute(root, 'data-config');
  const scale = int(config.scalePercent, 'scalePercent') / 100;
  const controller = new AbortController();
  root.addEventListener('pointermove', (event) => {
    const box = root.getBoundingClientRect();
    root.style.setProperty('--zoom-x', `${((event.clientX - box.left) / box.width) * 100}%`);
    root.style.setProperty('--zoom-y', `${((event.clientY - box.top) / box.height) * 100}%`);
    root.style.setProperty('--zoom-scale', String(scale));
  }, { signal: controller.signal });
  root.addEventListener('pointerleave', () => root.style.removeProperty('--zoom-scale'), { signal: controller.signal });
}

function start(): void {
  document.querySelectorAll<HTMLElement>('[data-gallery-zoom]').forEach(mount);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
