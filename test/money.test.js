import assert from "node:assert/strict";
import test from "node:test";
import { formatMoneyMinor, parseMoneyMinor } from "../server/money.js";

test("parses one clearly stated product price in common Russian formats", () => {
  assert.equal(parseMoneyMinor("2 000 ₽"), 200000);
  assert.equal(parseMoneyMinor("1 299,50 руб."), 129950);
  assert.equal(parseMoneyMinor("2.500 руб."), 250000);
  assert.equal(parseMoneyMinor("от 2 000 ₽"), 200000);
});

test("does not guess between a range or multiple variant prices", () => {
  assert.equal(parseMoneyMinor("2 000–3 000 ₽"), null);
  assert.equal(parseMoneyMinor("24 000 ₽ / 17 700 ₽"), null);
  assert.equal(parseMoneyMinor("Не указана"), null);
  assert.equal(parseMoneyMinor(""), null);
});

test("formats minor units without floating point errors", () => {
  assert.equal(formatMoneyMinor(100000, "RUB"), "1 000 ₽");
  assert.equal(formatMoneyMinor(129950, "RUB"), "1 299,50 ₽");
});
