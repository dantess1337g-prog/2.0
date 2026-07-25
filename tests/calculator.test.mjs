import test from 'node:test';
import assert from 'node:assert/strict';
import { addFunpayMarkup, calculateBoost } from '../src/calculator.js';

test('полный маршрут от 100 до 2001 ELO стоит 8750 ₽', () => {
  const result = calculateBoost(100, 2001);
  assert.equal(result.stepCount, 77);
  assert.equal(result.basePrice, 8750);
  assert.equal(result.totalPrice, 8750);
});

test('считает стоимость пропорционально шагам по 25 ELO', () => {
  const result = calculateBoost(500, 1500);
  assert.equal(result.difference, 1000);
  assert.equal(result.stepCount, 40);
  assert.equal(result.basePrice, 4545);
  assert.equal(result.totalPrice, 4545);
});

test('округляет неполные 25 ELO вверх', () => {
  const result = calculateBoost(1000, 1026);
  assert.equal(result.stepCount, 2);
  assert.equal(result.basePrice, 227);
});

test('суммирует наценки от базовой стоимости', () => {
  const result = calculateBoost(1000, 1500, [
    { label: 'Экспресс', rate: 0.20 },
    { label: 'Премиум', rate: 0.25 },
  ]);
  assert.equal(result.basePrice, 2273);
  assert.equal(result.markupPrice, 1023);
  assert.equal(result.totalPrice, 3296);
});

test('считает наценки для полного диапазона', () => {
  const result = calculateBoost(100, 2001, [
    { label: 'Без передачи', rate: 0.50 },
    { label: 'Приоритет', rate: 0.35 },
    { label: 'Экспресс', rate: 0.20 },
    { label: 'Премиум', rate: 0.25 },
  ]);
  assert.equal(result.basePrice, 8750);
  assert.equal(result.markupPrice, 11375);
  assert.equal(result.totalPrice, 20125);
});

test('добавляет FunPay +5% к цене сайта', () => {
  const result = addFunpayMarkup(8750);
  assert.equal(result.markup, 438);
  assert.equal(result.total, 9188);
});

test('отклоняет цель ниже текущего ELO', () => {
  const result = calculateBoost(1500, 1400);
  assert.equal(result.valid, false);
  assert.equal(result.totalPrice, 0);
});

test('отклоняет текущее ELO ниже минимума', () => {
  const result = calculateBoost(99, 500);
  assert.equal(result.valid, false);
  assert.match(result.error, /ниже 100/);
});

test('отклоняет желаемое ELO ниже минимума', () => {
  const result = calculateBoost(100, 90);
  assert.equal(result.valid, false);
  assert.match(result.error, /ниже 101|выше текущего/);
});
