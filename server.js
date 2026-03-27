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
// Raw body for Stripe webhooks
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── CLIENTS ───────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // Use service key on backend for full access
);

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Email transporter (fallback if no Twilio)

 const mailer = nodemailer.createTransport({
  host: 'smtp.zoho.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.ZOHO_USER,
    pass: process.env.ZOHO_PASSWORD
  }
});
// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'MoveMate API is running', version: '1.0.0' });
});

// ── CITY → NEAREST PARTNER MATCHING ──────────────────────────────────────────
// Haversine formula for distance
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── POST /leads — Submit a customer lead ──────────────────────────────────────
app.post('/leads', async (req, res) => {
  try {
    const {
      city, services, from_suburb, to_suburb,
      property_size, move_date, name, phone,
      clean_type, storage_size, other_location
    } = req.body;

    if (!name || !phone || (!city && !other_location)) {
      return res.status(400).json({ error: 'Name, phone and city are required' });
    }

    // Save lead to Supabase
    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        city: city || other_location,
        services,
        from_suburb,
        to_suburb,
        property_size,
        move_date,
        name,
        phone,
        clean_type,
        storage_size,
        other_location,
        status: 'new'
      })
      .select()
      .single();

    if (error) throw error;
const serviceTypes = (services || '').split('+').map(s => s.trim());
   const { data: allPartners } = await supabase
  .from('partners')
  .select('*')
  .gt('credits', 0);

const partners = (allPartners || []).filter(p =>
  p.cities && p.cities.includes(city || other_location) &&
  p.services && serviceTypes.some(s => p.services.includes(s))
);

   // Notify matching partners
if (partners && partners.length > 0) {
  for (const partner of partners) {
    notifyPartner(partner, lead).catch(e => console.log('Notify error:', e.message));
  }
  console.log(`Lead ${lead.id} matched to ${partners.length} partners in ${city}`);
} else {
  // No direct match — notify admin to manually match
  notifyAdmin(lead).catch(e => console.log('Admin notify error:', e.message));
  console.log(`Lead ${lead.id} — no partners found in ${city}, notified admin`);
}
    res.json({ 
      success: true, 
      leadId: lead.id,
      matchedPartners: partners?.length || 0,
      message: 'Your request has been sent to local providers!'
    });

  } catch (err) {
    console.error('Lead submission error:', err);
    res.status(500).json({ error: 'Failed to submit lead', details: err.message });
  }
});

// ── POST /partners/register — Register a new partner ─────────────────────────
app.post('/partners/register', async (req, res) => {
  try {
    const { business_name, contact_name, phone, email, services, cities } = req.body;

    if (!business_name || !phone) {
      return res.status(400).json({ error: 'Business name and phone are required' });
    }

    // Check if partner already exists
    const { data: existing } = await supabase
      .from('partners')
      .select('id')
      .eq('phone', phone)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Partner already registered with this phone number' });
    }

    // Create partner with 2 free credits
    const { data: partner, error } = await supabase
      .from('partners')
      .insert({
        business_name,
        contact_name,
        phone,
        email,
        services: services || ['Removals'],
        cities: cities || [],
        credits: 2,
        tier: 'starter'
      })
      .select()
      .single();

    if (error) throw error;

    // Send welcome SMS
    if (twilioClient) {
      await twilioClient.messages.create({
        body: `Welcome to MoveMate, ${business_name}! You have 2 free leads waiting. Log in at movemate.au to unlock them.`,
        from: process.env.TWILIO_PHONE,
        to: formatAusPhone(phone)
      });
    }

    // Welcome email
    await mailer.sendMail({
      from: 'MoveMate <hello@movemate.au>',
      to: email,
      subject: 'Welcome to MoveMate — Your 2 free leads are ready',
      html: `
        <h2>Welcome to MoveMate, ${business_name}!</h2>
        <p>You're now a verified MoveMate partner. You have <strong>2 free leads</strong> ready to unlock.</p>
        <p><a href="https://movemate.au" style="background:#1a5cf8;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;">View My Leads →</a></p>
        <p>Questions? Reply to this email or contact hello@movemate.au</p>
      `
    }).catch(e => console.log('Email error:', e.message));

    res.json({ 
      success: true, 
      partnerId: partner.id,
      credits: 2,
      message: 'Registration successful! Check your SMS for next steps.'
    });

  } catch (err) {
    console.error('Partner registration error:', err);
    res.status(500).json({ error: 'Registration failed', details: err.message });
  }
});

// ── GET /partners/:id — Get partner dashboard data ────────────────────────────
app.get('/partners/:id', async (req, res) => {
  try {
    const { data: partner, error } = await supabase
      .from('partners')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !partner) return res.status(404).json({ error: 'Partner not found' });

    // Get available leads for this partner's cities/services
    const { data: leads } = await supabase
      .from('leads')
      .select('*')
      .in('city', partner.cities || [])
      .eq('status', 'new')
      .order('created_at', { ascending: false })
      .limit(20);

    // Get unlocked leads
    const { data: unlocked } = await supabase
      .from('lead_unlocks')
      .select('lead_id, unlocked_at, leads(*)')
      .eq('partner_id', req.params.id)
      .order('unlocked_at', { ascending: false });

    res.json({
      partner,
      availableLeads: leads || [],
      unlockedLeads: unlocked || []
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /partners/unlock — Unlock a lead (deduct 1 credit) ──────────────────
app.post('/partners/unlock', async (req, res) => {
  try {
    const { partnerId, leadId } = req.body;

    // Get partner
    const { data: partner } = await supabase
      .from('partners')
      .select('*')
      .eq('id', partnerId)
      .single();

    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    if (partner.credits <= 0 && partner.tier !== 'gold') {
      return res.status(402).json({ error: 'No credits remaining. Please top up.' });
    }

    // Check not already unlocked
    const { data: existing } = await supabase
      .from('lead_unlocks')
      .select('id')
      .eq('partner_id', partnerId)
      .eq('lead_id', leadId)
      .single();

    if (existing) return res.status(409).json({ error: 'Lead already unlocked' });

    // Get lead details
    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single();

    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Deduct credit (Gold tier has unlimited)
    if (partner.tier !== 'gold') {
      await supabase
        .from('partners')
        .update({ credits: partner.credits - 1 })
        .eq('id', partnerId);
    }

    // Record unlock
    await supabase
      .from('lead_unlocks')
      .insert({ lead_id: leadId, partner_id: partnerId });

    // Return full lead details to partner
    res.json({
      success: true,
      creditsRemaining: partner.tier === 'gold' ? 'unlimited' : partner.credits - 1,
      lead: {
        ...lead,
        // Full contact details now revealed
        customerName: lead.name,
        customerPhone: lead.phone
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /checkout — Create Stripe checkout session ──────────────────────────
app.post('/checkout', async (req, res) => {
  try {
    const { priceId, partnerId, partnerEmail } = req.body;

    const PRICE_TO_CREDITS = {
      [process.env.STRIPE_PRICE_BASIC]:    { credits: 15,  tier: 'starter' },
      [process.env.STRIPE_PRICE_VALUE]:    { credits: 30,  tier: 'starter' },
      [process.env.STRIPE_PRICE_GOLD]:     { credits: 999, tier: 'gold'    },
      [process.env.STRIPE_PRICE_SINGLE]:   { credits: 1,   tier: 'starter' },
    };

    const pack = PRICE_TO_CREDITS[priceId];
    if (!pack) return res.status(400).json({ error: 'Invalid price ID' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: priceId === process.env.STRIPE_PRICE_GOLD ? 'subscription' : 'payment',
      success_url: `https://movemate.au?payment=success&partner=${partnerId}&credits=${pack.credits}`,
      cancel_url: `https://movemate.au?payment=cancelled`,
      customer_email: partnerEmail,
      metadata: { partnerId, credits: pack.credits, tier: pack.tier }
    });

    res.json({ sessionId: session.id, url: session.url });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook/stripe — Handle Stripe payment confirmations ────────────────
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { partnerId, credits, tier } = session.metadata;

    if (partnerId) {
      const { data: partner } = await supabase
        .from('partners')
        .select('credits, business_name, phone')
        .eq('id', partnerId)
        .single();

      if (partner) {
        const newCredits = tier === 'gold' ? 999 : (partner.credits + parseInt(credits));
        
        await supabase
          .from('partners')
          .update({ 
            credits: newCredits,
            tier: tier
          })
          .eq('id', partnerId);

        // SMS confirmation
        if (twilioClient && partner.phone) {
          await twilioClient.messages.create({
            body: `MoveMate: Payment confirmed! ${tier === 'gold' ? 'Unlimited leads activated' : `${credits} credits added`}. Log in at movemate.au`,
            from: process.env.TWILIO_PHONE,
            to: formatAusPhone(partner.phone)
          });
        }

        console.log(`Partner ${partnerId} topped up: ${credits} credits, tier: ${tier}`);
      }
    }
  }

  res.json({ received: true });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function notifyPartner(partner, lead) {
  const message = `MoveMate New Lead 🏠\n${lead.services} — ${lead.city}\n${lead.from_suburb}${lead.to_suburb ? ' → ' + lead.to_suburb : ''}\n${lead.property_size} · ${lead.move_date || 'Flexible date'}\nLog in to unlock: movemate.au`;

  // SMS via Twilio
  if (twilioClient && partner.phone) {
    try {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE,
        to: formatAusPhone(partner.phone)
      });
    } catch (e) {
      console.log(`SMS failed for partner ${partner.id}:`, e.message);
    }
  }

  // Email fallback
  if (partner.email) {
    await mailer.sendMail({
      from: 'MoveMate Leads <hello@movemate.au>',
      to: partner.email,
      subject: `New Lead: ${lead.services} in ${lead.city}`,
      html: `
        <h2>New Lead Alert 🏠</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;font-weight:bold">Service</td><td style="padding:8px">${lead.services}</td></tr>
          <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">City</td><td style="padding:8px">${lead.city}</td></tr>
          <tr><td style="padding:8px;font-weight:bold">Route</td><td style="padding:8px">${lead.from_suburb}${lead.to_suburb ? ' → ' + lead.to_suburb : ''}</td></tr>
          <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">Property</td><td style="padding:8px">${lead.property_size}</td></tr>
          <tr><td style="padding:8px;font-weight:bold">Move Date</td><td style="padding:8px">${lead.move_date || 'Flexible'}</td></tr>
        </table>
        <p style="margin-top:20px">
          <a href="https://movemate.au" style="background:#1a5cf8;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">
            Unlock Lead (1 credit) →
          </a>
        </p>
        <p style="color:#666;font-size:12px">You received this because you're a verified MoveMate partner in ${lead.city}.</p>
      `
    }).catch(e => console.log('Email error:', e.message));
  }
}

async function notifyAdmin(lead) {
  await mailer.sendMail({
    from: 'MoveMate System <hello@movemate.au>',
    to: 'hello@movemate.au',
    subject: `⚠️ Unmatched Lead — ${lead.city} — ${lead.services}`,
    html: `
      <h2>Unmatched Lead — Manual Action Required</h2>
      <p>No partners found for this lead. Please match manually.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:8px;font-weight:bold">Lead ID</td><td style="padding:8px">${lead.id}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">City</td><td style="padding:8px">${lead.city}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Service</td><td style="padding:8px">${lead.services}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">Customer</td><td style="padding:8px">${lead.name} — ${lead.phone}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Route</td><td style="padding:8px">${lead.from_suburb} → ${lead.to_suburb}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">Property</td><td style="padding:8px">${lead.property_size}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Move Date</td><td style="padding:8px">${lead.move_date || 'Flexible'}</td></tr>
      </table>
    `
  }).catch(e => console.log('Admin email error:', e.message));
}

function formatAusPhone(phone) {
  // Convert 04XX XXX XXX to +614XX XXX XXX
  const cleaned = phone.replace(/\s/g, '');
  if (cleaned.startsWith('0')) return '+61' + cleaned.slice(1);
  if (cleaned.startsWith('+61')) return cleaned;
  return '+61' + cleaned;
}

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`MoveMate API running on port ${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? '✅' : '❌ missing'}`);
  console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌ missing'}`);
  console.log(`Twilio: ${process.env.TWILIO_ACCOUNT_SID ? '✅' : '❌ missing'}`);
});

