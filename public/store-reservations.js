(() => {
  const formatMoney = (minor, currency) => {
    if (!Number.isSafeInteger(minor) || minor < 0) return "";
    try {
      return new Intl.NumberFormat("ru-RU", {
        style: "currency",
        currency: /^[A-Z]{3}$/.test(currency || "") ? currency : "RUB",
        minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(minor / 100);
    } catch {
      return `${new Intl.NumberFormat("ru-RU").format(minor / 100)} ${currency || "RUB"}`;
    }
  };

  function updatePriceSummary(form) {
    const summary = form.querySelector("[data-reservation-price-summary]");
    if (!summary) return;
    const quantityInput = form.querySelector("[data-reservation-quantity-input]");
    const quantity = Math.max(1, Math.min(20, Number(quantityInput?.value) || 1));
    const unitPrice = Number(form.dataset.unitPriceMinor);
    const calculated = Number.isSafeInteger(unitPrice) && unitPrice > 0;
    const currency = String(form.dataset.priceCurrency || "RUB").toUpperCase();
    const quantityLabel = summary.querySelector("[data-reservation-quantity]");
    const unitLabel = summary.querySelector("[data-reservation-unit-price]");
    const totalLabel = summary.querySelector("[data-reservation-total]");
    if (unitLabel) unitLabel.textContent = calculated ? formatMoney(unitPrice, currency) : "Уточняется менеджером";
    if (quantityLabel) quantityLabel.textContent = `${quantity} шт.`;
    if (totalLabel) totalLabel.textContent = calculated
      ? formatMoney(unitPrice * quantity, currency)
      : "Будет подтверждена менеджером";
    summary.classList.toggle("is-calculated", calculated);
    summary.classList.toggle("is-pending", !calculated);
  }

  function showSuccessPopup(number) {
    document.querySelector(".reservation-success-popup")?.remove();
    const popup = document.createElement("div");
    popup.className = "reservation-success-popup";
    popup.setAttribute("role", "status");
    popup.setAttribute("aria-live", "polite");
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Заявка принята";
    const message = document.createElement("p");
    message.textContent = "Ожидайте обратной связи от менеджера VAPELAB.";
    content.append(title, message);
    if (number) {
      const reference = document.createElement("small");
      reference.textContent = `Номер бронирования: ${number}`;
      content.append(reference);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "reservation-success-close";
    close.setAttribute("aria-label", "Закрыть уведомление");
    close.textContent = "×";
    close.addEventListener("click", () => popup.remove());
    popup.append(content, close);
    document.body.append(popup);
    window.setTimeout(() => {
      popup.classList.add("is-leaving");
      window.setTimeout(() => popup.remove(), 250);
    }, 5500);
  }

  document.addEventListener("input", (event) => {
    const input = event.target.closest("[data-reservation-quantity-input]");
    if (input) updatePriceSummary(input.form);
  });

  document.addEventListener("change", (event) => {
    const input = event.target.closest("[data-reservation-quantity-input]");
    if (input) updatePriceSummary(input.form);
  });

  document.querySelectorAll("form[data-store-reservation]").forEach((form) => {
    updatePriceSummary(form);
    form.addEventListener("reset", () => {
      window.setTimeout(() => {
        const selected = document.querySelector(`[data-product-variant][data-product-id="${form.dataset.productId}"][aria-pressed='true']`);
        const variantInput = form.querySelector("[data-selected-variant-id]");
        if (selected && variantInput) variantInput.value = selected.dataset.variantId;
        updatePriceSummary(form);
      }, 0);
    });
  });
  document.addEventListener("vapelab:variant-change", (event) => {
    const form = event.target?.closest?.("form[data-store-reservation]");
    if (form) updatePriceSummary(form);
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-store-reservation]");
    if (!form) return;
    event.preventDefault();
    const feedback = form.querySelector(".seo-reservation-feedback");
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    if (feedback) feedback.textContent = "Отправляем запрос…";
    const values = new FormData(form);
    const body = {
      product_id: Number(form.dataset.productId),
      variant_id: values.get("variant_id") ? Number(values.get("variant_id")) : null,
      customer_name: values.get("customer_name"),
      phone: values.get("phone"),
      email: values.get("email"),
      quantity: Number(values.get("quantity") || 1),
      message: values.get("message"),
      age_confirmed: values.get("age_confirmed") === "on",
      pd_consent: values.get("pd_consent") === "on",
      website: values.get("website"),
      source_path: values.get("source_path") || location.pathname,
    };
    try {
      const response = await fetch("/api/store/reservations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Не удалось отправить запрос");
      if (feedback) feedback.textContent = result.number
        ? `Заявка принята. Номер бронирования: ${result.number}. Ожидайте обратной связи.`
        : "Заявка принята. Ожидайте обратной связи.";
      showSuccessPopup(result.number);
      form.reset();
      updatePriceSummary(form);
      window.VAPELABAnalytics?.track("reservation_submitted", { target_text: "Бронирование товара", target_path: location.pathname });
    } catch (error) {
      if (feedback) feedback.textContent = error.message;
    } finally { if (submit) { const selected = document.querySelector(`[data-product-variant][data-product-id="${form.dataset.productId}"][aria-pressed="true"]`); submit.disabled = selected?.dataset.stockStatus === "out_of_stock"; } }
  });
})();
