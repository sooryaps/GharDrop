# Master Build Prompt — Ghardrop AI Ordering Assistant

Paste this whole prompt into Claude Code (or a similar AI coding tool) to build the project. Work through it phase by phase — don't ask for everything at once. Fill in the [bracketed] details with your real info before using.

---

## Project Overview

Build a full-stack ordering assistant for **Ghardrop**, a home-cooked weekend cloud kitchen in Mangalore, India that sells a strictly limited number of thalis (max [25] per day, Friday–Sunday only). The system must:

1. Let customers chat with an AI assistant (via WhatsApp) that recommends dish combinations and highlights the day's deal
2. Track real-time remaining ticket count and stop taking orders once sold out
3. Store orders, customers, and menu data in a database
4. Never expose API keys or secrets to the client/frontend
5. Be simple enough for a non-technical person (my mom) to check today's orders

## Tech Stack

- **Frontend:** React (existing prototype: `ghardrop-chat.jsx`, use as visual/UX reference)
- **Backend:** Node.js + Express (or Python + FastAPI — pick one and justify)
- **Database:** PostgreSQL via Supabase
- **AI:** Anthropic Claude API (model: claude-sonnet-4-6), called only from the backend, never the frontend
- **Messaging:** WhatsApp Business Cloud API (Meta)
- **Payments:** Razorpay (UPI support)
- **Hosting:** Frontend on Vercel, backend on Railway or Render

## Build Phases — work through these in order, confirm each works before moving to the next

### Phase 1 — Secure Backend Foundation
- Set up a Node.js/Express (or FastAPI) backend
- Move the Claude API call from frontend to backend — API key lives in a `.env` file, never in client code
- Create one endpoint: `POST /api/chat` that accepts a message + conversation history, calls Claude with the system prompt, returns the reply
- Add basic rate limiting (e.g. 20 requests/minute per IP) to prevent abuse/cost overrun

### Phase 2 — Database Schema
Design and create tables for:
- `menu_items` (id, name, base_price, cost_price, tags, description)
- `daily_menu` (id, date, menu_item_id, price_today, photo_url, quantity_available) — this is the table mom fills in each day; the AI and dashboard both read from THIS, not from a hardcoded or old-date menu
- `daily_deals` (id, date, title, items, price, original_price)
- `orders` (id, customer_phone, items, total_price, status, created_at, date)
- `tickets` (date, total_capacity, remaining_count)
- `customers` (phone, name, order_history, preferences — for future personalization)
- `ratings` (id, order_id, menu_item_id, stars, comment, created_at)

Include a migration script and seed data matching the current menu.

### Phase 3 — WhatsApp Integration
- Connect the backend to WhatsApp Business Cloud API
- Incoming customer messages → backend → Claude (with menu + order context) → reply sent back via WhatsApp
- Handle the order flow: customer confirms an item → create a row in `orders` → decrement `tickets.remaining_count`
- When `remaining_count` hits 0, auto-reply that today is sold out, no further orders accepted

### Phase 4 — Context-Aware Recommendations (RAG)
- Before each AI call, fetch the customer's past orders from the `customers`/`orders` tables
- Include relevant history in the prompt context (e.g. "this customer has ordered kori gassi twice before")
- Keep this lightweight — a simple SQL lookup is enough, no need for a vector database at this scale

### Phase 5 — Payments
- Integrate Razorpay for UPI payment collection upfront (before order confirmation)
- Only mark an order as confirmed and decrement ticket count after payment succeeds

### Phase 6 — Owner Dashboard + Daily Menu Upload + Analytics
- A basic authenticated web page (for me/my mom) with two parts:
  1. **Daily menu upload** — a dead-simple form (or WhatsApp message parsed by the backend) where mom enters/uploads what's being cooked today, with photos. This becomes the ONLY source of truth for today's menu — the AI must always pull from today's entry, never yesterday's or hardcoded data.
  2. **Dashboard** showing:
     - Full order history (searchable by date)
     - Today's live orders + remaining tickets
     - Profit/loss: revenue minus ingredient cost per dish (needs a simple cost-per-dish field when mom enters the menu)
     - Best-sellers: which dishes sold most, over any date range
     - Customer ratings/comments per dish, collected after delivery (e.g. a WhatsApp follow-up message: "rate today's meal 1-5")
     - Simple charts (not just tables) — this is a strong resume/interview visual, use a charting library
- No need for anything visually fancy at first — get the data model and logic right before making it "crazy" visually

### Phase 7 — Security Hardening
- Input validation and sanitization on all endpoints
- Rate limiting on all public endpoints, not just chat
- HTTPS enforced everywhere
- No sensitive customer data (phone numbers) logged in plaintext anywhere avoidable
- Basic auth on the owner dashboard

## Constraints
- Keep everything as simple as possible at each phase — this is a real small business, not an enterprise system
- Explain each architectural decision in plain language as you go, since I'm learning as I build
- Prioritize working code over exhaustive edge-case handling in early phases
- Comment the code well — this project will be shown in job interviews, so clarity matters as much as function

## My current details (fill in before use)
- Location: Mangalore, India
- Daily ticket cap: [25]
- Days active: Friday–Sunday
- WhatsApp Business number: [not yet set up]
- Supabase project: [not yet created]

---

## Daily Learning Plan (study alongside building)

Goal: by the time the project is built, be able to confidently explain every concept below in an interview — not just have used it once.

Do a little each day. Don't rush ahead of the build phase you're actually working on — learning a concept right before/while you implement it sticks far better than reading it cold.

### Track alongside Phase 1 (Secure Backend)
- [ ] What an API key is and why it must never sit in frontend code (you've already learned this the practical way)
- [ ] REST API basics: what GET/POST/endpoints mean, request vs. response
- [ ] Environment variables / `.env` files and why secrets are kept out of code
- [ ] Rate limiting — what it is, why APIs need it, simple implementations
- [ ] LLM API parameters: `max_tokens`, `temperature`, `system` vs. `user` messages

### Track alongside Phase 2 (Database Schema)
- [ ] Basic SQL: SELECT, INSERT, UPDATE, JOIN
- [ ] What a schema is and why relationships between tables matter (e.g. orders → customers)
- [ ] Primary keys vs. foreign keys
- [ ] Practice explaining your own schema out loud in plain English

### Track alongside Phase 3 (WhatsApp Integration)
- [ ] Webhooks — what they are, how an incoming message triggers your backend
- [ ] Prompt engineering: system prompts, few-shot examples, why vague prompts give vague answers
- [ ] Structured output / JSON mode — getting the AI to return predictable, parseable data

### Track alongside Phase 4 (RAG)
- [ ] What RAG (Retrieval-Augmented Generation) is and why it beats fine-tuning for most real products
- [ ] What an embedding is (conceptually — a piece of text turned into numbers that capture meaning)
- [ ] Vector databases (Pinecone, Supabase pgvector, Chroma) and cosine similarity, at a conceptual level
- [ ] Be ready to explain: "how does my order-history lookup count as a simple RAG pipeline?"

### Track alongside Phase 5 (Payments)
- [ ] Basic understanding of payment gateway flow (Razorpay/UPI): initiate → redirect/collect → webhook confirms success
- [ ] Idempotency — why you shouldn't double-charge or double-count an order on retry

### Track alongside Phase 6 (Owner Dashboard)
- [ ] Basic authentication concepts: sessions vs. tokens, why a dashboard needs a login

### Track alongside Phase 7 (Security Hardening)
- [ ] Input validation and sanitization — why trusting user input is dangerous (SQL injection, prompt injection)
- [ ] HTTPS and why it matters
- [ ] What "least privilege" access means for a database/API

### Ongoing / interview-specific (study in parallel, not tied to a phase)
- [ ] Agents & tool use — how an LLM decides to call a function (you've seen this pattern already in how I use tools)
- [ ] Evaluation basics — hallucination, groundedness, how you'd know if the AI's answers are actually good
- [ ] Fine-tuning vs. prompting vs. RAG — when each is the right choice, and why most products don't fine-tune
- [ ] Practice explaining 2-3 real decisions from THIS project out loud, e.g. "why I moved the API call to a backend" — real reasoning beats memorized definitions in interviews

---

## Interview Prep (start once Phase 1-2 are working)

Knowing a concept and explaining it clearly under pressure are different skills — practice these out loud, not just in your head.

### Questions you should be able to answer using THIS project as your example
- "Tell me about a project you built." → 60-90 second version: what it does, who it's for, what YOU decided and why
- "Why did you move the API call to a backend instead of calling it from the frontend?" → security: never expose API keys client-side
- "What is RAG and where did you use it?" → point to the order-history lookup; explain why you didn't fine-tune instead
- "How do you handle a customer message the AI misunderstands?" → talk about system prompt design, testing, and your QA instinct for catching edge cases
- "How would this scale if you had 10,000 customers instead of 25 orders/day?" → talk about rate limiting, database indexing, moving beyond a simple SQL lookup to a real vector DB
- "What would you do differently if you rebuilt this?" → always have an honest answer ready; interviewers respect self-awareness

### General AI-role questions to prep separately
- Explain prompt engineering to a non-technical person
- What's the difference between fine-tuning, RAG, and prompting? When would you use each?
- What is hallucination, and how would you reduce it in a product?
- Walk through what happens end-to-end when a user sends a message to an LLM-powered app

### Don't skip this
- If target roles have a coding/DSA round, that's a separate prep track (arrays, strings, basic algorithms) — this project won't cover it, plan time for it separately
- Mock interview out loud at least once a week once you're 4+ weeks in — explaining out loud surfaces gaps that silent reading doesn't
