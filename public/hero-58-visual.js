/**
 * VAPELAB Hero visual: a lightweight particle-wave adaptation inspired by
 * OriginKit Hero 58 / Gauze Blaze. This is an original canvas treatment,
 * not the downloaded OriginKit source component.
 */
(() => {
  const canvas = document.getElementById("hero-canvas");
  if (!canvas) return;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches;
  const hero = canvas.closest(".hero");
  const state = { width: 0, height: 0, frame: 0, pointerX: 0, pointerY: 0, visible: true };
  const rows = 17;
  const columns = 62;
  const dots = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      dots.push({ row, column, phase: Math.random() * Math.PI * 2 });
    }
  }

  function resize() {
    const rect = hero.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    state.width = Math.max(1, Math.round(rect.width));
    state.height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(state.width * ratio);
    canvas.height = Math.round(state.height * ratio);
    canvas.style.width = `${state.width}px`;
    canvas.style.height = `${state.height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(0);
  }

  function draw(time) {
    const width = state.width;
    const height = state.height;
    context.clearRect(0, 0, width, height);

    const startX = width * 0.37;
    const spanX = width * 0.66;
    const centerY = height * 0.48;
    const pointerShift = coarsePointer ? 0 : (state.pointerY - 0.5) * 22;
    const motionTime = reduceMotion ? 0 : time * 0.00026;

    context.lineWidth = 0.7;
    for (let row = 0; row < rows; row += 1) {
      context.beginPath();
      let first = true;
      for (let column = 0; column < columns; column += 1) {
        const x = startX + (column / (columns - 1)) * spanX;
        const progress = column / (columns - 1);
        const envelope = Math.sin(progress * Math.PI) * 0.9 + 0.1;
        const waveA = Math.sin(progress * 8.4 + row * 0.24 + motionTime) * 38;
        const waveB = Math.sin(progress * 4.1 - row * 0.17 - motionTime * 0.7) * 24;
        const y = centerY + (row - (rows - 1) / 2) * 9 + (waveA + waveB + pointerShift) * envelope;
        if (first) {
          context.moveTo(x, y);
          first = false;
        } else context.lineTo(x, y);
      }
      const alpha = 0.07 + (row % 5) * 0.012;
      context.strokeStyle = row % 4 === 0
        ? `rgba(70, 177, 222, ${alpha + 0.045})`
        : `rgba(198, 218, 236, ${alpha})`;
      context.stroke();
    }

    for (const dot of dots) {
      const progress = dot.column / (columns - 1);
      const x = startX + progress * spanX;
      const envelope = Math.sin(progress * Math.PI) * 0.9 + 0.1;
      const waveA = Math.sin(progress * 8.4 + dot.row * 0.24 + motionTime + dot.phase * 0.03) * 38;
      const waveB = Math.sin(progress * 4.1 - dot.row * 0.17 - motionTime * 0.7) * 24;
      const y = centerY + (dot.row - (rows - 1) / 2) * 9 + (waveA + waveB + pointerShift) * envelope;
      const alpha = 0.18 + (1 - progress) * 0.16;
      context.beginPath();
      context.arc(x, y, dot.column % 7 === 0 ? 1.35 : 0.75, 0, Math.PI * 2);
      context.fillStyle = dot.column % 9 === 0
        ? `rgba(67, 199, 232, ${alpha})`
        : `rgba(221, 235, 247, ${alpha * 0.66})`;
      context.fill();
    }
  }

  function animate(time) {
    if (!state.visible || document.hidden || reduceMotion) {
      state.frame = 0;
      return;
    }
    draw(time);
    state.frame = window.requestAnimationFrame(animate);
  }

  function start() {
    if (reduceMotion || state.frame || !state.visible || document.hidden) return;
    state.frame = window.requestAnimationFrame(animate);
  }

  function stop() {
    if (state.frame) window.cancelAnimationFrame(state.frame);
    state.frame = 0;
  }

  if (!coarsePointer) {
    hero.addEventListener("pointermove", (event) => {
      const rect = hero.getBoundingClientRect();
      state.pointerX = (event.clientX - rect.left) / Math.max(1, rect.width);
      state.pointerY = (event.clientY - rect.top) / Math.max(1, rect.height);
    }, { passive: true });
  }

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      state.visible = entry.isIntersecting;
      if (state.visible) start();
      else stop();
    }, { threshold: 0.02 });
    observer.observe(hero);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  window.addEventListener("resize", resize, { passive: true });
  resize();
  start();
})();
