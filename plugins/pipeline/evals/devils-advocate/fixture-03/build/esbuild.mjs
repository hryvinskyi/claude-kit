import { build } from 'esbuild';

// Entry points are explicit: a storefront TypeScript file is compiled only when it is listed here,
// and the fileId that names its output (Vendor_Module::js/<name>.js) renders nothing until then.
const entryPoints = [
  {
    in: 'app/code/Acme/Base/view/frontend/web/ts/cookie-notice.ts',
    out: 'app/code/Acme/Base/view/frontend/web/js/cookie-notice',
  },
  {
    in: 'app/code/Acme/Catalog/view/frontend/web/ts/gallery-zoom.ts',
    out: 'app/code/Acme/Catalog/view/frontend/web/js/gallery-zoom',
  },
];

await build({
  entryPoints,
  outdir: '.',
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  sourcemap: false,
});
