# Ghardrop 🍛

**An AI-powered ordering assistant for a home-cooked, limited-supply weekend cloud kitchen — built end-to-end from scratch: secure backend, live database, WhatsApp integration, RAG-based personalization, real payments, and an owner analytics dashboard.**

> Built as a solo project to learn production AI-application engineering: LLM API integration, retrieval-augmented generation (RAG), webhook-based system integration, and backend security — not a tutorial clone.

---

## What It Does

Ghardrop lets customers order home-cooked meals directly over WhatsApp, chatting with an AI assistant that:
- Recommends dish combinations from **today's actual menu** (never stale or hardcoded data)
- Highlights the day's featured deal
- **Personalizes recommendations** using each customer's real past order history
- Handles real payment collection via UPI before confirming any order
- Enforces a strict daily order cap (scarcity-driven model — sells out, not endless supply)

The business owner (a home cook) uploads each day's menu through a simple checkbox-based page — no technical skill required — and can view live revenue, best-sellers, and order history on a dashboard.

---

## Architecture

```
Customer (WhatsApp)
       │
       ▼
Meta WhatsApp Cloud API  ──webhook──▶  Node.js/Express Backend
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
             Google Gemini API         Supabase (PostgreSQL)      Razorpay API
           (AI recommendations)     (menu, orders, customers,   (payment collection,
                                      ratings, tickets)           webhook-verified)
```

**Flow:** A customer message hits Meta's servers → forwarded to the backend via webhook → backend retrieves today's live menu and the customer's order history from the database (RAG) → both are fed to Gemini as context → the AI's reply is sent back through Meta to the customer. Payments follow a similar webhook-verified pattern: an order is only written to the database after Razorpay cryptographically confirms the payment succeeded — never before.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Backend | Node.js + Express | Industry-standard, lightweight REST API framework |
| Database | Supabase (PostgreSQL) | Relational data, free tier, built-in table editor for a non-technical admin |
| AI | Google Gemini API | LLM for menu-aware, personalized recommendations |
| Messaging | Meta WhatsApp Cloud API | Real customer-facing channel, official production-grade integration |
| Payments | Razorpay | UPI-first payment gateway, test mode for safe development |
| Security | Helmet, express-rate-limit, HMAC webhook verification | Layered protection: headers, abuse prevention, cryptographic request verification |

---

## Key Engineering Decisions

- **API keys never touch the frontend.** All calls to Gemini, Razorpay, and WhatsApp happen server-side only — the browser/client never sees a secret key.
- **RAG, not fine-tuning.** Customer personalization is done by retrieving real order history from the database and injecting it into the AI's prompt at request time — cheaper, instant to update, and always current, with no model training involved.
- **Payments are confirmed server-to-server.** The frontend never gets to declare "payment succeeded" — only a cryptographically signature-verified webhook call from Razorpay can trigger an order being written to the database.
- **`upsert` for daily state.** The day's order cap is created-or-updated in a single database operation each time the owner uploads a new menu, eliminating an entire class of "missing row" bugs that came up during development.

---

## Real Challenges Solved (selected)

- **Silent token-budget bug:** Gemini's internal reasoning step was consuming the entire output token budget before generating a visible answer, producing truncated replies. Diagnosed by reading the raw `finishReason` and `thoughtsTokenCount` fields in the API response, not by guessing.
- **WhatsApp webhook subscription gap:** a webhook can be fully verified by Meta and still receive zero real events if the app isn't explicitly linked to the WhatsApp Business Account via a separate API call — a genuinely easy-to-miss step in Meta's current developer flow.
- **Payment webhook signature verification:** implemented HMAC-SHA256 signature checking so a payment can only be confirmed by a request that's provably from Razorpay, closing off a real vulnerability where a forged request could otherwise trigger a free order.

---

## Setup

```bash
git clone <this-repo>
cd ghardrop
npm install
cp .env.example .env   # fill in your own keys — see below
node server.js
```

**Environment variables required** (see `.env.example`):
```
GEMINI_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
PORT=3000
```

For local WhatsApp webhook testing, expose your local server with [ngrok](https://ngrok.com) and register the resulting URL in Meta's developer dashboard.

---

## Screenshots

*(Add screenshots of the chat widget, owner dashboard, and menu upload page here)*

---

## What's Next

- Row Level Security policies in Supabase (currently deferred since the backend uses a trusted service key)
- Authentication on the owner dashboard
- Production WhatsApp access token instead of a temporary development one

---

*Built solo, documented daily — see `/docs` for detailed engineering notes on each development phase.*
