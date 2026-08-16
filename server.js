// Load secret keys from .env into process.env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Razorpay = require('razorpay');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cron = require('node-cron');
const {
  validateOrderAmount,
  validateChatMessage,
  validateQuantity,
  validateOrderQuantity,
  validateTicketCapacity,
  validateDealComponents,
  validateRating,
  parseItemsWithQuantity,
  formatItemsWithQuantity,
  parseOrderIntentResponse,
  matchDishName,
  validateStatusTransition,
  isValidOwnerToken,
} = require('./utils');

// ---- Setup connections ----
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ---- Security middleware ----
app.use(helmet());

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // max 20 requests per minute per IP
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', limiter);

// ---- Standard middleware ----
app.use(express.json());
app.use(cors());

// ---- Owner-only route protection ----
// Simple shared-secret token, not a full session system — proportional to
// a single-owner tool. Compared via timing-safe equality (isValidOwnerToken)
// so the token can't be guessed via response-time differences.
function requireOwnerAuth(req, res, next) {
  const token = req.headers['x-owner-token'];
  if (!isValidOwnerToken(token, process.env.OWNER_DASHBOARD_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

// ---- Test route ----
app.get('/', (req, res) => {
  res.send('Ghardrop backend is running!');
});

// ---- Helper: embed a text string via Gemini's embedding model ----
async function embedText(text) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
    }
  );
  const data = await response.json();
  return data.embedding?.values;
}

// ---- Helper: detects whether an incoming message is an order request,
// and if so, extracts {name, quantity} pairs — matched against the REAL
// menu, not just whatever the AI says. This function never creates an
// order itself; it only classifies intent. Every extracted item still
// has to pass resolveOrderItems' live stock/price check later, same as
// any other checkout. Fails safe: any parsing ambiguity, malformed AI
// output, or unmatched dish name results in isOrder: false rather than
// a guess, so a misfire never accidentally creates a payment link.
async function detectOrderIntent(message, availableMenuNames) {
  if (availableMenuNames.length === 0) {
    // Nothing is being sold today — there's nothing to order, don't
    // even bother calling the AI.
    return { isOrder: false, items: [], unmatchedNames: [] };
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: message }] }],
          systemInstruction: {
            parts: [
              {
                text: `You classify a customer WhatsApp message for a food ordering system. Reply with ONLY raw JSON, no markdown, no explanation, matching exactly this shape:
{"isOrder": boolean, "items": [{"name": string, "quantity": integer}]}

Rules:
- Only set isOrder: true if the customer is clearly trying to place/confirm an order (e.g. "I want 2 neer dosa", "give me kori gassi", "2 of that please").
- Questions, greetings, or general chat about the menu are isOrder: false with an empty items array.
- Every "name" in items MUST be copied exactly from this list of today's actual available dishes — never invent or guess a dish name that isn't in this list:
${availableMenuNames.map((n) => `- ${n}`).join('\n')}
- If the customer's message doesn't clearly map to one of the dishes above, do not include it as an item.
- Default quantity to 1 if the customer didn't specify a number.`,
              },
            ],
          },
          generationConfig: { maxOutputTokens: 512 },
        }),
      }
    );

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    const parsed = parseOrderIntentResponse(rawText);
    if (!parsed.valid || !parsed.data.isOrder) {
      return { isOrder: false, items: [], unmatchedNames: [] };
    }

    // Second, independent check: match every AI-claimed name against the
    // real menu ourselves. If the AI hallucinated a name despite
    // instructions, matchDishName returns null for it and we drop it —
    // we never trust the AI's word alone that a name is real.
    const matchedItems = [];
    const unmatchedNames = [];
    for (const item of parsed.data.items) {
      const matched = matchDishName(item.name, availableMenuNames);
      if (matched) {
        matchedItems.push({ name: matched, quantity: item.quantity });
      } else {
        unmatchedNames.push(item.name);
      }
    }

    if (matchedItems.length === 0) {
      return { isOrder: false, items: [], unmatchedNames };
    }

    return { isOrder: true, items: matchedItems, unmatchedNames };
  } catch (error) {
    console.error('Order intent detection error:', error);
    // Any failure (network, parsing, unexpected shape) fails safe to
    // "not an order" — worst case the customer gets a normal chat reply
    // instead of an order, never the reverse.
    return { isOrder: false, items: [], unmatchedNames: [] };
  }
}

// ---- Chat route: talks to Gemini, using live menu + customer history ----
// ---- Helper: generates a conversational reply using live menu, deals,
// semantic search, and customer order history. Extracted so both the
// public /api/chat route AND the WhatsApp webhook can call this directly
// — previously the webhook self-called /api/chat over HTTP to localhost,
// which added an unnecessary network hop and re-triggered the rate
// limiter against itself. Direct function calls avoid both.
async function generateChatReply(message, phone) {
  const today = new Date().toISOString().split('T')[0];

  const { data: todaysMenu } = await supabase
    .from('daily_menu')
    .select('price_today, quantity_available, menu_items(name, tags, description)')
    .eq('date', today);
  const availableMenu = (todaysMenu || []).filter((item) => item.quantity_available > 0);

  const queryEmbedding = await embedText(message);

  let semanticMatches = '';
  if (queryEmbedding) {
    const { data: matches } = await supabase.rpc('match_menu_items', {
      query_embedding: queryEmbedding,
      match_threshold: 0.78,
      match_count: 2,
    });
    if (matches && matches.length > 0) {
      semanticMatches = matches.map((m) => `- ${m.name} (similarity: ${m.similarity.toFixed(2)})`).join('\n');
    }
  }

  const { data: todaysDeals } = await supabase
    .from('daily_deals')
    .select('*')
    .eq('date', today);

  let historyText = 'No past order history available.';
  if (phone) {
    const { data: pastOrders } = await supabase
      .from('orders')
      .select('items, total_price, date')
      .eq('customer_phone', phone)
      .eq('status', 'completed')
      .order('date', { ascending: false })
      .limit(5);

    if (pastOrders && pastOrders.length > 0) {
      historyText = pastOrders
        .map((o) => `- ${o.date}: ${o.items} (₹${o.total_price})`)
        .join('\n');
    }
  }

  const menuText = (availableMenu || [])
    .map((item) => `- ${item.menu_items.name}: ₹${item.price_today} (${item.menu_items.tags})`)
    .join('\n');

  const dealText = todaysDeals && todaysDeals.length > 0
    ? todaysDeals
        .filter((d) => d.remaining_count > 0)
        .map((d) => `- Today's deal "${d.title}": ${d.items} for ₹${d.price}${d.original_price ? ` (normally ₹${d.original_price})` : ''} — ${d.remaining_count} left`)
        .join('\n') || 'No special deals available right now (sold out).'
    : 'No special deal today.';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: message }] }],
        systemInstruction: {
          parts: [
            {
              text: `You are Ghardrop's ordering assistant. Only recommend dishes from today's actual menu below — never mention anything not listed. Keep replies short, 2-3 sentences, conversational.

Today's menu:
${menuText || 'No menu has been posted yet today — let the customer know to check back soon.'}
Semantically similar dishes to the customer's query (ONLY mention these if the customer's question is actually about food preferences/taste — ignore this section entirely for greetings or general menu questions):
${semanticMatches || 'No strong semantic matches found.'}
${dealText}

This customer's past orders (use this to personalize recommendations naturally, don't just list it back robotically):
${historyText}`,
            },
          ],
        },
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, no response.';
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, phone } = req.body;

    const messageCheck = validateChatMessage(message);
    if (!messageCheck.valid) {
      return res.status(400).json({ error: messageCheck.error });
    }

    const reply = await generateChatReply(message, phone);
    res.json({ reply });
  } catch (error) {
    console.error('Chat route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- WhatsApp webhook verification (Meta calls this once, GET) ----
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---- Helper: sends a WhatsApp text message to a customer ----
async function sendWhatsAppMessage(to, body) {
  const result = await fetch(
    `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        text: { body },
      }),
    }
  );
  const data = await result.json();
  console.log('WhatsApp send result:', JSON.stringify(data, null, 2));
  return data;
}

// ---- WhatsApp incoming messages (Meta calls this every time, POST) ----
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const from = message.from;
    const text = message.text.body;
    console.log(`Message from ${from}: ${text}`);

    const today = new Date().toISOString().split('T')[0];
    const { data: todaysMenu } = await supabase
      .from('daily_menu')
      .select('quantity_available, menu_items(name)')
      .eq('date', today);
    const availableMenuNames = (todaysMenu || [])
      .filter((item) => item.quantity_available > 0)
      .map((item) => item.menu_items.name);

    const intent = await detectOrderIntent(text, availableMenuNames);

    if (intent.isOrder && intent.items.length > 0) {
      const itemsString = formatItemsWithQuantity(intent.items);
      const result = await createPaymentLinkForOrder({ items: itemsString, customerPhone: from });

      if (result.ok) {
        await sendWhatsAppMessage(
          from,
          `Got it! Your order: ${result.items} — ₹${result.totalPrice}.\n\nPay here to confirm: ${result.shortUrl}`
        );
      } else {
        // Stock ran out, item unmatched, etc — tell the customer plainly
        // rather than silently failing or falling back to generic chat,
        // since they clearly tried to order something specific.
        await sendWhatsAppMessage(from, result.error);
      }
      return;
    }

    // Not a detected order (or a detected-but-unmatched attempt with no
    // valid items) — fall back to normal conversational reply.
    const reply = await generateChatReply(text, from);
    await sendWhatsAppMessage(from, reply);
  } catch (error) {
    console.error('Webhook error:', error);
  }
});

// ---- Helper: resolves each requested {name, quantity} against today's
// daily_menu in one place. Returns, per item: whether it exists on today's
// menu, whether there's enough stock, its real price_today, and its
// canonical (correctly-cased) name from the database. This is the single
// source of truth for both the stock check AND the price calculation below
// — the server trusts nothing the client claims about price or item names.
async function resolveOrderItems(requestedItems, today) {
  const resolved = [];

  for (const item of requestedItems) {
    const { data: menuRow } = await supabase
      .from('daily_menu')
      .select('quantity_available, price_today, menu_items!inner(name)')
      .eq('date', today)
      .ilike('menu_items.name', item.name)
      .single();

    resolved.push({
      requestedName: item.name,
      quantity: item.quantity,
      found: !!menuRow,
      canonicalName: menuRow ? menuRow.menu_items.name : item.name,
      priceToday: menuRow ? menuRow.price_today : null,
      availableQty: menuRow ? menuRow.quantity_available : 0,
    });
  }

  return resolved;
}

// ---- Helper: validates AND prices a DEAL order, for a SPECIFIC deal by
// ID — necessary now that multiple deals can exist on the same day.
// Reuses resolveOrderItems on the deal's stored components, so each
// component dish's real stock is checked the exact same way a regular
// order would check it — a deal can't bypass inventory limits. Price
// comes from the deal's bundle price (daily_deals.price), not the sum of
// individual component prices. Also checks the deal's OWN ticket capacity.
async function resolveDealOrder(dealId, today) {
  const { data: deal } = await supabase
    .from('daily_deals')
    .select('*')
    .eq('id', dealId)
    .single();

  if (!deal) {
    return { ok: false, status: 404, error: 'That deal could not be found.' };
  }
  if (deal.date !== today) {
    // Prevents paying against a stale deal ID from a previous day, e.g. a
    // link/reference held onto after the deal expired.
    return { ok: false, status: 410, error: 'That deal is no longer available (expired).' };
  }
  if (deal.remaining_count <= 0) {
    return { ok: false, status: 409, error: `Sorry, "${deal.title}" is sold out.` };
  }
  if (!Array.isArray(deal.components) || deal.components.length === 0) {
    // Data integrity issue, not a customer error — log for investigation.
    console.log(`DEAL MISCONFIGURED: deal id ${deal.id} for ${today} has no components.`);
    return { ok: false, status: 500, error: "That deal isn't set up correctly. Please try individual items." };
  }

  const resolvedItems = await resolveOrderItems(deal.components, today);

  const notFound = resolvedItems.filter((i) => !i.found).map((i) => i.requestedName);
  const outOfStock = resolvedItems
    .filter((i) => i.found && i.availableQty < i.quantity)
    .map((i) => `${i.canonicalName} (wanted ${i.quantity}, ${i.availableQty} left)`);

  if (notFound.length > 0 || outOfStock.length > 0) {
    const problems = [];
    if (outOfStock.length > 0) problems.push(`not enough stock: ${outOfStock.join(', ')}`);
    if (notFound.length > 0) problems.push(`unavailable: ${notFound.join(', ')}`);
    return {
      ok: false,
      status: 409,
      error: `Sorry, "${deal.title}" can't be fulfilled right now (${problems.join('; ')}).`,
      outOfStock,
      notFound,
    };
  }

  const canonicalItemsString = formatItemsWithQuantity(
    resolvedItems.map((i) => ({ name: i.canonicalName, quantity: i.quantity }))
  );

  return { ok: true, totalPrice: deal.price, canonicalItemsString, isDealOrder: true, dealId: deal.id };
}

// ---- Helper: validates AND prices an order from raw item names+quantities.
// This is the single, shared security gate for EVERY way a customer can pay
// (browser checkout, WhatsApp Payment Link, any future entry point) — they
// all call this same function so stock/price rules can never drift apart
// between different payment flows. Returns either a ready-to-charge order
// or a structured error describing exactly what's wrong.
async function validateAndPriceOrder(items, today) {
  const requestedItems = parseItemsWithQuantity(items);
  if (requestedItems.length === 0) {
    return { ok: false, status: 400, error: 'No items in order.' };
  }

  for (const item of requestedItems) {
    const qtyCheck = validateOrderQuantity(item.quantity);
    if (!qtyCheck.valid) {
      return { ok: false, status: 400, error: `Invalid quantity for "${item.name}": ${qtyCheck.error}` };
    }
  }

  const resolvedItems = await resolveOrderItems(requestedItems, today);

  const notFound = resolvedItems.filter((i) => !i.found).map((i) => i.requestedName);
  const outOfStock = resolvedItems
    .filter((i) => i.found && i.availableQty < i.quantity)
    .map((i) => `${i.canonicalName} (wanted ${i.quantity}, ${i.availableQty} left)`);

  if (notFound.length > 0 || outOfStock.length > 0) {
    const problems = [];
    if (outOfStock.length > 0) problems.push(`not enough stock: ${outOfStock.join(', ')}`);
    if (notFound.length > 0) problems.push(`not on today's menu: ${notFound.join(', ')}`);
    return {
      ok: false,
      status: 409,
      error: `Sorry, some items can't be ordered right now (${problems.join('; ')}). Please update your order.`,
      outOfStock,
      notFound,
    };
  }

  // Server-computed total — the only number that ever reaches Razorpay,
  // regardless of which entry point (browser or WhatsApp) is charging.
  const totalPrice = resolvedItems.reduce((sum, i) => sum + i.priceToday * i.quantity, 0);

  const amountCheck = validateOrderAmount(totalPrice);
  if (!amountCheck.valid) {
    return { ok: false, status: 400, error: 'Order total is invalid.' };
  }

  const canonicalItemsString = formatItemsWithQuantity(
    resolvedItems.map((i) => ({ name: i.canonicalName, quantity: i.quantity }))
  );

  return { ok: true, totalPrice, canonicalItemsString };
}

// ---- Create a Razorpay payment order (browser/Checkout.js flow) ----
// SECURITY NOTE: the client sends item names + quantities only. It does
// NOT send a trusted price — validateAndPriceOrder always calculates the
// amount itself from real daily_menu.price_today values.
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, customerPhone, dealId } = req.body;
    const today = new Date().toISOString().split('T')[0];

    const priced = dealId
      ? await resolveDealOrder(dealId, today)
      : await validateAndPriceOrder(items, today);

    if (!priced.ok) {
      return res.status(priced.status).json({ error: priced.error, outOfStock: priced.outOfStock, notFound: priced.notFound });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(priced.totalPrice * 100), // paise
      currency: 'INR',
      receipt: `ghardrop_${Date.now()}`,
      // Razorpay notes values must be strings. Storing the actual dealId
      // (not just true/false) is what lets the webhook decrement the
      // CORRECT deal now that multiple deals can exist on the same day.
      notes: { items: priced.canonicalItemsString, customerPhone, dealId: priced.dealId ? String(priced.dealId) : '' },
    });

    res.json({
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      totalPrice: priced.totalPrice,
      items: priced.canonicalItemsString,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('Payment order creation error:', error);
    res.status(500).json({ error: 'Could not create payment order.' });
  }
});

// ---- Helper: creates a real Razorpay Payment Link for an order, either
// regular items or a specific deal. Extracted so the WhatsApp webhook can
// call this directly (no HTTP self-call) when it detects order intent.
async function createPaymentLinkForOrder({ items, customerPhone, dealId }) {
  const today = new Date().toISOString().split('T')[0];

  const priced = dealId
    ? await resolveDealOrder(dealId, today)
    : await validateAndPriceOrder(items, today);

  if (!priced.ok) {
    return priced; // { ok: false, status, error, outOfStock, notFound }
  }

  const paymentLink = await razorpay.paymentLink.create({
    amount: Math.round(priced.totalPrice * 100), // paise
    currency: 'INR',
    description: priced.canonicalItemsString,
    reference_id: `ghardrop_${Date.now()}`.slice(0, 40), // Razorpay caps reference_id at 40 chars
    customer: { contact: customerPhone },
    notify: { sms: false, whatsapp: false }, // WE send it via WhatsApp ourselves, not Razorpay
    notes: { items: priced.canonicalItemsString, customerPhone, dealId: priced.dealId ? String(priced.dealId) : '' },
  });

  return {
    ok: true,
    paymentLinkId: paymentLink.id,
    shortUrl: paymentLink.short_url,
    totalPrice: priced.totalPrice,
    items: priced.canonicalItemsString,
  };
}

// ---- Create a Razorpay Payment Link (WhatsApp flow) ----
// Same validateAndPriceOrder gate as /api/create-order — a WhatsApp order
// is priced and stock-checked exactly the same way a browser order is.
// Produces a plain https://rzp.io/... URL that works inside a WhatsApp
// text message (Checkout.js's popup widget does not).
app.post('/api/create-payment-link', requireOwnerAuth, async (req, res) => {
  try {
    const { items, customerPhone, dealId } = req.body;

    if (!customerPhone || typeof customerPhone !== 'string') {
      return res.status(400).json({ error: 'customerPhone is required.' });
    }

    const result = await createPaymentLinkForOrder({ items, customerPhone, dealId });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, outOfStock: result.outOfStock, notFound: result.notFound });
    }

    res.json({
      paymentLinkId: result.paymentLinkId,
      shortUrl: result.shortUrl,
      totalPrice: result.totalPrice,
      items: result.items,
    });
  } catch (error) {
    console.error('Payment link creation error:', error);
    res.status(500).json({ error: 'Could not create payment link.' });
  }
});

// ---- Helper: sends the post-order rating request over WhatsApp ----
async function sendRatingRequest(orderId, customerPhone) {
  await fetch(
    `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: customerPhone,
        text: { body: `Hope you enjoyed your meal! Reply with a rating 1-5 stars for order #${orderId} 🌟` },
      }),
    }
  );
}

// ---- Razorpay webhook: confirms real payment, THEN writes to database ----
app.post('/razorpay-webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const body = JSON.stringify(req.body);

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.log('Invalid webhook signature — ignoring.');
    return res.status(400).send('Invalid signature');
  }

  res.status(200).send('OK'); // acknowledge immediately

  const event = req.body.event;
  if (event !== 'payment.captured') {
    return;
  }

  const payment = req.body.payload.payment.entity;
  const { items, customerPhone, dealId } = payment.notes;
  const amountRupees = payment.amount / 100;
  const today = new Date().toISOString().split('T')[0];
  const wasDealOrder = !!dealId;

  console.log(`Payment confirmed: ₹${amountRupees} from ${customerPhone} for ${items}${wasDealOrder ? ` (DEAL id ${dealId})` : ''}`);

  const { error: insertError } = await supabase.from('orders').insert({
    customer_phone: customerPhone,
    items: items,
    total_price: amountRupees,
    status: 'completed',
    date: today,
  });

  if (insertError) {
    console.log('ORDER INSERT FAILED:', insertError.message);
  } else {
    console.log('Order successfully inserted into database.');

    const { data: newOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('customer_phone', customerPhone)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const orderedItems = parseItemsWithQuantity(items);
    for (const { name: dishName, quantity } of orderedItems) {
      const { data: menuRow } = await supabase
        .from('daily_menu')
        .select('id, menu_items!inner(name)')
        .eq('date', today)
        .ilike('menu_items.name', dishName)
        .single();

      if (menuRow) {
        // Atomic: decrements by the real quantity ordered, and the SQL
        // function's own WHERE clause refuses to go below 0 even under
        // concurrent requests. See decrement_quantity() in Supabase.
        const { data: decremented, error: decrementError } = await supabase.rpc('decrement_quantity', {
          row_id: menuRow.id,
          amount: quantity,
        });
        if (decrementError) {
          console.log(`QUANTITY DECREMENT FAILED for ${dishName} x${quantity}:`, decrementError.message);
        } else if (!decremented) {
          // Payment already succeeded — money moved — but stock ran out
          // between checkout and this webhook (race condition). This is
          // a real oversell that needs a human, not a silent failure.
          console.log(`OVERSOLD: ${dishName} x${quantity} — payment captured but insufficient stock at decrement time. Manual review needed for order from ${customerPhone}.`);
        }
      }
    }

    if (wasDealOrder) {
      // Atomic, same pattern as decrement_ticket — refuses to go below 0
      // even under concurrent deal payments. This is IN ADDITION TO the
      // per-dish decrement above, which already covers the deal's
      // component dishes correctly since `items` contains them. Keyed by
      // the specific dealId (not date) now that multiple deals per day
      // are supported.
      const { data: dealDecremented, error: dealTicketError } = await supabase.rpc('decrement_deal_ticket', {
        row_id: Number(dealId),
      });
      if (dealTicketError) {
        console.log(`DEAL TICKET DECREMENT FAILED for deal ${dealId}:`, dealTicketError.message);
      } else if (!dealDecremented) {
        console.log(`DEAL OVERSOLD: deal ${dealId} — payment captured but deal was already at 0 remaining. Manual review needed for order from ${customerPhone}.`);
      }
    }

    if (newOrder) {
      setTimeout(() => {
        sendRatingRequest(newOrder.id, customerPhone);
      }, 2 * 60 * 60 * 1000); // 2 hours
    }
  }

  // Atomic ticket decrement — fixed 2026-08: previous version did a
  // read-then-write which could go negative under concurrent payments
  // or when remaining_count was already 0. decrement_ticket() does the
  // check-and-decrement in a single SQL statement.
  const { data: decremented, error: ticketError } = await supabase.rpc('decrement_ticket', {
    row_date: today,
  });

  if (ticketError) {
    console.log('TICKET DECREMENT FAILED:', ticketError.message);
  } else if (!decremented) {
    console.log('Ticket decrement skipped — already at 0 for today (sold out or race avoided).');
  } else {
    console.log('Ticket count successfully decremented.');
  }
});

// ---- Mom uses this each day to set what's being cooked, prices, and today's deal ----
app.post('/api/daily-menu', requireOwnerAuth, async (req, res) => {
  try {
    const { items, deals, ticketCap } = req.body;
    const today = new Date().toISOString().split('T')[0];

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Menu must include at least one item.' });
    }

    // Validate every quantity BEFORE touching the database. Reject the
    // whole upload on the first bad value rather than partially saving —
    // this was the confirmed root cause of the negative-quantity bug.
    for (const item of items) {
      const quantityCheck = validateQuantity(item.quantity);
      if (!quantityCheck.valid) {
        return res.status(400).json({
          error: `Invalid quantity for item "${item.name || item.menuItemId}": ${quantityCheck.error}`,
        });
      }
    }

    // Validate the daily order-capacity ticket count. Previously
    // `ticketCap || 25` let a negative number through unchanged (negative
    // numbers are truthy in JS) — this closes that gap.
    const capacityToUse = ticketCap === undefined || ticketCap === null ? 25 : ticketCap;
    const capacityCheck = validateTicketCapacity(capacityToUse);
    if (!capacityCheck.valid) {
      return res.status(400).json({ error: `Invalid Total Tickets Today: ${capacityCheck.error}` });
    }

    // `deals` is now an array — 0, 1, or many deals can exist on the same
    // day. Each is validated independently, same fail-fast-and-whole
    // principle as the quantity check above: if ANY deal is invalid, the
    // whole save is rejected before anything is written, rather than
    // silently saving some deals and dropping bad ones.
    const dealsToValidate = Array.isArray(deals) ? deals : [];
    const todaysCheckedNames = items.map((i) => i.name).filter(Boolean);
    const validatedDeals = [];

    for (const deal of dealsToValidate) {
      if (!deal.title || typeof deal.title !== 'string' || deal.title.trim().length === 0) {
        return res.status(400).json({ error: 'Every deal needs a title.' });
      }

      const dealCapacityToUse = deal.capacity === undefined || deal.capacity === null ? 25 : deal.capacity;
      const dealCapacityCheck = validateTicketCapacity(dealCapacityToUse);
      if (!dealCapacityCheck.valid) {
        return res.status(400).json({ error: `Invalid capacity for deal "${deal.title}": ${dealCapacityCheck.error}` });
      }

      const componentsCheck = validateDealComponents(deal.components);
      if (!componentsCheck.valid) {
        return res.status(400).json({ error: `Deal "${deal.title}": ${componentsCheck.error}` });
      }

      const unknownComponents = deal.components
        .map((c) => c.name)
        .filter((name) => !matchDishName(name, todaysCheckedNames));
      if (unknownComponents.length > 0) {
        return res.status(400).json({
          error: `Deal "${deal.title}" components must be dishes checked in today's menu. Not found: ${unknownComponents.join(', ')}`,
        });
      }

      const priceCheck = validateOrderAmount(deal.price);
      if (!priceCheck.valid) {
        return res.status(400).json({ error: `Invalid price for deal "${deal.title}": ${priceCheck.error}` });
      }

      validatedDeals.push({
        title: deal.title.trim(),
        components: deal.components,
        price: deal.price,
        originalPrice: deal.originalPrice || null,
        capacity: dealCapacityToUse,
      });
    }

    const dailyMenuRows = items.map((item) => ({
      date: today,
      menu_item_id: item.menuItemId,
      price_today: item.price,
      quantity_available: item.quantity,
    }));

    await supabase.from('daily_menu').delete().eq('date', today);
    const { error: menuError } = await supabase.from('daily_menu').insert(dailyMenuRows);
    if (menuError) {
      console.log('DAILY MENU INSERT FAILED:', menuError.message);
      return res.status(500).json({ error: 'Could not save menu.' });
    }

    // Delete-then-reinsert-all is the same idempotent pattern used for
    // daily_menu — re-saving the page always reflects exactly what's in
    // the form, clearing any deals removed since the last save. Now
    // inserts however many deals were validated above (0, 1, or many).
    await supabase.from('daily_deals').delete().eq('date', today);
    if (validatedDeals.length > 0) {
      const dealRows = validatedDeals.map((deal) => ({
        date: today,
        title: deal.title,
        // items (display string) is derived from the validated, structured
        // components — never free text — so what's shown always matches
        // what checkout will actually decrement.
        items: formatItemsWithQuantity(deal.components),
        components: deal.components,
        price: deal.price,
        original_price: deal.originalPrice,
        total_capacity: deal.capacity,
        remaining_count: deal.capacity,
      }));
      const { error: dealError } = await supabase.from('daily_deals').insert(dealRows);
      if (dealError) {
        console.log('DAILY DEALS INSERT FAILED:', dealError.message);
        return res.status(500).json({ error: 'Menu saved, but could not save the deal(s).' });
      }
    }

    const { error: ticketError } = await supabase
      .from('tickets')
      .upsert({ date: today, total_capacity: capacityToUse, remaining_count: capacityToUse });
    if (ticketError) console.log('TICKET UPSERT FAILED:', ticketError.message);

    res.json({ success: true, message: `Today's menu saved with ${items.length} items.` });
  } catch (error) {
    console.error('Daily menu route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Quick "Sold Out" toggle — instantly sets one dish's remaining
// stock to 0 for today, WITHOUT requiring the whole menu form to be
// resubmitted. This is for the real moment something runs out mid-day —
// a single tap, not reopening the full menu page. Also supports
// "un-sold-out" (restoring a quantity) via the same route, so a
// misclick is recoverable. ----
app.patch('/api/daily-menu/:menuItemId/stock', requireOwnerAuth, async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const { quantity_available } = req.body;
    const today = new Date().toISOString().split('T')[0];

    const quantityCheck = validateQuantity(quantity_available);
    if (!quantityCheck.valid) {
      return res.status(400).json({ error: quantityCheck.error });
    }

    const { data, error } = await supabase
      .from('daily_menu')
      .update({ quantity_available })
      .eq('date', today)
      .eq('menu_item_id', menuItemId)
      .select()
      .single();

    if (error || !data) {
      return res.status(error ? 500 : 404).json({
        error: error ? 'Could not update stock.' : "This dish isn't part of today's live menu yet — save the menu first.",
      });
    }

    res.json({ success: true, quantity_available: data.quantity_available });
  } catch (error) {
    console.error('Quick stock update route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Mom uses this to add a brand new dish to the master list (not tied
// to any specific day — it just makes the dish available to check next
// time she builds today's live menu). ----
app.post('/api/menu-items', requireOwnerAuth, async (req, res) => {
  try {
    const { name, base_price, description, tags } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Dish name is required.' });
    }
    const priceCheck = validateOrderAmount(base_price);
    if (!priceCheck.valid) {
      return res.status(400).json({ error: `Invalid price: ${priceCheck.error}` });
    }

    const { data, error } = await supabase
      .from('menu_items')
      .insert({
        name: name.trim(),
        base_price,
        description: description || null,
        tags: tags || null,
      })
      .select()
      .single();

    if (error) {
      console.log('MENU ITEM INSERT FAILED:', error.message);
      return res.status(500).json({ error: 'Could not add dish.' });
    }

    res.json({ success: true, dish: data });
  } catch (error) {
    console.error('Add menu item route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Mom uses this to fix a spelling mistake or update a dish's price/
// description on the master list, without deleting and recreating it
// (which would also lose its history/embedding). ----
app.patch('/api/menu-items/:id', requireOwnerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, base_price, description, tags, active } = req.body;

    const updates = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Dish name cannot be empty.' });
      }
      updates.name = name.trim();
    }
    if (base_price !== undefined) {
      const priceCheck = validateOrderAmount(base_price);
      if (!priceCheck.valid) {
        return res.status(400).json({ error: `Invalid price: ${priceCheck.error}` });
      }
      updates.base_price = base_price;
    }
    if (description !== undefined) updates.description = description || null;
    if (tags !== undefined) updates.tags = tags || null;
    if (active !== undefined) {
      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: '"active" must be true or false.' });
      }
      updates.active = active;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No changes provided.' });
    }

    const { data, error } = await supabase
      .from('menu_items')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      console.log('MENU ITEM UPDATE FAILED:', error ? error.message : 'no matching row');
      return res.status(error ? 500 : 404).json({ error: error ? 'Could not update dish.' : 'Dish not found.' });
    }

    // NOTE: if the name changed, this dish's embedding (used for semantic
    // search in /api/chat) is now stale — it still reflects the OLD name.
    // Not auto-regenerated here to avoid an extra Gemini call on every
    // edit; re-run /api/generate-embeddings after a name/description
    // change if semantic search accuracy matters for this dish.
    res.json({ success: true, dish: data });
  } catch (error) {
    console.error('Edit menu item route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- "Delete" a dish from the master list — actually a SOFT delete
// (active = false), matching how real catalogs handle this (Shopify
// "archived", Amazon "inactive"). A hard delete risks breaking foreign-key
// references from daily_menu, and orders already store item names as
// plain-text snapshots rather than live references, so archiving loses
// nothing historically while still removing the dish from view going
// forward. ----
app.delete('/api/menu-items/:id', requireOwnerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('menu_items')
      .update({ active: false })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      console.log('MENU ITEM ARCHIVE FAILED:', error ? error.message : 'no matching row');
      return res.status(error ? 500 : 404).json({ error: error ? 'Could not archive dish.' : 'Dish not found.' });
    }
    res.json({ success: true, dish: data });
  } catch (error) {
    console.error('Archive menu item route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Fetch the master list of dishes, for the menu upload page.
// Only ACTIVE dishes by default — archived ones stay out of the "check
// what to cook today" list without being deleted. Pass
// ?includeArchived=true to see everything (e.g. for a future restore UI). ----
app.get('/api/menu-items', requireOwnerAuth, async (req, res) => {
  let query = supabase.from('menu_items').select('*');
  if (req.query.includeArchived !== 'true') {
    query = query.eq('active', true);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- Returns yesterday's saved menu + deals, so the menu page can
// pre-fill today's form as a starting point. Does NOT save anything —
// purely read-only; the owner still reviews and hits Save herself.
// Dishes that have since been archived are silently skipped rather than
// breaking the copy (they just won't be checkable anyway). ----
app.get('/api/daily-menu/yesterday', requireOwnerAuth, async (req, res) => {
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const { data: yesterdaysMenu } = await supabase
      .from('daily_menu')
      .select('price_today, quantity_available, menu_items!inner(id, name, active)')
      .eq('date', yesterday);

    const items = (yesterdaysMenu || [])
      .filter((row) => row.menu_items.active) // skip archived dishes
      .map((row) => ({
        menuItemId: row.menu_items.id,
        name: row.menu_items.name,
        price: row.price_today,
        quantity: row.quantity_available,
      }));

    const { data: yesterdaysDeals } = await supabase
      .from('daily_deals')
      .select('*')
      .eq('date', yesterday);

    const deals = (yesterdaysDeals || []).map((deal) => ({
      title: deal.title,
      components: deal.components,
      price: deal.price,
      originalPrice: deal.original_price,
      capacity: deal.total_capacity,
    }));

    res.json({ date: yesterday, items, deals });
  } catch (error) {
    console.error('Copy-yesterday route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Lightweight endpoint for the Kitchen View — today's orders that
// still need action (pending/preparing/ready), nothing else. No revenue,
// no best-sellers, no CRM data — just what needs cooking right now. ----
app.get('/api/kitchen-orders', requireOwnerAuth, async (req, res) => {
  try {
    // NOT filtered by today's date — a pending/preparing/ready order from
    // yesterday still genuinely needs attention. Scoping this to "today
    // only" would make an old unfinished order silently disappear at
    // midnight even though nothing about it was resolved.
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, items, kitchen_status, created_at, customer_phone')
      .in('kitchen_status', ['pending', 'preparing', 'ready'])
      .order('created_at', { ascending: true }); // oldest first — cook in order received

    if (error) return res.status(500).json({ error: error.message });

    res.json({ orders: orders || [] });
  } catch (error) {
    console.error('Kitchen orders route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Powers the owner dashboard: recent orders, revenue, best-sellers, today's tickets ----
app.get('/api/dashboard', requireOwnerAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: recentOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(50);

    const { data: todayTicket } = await supabase
      .from('tickets')
      .select('*')
      .eq('date', today)
      .single();

    const { data: ratings } = await supabase
      .from('ratings')
      .select('stars, comment, menu_item_id, created_at')
      .order('created_at', { ascending: false })
      .limit(20);

    const dishCounts = {};
    (recentOrders || []).forEach((order) => {
      order.items.split(',').forEach((item) => {
        const name = item.trim();
        dishCounts[name] = (dishCounts[name] || 0) + 1;
      });
    });
    const bestSellers = Object.entries(dishCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const totalRevenue = (recentOrders || []).reduce((sum, o) => sum + Number(o.total_price), 0);

    res.json({
      recentOrders: recentOrders || [],
      todayTicket: todayTicket || null,
      ratings: ratings || [],
      bestSellers,
      totalRevenue,
      totalOrders: (recentOrders || []).length,
    });
  } catch (error) {
    console.error('Dashboard route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Owner dashboard uses this to move an order through the kitchen
// lifecycle: pending -> preparing -> ready -> delivered (or -> cancelled
// from pending/preparing). Rejects illegal jumps via validateStatusTransition.
app.patch('/api/orders/:id/status', requireOwnerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status: newStatus } = req.body;

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('id, kitchen_status')
      .eq('id', id)
      .single();

    if (fetchError || !order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const transitionCheck = validateStatusTransition(order.kitchen_status, newStatus);
    if (!transitionCheck.valid) {
      return res.status(400).json({ error: transitionCheck.error });
    }

    const { error: updateError } = await supabase
      .from('orders')
      .update({ kitchen_status: newStatus })
      .eq('id', id);

    if (updateError) {
      console.log('ORDER STATUS UPDATE FAILED:', updateError.message);
      return res.status(500).json({ error: 'Could not update order status.' });
    }

    res.json({ success: true, id, kitchen_status: newStatus });
  } catch (error) {
    console.error('Order status route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- TEST-ONLY: manually verify order-intent detection against today's
// real menu, before it's wired into the live WhatsApp webhook. Owner-only.
// Safe to remove once Phase 5 (webhook wiring) is done and confirmed live.
app.post('/api/test-order-intent', requireOwnerAuth, async (req, res) => {
  try {
    const { message } = req.body;
    const messageCheck = validateChatMessage(message);
    if (!messageCheck.valid) {
      return res.status(400).json({ error: messageCheck.error });
    }

    const today = new Date().toISOString().split('T')[0];
    const { data: todaysMenu } = await supabase
      .from('daily_menu')
      .select('quantity_available, menu_items(name)')
      .eq('date', today);

    const availableMenuNames = (todaysMenu || [])
      .filter((item) => item.quantity_available > 0)
      .map((item) => item.menu_items.name);

    const result = await detectOrderIntent(message, availableMenuNames);

    res.json({
      message,
      todaysAvailableMenu: availableMenuNames,
      detectionResult: result,
    });
  } catch (error) {
    console.error('Order intent test route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Customers submit a rating after their order ----
app.post('/api/rate-order', async (req, res) => {
  try {
    const { orderId, stars, comment } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    const ratingCheck = validateRating(stars);
    if (!ratingCheck.valid) {
      return res.status(400).json({ error: ratingCheck.error });
    }

    const { error } = await supabase.from('ratings').insert({
      order_id: orderId,
      stars: stars,
      comment: comment || null,
    });

    if (error) {
      console.log('RATING INSERT FAILED:', error.message);
      return res.status(500).json({ error: 'Could not save rating.' });
    }

    res.json({ success: true, message: 'Thanks for the feedback!' });
  } catch (error) {
    console.error('Rating route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- One-off/admin route: generates embeddings for every menu item ----
app.post('/api/generate-embeddings', requireOwnerAuth, async (req, res) => {
  try {
    const { data: items } = await supabase.from('menu_items').select('*');

    for (const item of items) {
      const text = `${item.name}. ${item.description || ''}. Tags: ${item.tags || ''}`;

      const embedResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            content: { parts: [{ text }] },
          }),
        }
      );
      const embedData = await embedResponse.json();
      const embedding = embedData.embedding?.values;

      if (embedding) {
        await supabase
          .from('menu_items')
          .update({ embedding })
          .eq('id', item.id);
        console.log(`Embedded: ${item.name}`);
      }
    }

    res.json({ success: true, message: `Embedded ${items.length} menu items.` });
  } catch (error) {
    console.error('Embedding generation error:', error);
    res.status(500).json({ error: 'Failed to generate embeddings.' });
  }
});

// Runs every day at 5 PM — reminds customers who haven't ordered recently
async function runReEngagementJob() {
  console.log('Running daily re-engagement job...');

  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const cutoffDate = twoWeeksAgo.toISOString().split('T')[0];

  const { data: customers } = await supabase.from('customers').select('phone, name');

  let sentCount = 0;

  for (const customer of customers || []) {
    const { data: lastOrder } = await supabase
      .from('orders')
      .select('date')
      .eq('customer_phone', customer.phone)
      .eq('status', 'completed')
      .order('date', { ascending: false })
      .limit(1)
      .single();

    const isInactive = lastOrder && lastOrder.date < cutoffDate;

    if (isInactive) {
      await fetch(
        `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: customer.phone,
            text: { body: `We miss you! Check out this week's menu on Ghardrop 🍛` },
          }),
        }
      );
      sentCount++;
    }
  }
  console.log(`Re-engagement sent to ${sentCount} customers.`);
}

// The actual scheduled trigger — runs the function above, daily at 5 PM
cron.schedule('0 17 * * *', runReEngagementJob);

app.post('/api/test-reengagement', requireOwnerAuth, async (req, res) => {
  await runReEngagementJob();
  res.json({ success: true, message: 'Re-engagement job triggered manually.' });
});

app.get('/api/customer/:phone', requireOwnerAuth, async (req, res) => {
  try {
    const { phone } = req.params;

    const { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .single();

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found.' });
    }

    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_phone', phone)
      .order('created_at', { ascending: false });

    // NOTE: this filter on a joined table (orders.customer_phone) has not
    // been verified against real data — flagged for a follow-up check,
    // not changed here without evidence per project rules.
    const { data: ratings } = await supabase
      .from('ratings')
      .select('stars, comment, created_at, orders(customer_phone)')
      .eq('orders.customer_phone', phone);

    const totalSpend = (orders || []).reduce((sum, o) => sum + Number(o.total_price), 0);
    const totalOrders = (orders || []).length;
    const lastOrderDate = orders && orders.length > 0 ? orders[0].date : null;
    const avgRating = ratings && ratings.length > 0
      ? (ratings.reduce((sum, r) => sum + r.stars, 0) / ratings.length).toFixed(1)
      : null;

    res.json({
      customer,
      totalSpend,
      totalOrders,
      lastOrderDate,
      avgRating,
      orderHistory: orders || [],
    });
  } catch (error) {
    console.error('Customer profile error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Start the server (kept as the very last thing in the file) ----
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});