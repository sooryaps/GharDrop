// Load secret keys from .env into process.env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Razorpay = require('razorpay');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// ---- Setup connections ----
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const app = express();
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

// ---- Test route ----
app.get('/', (req, res) => {
  res.send('Ghardrop backend is running!');
});

// ---- Chat route: talks to Gemini, using live menu + customer history ----
app.post('/api/chat', async (req, res) => {
  try {
    const { message, phone } = req.body;
    if (!message || typeof message !== 'string' || message.length > 500) {
      return res.status(400).json({ error: 'Invalid message.' });
    }
    const today = new Date().toISOString().split('T')[0];

    const { data: todaysMenu } = await supabase
      .from('daily_menu')
      .select('price_today, quantity_available, menu_items(name, tags, description)')
      .eq('date', today);

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

    const menuText = (todaysMenu || [])
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

// ---- Create a Razorpay payment order ----
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, totalPrice, customerPhone } = req.body;

  if (!totalPrice || totalPrice <= 0 || typeof totalPrice !== 'number') {
      return res.status(400).json({ error: 'Invalid amount.' });
    }
    if (!customerPhone || typeof customerPhone !== 'string' || customerPhone.length < 10) {
      return res.status(400).json({ error: 'Invalid phone number.' });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: totalPrice * 100,
      currency: 'INR',
      receipt: `ghardrop_${Date.now()}`,
      notes: { items, customerPhone },
    });

    res.json({
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('Payment order creation error:', error);
    res.status(500).json({ error: 'Could not create payment order.' });
  }
});

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
  if (event === 'payment.captured') {
    const payment = req.body.payload.payment.entity;
    const { items, customerPhone } = payment.notes;
    const amountRupees = payment.amount / 100;
    const today = new Date().toISOString().split('T')[0];

    console.log(`Payment confirmed: ₹${amountRupees} from ${customerPhone} for ${items}`);

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
    }

    const { data: ticketRow, error: ticketFetchError } = await supabase
      .from('tickets')
      .select('remaining_count')
      .eq('date', today)
      .single();

    if (ticketFetchError) {
      console.log('TICKET FETCH FAILED (likely no row exists for today):', ticketFetchError.message);
    } else if (ticketRow) {
      const { error: ticketUpdateError } = await supabase
        .from('tickets')
        .update({ remaining_count: ticketRow.remaining_count - 1 })
        .eq('date', today);

      if (ticketUpdateError) {
        console.log('TICKET UPDATE FAILED:', ticketUpdateError.message);
      } else {
        console.log('Ticket count successfully decremented.');
      }
    }
  }
});

// ---- Mom uses this each day to set what's being cooked, prices, and today's deal ----
app.post('/api/daily-menu', async (req, res) => {
  try {
    const { items, dealTitle, dealItems, dealPrice, dealOriginalPrice, ticketCap } = req.body;
    const today = new Date().toISOString().split('T')[0];

    const dailyMenuRows = items.map((item) => ({
      date: today,
      menu_item_id: item.menuItemId,
      price_today: item.price,
      quantity_available: item.quantity,
    }));

    const { error: menuError } = await supabase.from('daily_menu').insert(dailyMenuRows);
    if (menuError) {
      console.log('DAILY MENU INSERT FAILED:', menuError.message);
      return res.status(500).json({ error: 'Could not save menu.' });
    }

    if (dealTitle) {
      const { error: dealError } = await supabase.from('daily_deals').insert({
        date: today,
        title: dealTitle,
        items: dealItems,
        price: dealPrice,
        original_price: dealOriginalPrice,
      });
      if (dealError) console.log('DAILY DEAL INSERT FAILED:', dealError.message);
    }

    const { error: ticketError } = await supabase
      .from('tickets')
      .upsert({ date: today, total_capacity: ticketCap || 25, remaining_count: ticketCap || 25 });
    if (ticketError) console.log('TICKET UPSERT FAILED:', ticketError.message);

    res.json({ success: true, message: `Today's menu saved with ${items.length} items.` });
  } catch (error) {
    console.error('Daily menu route error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---- Fetch the master list of all possible dishes, for the menu upload page ----
app.get('/api/menu-items', async (req, res) => {
  const { data, error } = await supabase.from('menu_items').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- Powers the owner dashboard: recent orders, revenue, best-sellers, today's tickets ----
app.get('/api/dashboard', async (req, res) => {
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

// ---- Customers submit a rating after their order ----
app.post('/api/rate-order', async (req, res) => {
  try {
    const { orderId, stars, comment } = req.body;

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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});