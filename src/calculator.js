export const LIMITS = Object.freeze({
  minCurrent: 100,
  maxCurrent: 2000,
  minTarget: 101,
  maxTarget: 2001,
  step: 25,
  fullRangeBasePrice: 8750,
  funpayRate: 0.05,
});

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function parseElo(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return Number.NaN;
  const number = Number(raw.replace(',', '.'));
  return Number.isFinite(number) ? Math.round(number) : Number.NaN;
}

export function normalizeElo(currentElo, targetElo) {
  const current = parseElo(currentElo);
  const target = parseElo(targetElo);
  return { current, target };
}

function invalidResult(error, current, target, field = '') {
  return {
    valid: false,
    error,
    field,
    current: Number.isFinite(current) ? current : '',
    target: Number.isFinite(target) ? target : '',
    difference: 0,
    stepCount: 0,
    basePrice: 0,
    markupRate: 0,
    markupPrice: 0,
    totalPrice: 0,
  };
}

export function getStepCount(eloAmount) {
  if (eloAmount <= 0) return 0;
  return Math.ceil(eloAmount / LIMITS.step);
}

export function getTotalRangeSteps() {
  return getStepCount(LIMITS.maxTarget - LIMITS.minCurrent);
}

function calculateBasePrice(stepCount) {
  if (stepCount <= 0) return 0;
  return Math.round((LIMITS.fullRangeBasePrice * stepCount) / getTotalRangeSteps());
}

export function calculateBoost(currentElo, targetElo, addons = []) {
  const { current, target } = normalizeElo(currentElo, targetElo);

  if (!Number.isFinite(current)) {
    return invalidResult('Введите текущее ELO.', current, target, 'current');
  }
  if (!Number.isFinite(target)) {
    return invalidResult('Введите желаемое ELO.', current, target, 'target');
  }
  if (current < LIMITS.minCurrent) {
    return invalidResult(`Текущее ELO не может быть ниже ${LIMITS.minCurrent}.`, current, target, 'current');
  }
  if (current > LIMITS.maxCurrent) {
    return invalidResult(`Текущее ELO не может быть выше ${LIMITS.maxCurrent}.`, current, target, 'current');
  }
  if (target < LIMITS.minTarget) {
    return invalidResult(`Желаемое ELO не может быть ниже ${LIMITS.minTarget}.`, current, target, 'target');
  }
  if (target > LIMITS.maxTarget) {
    return invalidResult(`Желаемое ELO не может быть выше ${LIMITS.maxTarget}.`, current, target, 'target');
  }
  if (target <= current) {
    return invalidResult('Желаемое ELO должно быть выше текущего.', current, target, 'target');
  }

  const difference = target - current;
  const stepCount = getStepCount(difference);
  const basePrice = calculateBasePrice(stepCount);
  const markupRate = addons.reduce((total, addon) => total + Number(addon.rate || 0), 0);
  const markupPrice = Math.round(basePrice * markupRate);
  const totalPrice = basePrice + markupPrice;

  return {
    valid: true,
    error: '',
    current,
    target,
    difference,
    stepCount,
    basePrice,
    markupRate,
    markupPrice,
    totalPrice,
    field: '',
  };
}

export function addFunpayMarkup(sitePrice) {
  const markup = Math.round(Number(sitePrice || 0) * LIMITS.funpayRate);
  return {
    markup,
    total: Math.round(Number(sitePrice || 0)) + markup,
  };
}

export function formatRubles(value) {
  return Math.round(value).toLocaleString('ru-RU');
}

export function createOrderMessage(result, addons = [], checkout = {}) {
  const addonsText = addons.length
    ? addons.map(({ label, rate }) => `${label} (+${Math.round(rate * 100)}%)`).join(', ')
    : 'без дополнительных условий';

  const method = checkout.funpay ? 'FunPay (+5% к цене сайта)' : 'Telegram / сайт';
  const lines = [
    'Здравствуйте! Хочу оформить заказ в Miracle Boost.',
    '',
    `Текущее ELO: ${result.current}`,
    `Желаемое ELO: ${result.target}`,
    `Объём: ${result.difference} ELO`,
    `Шагов по 25 ELO: ${result.stepCount}`,
    `Базовая стоимость: ${formatRubles(result.basePrice)} ₽`,
    `Условия: ${addonsText}`,
    `Способ сделки: ${method}`,
  ];

  if (checkout.funpay) {
    lines.push(`Цена сайта: ${formatRubles(result.totalPrice)} ₽`);
    lines.push(`Наценка FunPay: ${formatRubles(checkout.funpayMarkup || 0)} ₽`);
  }

  lines.push(`Предварительная стоимость: ${formatRubles(checkout.finalPrice ?? result.totalPrice)} ₽`);
  lines.push('');
  lines.push('Подскажите, пожалуйста, сроки и подтвердите итоговую стоимость.');

  return lines.join('\n');
}
