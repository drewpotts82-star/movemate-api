
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

    const resolvedCity = city || other_location;

    // Save lead to Supabase
    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        city: resolvedCity,
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

    // Split services into individual types
    const serviceTypes = (services || '').split('+').map(s => s.trim()).filter(Boolean);

    // Get ALL partners in this city with credits
    const { data: allPartners } = await supabase
      .from('partners')
      .select('*')
      .gt('credits', 0);

    const cityPartners = (allPartners || []).filter(p =>
      p.cities && p.cities.includes(resolvedCity)
    );

    let totalNotified = 0;

    // ── Notify each service type separately ──────────────────────────────────
    for (const serviceType of serviceTypes) {
      const matchedPartners = cityPartners.filter(p =>
        p.services && p.services.includes(serviceType)
      );

      if (matchedPartners.length > 0) {
        for (const partner of matchedPartners) {
          notifyPartner(partner, lead, serviceType).catch(e =>
            console.log(`Notify error (${serviceType}):`, e.message)
          );
          totalNotified++;
        }
        console.log(`Lead ${lead.id} — ${serviceType}: notified ${matchedPartners.length} partners in ${resolvedCity}`);
      } else {
        // No partners for this service type — notify admin
        notifyAdmin(lead, serviceType).catch(e =>
          console.log('Admin notify error:', e.message)
        );
        console.log(`Lead ${lead.id} — ${serviceType}: no partners in ${resolvedCity}, notified admin`);
      }
    }

    res.json({
      success: true,
      leadId: lead.id,
      matchedPartners: totalNotified,
      message: 'Your request has been sent to local providers!'
    });

  } catch (err) {
    console.error('Lead submission error:', err);
    res.status(500).json({ error: 'Failed to submit lead', details: err.message });
  }
});

// ── GET /partners/login — Login by phone number ───────────────────────────────
app.get('/partners/login', async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    // Try both formatted and raw phone
    const formatted = formatAusPhone(phone);
    const { data: partner } = await supabase
      .from('partners')
      .select('*')
      .or(`phone.eq.${formatted},phone.eq.${phone}`)
      .single();

    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    // Get available leads for this partner
    const { data: leads } = await supabase
      .from('leads')
      .select('*')
      .in('city', partner.cities || [])
      .eq('status', 'new')
      .order('created_at', { ascending: false })
      .limit(20);

    // Filter leads by partner's services
    const relevantLeads = (leads || []).filter(l =>
      l.services && partner.services &&
      partner.services.some(s => l.services.includes(s))
    );

    // Get unlocked leads
    const { data: unlocked } = await supabase
      .from('lead_unlocks')
      .select('lead_id, unlocked_at, leads(*)')
      .eq('partner_id', partner.id)
      .order('unlocked_at', { ascending: false });

    res.json({
      partner,
      availableLeads: relevantLeads,
      unlockedLeads: unlocked || []
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /partners/register — Register a new partner ─────────────────────────
app.post('/partners/register', async (req, res) => {
  try {
    const { business_name, contact_name, phone, email, services, cities } = req.body;

    if (!business_name || !phone) {
      return res.status(400).json({ error: 'Business name and phone are required' });
    }

    const formattedPhone = formatAusPhone(phone);

    const { data: existing } = await supabase
      .from('partners')
      .select('id')
      .or(`phone.eq.${formattedPhone},phone.eq.${phone}`)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Partner already registered with this phone number' });
    }

    const { data: partner, error } = await supabase
      .from('partners')
      .insert({
        business_name,
        contact_name,
        phone: formattedPhone,
        email,
        services: services || ['Removals'],
        cities: cities || [],
        credits: 2,
        tier: 'starter'
      })
      .select()
      .single();

    if (error) throw error;

    // Welcome SMS
    if (twilioClient) {
      twilioClient.messages.create({
        body: `Welcome to MoveMate, ${business_name}! You have 2 free leads waiting. Log in at movemate.au to unlock them.`,
        from: process.env.TWILIO_PHONE,
        to: formattedPhone
      }).catch(e => console.log('Welcome SMS error:', e.message));
    }

    // Welcome email
    if (email) {
      mailer.sendMail({
        from: `MoveMate <${process.env.ZOHO_USER}>`,
        to: email,
        subject: 'Welcome to MoveMate — Your 2 free leads are ready',
        html: `
          <h2>Welcome to MoveMate, ${business_name}!</h2>
          <p>You're now a verified MoveMate partner. You have <strong>2 free leads</strong> ready to unlock.</p>
          <p><a href="https://movemate.au" style="background:#1a5cf8;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;">View My Leads →</a></p>
          <p>Questions? Reply to this email or contact hello@movemate.au</p>
        `
      }).catch(e => console.log('Welcome email error:', e.message));
    }

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

    const { data: leads } = await supabase
      .from('leads')
      .select('*')
      .in('city', partner.cities || [])
      .eq('status', 'new')
      .order('created_at', { ascending: false })
      .limit(20);

    const relevantLeads = (leads || []).filter(l =>
      l.services && partner.services &&
      partner.services.some(s => l.services.includes(s))
    );

    const { data: unlocked } = await supabase
      .from('lead_unlocks')
      .select('lead_id, unlocked_at, leads(*)')
      .eq('partner_id', req.params.id)
      .order('unlocked_at', { ascending: false });

    res.json({
      partner,
      availableLeads: relevantLeads,
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

    const { data: partner } = await supabase
      .from('partners')
      .select('*')
      .eq('id', partnerId)
      .single();

    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    if (partner.credits <= 0 && partner.tier !== 'gold') {
      return res.status(402).json({ error: 'No credits remaining. Please top up.' });
    }

    const { data: existing } = await supabase
      .from('lead_unlocks')
      .select('id')
      .eq('partner_id', partnerId)
      .eq('lead_id', leadId)
      .single();

    if (existing) return res.status(409).json({ error: 'Lead already unlocked' });

    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single();

    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    if (partner.tier !== 'gold') {
      await supabase
        .from('partners')
        .update({ credits: partner.credits - 1 })
        .eq('id', partnerId);
    }

    await supabase
      .from('lead_unlocks')
      .insert({ lead_id: leadId, partner_id: partnerId });

    res.json({
      success: true,
      creditsRemaining: partner.tier === 'gold' ? 'unlimited' : partner.credits - 1,
      lead: {
        ...lead,
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
      [process.env.STRIPE_PRICE_BASIC]:  { credits: 15,  tier: 'starter' },
      [process.env.STRIPE_PRICE_VALUE]:  { credits: 30,  tier: 'starter' },
      [process.env.STRIPE_PRICE_GOLD]:   { credits: 999, tier: 'gold'    },
      [process.env.STRIPE_PRICE_SINGLE]: { credits: 1,   tier: 'starter' },
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

// ── POST /webhook/stripe ──────────────────────────────────────────────────────
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
          .update({ credits: newCredits, tier })
          .eq('id', partnerId);

        if (twilioClient && partner.phone) {
          twilioClient.messages.create({
            body: `MoveMate: Payment confirmed! ${tier === 'gold' ? 'Unlimited leads activated' : `${credits} credits added`}. Log in at movemate.au`,
            from: process.env.TWILIO_PHONE,
            to: formatAusPhone(partner.phone)
          }).catch(e => console.log('Payment SMS error:', e.message));
        }

        console.log(`Partner ${partnerId} topped up: ${credits} credits, tier: ${tier}`);
      }
    }
  }

  res.json({ received: true });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Notify partner for a SPECIFIC service type only
async function notifyPartner(partner, lead, serviceType) {
  const serviceLabel = serviceType || lead.services;

  const message =
    `🚚 MoveMate New Lead!\n` +
    `Service: ${serviceLabel}\n` +
    `Location: ${lead.city}\n` +
    `${lead.from_suburb ? 'From: ' + lead.from_suburb : ''}${lead.to_suburb ? ' → ' + lead.to_suburb : ''}\n` +
    `${lead.property_size ? 'Property: ' + lead.property_size : ''}\n` +
    `${lead.move_date ? 'Date: ' + lead.move_date : 'Date: Flexible'}\n` +
    `Log in to unlock: movemate.au`;

  // SMS
  if (twilioClient && partner.phone) {
    try {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE,
        to: formatAusPhone(partner.phone)
      });
      console.log(`✅ SMS sent to ${partner.business_name} for ${serviceLabel}`);
    } catch (e) {
      console.log(`❌ SMS failed for ${partner.business_name}:`, e.message);
    }
  }

  // Email
  if (partner.email) {
    mailer.sendMail({
      from: `MoveMate Leads <${process.env.ZOHO_USER}>`,
      to: partner.email,
      subject: `New ${serviceLabel} Lead — ${lead.city}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0;">
            <h2 style="color:white;margin:0;">🚚 New ${serviceLabel} Lead</h2>
          </div>
          <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee;">
            <p>Hi ${partner.business_name}, you have a new lead!</p>
            <table style="width:100%;border-collapse:collapse;">
              <tr style="background:#fff;border-bottom:1px solid #eee;">
                <td style="padding:8px;font-weight:bold;">Service</td>
                <td style="padding:8px;">${serviceLabel}</td>
              </tr>
              <tr style="background:#f5f5f5;border-bottom:1px solid #eee;">
                <td style="padding:8px;font-weight:bold;">City</td>
                <td style="padding:8px;">${lead.city}</td>
              </tr>
              <tr style="background:#fff;border-bottom:1px solid #eee;">
                <td style="padding:8px;font-weight:bold;">Route</td>
                <td style="padding:8px;">${lead.from_suburb || ''}${lead.to_suburb ? ' → ' + lead.to_suburb : ''}</td>
              </tr>
              <tr style="background:#f5f5f5;border-bottom:1px solid #eee;">
                <td style="padding:8px;font-weight:bold;">Property</td>
                <td style="padding:8px;">${lead.property_size || 'Not specified'}</td>
              </tr>
              <tr style="background:#fff;">
                <td style="padding:8px;font-weight:bold;">Move Date</td>
                <td style="padding:8px;">${lead.move_date || 'Flexible'}</td>
              </tr>
            </table>
            <div style="text-align:center;margin-top:20px;">
              <a href="https://movemate.au" style="background:#1a5cf8;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
                Unlock Lead (1 credit) →
              </a>
            </div>
            <p style="color:#999;font-size:11px;margin-top:16px;text-align:center;">
              MoveMate · movemate.au · You're a verified partner in ${lead.city}.
            </p>
          </div>
        </div>
      `
    }).catch(e => console.log('Partner email error:', e.message));
  }
}

async function notifyAdmin(lead, serviceType) {
  mailer.sendMail({
    from: `MoveMate System <${process.env.ZOHO_USER}>`,
    to: process.env.ZOHO_USER,
    subject: `⚠️ Unmatched ${serviceType} Lead — ${lead.city}`,
    html: `
      <h2>Unmatched Lead — Manual Action Required</h2>
      <p>No ${serviceType} partners found in ${lead.city}.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:8px;font-weight:bold">Service</td><td style="padding:8px">${serviceType}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">City</td><td style="padding:8px">${lead.city}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Customer</td><td style="padding:8px">${lead.name} — ${lead.phone}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">Route</td><td style="padding:8px">${lead.from_suburb || ''} → ${lead.to_suburb || ''}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Property</td><td style="padding:8px">${lead.property_size || ''}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:8px;font-weight:bold">Move Date</td><td style="padding:8px">${lead.move_date || 'Flexible'}</td></tr>
      </table>
    `
  }).catch(e => console.log('Admin email error:', e.message));
}

function formatAusPhone(phone) {
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
