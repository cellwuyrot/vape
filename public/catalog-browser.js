(() => {
  const root = document.querySelector("#catalog-directory");
  if (!root) return;
  root.classList.add("catalog-enhanced");
  const input = root.querySelector("#catalog-query");
  const form = root.querySelector(".catalog-controls");
  const groupInput = form.querySelector('[name="group"]');
  const letterInput = form.querySelector('[name="letter"]');
  const select = root.querySelector("#catalog-group-select");
  const count = root.querySelector(".catalog-count strong");
  const empty = root.querySelector("[data-catalog-empty]");
  const items = [...root.querySelectorAll("[data-catalog-item]")];
  const sections = [...root.querySelectorAll("[data-catalog-section]")];
  const letters = [...root.querySelectorAll("[data-catalog-letter]")];
  let group = groupInput.value || "0";
  let letter = letterInput.value || "";
  const normalize = (s) => String(s || "").normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
  const url = () => {
    const params = new URLSearchParams();
    if (group !== "0") params.set("group", group);
    if (input.value.trim()) params.set("q", input.value.trim());
    if (letter) params.set("letter", letter);
    return `/catalog/categories${params.toString() ? `?${params}` : ""}`;
  };
  function render(updateHistory = true) {
    let visible = 0;
    const search = normalize(input.value);
    for (const item of items) {
      const show = (group === "0" || item.dataset.group === group) &&
        (!search || normalize(item.dataset.name).includes(search)) && (!letter || item.dataset.letter === letter);
      item.hidden = !show;
      if (show) visible++;
    }
    for (const section of sections) section.hidden = !section.querySelector("[data-catalog-item]:not([hidden])");
    for (const link of letters) {
      const active = link.dataset.catalogLetter === letter;
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
      const href = new URL(url(), window.location.origin);
      if (link.dataset.catalogLetter) href.searchParams.set("letter", link.dataset.catalogLetter); else href.searchParams.delete("letter");
      link.href = href.pathname + href.search;
    }
    for (const link of root.querySelectorAll("[data-catalog-group-link]")) {
      const target = link.dataset.catalogGroupLink;
      if (target === group) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
      const params = new URLSearchParams();
      if (target !== "0") params.set("group", target);
      if (input.value.trim()) params.set("q", input.value.trim());
      link.href = `/catalog/categories${params.toString() ? `?${params}` : ""}`;
    }
    count.textContent = String(visible);
    empty.hidden = visible !== 0;
    groupInput.value = group === "0" ? "" : group;
    letterInput.value = letter;
    if (select) select.value = group;
    if (updateHistory) history.replaceState(null, "", url());
  }
  input.addEventListener("input", () => { letter = ""; render(); });
  form.addEventListener("submit", (event) => { event.preventDefault(); render(); });
  for (const link of letters) link.addEventListener("click", (event) => {
    event.preventDefault(); letter = link.dataset.catalogLetter || "";
    history.pushState(null, "", url()); render(false);
  });
  if (select) select.addEventListener("change", () => {
    const params = new URLSearchParams();
    if (select.value !== "0") params.set("group", select.value);
    if (input.value.trim()) params.set("q", input.value.trim());
    window.location.href = `/catalog/categories${params.toString() ? `?${params}` : ""}`;
  });
  window.addEventListener("popstate", () => {
    const params = new URLSearchParams(location.search);
    input.value = params.get("q") || "";
    group = params.get("group") || "0";
    letter = params.get("letter") || "";
    render(false);
  });
  render(false);
})();
