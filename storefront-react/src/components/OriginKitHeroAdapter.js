import React, { createElement as h } from 'react';

// The owner installs OriginKit Hero 58 through its authenticated CLI.
// This adapter discovers the downloaded local source; no CDN or guessed import path is used.
const originKitModules = import.meta.glob('./originkit/**/*.{js,jsx}', { eager: true });
const heroEntry = Object.entries(originKitModules).find(([file]) => /hero[-_]?58/i.test(file));
const heroModule = heroEntry?.[1] || null;
const candidates = heroModule
  ? [heroModule.default, heroModule.Hero58, heroModule.Hero]
  : [];
const isComponentType = (value) =>
  typeof value === 'function' || Boolean(value && typeof value === 'object' && value.$$typeof);
const OriginKitHero = candidates.find(isComponentType) || null;

export default function OriginKitHeroAdapter({ fallback, settings }) {
  if (!OriginKitHero) return fallback;
  return h('div', { className: 'originkit-hero58-shell', 'data-origin-kit-hero': '58' }, h(OriginKitHero, { settings }));
}

export const hasOriginKitHero58 = Boolean(OriginKitHero);
