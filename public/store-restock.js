(() => {
  document.querySelectorAll("form[data-store-restock]").forEach((form) => {
    if (form.dataset.bound === "1") return;
    form.dataset.bound = "1";
    const feedback = form.querySelector(".seo-restock-feedback");
    const submit = form.querySelector('button[type="submit"]');
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form).entries());
      submit.disabled = true;
      if (feedback) feedback.textContent = "Сохраняем подписку…";
      try {
        const headers = { "Content-Type": "application/json", Accept: "application/json" };
        try {
          const accessToken = localStorage.getItem("rucrm.token");
          if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        } catch { /* storage may be disabled; guest can still submit contact details */ }
        const response = await fetch("/api/store/restock-subscriptions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            product_id: Number(form.dataset.productId),
            customer_name: values.customer_name || "",
            email: values.email || "",
            telegram_username: values.telegram_username || "",
            pd_consent: values.pd_consent === "on",
            age_confirmed: values.age_confirmed === "on",
            website: values.website || "",
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || "Не удалось оформить уведомление");
        const data = payload.data || payload;
        if (feedback) feedback.textContent = data.duplicate
          ? "Вы уже подписаны. Повторно оформлять заявку не нужно."
          : "Заявка принята. Мы сообщим, когда товар снова появится.";
        if (data.telegram_link_url) {
          const link = document.createElement("a");
          link.href = data.telegram_link_url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "Подключить Telegram для уведомления";
          link.className = "seo-restock-telegram-link";
          feedback?.append(document.createElement("br"), link);
        } else if (data.telegram_link_required && feedback) {
          feedback.append(document.createTextNode(" Для Telegram-уведомления администратору нужно подключить бота."));
        }
        form.reset();
      } catch (error) {
        if (feedback) feedback.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
  });
})();
