// Pure functions extracted from server.js so they can be tested in isolation,
// without needing a running server or a real database connection.

const crypto = require('crypto');

/**
 * Validates a payment amount before creating a Razorpay order.
 * Returns { valid: true } or { valid: false, error: '...' }
 */
function validateOrderAmount(totalPrice) {
  if (!totalPrice || typeof totalPrice !== 'number' || totalPrice <= 0) {
    return { valid: false, error: 'Invalid amount.' };
  }
  return { valid: true };
}

/**
 * Validates an incoming chat message before calling the AI.
 */
function validateChatMessage(message) {
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return { valid: false, error: 'Invalid message.' };
  }
  if (message.length > 500) {
    return { valid: false, error: 'Message too long.' };
  }
  return { valid: true };
}
function isDishAvailable(quantityAvailable) {
  return quantityAvailable > 0;
}

/**
 * Validates a quantity value before it's inserted into daily_menu.
 * Rejects (rather than silently clamping) so bad input surfaces as an
 * error the owner can fix, instead of quietly becoming 0.
 */
function validateQuantity(quantity) {
  if (typeof quantity !== 'number' || Number.isNaN(quantity) || !Number.isInteger(quantity)) {
    return { valid: false, error: 'Quantity must be a whole number.' };
  }
  if (quantity < 0) {
    return { valid: false, error: 'Quantity cannot be negative.' };
  }
  return { valid: true };
}

/**
 * Validates a star rating (1-5 integer) before it's inserted into ratings.
 */
function validateRating(stars) {
  if (typeof stars !== 'number' || !Number.isInteger(stars)) {
    return { valid: false, error: 'Rating must be a whole number.' };
  }
  if (stars < 1 || stars > 5) {
    return { valid: false, error: 'Rating must be between 1 and 5.' };
  }
  return { valid: true };
}
/**
 * Verifies a Razorpay webhook signature using HMAC-SHA256.
 * Returns true if the signature matches, false otherwise.
 */
function verifyWebhookSignature(body, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return signature === expectedSignature;
}

/**
 * Calculates best-selling dishes from a list of orders.
 * Each order has an `items` field like "Kori Gassi, Boiled Red Rice".
 */
function calculateBestSellers(orders, topN = 6) {
  const dishCounts = {};
  orders.forEach((order) => {
    order.items.split(',').forEach((item) => {
      const name = item.trim();
      dishCounts[name] = (dishCounts[name] || 0) + 1;
    });
  });
  return Object.entries(dishCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/**
 * Determines if a customer counts as "inactive" for re-engagement purposes,
 * based on their last order date.
 */
function isCustomerInactive(lastOrderDate, daysThreshold = 14) {
  if (!lastOrderDate) return false; // never ordered = not "inactive", different case
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysThreshold);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return lastOrderDate < cutoffStr;
}

module.exports = {
  validateOrderAmount,
  validateChatMessage,
  isDishAvailable,
  validateQuantity,
  validateRating,
  verifyWebhookSignature,
  calculateBestSellers,
  isCustomerInactive,
};