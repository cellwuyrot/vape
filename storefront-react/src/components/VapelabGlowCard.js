import React, { createElement as h, useRef } from 'react';
import './VapelabGlowCard.css';

/** Independently authored VAPELAB fallback for pointer-responsive surface lighting. */
export default function VapelabGlowCard({
  children,
  className = '',
  spotlightColor = 'rgba(36, 107, 222, .18)',
  style,
}) {
  const surfaceRef = useRef(null);

  const setPointer = (event) => {
    const surface = surfaceRef.current;
    if (!surface || event.pointerType === 'touch') return;
    const bounds = surface.getBoundingClientRect();
    const localX = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    const localY = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    surface.style.setProperty('--vapelab-glow-x', `${localX}px`);
    surface.style.setProperty('--vapelab-glow-y', `${localY}px`);
    surface.style.setProperty('--vapelab-glow-opacity', '1');
  };

  const clearPointer = () => {
    surfaceRef.current?.style.setProperty('--vapelab-glow-opacity', '0');
  };

  return h('div', {
    ref: surfaceRef,
    className: `vapelab-glow-card ${className}`.trim(),
    style: { ...style, '--vapelab-glow-color': spotlightColor },
    onPointerMove: setPointer,
    onPointerLeave: clearPointer,
    onBlurCapture: clearPointer,
  }, children);
}
