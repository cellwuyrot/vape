import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendTarget = process.env.VAPELAB_BACKEND_URL || 'http://127.0.0.1:3000';

export default defineConfig(({ command }) => ({
  root: here,
  // Dev starts at /; production assets are served beneath /react-app/.
  base: command === 'serve' ? '/' : '/react-app/',
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(here, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backendTarget, changeOrigin: true },
      '/assets': { target: backendTarget, changeOrigin: true },
      '/crm': { target: backendTarget, changeOrigin: true },
      '/tabak': { target: backendTarget, changeOrigin: true },
      '/stiki': { target: backendTarget, changeOrigin: true },
      '/nagrevateli-tabaka': { target: backendTarget, changeOrigin: true },
      '/odnorazki': { target: backendTarget, changeOrigin: true },
      '/zhidkosti': { target: backendTarget, changeOrigin: true },
      '/kartridzhi': { target: backendTarget, changeOrigin: true },
      '/kalyany': { target: backendTarget, changeOrigin: true },
      '/sigarety': { target: backendTarget, changeOrigin: true },
      '/sigarilly': { target: backendTarget, changeOrigin: true },
      '/napitki': { target: backendTarget, changeOrigin: true },
      '/nikotinovaya-zhvachka': { target: backendTarget, changeOrigin: true },
      '/toplivo-dlya-zazhigalok': { target: backendTarget, changeOrigin: true },
      '/energeticheskie-pauchi': { target: backendTarget, changeOrigin: true },
      '/makhorka': { target: backendTarget, changeOrigin: true },
      '/tabak-dlya-kalyana': { target: backendTarget, changeOrigin: true },
      '/stiki-terea-dlya-iqos-iluma': { target: backendTarget, changeOrigin: true },
      '/parovye-kamni-dlya-kalyana': { target: backendTarget, changeOrigin: true },
      '/energetiki-swonq-450ml': { target: backendTarget, changeOrigin: true },
      '/armyanskie-sigarety': { target: backendTarget, changeOrigin: true },
      '/sigarilly-aristocrat-blok-10': { target: backendTarget, changeOrigin: true },
      '/stiki-dlya-nagrevateley-tabaka': { target: backendTarget, changeOrigin: true },
      '/pod-sistemy-na-predzapravlennyh-kartridzhah': { target: backendTarget, changeOrigin: true },
      '/pod-sistemy-na-zapravlyaemyh-kartridzhah': { target: backendTarget, changeOrigin: true },
      '/predzapravlennye-kartridzhi-dlya-pod-sistem': { target: backendTarget, changeOrigin: true },
      '/zapravlyaemye-kartridzhi-dlya-pod-sistem': { target: backendTarget, changeOrigin: true },
      '/zhidkosti-dlya-veypa-bez-nikotina': { target: backendTarget, changeOrigin: true },
      '/zhidkosti-na-solevom-nikotine': { target: backendTarget, changeOrigin: true },
      '/kalyany-i-aksessuary': { target: backendTarget, changeOrigin: true },
      '/trubochnyy-tabak': { target: backendTarget, changeOrigin: true },
      '/mahorka': { target: backendTarget, changeOrigin: true },
      '/favicon.svg': { target: backendTarget, changeOrigin: true },
      '/page': { target: backendTarget, changeOrigin: true },
      '/hero-58-visual.js': { target: backendTarget, changeOrigin: true },
      '/site-navigation.js': { target: backendTarget, changeOrigin: true },
      '/fonts.css': { target: backendTarget, changeOrigin: true },
      '/robots.txt': { target: backendTarget, changeOrigin: true },
      '/sitemap.xml': { target: backendTarget, changeOrigin: true },
      '/product': { target: backendTarget, changeOrigin: true },
      '/news': { target: backendTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(here, '../public/react-app'),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/vapelab-storefront.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (asset) => String(asset.name || '').endsWith('.css')
          ? 'assets/vapelab-storefront.css'
          : 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
