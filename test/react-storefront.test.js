import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const reactPackage = JSON.parse(read('storefront-react/package.json'));
const originConfig = JSON.parse(read('storefront-react/components.json'));

test('публичная React-витрина имеет изолированный Vite build и не добавляет пакеты в backend', () => {
  assert.equal(reactPackage.dependencies.react, '19.3.1');
  assert.equal(reactPackage.dependencies['react-dom'], '19.3.1');
  assert.equal(reactPackage.devDependencies.vite, '8.3.8');
  assert.equal(reactPackage.scripts.build, 'vite build');
  assert.deepEqual(Object.keys(JSON.parse(read('package.json')).dependencies || {}).sort(), ["imapflow", "mailparser"]);
  assert.match(read('storefront-react/vite.config.js'), /\.\.\/public\/react-app/);
  assert.match(read('storefront-react/vite.config.js'), /vapelab-storefront\.js/);
  assert.match(read('storefront-react/vite.config.js'), /base: command === 'serve' \? '\/' : '\/react-app\/'/);
});

test('OriginKit настроен под Vite, React и обычный CSS без секретов в конфигурации', () => {
  assert.equal(originConfig.stack, 'vite');
  assert.equal(originConfig.styling, 'css');
  assert.equal(originConfig.typescript, false);
  assert.equal(originConfig.componentsDir, 'src/components/originkit');
  assert.doesNotMatch(JSON.stringify(originConfig), /api[_-]?key|token|secret/i);
  assert.match(reactPackage.scripts['originkit:hero58'], /originkit@latest add hero-58/);
});

test('React Bits подключается через официальный локальный registry, а до установки работает независимый fallback', () => {
  const adapter = read('storefront-react/src/components/SpotlightAdapter.js');
  const fallback = read('storefront-react/src/components/VapelabGlowCard.js');
  const css = read('storefront-react/src/components/VapelabGlowCard.css');
  const installScript = read('storefront-react/scripts/install-reactbits.ps1');
  const registryConfig = JSON.parse(read('storefront-react/components.reactbits.json'));

  assert.match(adapter, /import\.meta\.glob/);
  assert.match(adapter, /spotlight\[-_\]\?card/i);
  assert.match(adapter, /VapelabGlowCard/);
  assert.match(fallback, /useRef/);
  assert.match(fallback, /onPointerMove/);
  assert.match(fallback, /--vapelab-glow-x/);
  assert.match(fallback, /--vapelab-glow-y/);
  assert.doesNotMatch(fallback, /onFocusCapture: setPointer/);
  assert.match(css, /radial-gradient/);
  assert.match(css, /prefers-reduced-motion/);
  assert.equal(registryConfig.registries['@react-bits'], 'https://reactbits.dev/r/{name}.json');
  const jsconfig = JSON.parse(read('storefront-react/jsconfig.json'));
  assert.deepEqual(jsconfig.compilerOptions.paths['@/*'], ['./src/*']);
  assert.match(installScript, /@react-bits\/SpotlightCard-JS-CSS/);
  assert.match(installScript, /finally[\s\S]*WriteAllText/);
  assert.equal(fs.existsSync(path.join(root, 'storefront-react/src/components/SpotlightCard.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'storefront-react/src/components/SpotlightCard.css')), false);
});

test('OriginKit Hero 58 устанавливается только авторизованным CLI и не маскируется под локальный оригинал', () => {
  const installScript = read('storefront-react/scripts/install-originkit-hero58.ps1');
  const inspectScript = read('storefront-react/scripts/inspect-originkit.mjs');
  const guide = read('storefront-react/VISUAL-COMPONENTS-SETUP.md');
  assert.match(installScript, /originkit@latest login/);
  assert.match(installScript, /originkit@latest add hero-58/);
  assert.match(inspectScript, /Gauze/);
  assert.match(guide, /не хранится в этом передаваемом ZIP/i);
});

test('React home использует лёгкий API, загрузку и ссылку на полный каталог', () => {
  const source = read('storefront-react/src/main.js');
  assert.match(source, /fetch\('\/api\/store\/navigation'/);
  assert.match(source, /AbortController/);
  assert.match(source, /skeleton/);
  assert.match(source, /catalog\/categories/);
  assert.match(source, /rel: 'noopener noreferrer'/);
  assert.match(source, /prefers-reduced-motion/);
});

test('публичные HTML-шаблоны больше не загружают React с esm.sh', () => {
  const home = read('public/storefront.html');
  const pages = read('server/public-pages.js');
  assert.doesNotMatch(home, /esm\.sh|importmap|react-dom\/client/);
  assert.doesNotMatch(pages, /esm\.sh|importmap|react-dom\/client/);
  assert.doesNotMatch(pages, /reactAssetTags|react-app\/assets\/vapelab-storefront/);
  assert.match(pages, /spotlight-fallback\.js/);
});

test('главная отдаёт собранный React index только после его фактической сборки', () => {
  const server = read('server/index.js');
  assert.match(server, /reactEntry/);
  assert.match(server, /fs\.existsSync\(reactEntry\)/);
  assert.match(server, /fallbackEntry/);
});

test('Hero 58 использует локальный OriginKit export при установке и fallback до неё', () => {
  const hero = read('public/hero-58-visual.js');
  const adapter = read('storefront-react/src/components/OriginKitHeroAdapter.js');
  const main = read('storefront-react/src/main.js');
  assert.match(hero, /inspired by/);
  assert.match(hero, /not the downloaded OriginKit source component/i);
  assert.match(adapter, /import\.meta\.glob/);
  assert.match(adapter, /hero\[-_\]\?58/i);
  assert.match(adapter, /OriginKitHero/);
  assert.match(adapter, /fallback/);
  assert.match(main, /OriginKitHeroAdapter/);
  const guide = read('storefront-react/ORIGINKIT-HERO58.md');
  assert.match(guide, /npx originkit@latest add hero-58/);
  assert.match(guide, /Vite/);
});


test('dev proxy покрывает реальные вложенные slug и брендовый favicon', () => {
  const config = read('storefront-react/vite.config.js');
  for (const slug of ['stiki-terea-dlya-iqos-iluma', 'parovye-kamni-dlya-kalyana', 'energetiki-swonq-450ml', 'armyanskie-sigarety', 'sigarilly-aristocrat-blok-10', 'favicon.svg']) {
    assert.ok(config.includes(`'/${slug}'`), `Отсутствует proxy для /${slug}`);
  }
});

test('новая главная не использует технические номера как декоративные подписи категорий и направлений', () => {
  const source = read('storefront-react/src/main.js');
  assert.doesNotMatch(source, /category-card-index|direction-index/);
  assert.doesNotMatch(source, /ASSORTMENT/i);
});
