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
 * Parses an items string that may include per-dish quantities, e.g.
 * "Neer Dosa (4pc) x2, Kori Gassi" -> [{ name: 'Neer Dosa (4pc)', quantity: 2 }, { name: 'Kori Gassi', quantity: 1 }]
 * A dish with no "xN" suffix defaults to quantity 1, so this stays
 * backward-compatible with every order created before quantities existed.
 */
function parseItemsWithQuantity(items) {
  return parseItemsString(items).map((entry) => {
    const match = entry.match(/^(.*)\sx(\d+)$/i);
    if (match) {
      return { name: match[1].trim(), quantity: parseInt(match[2], 10) };
    }
    return { name: entry, quantity: 1 };
  });
}

/**
 * Formats an array of { name, quantity } back into the stored items string.
 * Quantity of 1 is omitted (matches the old plain-name format) so ledgers
 * stay readable for the common single-item case.
 */
function formatItemsWithQuantity(items) {
  return items
    .map((item) => (item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name))
    .join(', ');
}

/**
 * Calculates best-selling dishes from a list of orders, counting real
 * quantities sold (e.g. "Neer Dosa x3" contributes 3, not 1).
 */
function calculateBestSellers(orders, topN = 6) {
  const dishCounts = {};
  orders.forEach((order) => {
    parseItemsWithQuantity(order.items).forEach(({ name, quantity }) => {
      dishCounts[name] = (dishCounts[name] || 0) + quantity;
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

/**
 * Parses a comma-separated items string (e.g. "Kori Gassi, Boiled Red Rice")
 * into a clean array of trimmed dish names. Ignores empty entries so a
 * trailing/stray comma doesn't produce a blank dish name.
 */
function parseItemsString(items) {
  if (!items || typeof items !== 'string') return [];
  return items
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Defines which kitchen_status transitions are legal, so a dashboard click
 * can't skip states (pending -> delivered) or move a terminal order
 * backwards (delivered -> preparing).
 */
const ALLOWED_STATUS_TRANSITIONS = {
  pending: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['delivered'],
  delivered: [],
  cancelled: [],
};

const VALID_KITCHEN_STATUSES = Object.keys(ALLOWED_STATUS_TRANSITIONS);

/**
 * Validates a requested kitchen_status transition.
 * Returns { valid: true } or { valid: false, error: '...' }
 */
function validateStatusTransition(currentStatus, newStatus) {
  if (!VALID_KITCHEN_STATUSES.includes(newStatus)) {
    return { valid: false, error: `"${newStatus}" is not a valid status.` };
  }
  if (!VALID_KITCHEN_STATUSES.includes(currentStatus)) {
    return { valid: false, error: `Order has an unrecognized current status ("${currentStatus}").` };
  }
  const allowedNext = ALLOWED_STATUS_TRANSITIONS[currentStatus];
  if (!allowedNext.includes(newStatus)) {
    return {
      valid: false,
      error: `Cannot move an order from "${currentStatus}" to "${newStatus}".`,
    };
  }
  return { valid: true };
}

/**
 * Timing-safe comparison of the owner dashboard token, so an attacker
 * probing the header can't infer correct characters from response timing.
 * Returns false (not throw) on any malformed/missing input.
 */
function isValidOwnerToken(providedToken, expectedToken) {
  if (!providedToken || !expectedToken) return false;
  if (typeof providedToken !== 'string' || typeof expectedToken !== 'string') return false;

  const providedBuf = Buffer.from(providedToken);
  const expectedBuf = Buffer.from(expectedToken);

  // Lengths must match before calling timingSafeEqual (it throws otherwise).
  // This length check itself doesn't leak useful timing info since token
  // length isn't secret in the same way its content is.
  if (providedBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Validates a quantity requested WITHIN an order (e.g. "2 neer dosa").
 * Unlike validateQuantity (menu stock, which can legitimately be 0),
 * an order line must request at least 1 of something.
 */
function validateOrderQuantity(quantity) {
  if (typeof quantity !== 'number' || Number.isNaN(quantity) || !Number.isInteger(quantity)) {
    return { valid: false, error: 'Quantity must be a whole number.' };
  }
  if (quantity < 1) {
    return { valid: false, error: 'Quantity must be at least 1.' };
  }
  if (quantity > 50) {
    return { valid: false, error: 'Quantity per item seems unrealistically high — please double check.' };
  }
  return { valid: true };
}

/**
 * Safely parses and validates the JSON Gemini is asked to return for
 * order-intent detection. Handles the common failure modes of LLM
 * "structured output": markdown code fences around the JSON, extra
 * prose before/after, missing fields, or wrong types. Never throws —
 * always returns a validated shape or a clear reason it failed, so a
 * malformed AI response degrades to "treat as not an order" rather than
 * crashing or (worse) being trusted blindly.
 */
function parseOrderIntentResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { valid: false, error: 'Empty or non-string response.' };
  }

  // Strip common markdown code-fence wrapping (```json ... ``` or ``` ... ```)
  const stripped = rawText.replace(/```json\s*|```\s*/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return { valid: false, error: 'Response was not valid JSON.' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, error: 'Response was not a JSON object.' };
  }

  if (typeof parsed.isOrder !== 'boolean') {
    return { valid: false, error: 'Missing or invalid "isOrder" field.' };
  }

  if (!parsed.isOrder) {
    return { valid: true, data: { isOrder: false, items: [] } };
  }

  if (!Array.isArray(parsed.items)) {
    return { valid: false, error: 'Missing or invalid "items" array.' };
  }

  const cleanItems = [];
  for (const item of parsed.items) {
    if (
      !item ||
      typeof item.name !== 'string' ||
      item.name.trim().length === 0 ||
      typeof item.quantity !== 'number' ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1
    ) {
      return { valid: false, error: `Malformed item in response: ${JSON.stringify(item)}` };
    }
    cleanItems.push({ name: item.name.trim(), quantity: item.quantity });
  }

  if (cleanItems.length === 0) {
    // isOrder: true but no items is contradictory — treat as not an order
    // rather than guessing what was meant.
    return { valid: true, data: { isOrder: false, items: [] } };
  }

  return { valid: true, data: { isOrder: true, items: cleanItems } };
}

/**
 * Matches an AI-extracted (possibly imperfect) dish name against the real
 * list of today's menu item names. This is a safety net independent of
 * how well the AI followed instructions to only use real menu names —
 * it never invents a match for something that isn't actually on the menu.
 *
 * Match order: exact (case-insensitive) match first, then a "menu name
 * starts with the requested name" match (handles "neer dosa" matching
 * "Neer Dosa (4pc)"). Returns null if nothing reasonably matches — the
 * caller should treat that as "ask the customer to clarify," never as
 * a silent guess.
 */
function matchDishName(requestedName, menuNames) {
  if (!requestedName || !Array.isArray(menuNames) || menuNames.length === 0) return null;

  const normalizedRequest = requestedName.trim().toLowerCase();

  const exactMatch = menuNames.find((name) => name.toLowerCase() === normalizedRequest);
  if (exactMatch) return exactMatch;

  const prefixMatches = menuNames.filter((name) =>
    name.toLowerCase().startsWith(normalizedRequest)
  );
  // Only auto-match if exactly one menu item starts with the requested
  // name — if it's ambiguous (e.g. two dishes both start with "Neer"),
  // refuse to guess rather than silently picking one.
  if (prefixMatches.length === 1) return prefixMatches[0];

  return null;
}

module.exports = {
  validateOrderAmount,
  validateChatMessage,
  isDishAvailable,
  validateQuantity,
  validateOrderQuantity,
  validateRating,
  parseItemsString,
  parseItemsWithQuantity,
  formatItemsWithQuantity,
  parseOrderIntentResponse,
  matchDishName,
  validateStatusTransition,
  VALID_KITCHEN_STATUSES,
  isValidOwnerToken,
  verifyWebhookSignature,
  calculateBestSellers,
  isCustomerInactive,
};