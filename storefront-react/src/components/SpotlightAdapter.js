import React, { createElement as h } from 'react';
import VapelabGlowCard from './VapelabGlowCard.js';

// React Bits source is installed locally by the owner through the official shadcn registry.
// The adapter discovers it without a CDN import and keeps the storefront usable before install.
const visualModules = import.meta.glob('./visuals/**/*.{js,jsx}', { eager: true });
const spotlightModule = Object.entries(visualModules).find(([file]) => /spotlight[-_]?card/i.test(file));
const registeredSpotlight = spotlightModule?.[1]?.default
  || spotlightModule?.[1]?.SpotlightCard
  || null;

export default function SpotlightAdapter({ children, className = '', spotlightColor = 'rgba(36, 107, 222, .18)', ...props }) {
  if (typeof registeredSpotlight === 'function') {
    return h(registeredSpotlight, {
      ...props,
      className,
      spotlightColor,
      theme: 'light',
      intensity: 0.14,
      borderGlow: 0.38,
      softness: 0.78,
      flare: false,
      grain: 0,
    }, children);
  }

  return h(VapelabGlowCard, { ...props, className, spotlightColor }, children);
}
