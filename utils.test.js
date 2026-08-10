const {
  validateOrderAmount,
  validateChatMessage,
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
