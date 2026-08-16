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
app.post('/api/chat', async (req, res) => {
  try {
    const { message, phone } = req.body;

    const messageCheck = validateChatMessage(message);
    if (!messageCheck.valid) {
      return res.status(400).json({ error: messageCheck.error });
    }

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

    const { data: todaysDeal } = await supabase
      .from('daily_deals')
      .select('*')
      .eq('date', today)
      .single();

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

    const dealText = todaysDeal
      ? `Today's deal: ${todaysDeal.title} — ${todaysDeal.items} for ₹${todaysDeal.price} (normally ₹${todaysDeal.original_price})`
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
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, no response.';
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

// ---- WhatsApp incoming messages (Meta calls this every time, POST) ----
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (message && message.type === 'text') {
      const from = message.from;
      const text = message.text.body;
      console.log(`Message from ${from}: ${text}`);

      const chatResponse = await fetch(`http://localhost:${PORT}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, phone: from }),
      });
      const chatData = await chatResponse.json();

      const sendResult = await fetch(
        `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: from,
            text: { body: chatData.reply },
          }),
        }
      );
      const sendData = await sendResult.json();
      console.log('WhatsApp send result:', JSON.stringify(sendData, null, 2));
    }
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

// ---- Helper: validates AND prices a DEAL order. Reuses resolveOrderItems
// on the deal's stored components, so each component dish's real stock is
// checked the exact same way a regular order would check it — a deal
// can't bypass inventory limits. Price comes from the deal's bundle price
// (daily_deals.price), not the sum of individual component prices. Also
// checks the deal's OWN ticket capacity (separate from per-dish stock).
async function resolveDealOrder(today) {
  const { data: deal } = await supabase
    .from('daily_deals')
    .select('*')
    .eq('date', today)
    .single();

  if (!deal) {
    return { ok: false, status: 404, error: "No deal is available today." };
  }
  if (deal.remaining_count <= 0) {
    return { ok: false, status: 409, error: "Sorry, today's deal is sold out." };
  }
  if (!Array.isArray(deal.components) || deal.components.length === 0) {
    // Data integrity issue, not a customer error — log for investigation.
    console.log(`DEAL MISCONFIGURED: deal id ${deal.id} for ${today} has no components.`);
    return { ok: false, status: 500, error: "Today's deal isn't set up correctly. Please try individual items." };
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
      error: `Sorry, today's deal can't be fulfilled right now (${problems.join('; ')}).`,
      outOfStock,
      notFound,
    };
  }

  const canonicalItemsString = formatItemsWithQuantity(
    resolvedItems.map((i) => ({ name: i.canonicalName, quantity: i.quantity }))
  );

  return { ok: true, totalPrice: deal.price, canonicalItemsString, isDealOrder: true };
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
    const { items, customerPhone, isDealOrder } = req.body;
    const today = new Date().toISOString().split('T')[0];

    const priced = isDealOrder
      ? await resolveDealOrder(today)
      : await validateAndPriceOrder(items, today);

    if (!priced.ok) {
      return res.status(priced.status).json({ error: priced.error, outOfStock: priced.outOfStock, notFound: priced.notFound });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(priced.totalPrice * 100), // paise
      currency: 'INR',
      receipt: `ghardrop_${Date.now()}`,
      // isDeal stored as a string — Razorpay notes values must be strings.
      // The webhook checks this to know whether to also decrement the
      // deal's own ticket counter, on top of the usual per-dish decrement.
      notes: { items: priced.canonicalItemsString, customerPhone, isDeal: isDealOrder ? 'true' : 'false' },
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

// ---- Create a Razorpay Payment Link (WhatsApp flow) ----
// Same validateAndPriceOrder gate as /api/create-order — a WhatsApp order
// is priced and stock-checked exactly the same way a browser order is.
// Produces a plain https://rzp.io/... URL that works inside a WhatsApp
// text message (Checkout.js's popup widget does not).
app.post('/api/create-payment-link', requireOwnerAuth, async (req, res) => {
  try {
    const { items, customerPhone, isDealOrder } = req.body;

    if (!customerPhone || typeof customerPhone !== 'string') {
      return res.status(400).json({ error: 'customerPhone is required.' });
    }

    const today = new Date().toISOString().split('T')[0];

    const priced = isDealOrder
      ? await resolveDealOrder(today)
      : await validateAndPriceOrder(items, today);

    if (!priced.ok) {
      return res.status(priced.status).json({ error: priced.error, outOfStock: priced.outOfStock, notFound: priced.notFound });
    }

    const paymentLink = await razorpay.paymentLink.create({
      amount: Math.round(priced.totalPrice * 100), // paise
      currency: 'INR',
      description: priced.canonicalItemsString,
      reference_id: `ghardrop_${Date.now()}`.slice(0, 40), // Razorpay caps reference_id at 40 chars
      customer: { contact: customerPhone },
      notify: { sms: false, whatsapp: false }, // WE send it via WhatsApp ourselves, not Razorpay
      notes: { items: priced.canonicalItemsString, customerPhone, isDeal: isDealOrder ? 'true' : 'false' },
    });

    res.json({
      paymentLinkId: paymentLink.id,
      shortUrl: paymentLink.short_url,
      totalPrice: priced.totalPrice,
      items: priced.canonicalItemsString,
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
  const { items, customerPhone, isDeal } = payment.notes;
  const amountRupees = payment.amount / 100;
  const today = new Date().toISOString().split('T')[0];
  const wasDealOrder = isDeal === 'true';

  console.log(`Payment confirmed: ₹${amountRupees} from ${customerPhone} for ${items}${wasDealOrder ? ' (DEAL)' : ''}`);

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
      // component dishes correctly since `items` contains them.
      const { data: dealDecremented, error: dealTicketError } = await supabase.rpc('decrement_deal_ticket', {
        row_date: today,
      });
      if (dealTicketError) {
        console.log('DEAL TICKET DECREMENT FAILED:', dealTicketError.message);
      } else if (!dealDecremented) {
        console.log(`DEAL OVERSOLD: payment captured but deal was already at 0 remaining. Manual review needed for order from ${customerPhone}.`);
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
    const {
      items,
      dealTitle,
      dealComponents,
      dealPrice,
      dealOriginalPrice,
      dealCapacity,
      ticketCap,
    } = req.body;
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

    // If a deal is being set up, validate its capacity and components
    // BEFORE writing anything — same fail-fast-and-whole principle as the
    // quantity check above. A deal's components must reference dishes
    // that are actually checked/being sold today; you can't build a deal
    // around a dish that isn't live.
    let validatedDealCapacity = null;
    if (dealTitle) {
      const dealCapacityToUse = dealCapacity === undefined || dealCapacity === null ? 25 : dealCapacity;
      const dealCapacityCheck = validateTicketCapacity(dealCapacityToUse);
      if (!dealCapacityCheck.valid) {
        return res.status(400).json({ error: `Invalid deal capacity: ${dealCapacityCheck.error}` });
      }
      validatedDealCapacity = dealCapacityToUse;

      const componentsCheck = validateDealComponents(dealComponents);
      if (!componentsCheck.valid) {
        return res.status(400).json({ error: componentsCheck.error });
      }

      const todaysCheckedNames = items.map((i) => i.name).filter(Boolean);
      const unknownComponents = dealComponents
        .map((c) => c.name)
        .filter((name) => !matchDishName(name, todaysCheckedNames));
      if (unknownComponents.length > 0) {
        return res.status(400).json({
          error: `Deal components must be dishes checked in today's menu. Not found: ${unknownComponents.join(', ')}`,
        });
      }

      const priceCheck = validateOrderAmount(dealPrice);
      if (!priceCheck.valid) {
        return res.status(400).json({ error: `Invalid deal price: ${priceCheck.error}` });
      }
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

    await supabase.from('daily_deals').delete().eq('date', today);
    if (dealTitle) {
      // items (display string) is derived from the validated, structured
      // components — never free text — so what's shown always matches
      // what checkout will actually decrement.
      const dealItemsDisplay = formatItemsWithQuantity(dealComponents);
      const { error: dealError } = await supabase.from('daily_deals').insert({
        date: today,
        title: dealTitle,
        items: dealItemsDisplay,
        components: dealComponents,
        price: dealPrice,
        original_price: dealOriginalPrice || null,
        total_capacity: validatedDealCapacity,
        remaining_count: validatedDealCapacity,
      });
      if (dealError) {
        console.log('DAILY DEAL INSERT FAILED:', dealError.message);
        return res.status(500).json({ error: 'Menu saved, but could not save the deal.' });
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

// ---- Fetch the master list of all possible dishes, for the menu upload page ----
app.get('/api/menu-items', requireOwnerAuth, async (req, res) => {
  const { data, error } = await supabase.from('menu_items').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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