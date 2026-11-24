(() => {
  const formatMoney = (minor, currency = "RUB") => {
    if (!Number.isSafeInteger(minor) || minor < 1) return "";
    try {
      return new Intl.NumberFormat("ru-RU", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100);
    } catch {
      return `${(minor / 100).toLocaleString("ru-RU")} ${currency}`;
    }
  };

  const parsePriceMinor = (raw) => {
    const text = String(raw ?? "").replace(/[\u00a0\u202f]/g, " ").trim();
    if (!text || /(?:^|\s)(?:от|до)(?:\s|$)|[\/;|]|\d\s*[–—-]\s*\d/i.test(text)) return null;
    const tokens = [...text.matchAll(/(?<!\d)(?:\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+|\d+)(?:[.,]\d{1,2})?(?!\d)/g)];
    if (tokens.length !== 1) return null;
    let token = tokens[0][0].replace(/\s/g, "");
    const decimal = token.match(/[.,](\d{1,2})$/);
    const fraction = decimal ? Number(decimal[1].padEnd(2, "0")) : 0;
    if (decimal) token = token.slice(0, -decimal[0].length);
    const digits = token.replace(/[.,]/g, "");
    if (!/^\d+$/.test(digits)) return null;
    const result = Number(digits) * 100 + fraction;
    return Number.isSafeInteger(result) && result > 0 && result <= 9_000_000_000_000 ? result : null;
  };

  function setMainImage(gallery, url, alt) {
    const image = gallery.querySelector("[data-product-main-image]");
    const placeholder = gallery.querySelector("[data-product-gallery-placeholder]");
    if (!image) return;
    const safeUrl = String(url || "").trim();
    image.onerror = () => {
      const fallback = String(gallery.dataset.defaultImage || "").trim();
      if (fallback && fallback !== safeUrl) {
        image.onerror = null;
        setMainImage(gallery, fallback, gallery.dataset.defaultAlt || alt);
        return;
      }
      image.hidden = true;
      image.removeAttribute("src");
      if (placeholder) placeholder.hidden = false;
    };
    image.onload = () => {
      image.hidden = false;
      if (placeholder) placeholder.hidden = true;
    };
    if (!safeUrl) {
      image.hidden = true;
      image.removeAttribute("src");
      if (placeholder) placeholder.hidden = false;
      return;
    }
    image.alt = alt || gallery.dataset.defaultAlt || "Изображение товара";
    if (image.getAttribute("src") === safeUrl && !image.hidden && image.complete && image.naturalWidth > 0) {
      if (placeholder) placeholder.hidden = true;
      return;
    }
    image.hidden = false;
    if (placeholder) placeholder.hidden = true;
    image.src = safeUrl;
  }

  function setGallery(gallery, images) {
    let parsed = [];
    try { parsed = JSON.parse(images || "[]"); } catch { /* leave empty */ }
    gallery._variantImages = Array.isArray(parsed) ? parsed.filter((item) => item && item.url) : [];
    gallery._variantIndex = 0;
    renderGallery(gallery);
  }
  function renderGallery(gallery) {
    const images = gallery._variantImages || [];
    const item = images[gallery._variantIndex || 0];
    setMainImage(gallery, item?.url || "", item?.alt || "");
    const controls = gallery.querySelector("[data-gallery-controls]");
    const counter = gallery.querySelector("[data-gallery-counter]");
    if (controls) controls.hidden = images.length < 2;
    if (counter) counter.textContent = images.length ? `${(gallery._variantIndex || 0) + 1} / ${images.length}` : "";
  }

  function selectVariant(button) {
    const detail = button.closest(".seo-product-detail");
    if (!detail) return;
    const gallery = detail.querySelector("[data-product-media]");
    const variantId = String(button.dataset.variantId || "");
    detail.querySelectorAll("[data-product-variant]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-selected", active);
      item.setAttribute("aria-pressed", active ? "true" : "false");
    });

    if (gallery) {
      const variantImage = button.dataset.imageUrl || gallery.dataset.defaultImage || "";
      const variantAlt = button.dataset.imageAlt || gallery.dataset.defaultAlt || "Изображение товара";
      if (button.dataset.galleryImages) setGallery(gallery, button.dataset.galleryImages);
      else setMainImage(gallery, variantImage, variantAlt);
    }

    const information = detail.querySelector(".seo-product-information");
    const pricePanel = information?.querySelector("[data-product-price-panel]");
    if (pricePanel) {
      const price = String(button.dataset.price || "").trim();
      const oldPrice = String(button.dataset.oldPrice || "").trim();
      const availability = String(button.dataset.availability || "").trim();
      const current = pricePanel.querySelector("[data-product-current-price]");
      const old = pricePanel.querySelector("[data-product-old-price]");
      const stock = pricePanel.querySelector("[data-product-availability]");
      if (current) current.textContent = price || "Уточняется";
      if (old) { old.textContent = oldPrice ? `Прежняя цена: ${oldPrice}` : ""; old.hidden = !oldPrice; }
      if (stock) { stock.textContent = availability; stock.hidden = !availability; }
    }
    const stockState = information?.querySelector("[data-product-stock-state]");
    if (stockState) {
      stockState.textContent = button.dataset.availability || "Наличие уточняется";
      stockState.className = `seo-stock-state seo-stock-${button.dataset.stockStatus || "unknown"}`;
    }
    const description = information?.querySelector("[data-product-description]");
    if (description) description.textContent = button.dataset.description || "";

    const reservation = document.querySelector(`form[data-store-reservation][data-product-id="${button.dataset.productId || ""}"]`);
    if (reservation) {
      const selectedInput = reservation.querySelector("[data-selected-variant-id]");
      if (selectedInput) selectedInput.value = variantId;
      const submit = reservation.querySelector('[type="submit"]');
      if (submit) submit.disabled = button.dataset.stockStatus === "out_of_stock";
      const unitPrice = parsePriceMinor(button.dataset.price);
      const currency = String(button.dataset.currency || reservation.dataset.priceCurrency || "RUB").toUpperCase();
      reservation.dataset.priceCurrency = currency;
      reservation.dataset.unitPriceMinor = unitPrice === null ? "" : String(unitPrice);
      const summary = reservation.querySelector("[data-reservation-price-summary]");
      const unit = reservation.querySelector("[data-reservation-unit-price]");
      const total = reservation.querySelector("[data-reservation-total]");
      const quantityInput = reservation.querySelector("[data-reservation-quantity-input]");
      const quantity = Math.max(1, Math.min(20, Number(quantityInput?.value) || 1));
      if (unit) unit.textContent = unitPrice === null ? "Уточняется менеджером" : formatMoney(unitPrice, currency);
      if (total) total.textContent = unitPrice === null ? "Будет подтверждена менеджером" : formatMoney(unitPrice * quantity, currency);
      summary?.classList.toggle("is-calculated", unitPrice !== null);
      summary?.classList.toggle("is-pending", unitPrice === null);
      const note = reservation.querySelector("[data-reservation-price-note]");
      if (note) note.textContent = unitPrice === null ? "Сумму подтвердит менеджер." : "Предварительный расчёт. Итог подтвердит менеджер.";
    }
  }

  document.addEventListener("click", (event) => {
    const navigation = event.target.closest("[data-gallery-prev], [data-gallery-next]");
    if (navigation) {
      const gallery = navigation.closest("[data-product-media]");
      const count = gallery?._variantImages?.length || 0;
      if (count) { gallery._variantIndex = ((gallery._variantIndex || 0) + (navigation.hasAttribute("data-gallery-next") ? 1 : -1) + count) % count; renderGallery(gallery); }
      return;
    }
    const option = event.target.closest("[data-product-variant]");
    if (option) {
      selectVariant(option);
      return;
    }
  });

  document.querySelectorAll("[data-product-media]").forEach((gallery) => {
    setGallery(gallery, gallery.dataset.galleryImages);
  });
})();
