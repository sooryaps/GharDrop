const {
  validateOrderAmount,
  validateChatMessage,
  buildGeminiContents,
  isDishAvailable,
  validateQuantity,
  validateOrderQuantity,
  validateTicketCapacity,
  validateDealComponents,
  validateRating,
  parseItemsString,
  parseItemsWithQuantity,
  formatItemsWithQuantity,
  parseOrderIntentResponse,
  parseComplaintIntentResponse,
  matchDishName,
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

// ---- parseComplaintIntentResponse ----
describe('parseComplaintIntentResponse', () => {
  test('parses a clean detected complaint', () => {
    const raw = '{"isComplaint": true, "summary": "Order arrived cold and 30 minutes late"}';
    const result = parseComplaintIntentResponse(raw);
    expect(result.valid).toBe(true);
    expect(result.data.isComplaint).toBe(true);
    expect(result.data.summary).toBe('Order arrived cold and 30 minutes late');
  });

  test('parses a clean non-complaint', () => {
    const result = parseComplaintIntentResponse('{"isComplaint": false}');
    expect(result.valid).toBe(true);
    expect(result.data.isComplaint).toBe(false);
  });

  test('strips markdown code fences', () => {
    const raw = '```json\n{"isComplaint": true, "summary": "Wrong item delivered"}\n```';
    const result = parseComplaintIntentResponse(raw);
    expect(result.valid).toBe(true);
    expect(result.data.summary).toBe('Wrong item delivered');
  });

  test('rejects malformed JSON instead of throwing', () => {
    expect(parseComplaintIntentResponse('not json').valid).toBe(false);
  });

  test('rejects a response missing isComplaint', () => {
    expect(parseComplaintIntentResponse('{"summary": "test"}').valid).toBe(false);
  });

  test('rejects isComplaint: true with a missing summary', () => {
    expect(parseComplaintIntentResponse('{"isComplaint": true}').valid).toBe(false);
  });

  test('rejects isComplaint: true with an empty summary', () => {
    expect(parseComplaintIntentResponse('{"isComplaint": true, "summary": ""}').valid).toBe(false);
  });

  test('rejects null/empty input without throwing', () => {
    expect(parseComplaintIntentResponse(null).valid).toBe(false);
    expect(parseComplaintIntentResponse('').valid).toBe(false);
  });
});

// ---- parseOrderIntentResponse ----
describe('parseOrderIntentResponse', () => {
  test('parses a clean order-intent response', () => {
    const raw = '{"isOrder": true, "items": [{"name": "Neer Dosa", "quantity": 2}]}';
    const result = parseOrderIntentResponse(raw);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ isOrder: true, items: [{ name: 'Neer Dosa', quantity: 2 }] });
  });

  test('parses a clean non-order response', () => {
    const raw = '{"isOrder": false, "items": []}';
    const result = parseOrderIntentResponse(raw);
    expect(result.valid).toBe(true);
    expect(result.data.isOrder).toBe(false);
  });

  test('strips markdown code fences around the JSON', () => {
    const raw = '```json\n{"isOrder": true, "items": [{"name": "Kori Gassi", "quantity": 1}]}\n```';
    const result = parseOrderIntentResponse(raw);
    expect(result.valid).toBe(true);
    expect(result.data.items[0].name).toBe('Kori Gassi');
  });

  test('rejects malformed JSON instead of throwing', () => {
    const result = parseOrderIntentResponse('this is not json at all');
    expect(result.valid).toBe(false);
  });

  test('rejects a JSON array at the top level', () => {
    const result = parseOrderIntentResponse('[1,2,3]');
    expect(result.valid).toBe(false);
  });

  test('rejects a response missing isOrder', () => {
    const result = parseOrderIntentResponse('{"items": []}');
    expect(result.valid).toBe(false);
  });

  test('rejects isOrder: true with a missing items array', () => {
    const result = parseOrderIntentResponse('{"isOrder": true}');
    expect(result.valid).toBe(false);
  });

  test('treats isOrder: true with an empty items array as not an order (contradictory)', () => {
    const result = parseOrderIntentResponse('{"isOrder": true, "items": []}');
    expect(result.valid).toBe(true);
    expect(result.data.isOrder).toBe(false);
  });

  test('rejects an item with a non-string name', () => {
    const raw = '{"isOrder": true, "items": [{"name": 123, "quantity": 1}]}';
    expect(parseOrderIntentResponse(raw).valid).toBe(false);
  });

  test('rejects an item with a zero or negative quantity', () => {
    const raw = '{"isOrder": true, "items": [{"name": "Kori Gassi", "quantity": 0}]}';
    expect(parseOrderIntentResponse(raw).valid).toBe(false);
  });

  test('rejects an item with a non-integer quantity', () => {
    const raw = '{"isOrder": true, "items": [{"name": "Kori Gassi", "quantity": 1.5}]}';
    expect(parseOrderIntentResponse(raw).valid).toBe(false);
  });

  test('rejects null/empty input without throwing', () => {
    expect(parseOrderIntentResponse(null).valid).toBe(false);
    expect(parseOrderIntentResponse('').valid).toBe(false);
    expect(parseOrderIntentResponse(undefined).valid).toBe(false);
  });
});

// ---- matchDishName ----
describe('matchDishName', () => {
  const menu = ['Neer Dosa (4pc)', 'Kori Gassi', 'Boiled Red Rice', 'Chicken Sukka'];

  test('matches an exact (case-insensitive) name', () => {
    expect(matchDishName('kori gassi', menu)).toBe('Kori Gassi');
  });

  test('matches via unambiguous prefix', () => {
    expect(matchDishName('neer dosa', menu)).toBe('Neer Dosa (4pc)');
  });

  test('returns null for a name not on the menu at all', () => {
    expect(matchDishName('Butter Chicken', menu)).toBeNull();
  });

  test('returns null (refuses to guess) when prefix is ambiguous between two dishes', () => {
    const ambiguousMenu = ['Neer Dosa (4pc)', 'Neer Dosa (2pc)'];
    expect(matchDishName('neer dosa', ambiguousMenu)).toBeNull();
  });

  test('returns null for empty/missing input', () => {
    expect(matchDishName('', menu)).toBeNull();
    expect(matchDishName(null, menu)).toBeNull();
    expect(matchDishName('Kori Gassi', [])).toBeNull();
  });
});

// ---- validateTicketCapacity ----
describe('validateTicketCapacity', () => {
  test('rejects a negative capacity (the ticketCap loophole this closes)', () => {
    expect(validateTicketCapacity(-5).valid).toBe(false);
  });

  test('rejects zero', () => {
    expect(validateTicketCapacity(0).valid).toBe(false);
  });

  test('rejects a non-integer', () => {
    expect(validateTicketCapacity(12.5).valid).toBe(false);
  });

  test('rejects an unrealistically high value', () => {
    expect(validateTicketCapacity(9999).valid).toBe(false);
  });

  test('rejects a non-number type', () => {
    expect(validateTicketCapacity('25').valid).toBe(false);
  });

  test('accepts a normal capacity', () => {
    expect(validateTicketCapacity(25).valid).toBe(true);
  });
});

// ---- validateDealComponents ----
describe('validateDealComponents', () => {
  test('accepts a valid single-component deal', () => {
    expect(validateDealComponents([{ name: 'Neer Dosa (4pc)', quantity: 1 }]).valid).toBe(true);
  });

  test('accepts a valid multi-component deal', () => {
    const components = [
      { name: 'Neer Dosa (4pc)', quantity: 1 },
      { name: 'Boiled Red Rice', quantity: 1 },
    ];
    expect(validateDealComponents(components).valid).toBe(true);
  });

  test('rejects an empty components array', () => {
    expect(validateDealComponents([]).valid).toBe(false);
  });

  test('rejects non-array input', () => {
    expect(validateDealComponents(null).valid).toBe(false);
    expect(validateDealComponents('Neer Dosa').valid).toBe(false);
  });

  test('rejects a component missing a name', () => {
    expect(validateDealComponents([{ quantity: 1 }]).valid).toBe(false);
  });

  test('rejects a component with an invalid (zero) quantity', () => {
    expect(validateDealComponents([{ name: 'Neer Dosa (4pc)', quantity: 0 }]).valid).toBe(false);
  });

  test('rejects a component with a negative quantity', () => {
    expect(validateDealComponents([{ name: 'Neer Dosa (4pc)', quantity: -1 }]).valid).toBe(false);
  });
});

// ---- buildGeminiContents ----
describe('buildGeminiContents', () => {
  test('appends current message with no history', () => {
    const result = buildGeminiContents([], 'hi there');
    expect(result).toEqual([{ role: 'user', parts: [{ text: 'hi there' }] }]);
  });

  test('maps assistant role to model role', () => {
    const history = [{ role: 'assistant', message: 'How can I help?' }];
    const result = buildGeminiContents(history, 'I want dosa');
    expect(result[0].role).toBe('model');
  });

  test('maps user role to user role', () => {
    const history = [{ role: 'user', message: 'hi' }];
    const result = buildGeminiContents(history, 'I want dosa');
    expect(result[0].role).toBe('user');
  });

  test('preserves order and appends current message last', () => {
    const history = [
      { role: 'user', message: 'hi' },
      { role: 'assistant', message: 'Welcome!' },
    ];
    const result = buildGeminiContents(history, 'I want 2 dosa');
    expect(result.map((r) => r.parts[0].text)).toEqual(['hi', 'Welcome!', 'I want 2 dosa']);
  });

  test('handles null/undefined history without throwing', () => {
    expect(buildGeminiContents(null, 'hi').length).toBe(1);
    expect(buildGeminiContents(undefined, 'hi').length).toBe(1);
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