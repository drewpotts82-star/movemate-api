require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilio = require('twilio');
const nodemailer = require('nodemailer');

const app = express();

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors({ origin: ['https://movemate.au', 'https://www.movemate.au', 'http://localhost:3000'] }));
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── CLIENTS ───────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const emailTransporter = process.env.ZOHO_USER && process.env.ZOHO_PASSWORD
  ? nodemailer.createTransport({
      host: 'smtp.zoho.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.ZOHO_USER,
        pass: process.env.ZOHO_PASSWORD
      }
    })
  : null;

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'MoveMate API running', version: '2.2.0', model: 'sms-email-blast' });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
function formatAusPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/\s/g, '');
  if (cleaned.startsWith('0')) return '+61' + cleaned.slice(1);
  if (cleaned.startsWith('+61')) return cleaned;
  return '+61' + cleaned;
}

function isAusMobile(phone) {
  if (!phone) return false;
  const cleaned = phone.replace(/\s/g, '');
  return cleaned.startsWith('04') || cleaned.startsWith('+614');
}

async function sendSMS(to, body) {
  if (!twilioClient) {
    console.log(`[SMS SKIPPED] To: ${to} | ${body.substring(0, 60)}`);
    return false;
  }
  try {
    await twilioClient.messages.create({
      body,
      from: process.env.TWILIO_PHONE || '+61468167408',
      to: formatAusPhone(to)
    });
    return true;
  } catch (e) {
    console.log(`SMS failed to ${to}: ${e.message}`);
    return false;
  }
}

async function sendEmail(to, subject, body) {
  if (!emailTransporter) {
    console.log(`[EMAIL SKIPPED] To: ${to} | ${subject}`);
    return false;
  }
  try {
    await emailTransporter.sendMail({
      from: `MoveMate <${process.env.ZOHO_USER}>`,
      to,
      subject,
      text: body
    });
    console.log(`[EMAIL SENT] To: ${to} | Subject: ${subject}`);
    return true;
  } catch (e) {
    console.log(`Email failed to ${to}: ${e.message}`);
    return false;
  }
}

function buildLeadSMS(lead, service, city) {
  const cityShort = city.split(',')[0].trim();
  const date = lead.move_date ? ` · ${lead.move_date}` : '';
  const size = lead.property_size ? ` · ${lead.property_size}` : '';
  const route = lead.from_suburb ? ` · ${lead.from_suburb}${lead.to_suburb ? ' to ' + lead.to_suburb : ''}` : '';
  const apiBase = process.env.API_URL || 'https://movemate-api-production.up.railway.app';
  return `MoveMate: New ${service} job in ${cityShort}${size}${route}${date}. Max 3 businesses competing. Get client contact for $15: ${apiBase}/lead/${lead.id}`;
}

function buildLeadEmail(lead, service, city) {
  const cityShort = city.split(',')[0].trim();
  const date = lead.move_date ? ` on ${lead.move_date}` : '';
  const size = lead.property_size ? `, ${lead.property_size}` : '';
  const route = lead.from_suburb ? ` from ${lead.from_suburb}${lead.to_suburb ? ' to ' + lead.to_suburb : ''}` : '';
  const apiBase = process.env.API_URL || 'https://movemate-api-production.up.railway.app';
  return {
    subject: `MoveMate: New ${service} job in ${cityShort}`,
    body: `Hi,\n\nA new ${service} job has come in for ${cityShort}${size}${route}${date}.\n\nMax 3 businesses competing. Unlock customer contact for $15:\n${apiBase}/lead/${lead.id}\n\nMoveMate Team\nhello@movemate.au`
  };
}

// ── POST /leads ───────────────────────────────────────────────────────────────
app.post('/leads', async (req, res) => {
  try {
    const { city, services, from_suburb, to_suburb, property_size, move_date, name, phone, clean_type, storage_size, other_location } = req.body;

    if (!name || !phone || (!city && !other_location)) {
      return res.status(400).json({ error: 'Name, phone and city required' });
    }

    const cityName = city || other_location;
    const cityShort = cityName.split(',')[0].trim();

    // Save lead
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .insert({ city: cityName, services, from_suburb, to_suburb, property_size, move_date, name, phone, clean_type, storage_size, other_location, status: 'new' })
      .select()
      .single();

    if (leadError) throw leadError;

    // Find businesses in this city
    const serviceTypes = (services || '').split('+').map(s => s.trim());
    const stateVariants = ['QLD','NSW','VIC','WA','SA','TAS','NT','ACT'].map(s => `cities.cs.{"${cityShort}, ${s}"}`);
    stateVariants.push(`cities.cs.{"${cityName}"}`);

    const { data: businesses } = await supabase
      .from('partners')
      .select('id, business_name, phone, email, services, cities')
      .or(stateVariants.join(','));

    // Filter by service type
    const matchingBiz = (businesses || []).filter(b =>
      !b.services || b.services.length === 0 ||
      serviceTypes.some(st => b.services.includes(st))
    );

    // Route by contact type — mobile gets SMS, landline gets email
    const serviceLabel = serviceTypes[0] || 'Moving';
    const smsBody = buildLeadSMS(lead, serviceLabel, cityName);
    let smsSent = 0;
    let emailSent = 0;

    for (const biz of matchingBiz) {
      if (isAusMobile(biz.phone)) {
        const sent = await sendSMS(biz.phone, smsBody);
        if (sent) smsSent++;
      } else if (biz.email) {
        const { subject, body } = buildLeadEmail(lead, serviceLabel, cityName);
        const sent = await sendEmail(biz.email, subject, body);
        if (sent) emailSent++;
      } else {
        console.log(`[SKIPPED] ${biz.business_name} — no mobile or email`);
      }
    }

    // No businesses found — alert admin
    if (matchingBiz.length === 0) {
      const adminPhone = process.env.ADMIN_PHONE || '+61468167408';
      await sendSMS(adminPhone, `MoveMate ADMIN: Lead in ${cityShort} - no businesses found. ${name} ${phone} needs ${serviceLabel}.`);
    }

    // Confirm to customer
    await sendSMS(phone, `Hi ${name}! MoveMate has alerted local ${serviceLabel} providers in ${cityShort}. You will hear from them soon. Questions? hello@movemate.au`);

    res.json({ success: true, leadId: lead.id, businessesNotified: smsSent, emailsNotified: emailSent });

  } catch (err) {
    console.error('Lead error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /lead/:id — Job details for business ──────────────────────────────────
app.get('/lead/:id', async (req, res) => {
  try {
    const { data: lead, error } = await supabase
      .from('leads')
      .select('id, city, services, from_suburb, to_suburb, property_size, move_date, clean_type, storage_size, created_at')
      .eq('id', req.params.id)
      .single();

    if (error || !lead) return res.status(404).json({ error: 'Lead not found' });

    const { count } = await supabase
      .from('lead_unlocks')
      .select('*', { count: 'exact', head: true })
      .eq('lead_id', req.params.id);

    const spotsLeft = Math.max(0, 3 - (count || 0));

    res.json({ lead, spotsLeft, alreadyClaimed: count || 0, available: spotsLeft > 0 });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /lead/:id/unlock — Start $15 Stripe checkout ─────────────────────────
app.post('/lead/:id/unlock', async (req, res) => {
  try {
    const { businessPhone, businessName } = req.body;
    const leadId = req.params.id;

    const { count } = await supabase
      .from('lead_unlocks')
      .select('*', { count: 'exact', head: true })
      .eq('lead_id', leadId);

    if ((count || 0) >= 3) {
      return res.status(402).json({ error: 'All 3 spots for this lead have been claimed.' });
    }

    const { data: existing } = await supabase
      .from('lead_unlocks')
      .select('id')
      .eq('lead_id', leadId)
      .eq('partner_phone', businessPhone)
      .maybeSingle();

    if (existing) return res.status(409).json({ error: 'You already unlocked this lead.' });

    const apiBase = process.env.API_URL || 'https://movemate-api-production.up.railway.app';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_SINGLE, quantity: 1 }],
      mode: 'payment',
      success_url: `${apiBase}/lead/${leadId}/success?session_id={CHECKOUT_SESSION_ID}&phone=${encodeURIComponent(businessPhone)}`,
      cancel_url: `https://movemate.au/lead/${leadId}?cancelled=true`,
      metadata: { leadId, businessPhone, businessName: businessName || '' }
    });

    res.json({ checkoutUrl: session.url });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /lead/:id/success — Reveal customer contact after payment ──────────────
app.get('/lead/:id/success', async (req, res) => {
  try {
    const { session_id, phone } = req.query;
    const leadId = req.params.id;

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    await supabase.from('lead_unlocks').upsert({
      lead_id: leadId,
      partner_phone: phone,
      stripe_session_id: session_id,
      unlocked_at: new Date().toISOString()
    }, { onConflict: 'lead_id,partner_phone', ignoreDuplicates: true });

    const { data: lead } = await supabase.from('leads').select('*').eq('id', leadId).single();
    const { count } = await supabase.from('lead_unlocks').select('*', { count: 'exact', head: true }).eq('lead_id', leadId);

    await sendSMS(phone, `MoveMate: Payment confirmed! Customer contact for ${lead.services} job in ${lead.city.split(',')[0]}: ${lead.name} on ${lead.phone}. Good luck!`);

    res.json({
      success: true,
      customer: { name: lead.name, phone: lead.phone, city: lead.city, services: lead.services, from_suburb: lead.from_suburb, to_suburb: lead.to_suburb, property_size: lead.property_size, move_date: lead.move_date },
      spotsLeft: Math.max(0, 3 - (count || 0))
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /partners/register ───────────────────────────────────────────────────
app.post('/partners/register', async (req, res) => {
  try {
    const { business_name, contact_name, phone, email, services, cities } = req.body;
    if (!business_name || !phone) return res.status(400).json({ error: 'Business name and phone required' });

    const { data: partner, error } = await supabase
      .from('partners')
      .upsert({ business_name, contact_name, phone, email, services: services || ['Removals'], cities: cities || [], credits: 0, tier: 'pay-per-lead', source: 'registered' }, { onConflict: 'phone' })
      .select()
      .single();

    if (error) throw error;

    if (isAusMobile(phone)) {
      await sendSMS(phone, `Welcome to MoveMate, ${business_name}! You'll get SMS alerts for new jobs in your area. Click the link to unlock customer contact for $15. movemate.au`);
    } else if (email) {
      await sendEmail(email, `Welcome to MoveMate, ${business_name}!`, `Hi,\n\nYou're now registered on MoveMate. You'll receive email alerts for new jobs in your area.\n\nClick the link in each alert to unlock customer contact for $15.\n\nmovemate.au`);
    }

    res.json({ success: true, partnerId: partner.id });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /checkout ────────────────────────────────────────────────────────────
app.post('/checkout', async (req, res) => {
  try {
    const { priceId, partnerId, partnerEmail } = req.body;
    const VALID = [process.env.STRIPE_PRICE_BASIC, process.env.STRIPE_PRICE_VALUE, process.env.STRIPE_PRICE_GOLD, process.env.STRIPE_PRICE_SINGLE];
    if (!VALID.includes(priceId)) return res.status(400).json({ error: 'Invalid price' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: priceId === process.env.STRIPE_PRICE_GOLD ? 'subscription' : 'payment',
      success_url: `https://movemate.au?payment=success&partner=${partnerId}`,
      cancel_url: `https://movemate.au?payment=cancelled`,
      customer_email: partnerEmail,
      metadata: { partnerId }
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook/stripe ──────────────────────────────────────────────────────
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('Stripe webhook:', event.type);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  res.json({ received: true });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`MoveMate API v2.2 on port ${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? '✅' : '❌'}`);
  console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`Twilio: ${process.env.TWILIO_ACCOUNT_SID ? '✅' : '❌'}`);
  console.log(`Email: ${process.env.ZOHO_USER ? '✅' : '❌'}`);
});
```

Then run in Terminal:
```
cd ~/movemate-scraper && npm install nodemailer
