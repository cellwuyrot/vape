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
    const source = String(raw || "").trim();
    // Do not calculate a reservation total from ranges or multi-price labels.
    // Examples: "24 000 / 17 700 ₽", "от 1 200 ₽", "1 200–1 500 ₽".
    if (!source || /\b(?:от|до)\b|[\/;|]|\d\s*[–—-]\s*\d/i.test(source)) return null;
    let value = source.replace(/[^\d,.\-]/g, "").trim();
    if (!value || !/\d/.test(value)) return null;
    const comma = value.lastIndexOf(",");
    const dot = value.lastIndexOf(".");
    const decimalAt = Math.max(comma, dot);
    if (decimalAt >= 0 && value.length - decimalAt - 1 <= 2) {
      value = `${value.slice(0, decimalAt).replace(/[,.]/g, "")}.${value.slice(decimalAt + 1)}`;
    } else {
      value = value.replace(/[,.]/g, "");
    }
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
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
      setMainImage(gallery, variantImage, variantAlt);
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
    if (stockState && button.dataset.availability) stockState.textContent = button.dataset.availability;

    const reservation = document.querySelector(`form[data-store-reservation][data-product-id="${button.dataset.productId || ""}"]`);
    if (reservation) {
      const unitPrice = parsePriceMinor(button.dataset.price);
      const currency = String(reservation.dataset.priceCurrency || "RUB").toUpperCase();
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
    }
  }

  document.addEventListener("click", (event) => {
    const option = event.target.closest("[data-product-variant]");
    if (option) {
      selectVariant(option);
      return;
    }
  });

  document.querySelectorAll("[data-product-media]").forEach((gallery) => {
    const image = gallery.querySelector("[data-product-main-image]");
    if (image && image.getAttribute("src")) {
      image.addEventListener("error", () => {
        image.hidden = true;
        gallery.querySelector("[data-product-gallery-placeholder]")?.removeAttribute("hidden");
      }, { once: true });
    }
  });
})();
