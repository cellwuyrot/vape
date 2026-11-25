import React, { createElement as h, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import SpotlightCard from './components/SpotlightAdapter.js';
import OriginKitHeroAdapter from './components/OriginKitHeroAdapter.js';
import './styles.css';

const PRIMARY = [
  { slug: 'tabak', label: 'Табак', group: 'Материалы и расходные категории' },
  { slug: 'stiki', label: 'Стики', group: 'Материалы и расходные категории' },
  { slug: 'nagrevateli-tabaka', label: 'Нагреватели табака', group: 'Устройства и системы' },
  { slug: 'odnorazki', label: 'Одноразовые устройства', group: 'Устройства и системы' },
  { slug: 'pod-sistemy', label: 'POD-системы', group: 'Устройства и системы' },
  { slug: 'zhidkosti', label: 'Жидкости', group: 'Материалы и расходные категории' },
];

const LABELS = {
  'kartridzhi': 'Картриджи',
  'kalyany': 'Кальяны и аксессуары',
  'nikotinovaya-zhvachka': 'Никотиновая жвачка',
  'sigarety': 'Сигареты',
  'sigarilly': 'Сигариллы',
  'napitki': 'Напитки',
  'toplivo-dlya-zazhigalok': 'Топливо для зажигалок',
  'energeticheskie-pauchi': 'Энергетические паучи',
  'makhorka': 'Махорка',
  'tabak-dlya-kalyana': 'Табак для кальяна',
};

const safeUrl = (value) => {
  const raw = String(value || '').trim();
  if (raw.startsWith('/')) return raw;
  try {
    const parsed = new URL(raw);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
};

function getCategoryLinks(categories) {
  const roots = categories.filter((item) => !item.parent_id);
  const bySlug = new Map();
  for (const item of roots) {
    const slug = item.public_slug || item.slug;
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, label: LABELS[slug] || item.name, items: [], featured_product: null });
    const group = bySlug.get(slug);
    group.items.push(item);
    if (!group.featured_product && item.featured_product) group.featured_product = item.featured_product;
  }
  return [...bySlug.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

function useStore() {
  const [state, setState] = useState({ loading: true, error: '', data: { categories: [], news: [], settings: {} } });
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    fetch('/api/store/navigation', { headers: { Accept: 'application/json' }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || `Ошибка загрузки: ${response.status}`);
        return payload.data || payload;
      })
      .then((data) => setState({ loading: false, error: '', data }))
      .catch((error) => {
        if (error.name === 'AbortError') setState({ loading: false, error: 'Сервер долго не отвечает. Основные разделы каталога доступны по прямым ссылкам.', data: { categories: [], news: [], settings: {} } });
        else setState({ loading: false, error: 'Не удалось загрузить публикации и категории. Попробуйте обновить страницу.', data: { categories: [], news: [], settings: {} } });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, []);
  return state;
}

function useReveal() {
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      document.querySelectorAll('[data-reveal]').forEach((node) => node.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -36px 0px' });
    document.querySelectorAll('[data-reveal]:not(.is-visible)').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  });
}

function Header({ settings }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const logo = safeUrl(settings.logo_url) || '/assets/brand/vapelab-logo.webp';
  const nav = [ ['#categories', 'Каталог'], ['#directions', 'Направления'], ['#news', 'Новости'], ['#contacts', 'Контакты'] ];
  return h(React.Fragment, null,
    h('div', { className: 'topline' }, h('div', { className: 'container topline-inner' },
      h('span', null, 'VAPELAB'), h('span', null, settings.header_tagline || 'Каталог и информация о компании'),
      safeUrl(settings.telegram_url) ? h('a', { href: safeUrl(settings.telegram_url), target: '_blank', rel: 'noopener noreferrer' }, 'Telegram ↗') : null
    )),
    h('header', { className: 'site-header' }, h('div', { className: 'container header-inner' },
      h('a', { className: 'brand', href: '/', 'aria-label': 'VAPELAB — главная' },
        h('span', { className: 'brand-mark' }, h('img', { src: logo, alt: 'Логотип VAPELAB', onError: (event) => { const image = event.currentTarget; if (image.dataset.fallback) image.hidden = true; else { image.dataset.fallback = '1'; image.src = '/assets/brand/vapelab-logo.webp'; } } })),
        h('span', { className: 'brand-copy' }, h('strong', null, settings.brand_name || 'VAPELAB'), h('small', null, 'Каталог и информация о компании'))
      ),
      h('nav', { className: 'main-nav', 'aria-label': 'Основная навигация' }, nav.map(([href, label]) => h('a', { href, key: href }, label))),
      h('a', { className: 'login-link', href: '/crm' }, 'Личный кабинет', h('span', { 'aria-hidden': true }, '↗')),
      h('button', { className: `menu-toggle${menuOpen ? ' is-open' : ''}`, type: 'button', onClick: () => setMenuOpen((value) => !value), 'aria-label': menuOpen ? 'Закрыть меню' : 'Открыть меню', 'aria-expanded': menuOpen }, h('span'), h('span'))
    ), menuOpen ? h('nav', { className: 'mobile-nav', 'aria-label': 'Мобильная навигация' }, [...nav, ['/crm', 'Личный кабинет']].map(([href, label]) => h('a', { href, key: href, onClick: () => setMenuOpen(false) }, label))) : null)
  );
}

function HeroFallback({ settings }) {
  useEffect(() => {
    const canvas = document.getElementById('hero-canvas');
    if (!canvas || document.querySelector('script[data-vapelab-hero]')) return undefined;
    const script = document.createElement('script');
    script.src = '/hero-58-visual.js';
    script.defer = true;
    script.dataset.vapelabHero = '1';
    document.body.appendChild(script);
    return () => { script.remove(); };
  }, []);
  return h('section', { className: 'hero', id: 'top' },
    h('canvas', { className: 'hero-canvas', id: 'hero-canvas', 'aria-hidden': 'true' }),
    h('div', { className: 'hero-glow', 'aria-hidden': 'true' }),
    h('div', { className: 'container hero-content' },
      h('div', { className: 'hero-copy' },
        h('p', { className: 'eyebrow hero-eyebrow' }, h('span', { className: 'status-dot' }), settings.hero_eyebrow || 'VAPELAB · ИНФОРМАЦИОННЫЙ КАТАЛОГ'),
        h('h1', { style: { whiteSpace: 'pre-line' } }, settings.hero_title || 'VAPELAB.\nКаталог и информация.'),
        h('p', { className: 'hero-description' }, settings.hero_description || 'Информационная площадка компании: розничное и оптовое направления, категории продукции и материалы о VAPELAB.'),
        h('div', { className: 'hero-actions' },
          h('a', { className: 'button button-light', href: '#categories' }, settings.hero_cta_label || 'Открыть каталог', h('span', { 'aria-hidden': true }, '↘')),
          h('a', { className: 'hero-link', href: '#about' }, 'О компании ↗')
        )
      ),
      h('div', { className: 'hero-mark-wrap', 'aria-label': 'Фирменный знак VAPELAB' },
        h('div', { className: 'hero-mark-orbit', 'aria-hidden': 'true' }),
        h('div', { className: 'hero-logo-disc' }, h('img', { src: safeUrl(settings.logo_url) || '/assets/brand/vapelab-logo.webp', alt: '', onError: (event) => { const image = event.currentTarget; if (image.dataset.fallback) image.hidden = true; else { image.dataset.fallback = '1'; image.src = '/assets/brand/vapelab-logo.webp'; } } })),
        h('div', { className: 'hero-mark-word' }, 'VAPELAB'),
        h('div', { className: 'hero-mark-caption' }, h('span', null, 'РОЗНИЦА'), h('span', null, 'ОПТ'), h('span', null, 'ИНФОРМАЦИЯ'))
      )
    ),
    h('div', { className: 'container hero-bottom' }, h('span', null, 'КАТЕГОРИИ'), h('i', null), h('span', null, 'РОЗНИЧНОЕ НАПРАВЛЕНИЕ'), h('i', null), h('span', null, 'ОПТОВОЕ НАПРАВЛЕНИЕ'), h('a', { href: '#about', 'aria-label': 'Перейти к информации о компании' }, '↓'))
  );
}

function Hero({ settings }) {
  return h(OriginKitHeroAdapter, { settings, fallback: h(HeroFallback, { settings }) });
}

function CategoryCard({ item, compact = false }) {
  const product = item.featured_product || null;
  const image = safeUrl(product?.image_url);
  return h(SpotlightCard, { className: `category-card-spotlight${compact ? ' category-card-spotlight-compact' : ''}`, spotlightColor: 'rgba(23, 213, 201, .16)' },
    h('a', { className: 'category-card', href: `/${encodeURIComponent(item.slug)}`, 'aria-label': product ? `${item.label}: ${product.name}` : item.label },
      image ? h('img', { className: 'category-card-image', src: image, alt: product?.name || '', loading: 'lazy', decoding: 'async' }) : h('span', { className: 'category-card-image-placeholder', 'aria-hidden': true }, String(item.label || 'V').slice(0, 1)),
      h('span', { className: 'category-card-scrim', 'aria-hidden': true }),
      h('span', { className: 'category-card-copy' },
        h('span', { className: 'category-card-title' }, item.label),
        product ? h('span', { className: 'category-card-featured' }, h('strong', {}, product.name), product.brand ? h('small', {}, product.brand) : null, product.price_raw ? h('small', {}, product.price_raw) : null) : h('span', { className: 'category-card-featured category-card-featured-empty' }, 'Каталог VAPELAB'),
      ),
      h('span', { className: 'category-card-arrow', 'aria-hidden': 'true' }, '↗')
    )
  );
}

function Categories({ categories, loading, error, settings }) {
  const groups = useMemo(() => getCategoryLinks(categories), [categories]);
  const groupBySlug = new Map(groups.map((group) => [group.slug, group]));
  const featured = PRIMARY.map((item) => ({ ...item, ...(groupBySlug.get(item.slug) || {}), label: item.label, exists: groupBySlug.has(item.slug) }));
  return h('section', { className: 'categories-section', id: 'categories' },
    h('div', { className: 'container' },
      h('div', { className: 'section-heading categories-heading', 'data-reveal': true },
        h('div', null, h('p', { className: 'eyebrow' }, settings.categories_eyebrow || 'КАТАЛОГ'), h('h2', null, settings.categories_heading || 'Основные категории'), h('p', { className: 'section-intro' }, settings.categories_intro || 'Короткие переходы к самостоятельным разделам каталога.')),
        h('span', { className: 'category-count' }, h('strong', null, String(groups.length || 18)), h('small', null, 'разделов каталога'))
      ),
      loading ? h('div', { className: 'category-grid skeleton-grid', 'aria-label': 'Загрузка категорий' }, Array.from({ length: 6 }, (_, index) => h('div', { className: 'category-skeleton skeleton', key: index }))) :
        h('div', { className: 'category-grid' }, featured.map((item) => h('div', { className: 'category-reveal', 'data-reveal': true, key: item.slug }, h(CategoryCard, { item })))),
      h('a', { className: 'catalog-directory-link', href: '/catalog/categories' }, h('span', null, 'Все категории и подразделы'), h('span', { 'aria-hidden': true }, '↗')),
      error ? h('p', { className: 'load-notice', role: 'status' }, error) : null
    )
  );
}

function About({ settings }) {
  return h('section', { className: 'about-section', id: 'about' },
    h('div', { className: 'container about-grid' },
      h('div', { className: 'about-heading', 'data-reveal': true },
        h('p', { className: 'eyebrow' }, settings.about_eyebrow || 'О КОМПАНИИ'),
        h('h2', { style: { whiteSpace: 'pre-line' } }, settings.about_heading || 'VAPELAB —\nрозница и опт.')
      ),
      h('div', { className: 'about-copy', 'data-reveal': true },
        h('p', { className: 'about-lead' }, settings.about_lead || 'На публичном сайте VAPELAB представлены розничное и оптовое направления, информационный каталог, новости и контактные каналы.'),
        h('p', null, settings.about_text || 'Здесь собраны основные разделы, чтобы посетитель мог перейти к нужной части каталога или получить сведения о компании.'),
        h('a', { className: 'text-link', href: '#contacts' }, 'Контактная информация ↗')
      )
    )
  );
}

function Directions({ settings }) {
  return h('section', { className: 'directions-section', id: 'directions' },
    h('div', { className: 'container' },
      h('div', { className: 'section-heading', 'data-reveal': true }, h('div', null,
        h('p', { className: 'eyebrow' }, settings.directions_eyebrow || 'НАПРАВЛЕНИЯ'),
        h('h2', null, settings.directions_heading || 'Форматы работы VAPELAB'),
        h('p', { className: 'section-intro' }, settings.directions_intro || 'Два самостоятельных раздела с отдельной информацией и контактами.')
      )),
      h('div', { className: 'direction-grid' },
        h(SpotlightCard, { className: 'direction-spotlight', spotlightColor: 'rgba(36,107,222,.14)' },
          h('article', { className: 'direction-card', 'data-reveal': true },
            h('h3', null, settings.retail_heading || 'Розничное направление'),
            h('p', null, settings.retail_description || 'Информационные категории и отдельные карточки каталога VAPELAB.'),
            h('a', { href: '#categories' }, 'Перейти к каталогу ↗')
          )
        ),
        h(SpotlightCard, { className: 'direction-spotlight direction-card-dark', spotlightColor: 'rgba(57,200,234,.18)' },
          h('article', { className: 'direction-card', 'data-reveal': true },
            h('h3', null, settings.wholesale_heading || 'Оптовое направление'),
            h('p', null, settings.wholesale_description || 'Отдельный раздел с информацией о взаимодействии с оптовыми партнёрами.'),
            h('a', { href: '/optovy' }, 'Условия оптового направления ↗')
          )
        )
      )
    )
  );
}

function formatDate(value) {
  if (!value) return 'Дата не указана';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Дата не указана';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function News({ items, loading, settings }) {
  return h('section', { className: 'news-section', id: 'news' },
    h('div', { className: 'container' },
      h('div', { className: 'section-heading news-heading', 'data-reveal': true }, h('div', null, h('p', { className: 'eyebrow' }, settings.news_eyebrow || 'ПУБЛИКАЦИИ'), h('h2', null, settings.news_heading || 'Новости и материалы')),
        null),
      loading ? h('div', { className: 'news-grid' }, Array.from({ length: 3 }, (_, index) => h('div', { className: 'news-skeleton skeleton', key: index }))) :
        items.length ? h('div', { className: 'news-grid' }, items.slice(0, 3).map((item) => {
          const showImage = item.image_url && !Number(item.image_hidden) && !Number(item.is_18_plus);
          return h(SpotlightCard, { className: 'news-spotlight', key: item.id || item.slug }, h('article', { className: 'news-card', 'data-reveal': true },
            showImage ? h('div', { className: 'news-card-image' }, h('img', { src: safeUrl(item.image_url), alt: item.title || '', loading: 'lazy' })) : null,
            h('time', null, formatDate(item.published_at)), h('h3', null, item.title || 'Публикация VAPELAB'), h('p', null, item.excerpt || 'Материал из публичной новостной ленты компании.'),
            h('a', { href: `/news/${encodeURIComponent(item.slug)}` }, 'Открыть публикацию ↗')
          ));
        })) : h('p', { className: 'empty-state' }, 'В публичной выборке публикации не найдены.')
    )
  );
}

function Contacts({ settings }) {
  const phone = String(settings.contact_phone || '').trim();
  const telegram = safeUrl(settings.telegram_url);
  return h('section', { className: 'contacts-section', id: 'contacts' },
    h('div', { className: 'container contacts-inner' },
      h('div', { 'data-reveal': true }, h('p', { className: 'eyebrow' }, settings.contacts_eyebrow || 'КОНТАКТЫ'), h('h2', null, settings.contacts_heading || 'Связаться с VAPELAB'), h('p', null, settings.contacts_description || 'Контактные каналы и общая информация о компании.')),
      h('div', { className: 'contacts-links', 'data-reveal': true },
        phone ? h('a', { href: `tel:${phone.replace(/[^+\d]/g, '')}` }, phone, h('span', null, '↗')) : null,
        telegram ? h('a', { href: telegram, target: '_blank', rel: 'noopener noreferrer' }, 'Telegram', h('span', null, '↗')) : null
      )
    )
  );
}

function Footer({ settings }) {
  return h('footer', { className: 'site-footer' }, h('div', { className: 'container footer-main' },
    h('a', { className: 'footer-brand', href: '/' }, h('span', { className: 'footer-mark' }, h('img', { src: safeUrl(settings.logo_url) || '/assets/brand/vapelab-logo.webp', alt: '', onError: (event) => { const image = event.currentTarget; if (image.dataset.fallback) image.hidden = true; else { image.dataset.fallback = '1'; image.src = '/assets/brand/vapelab-logo.webp'; } } })), h('strong', null, settings.brand_name || 'VAPELAB')),
    h('p', null, settings.footer_description || 'Информационный каталог компании. Сведения и подписи воспроизводят опубликованные материалы и требуют актуальной проверки.'),
    h('nav', { 'aria-label': 'Навигация в подвале' },
      h('a', { href: '/tabak' }, 'Каталог'), h('a', { href: '#about' }, 'О компании'), h('a', { href: '#news' }, 'Новости'),
      h('a', { href: '#contacts' }, 'Контакты'), h('a', { href: '/page/privacy' }, 'Политика конфиденциальности'),
      h('a', { href: '/page/delivery' }, 'Доставка'), h('a', { href: '/optovy' }, 'Оптовое направление'), h('a', { href: '/crm' }, 'Личный кабинет')
    )
  ), h('div', { className: 'container footer-bottom' }, h('span', null, `© ${new Date().getFullYear()} VAPELAB`), h('a', { href: '#top' }, 'Наверх ↑')));
}

const CONTENT_FIELDS = [
  ['hero_eyebrow', 'Надпись над главным заголовком', 'VAPELAB · ИНФОРМАЦИОННЫЙ КАТАЛОГ', false],
  ['hero_title', 'Главный заголовок', 'VAPELAB.\nКаталог и информация.', true],
  ['hero_description', 'Описание главного экрана', 'Информационная площадка компании: розничное и оптовое направления, категории продукции и материалы о VAPELAB.', true],
  ['hero_cta_label', 'Текст кнопки главного экрана', 'Открыть каталог', false],
  ['header_tagline', 'Подпись в верхней полосе', 'Каталог и информация о компании', false],
  ['about_eyebrow', 'Подпись раздела «О компании»', 'О КОМПАНИИ', false],
  ['about_heading', 'Заголовок «О компании»', 'VAPELAB —\nрозница и опт.', true],
  ['about_lead', 'Вводный текст «О компании»', 'На публичном сайте VAPELAB представлены розничное и оптовое направления, информационный каталог, новости и контактные каналы.', true],
  ['about_text', 'Основной текст «О компании»', 'Здесь собраны основные разделы, чтобы посетитель мог перейти к нужной части каталога или получить сведения о компании.', true],
  ['categories_eyebrow', 'Подпись раздела каталога', 'КАТАЛОГ', false],
  ['categories_heading', 'Заголовок категорий', 'Основные категории', false],
  ['categories_intro', 'Описание блока категорий', 'Короткие переходы к самостоятельным разделам каталога.', true],
  ['directions_eyebrow', 'Подпись раздела направлений', 'НАПРАВЛЕНИЯ', false],
  ['directions_heading', 'Заголовок направлений', 'Форматы работы VAPELAB', false],
  ['directions_intro', 'Описание блока направлений', 'Два самостоятельных раздела с отдельной информацией и контактами.', true],
  ['retail_heading', 'Заголовок розничного направления', 'Розничное направление', false],
  ['retail_description', 'Описание розничного направления', 'Информационные категории и отдельные карточки каталога VAPELAB.', true],
  ['wholesale_heading', 'Заголовок оптового направления', 'Оптовое направление', false],
  ['wholesale_description', 'Описание оптового направления', 'Отдельный раздел с информацией о взаимодействии с оптовыми партнёрами.', true],
  ['news_eyebrow', 'Подпись раздела новостей', 'ПУБЛИКАЦИИ', false],
  ['news_heading', 'Заголовок новостей', 'Новости и материалы', false],
  ['contacts_eyebrow', 'Подпись раздела контактов', 'КОНТАКТЫ', false],
  ['contacts_heading', 'Заголовок контактов', 'Связаться с VAPELAB', false],
  ['contacts_description', 'Описание контактов', 'Контактные каналы и общая информация о компании.', true],
  ['footer_description', 'Текст в подвале сайта', 'Информационный каталог компании. Сведения и подписи воспроизводят опубликованные материалы и требуют актуальной проверки.', true],
];

function HomeContentEditor({ settings }) {
  const [role, setRole] = useState('');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const accessToken = localStorage.getItem('rucrm.token');
    if (!accessToken) return undefined;
    const controller = new AbortController();
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = await response.json();
        return payload.data || payload;
      })
      .then((user) => setRole(['superadmin', 'admin'].includes(user?.role) ? user.role : ''))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (!role) return null;
  const begin = () => {
    setDraft(Object.fromEntries(CONTENT_FIELDS.map(([key, , fallback]) => [key, settings[key] ?? fallback])));
    setStatus('');
    setOpen((value) => !value);
  };
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setStatus('');
    try {
      const accessToken = localStorage.getItem('rucrm.token');
      const response = await fetch('/api/store/settings', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(draft),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || 'Не удалось сохранить тексты');
      window.location.reload();
    } catch (error) {
      setStatus(error.message);
      setSaving(false);
    }
  };

  return h('section', { className: 'admin-site-content-editor' },
    h('div', { className: 'admin-site-actions' }, h('button', { type: 'button', className: 'admin-site-edit-button', onClick: begin }, open ? 'Закрыть редактор' : 'Редактировать сайт')),
    open ? h('form', { className: 'admin-site-editor', onSubmit: save },
      h('h2', null, 'Тексты главной страницы'),
      h('div', { className: 'admin-site-editor-grid' }, ...CONTENT_FIELDS.map(([key, label, fallback, multiline]) => h('label', { key },
        h('span', null, label),
        multiline ? h('textarea', { value: draft[key] ?? '', rows: key === 'hero_description' || key === 'about_text' ? 4 : 3, onChange: (event) => setDraft((current) => ({ ...current, [key]: event.target.value })) }) :
          h('input', { type: 'text', value: draft[key] ?? '', onChange: (event) => setDraft((current) => ({ ...current, [key]: event.target.value })) })
      ))),
      status ? h('p', { className: 'admin-site-editor-status', role: 'status' }, status) : null,
      h('div', { className: 'admin-site-editor-actions' },
        h('button', { type: 'button', className: 'editor-cancel', onClick: () => setOpen(false) }, 'Отмена'),
        h('button', { type: 'submit', disabled: saving }, saving ? 'Сохраняем…' : 'Сохранить тексты')
      )
    ) : null
  );
}

function HomeRecommendations() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/store/recommendations/daily', { headers: { Accept: 'application/json' }, signal: controller.signal })
      .then((response) => response.ok ? response.json() : { data: { products: [] } })
      .then((payload) => {
        const products = payload?.data?.products || payload?.products || [];
        setItems(Array.isArray(products) ? products : []);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!items.length) return null;
  return h('section', { className: 'home-recommendations' },
    h('div', { className: 'container' },
      h('div', { className: 'section-heading' }, h('div', null, h('p', { className: 'eyebrow' }, 'ПОДБОРКА ДНЯ'), h('h2', null, 'Возможно, вас заинтересует'))),
      h('div', { className: 'home-recommendation-grid' }, ...items.map((item) => h(SpotlightCard, { key: item.id, className: 'home-recommendation-spotlight' },
        h('a', { className: 'home-recommendation-card', href: `/product/${encodeURIComponent(item.slug)}` },
          item.image_url ? h('img', { src: item.image_url, alt: item.image_alt || item.name, loading: 'lazy' }) : h('span', { className: 'home-recommendation-placeholder' }, String(item.brand || item.name).slice(0, 2)),
          h('span', { className: 'home-recommendation-copy' }, h('strong', null, item.name), h('small', null, [item.brand, item.product_type].filter(Boolean).join(' · ') || 'VAPELAB'))
        )
      )))
    )
  );
}

function HomePage() {
  const { loading, error, data } = useStore();
  useReveal();
  const settings = data.settings || {};
  useEffect(() => {
    document.title = `${settings.brand_name || 'VAPELAB'} — каталог и информация о компании`;
    const description = document.querySelector('meta[name="description"]');
    if (description) description.content = settings.hero_description || 'VAPELAB — информация о компании, розничном и оптовом направлениях, категориях каталога и публикациях.';
  }, [settings.brand_name, settings.hero_description]);
  return h(React.Fragment, null,
    h(Header, { settings }),
    h(HomeContentEditor, { settings }),
    h('main', null,
      h(Hero, { settings }),
      h(About, { settings }),
      h(Categories, { categories: data.categories || [], loading, error, settings }),
      h(HomeRecommendations),
      h(Directions, { settings }),
      h(News, { items: data.news || [], loading, settings }),
      h(Contacts, { settings })
    ),
    h(Footer, { settings })
  );
}

function mountSpotlightCards() {
  document.querySelectorAll('[data-reactbits-spotlight]').forEach((host) => {
    if (host.dataset.reactbitsMounted === '1') return;
    const html = host.innerHTML;
    host.classList.remove('has-spotlight-fallback');
    host.dataset.reactbitsMounted = '1';
    const root = createRoot(host);
    root.render(h(SpotlightCard, { className: 'rb-spotlight-card', spotlightColor: 'rgba(44,145,231,.17)' }, h('div', { dangerouslySetInnerHTML: { __html: html } })));
  });
}

const app = document.getElementById('root');
if (app) createRoot(app).render(h(HomePage));
else mountSpotlightCards();
