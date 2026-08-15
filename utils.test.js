const {
  validateOrderAmount,
  validateChatMessage,
  isDishAvailable,
  validateQuantity,
  validateOrderQuantity,
  validateRating,
  parseItemsString,
  parseItemsWithQuantity,
  formatItemsWithQuantity,
  validateStatusTransition,
  isValidOwnerToken,
  verifyWebhookSignature,
  calculateBestSellers,
  isCustomerInactive,
} = require('./utils');

const crypto = require('crypto');

// ---- validateOrderAmount ----
describe('validateOrderAmount', () => {
  test('rejects a negative amount', () => {
    const result = validateOrderAmount(-100);
    expect(result.valid).toBe(false);
  });

  test('rejects zero', () => {
    const result = validateOrderAmount(0);
    expect(result.valid).toBe(false);
  });

  test('rejects a non-number', () => {
    const result = validateOrderAmount('220');
    expect(result.valid).toBe(false);
  });

  test('accepts a valid positive number', () => {
    const result = validateOrderAmount(220);
    expect(result.valid).toBe(true);
  });
});

// ---- validateChatMessage ----
describe('validateChatMessage', () => {
  test('rejects an empty message', () => {
    expect(validateChatMessage('').valid).toBe(false);
  });

  test('rejects a message over 500 characters', () => {
    const longMessage = 'a'.repeat(501);
    expect(validateChatMessage(longMessage).valid).toBe(false);
  });

  test('accepts a normal message', () => {
    expect(validateChatMessage('what is on the menu today?').valid).toBe(true);
  });
});

// ---- isDishAvailable ----
describe('isDishAvailable', () => {
  test('unavailable at 0', () => {
    expect(isDishAvailable(0)).toBe(false);
  });

  test('available above 0', () => {
    expect(isDishAvailable(5)).toBe(true);
  });
});

// ---- validateOrderQuantity ----
describe('validateOrderQuantity', () => {
  test('rejects 0 (an order line needs at least 1)', () => {
    expect(validateOrderQuantity(0).valid).toBe(false);
  });

  test('rejects a negative quantity', () => {
    expect(validateOrderQuantity(-2).valid).toBe(false);
  });

  test('rejects a non-integer', () => {
    expect(validateOrderQuantity(1.5).valid).toBe(false);
  });

  test('rejects an unrealistically large quantity', () => {
    expect(validateOrderQuantity(500).valid).toBe(false);
  });

  test('accepts a normal quantity', () => {
    expect(validateOrderQuantity(2).valid).toBe(true);
  });

  test('accepts quantity of 1', () => {
    expect(validateOrderQuantity(1).valid).toBe(true);
  });
});

// ---- validateQuantity ----
describe('validateQuantity', () => {
  test('rejects a negative quantity', () => {
    expect(validateQuantity(-5).valid).toBe(false);
  });

  test('rejects a non-integer (decimal)', () => {
    expect(validateQuantity(3.5).valid).toBe(false);
  });

  test('rejects NaN (e.g. from an empty form field)', () => {
    expect(validateQuantity(NaN).valid).toBe(false);
  });

  test('rejects a non-number type', () => {
    expect(validateQuantity('10').valid).toBe(false);
  });

  test('accepts zero (sold out, valid state)', () => {
    expect(validateQuantity(0).valid).toBe(true);
  });

  test('accepts a valid positive integer', () => {
    expect(validateQuantity(25).valid).toBe(true);
  });
});

// ---- validateRating ----
describe('validateRating', () => {
  test('rejects 0 stars', () => {
    expect(validateRating(0).valid).toBe(false);
  });

  test('rejects above 5 stars', () => {
    expect(validateRating(6).valid).toBe(false);
  });

  test('rejects a decimal rating', () => {
    expect(validateRating(4.5).valid).toBe(false);
  });

  test('rejects a non-number type', () => {
    expect(validateRating('5').valid).toBe(false);
  });

  test('accepts a valid rating', () => {
    expect(validateRating(4).valid).toBe(true);
  });
});

// ---- validateStatusTransition ----
describe('validateStatusTransition', () => {
  test('allows pending -> preparing', () => {
    expect(validateStatusTransition('pending', 'preparing').valid).toBe(true);
  });

  test('allows preparing -> ready', () => {
    expect(validateStatusTransition('preparing', 'ready').valid).toBe(true);
  });

  test('allows ready -> delivered', () => {
    expect(validateStatusTransition('ready', 'delivered').valid).toBe(true);
  });

  test('allows pending -> cancelled', () => {
    expect(validateStatusTransition('pending', 'cancelled').valid).toBe(true);
  });

  test('allows preparing -> cancelled', () => {
    expect(validateStatusTransition('preparing', 'cancelled').valid).toBe(true);
  });

  test('rejects skipping straight from pending to delivered', () => {
    expect(validateStatusTransition('pending', 'delivered').valid).toBe(false);
  });

  test('rejects cancelling an already-ready order', () => {
    expect(validateStatusTransition('ready', 'cancelled').valid).toBe(false);
  });

  test('rejects moving a delivered order anywhere (terminal state)', () => {
    expect(validateStatusTransition('delivered', 'preparing').valid).toBe(false);
  });

  test('rejects moving a cancelled order anywhere (terminal state)', () => {
    expect(validateStatusTransition('cancelled', 'pending').valid).toBe(false);
  });

  test('rejects an unrecognized target status', () => {
    expect(validateStatusTransition('pending', 'exploded').valid).toBe(false);
  });

  test('rejects an unrecognized current status', () => {
    expect(validateStatusTransition('mystery', 'pending').valid).toBe(false);
  });
});

// ---- parseItemsWithQuantity ----
describe('parseItemsWithQuantity', () => {
  test('parses a quantity suffix', () => {
    expect(parseItemsWithQuantity('Neer Dosa (4pc) x2')).toEqual([
      { name: 'Neer Dosa (4pc)', quantity: 2 },
    ]);
  });

  test('defaults to quantity 1 when no suffix (old order format)', () => {
    expect(parseItemsWithQuantity('Kori Gassi, Boiled Red Rice')).toEqual([
      { name: 'Kori Gassi', quantity: 1 },
      { name: 'Boiled Red Rice', quantity: 1 },
    ]);
  });

  test('handles a mix of quantified and plain items', () => {
    expect(parseItemsWithQuantity('Neer Dosa (4pc) x3, Kori Gassi')).toEqual([
      { name: 'Neer Dosa (4pc)', quantity: 3 },
      { name: 'Kori Gassi', quantity: 1 },
    ]);
  });

  test('returns an empty array for empty input', () => {
    expect(parseItemsWithQuantity('')).toEqual([]);
  });
});

// ---- formatItemsWithQuantity ----
describe('formatItemsWithQuantity', () => {
  test('omits x1 for single quantities (matches old format)', () => {
    expect(formatItemsWithQuantity([{ name: 'Kori Gassi', quantity: 1 }])).toBe('Kori Gassi');
  });

  test('includes xN for quantities above 1', () => {
    expect(formatItemsWithQuantity([{ name: 'Neer Dosa (4pc)', quantity: 2 }])).toBe('Neer Dosa (4pc) x2');
  });

  test('formats multiple items correctly', () => {
    expect(
      formatItemsWithQuantity([
        { name: 'Neer Dosa (4pc)', quantity: 2 },
        { name: 'Kori Gassi', quantity: 1 },
      ])
    ).toBe('Neer Dosa (4pc) x2, Kori Gassi');
  });

  test('round-trips through parseItemsWithQuantity', () => {
    const original = 'Neer Dosa (4pc) x3, Kori Gassi x1, Boiled Red Rice';
    const parsed = parseItemsWithQuantity(original);
    const formatted = formatItemsWithQuantity(parsed);
    expect(parseItemsWithQuantity(formatted)).toEqual(parsed);
  });
});

// ---- parseItemsString ----
describe('parseItemsString', () => {
  test('parses a normal comma-separated list', () => {
    expect(parseItemsString('Kori Gassi, Boiled Red Rice')).toEqual(['Kori Gassi', 'Boiled Red Rice']);
  });

  test('trims extra whitespace around names', () => {
    expect(parseItemsString('  Neer Dosa  ,   Chicken Sukka ')).toEqual(['Neer Dosa', 'Chicken Sukka']);
  });

  test('drops empty entries from a trailing comma', () => {
    expect(parseItemsString('Kori Gassi,')).toEqual(['Kori Gassi']);
  });

  test('returns an empty array for empty/missing input', () => {
    expect(parseItemsString('')).toEqual([]);
    expect(parseItemsString(null)).toEqual([]);
    expect(parseItemsString(undefined)).toEqual([]);
  });
});

// ---- isValidOwnerToken ----
describe('isValidOwnerToken', () => {
  test('accepts a matching token', () => {
    expect(isValidOwnerToken('correct-horse-battery', 'correct-horse-battery')).toBe(true);
  });

  test('rejects a wrong token of the same length', () => {
    expect(isValidOwnerToken('correct-horse-batteryX', 'correct-horse-battery1')).toBe(false);
  });

  test('rejects a wrong token of different length', () => {
    expect(isValidOwnerToken('short', 'correct-horse-battery')).toBe(false);
  });

  test('rejects a missing provided token', () => {
    expect(isValidOwnerToken(undefined, 'correct-horse-battery')).toBe(false);
  });

  test('rejects a missing expected token (env var not set)', () => {
    expect(isValidOwnerToken('anything', undefined)).toBe(false);
  });

  test('rejects a non-string provided token without throwing', () => {
    expect(isValidOwnerToken(12345, 'correct-horse-battery')).toBe(false);
  });
});

// ---- verifyWebhookSignature ----
describe('verifyWebhookSignature', () => {
  const secret = 'test_secret_123';
  const body = JSON.stringify({ event: 'payment.captured' });

  test('accepts a correctly computed signature', () => {
    const correctSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, correctSignature, secret)).toBe(true);
  });

  test('rejects a tampered/incorrect signature', () => {
    expect(verifyWebhookSignature(body, 'fake_signature', secret)).toBe(false);
  });

  test('rejects a signature computed with the wrong secret', () => {
    const wrongSecretSignature = crypto.createHmac('sha256', 'wrong_secret').update(body).digest('hex');
    expect(verifyWebhookSignature(body, wrongSecretSignature, secret)).toBe(false);
  });
});

// ---- calculateBestSellers ----
describe('calculateBestSellers', () => {
  test('correctly counts and ranks dishes across multiple orders', () => {
    const orders = [
      { items: 'Kori Gassi, Boiled Red Rice' },
      { items: 'Kori Gassi' },
      { items: 'Neer Dosa' },
    ];
    const result = calculateBestSellers(orders);
    expect(result[0].name).toBe('Kori Gassi');
    expect(result[0].count).toBe(2);
  });

  test('returns an empty array for no orders', () => {
    expect(calculateBestSellers([])).toEqual([]);
  });

  test('respects the topN limit', () => {
    const orders = [
      { items: 'A, B, C, D, E, F, G' },
    ];
    const result = calculateBestSellers(orders, 3);
    expect(result.length).toBe(3);
  });

  test('sums real quantities, not just occurrence count', () => {
    const orders = [
      { items: 'Neer Dosa (4pc) x3, Kori Gassi' },
      { items: 'Neer Dosa (4pc) x2' },
    ];
    const result = calculateBestSellers(orders);
    expect(result[0].name).toBe('Neer Dosa (4pc)');
    expect(result[0].count).toBe(5); // 3 + 2, not 2 occurrences
  });
});

// ---- isCustomerInactive ----
describe('isCustomerInactive', () => {
  test('customer with no orders is not "inactive" (different case)', () => {
    expect(isCustomerInactive(null)).toBe(false);
  });

  test('customer who ordered 20 days ago is inactive (threshold 14)', () => {
    const twentyDaysAgo = new Date();
    twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20);
    const dateStr = twentyDaysAgo.toISOString().split('T')[0];
    expect(isCustomerInactive(dateStr, 14)).toBe(true);
  });

  test('customer who ordered yesterday is NOT inactive', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];
    expect(isCustomerInactive(dateStr, 14)).toBe(false);
  });
});