import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const script = await fs.readFile(new URL("../public/product-variants.js", import.meta.url), "utf8");

function simulateVariantSelection(priceText) {
  const clickHandlers = [];
  const summaryClasses = new Set();
  const unit = { textContent: "" };
  const total = { textContent: "" };
  const summary = { classList: { toggle(name, active) { if (active) summaryClasses.add(name); else summaryClasses.delete(name); } } };
  const reservation = {
    dataset: { priceCurrency: "RUB", unitPriceMinor: "" },
    querySelector(selector) {
      if (selector === "[data-reservation-price-summary]") return summary;
      if (selector === "[data-reservation-unit-price]") return unit;
      if (selector === "[data-reservation-total]") return total;
      if (selector === "[data-reservation-quantity-input]") return { value: "2" };
      return null;
    },
  };
  const stockState = { textContent: "" };
  const information = {
    querySelector(selector) { return selector === "[data-product-stock-state]" ? stockState : null; },
  };
  const detail = {
    querySelector(selector) { return selector === "[data-product-media]" ? null : information; },
    querySelectorAll() { return [button]; },
  };
  const button = {
    dataset: { variantId: "11", productId: "7", price: priceText, availability: "В наличии" },
    classList: { toggle() {} },
    setAttribute() {},
    closest(selector) { return selector === ".seo-product-detail" ? detail : null; },
  };
  const document = {
    addEventListener(type, callback) { if (type === "click") clickHandlers.push(callback); },
    querySelectorAll() { return []; },
    querySelector(selector) { return selector.startsWith("form[data-store-reservation]") ? reservation : null; },
  };
  vm.runInNewContext(script, { document, Intl, Number, String, Math });
  clickHandlers[0]({ target: { closest(selector) { return selector === "[data-product-variant]" ? button : null; } } });
  return { reservation, unit, total, summaryClasses };
}

test("клиент не рассчитывает итог по строке с несколькими ценами", () => {
  const state = simulateVariantSelection("24 000 ₽ / 17 700 ₽");
  assert.equal(state.reservation.dataset.unitPriceMinor, "");
  assert.equal(state.unit.textContent, "Уточняется менеджером");
  assert.equal(state.total.textContent, "Будет подтверждена менеджером");
  assert.ok(state.summaryClasses.has("is-pending"));
  assert.ok(!state.summaryClasses.has("is-calculated"));
});

test("клиент рассчитывает сумму для одной однозначной цены", () => {
  const state = simulateVariantSelection("1 200 ₽");
  assert.equal(state.reservation.dataset.unitPriceMinor, "120000");
  assert.match(state.unit.textContent, /1\s*200/);
  assert.match(state.total.textContent, /2\s*400/);
  assert.ok(state.summaryClasses.has("is-calculated"));
});
