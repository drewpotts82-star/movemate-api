require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wfedrryofztvcabiazdw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// All 55+ MoveMate cities
const CITIES = [
  // QLD
  { name: 'Townsville', state: 'QLD' },
  { name: 'Cairns', state: 'QLD' },
  { name: 'Toowoomba', state: 'QLD' },
  { name: 'Mackay', state: 'QLD' },
  { name: 'Rockhampton', state: 'QLD' },
  { name: 'Bundaberg', state: 'QLD' },
  { name: 'Hervey Bay', state: 'QLD' },
  { name: 'Gladstone', state: 'QLD' },
  { name: 'Maryborough', state: 'QLD' },
  // NSW
  { name: 'Newcastle', state: 'NSW' },
  { name: 'Wollongong', state: 'NSW' },
  { name: 'Central Coast', state: 'NSW' },
  { name: 'Albury', state: 'NSW' },
  { name: 'Wagga Wagga', state: 'NSW' },
  { name: 'Tamworth', state: 'NSW' },
  { name: 'Coffs Harbour', state: 'NSW' },
  { name: 'Port Macquarie', state: 'NSW' },
  { name: 'Orange', state: 'NSW' },
  { name: 'Dubbo', state: 'NSW' },
  { name: 'Bathurst', state: 'NSW' },
  // VIC
  { name: 'Geelong', state: 'VIC' },
  { name: 'Ballarat', state: 'VIC' },
  { name: 'Bendigo', state: 'VIC' },
  { name: 'Shepparton', state: 'VIC' },
  { name: 'Warrnambool', state: 'VIC' },
  { name: 'Mildura', state: 'VIC' },
  { name: 'Wodonga', state: 'VIC' },
  // WA
  { name: 'Bunbury', state: 'WA' },
  { name: 'Mandurah', state: 'WA' },
  { name: 'Geraldton', state: 'WA' },
  { name: 'Kalgoorlie', state: 'WA' },
  { name: 'Albany', state: 'WA' },
  // SA
  { name: 'Mount Gambier', state: 'SA' },
  { name: 'Whyalla', state: 'SA' },
  { name: 'Murray Bridge', state: 'SA' },
  { name: 'Port Augusta', state: 'SA' },
  // TAS
  { name: 'Launceston', state: 'TAS' },
  { name: 'Devonport', state: 'TAS' },
  { name: 'Burnie', state: 'TAS' },
  // NT
  { name: 'Darwin', state: 'NT' },
  { name: 'Alice Springs', state: 'NT' },
  // ACT
  { name: 'Canberra', state: 'ACT' },
];

// Service types to search
const SERVICES = [
  { name: 'Removals',      queries: ['removalists', 'furniture removals', 'moving company'] },
  { name: 'Bond Cleaning', queries: ['bond cleaning', 'end of lease cleaning'] },
  { name: 'Storage',       queries: ['self storage', 'storage units'] },
];

// ── HELPERS ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('0')) return '+61' + cleaned.slice(1);
  if (cleaned.startsWith('61')) return '+' + cleaned;
  if (cleaned.startsWith('+61')) return cleaned;
  return cleaned.length >= 8 ? '+61' + cleaned : null;
}

// ── YELLOW PAGES SCRAPER ──────────────────────────────────────────────────────
async function scrapeYellowPages(query, city, state) {
  const location = `${city}+${state}`;
  const url = `https://www.yellowpages.com.au/search/listings?clue=${encodeURIComponent(query)}&locationClue=${encodeURIComponent(city + ' ' + state)}&lat=&lon=`;
  
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const businesses = [];

    // Yellow Pages listing cards
    $('.listing-result, .search-listing-result, [class*="listing"]').each((i, el) => {
      if (i >= 10) return; // Max 10 per search

      const name = $(el).find('.listing-name, h2, .business-name, [class*="name"]').first().text().trim();
      const phoneRaw = $(el).find('.phone, [class*="phone"], [class*="tel"], a[href^="tel:"]').first().text().trim() ||
                       $(el).find('a[href^="tel:"]').attr('href')?.replace('tel:', '');
      const suburb = $(el).find('.listing-address, [class*="address"], [class*="suburb"]').first().text().trim();

      if (name && name.length > 2) {
        const phone = cleanPhone(phoneRaw);
        businesses.push({ name, phone, suburb: suburb || city });
      }
    });

    return businesses;
  } catch (err) {
    console.log(`  ⚠️  YP failed for "${query}" in ${city}: ${err.message}`);
    return [];
  }
}

// ── TRUE LOCAL SCRAPER (backup) ───────────────────────────────────────────────
async function scrapeTrueLocal(query, city, state) {
  const url = `https://www.truelocal.com.au/search/${encodeURIComponent(query)}/${encodeURIComponent(city.toLowerCase().replace(' ', '-') + '-' + state.toLowerCase())}`;
  
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const businesses = [];

    $('[class*="listing"], [class*="result"], article').each((i, el) => {
      if (i >= 8) return;
      const name = $(el).find('h2, h3, [class*="name"], [class*="title"]').first().text().trim();
      const phoneRaw = $(el).find('[class*="phone"], a[href^="tel:"]').first().text().trim() ||
                       $(el).find('a[href^="tel:"]').attr('href')?.replace('tel:', '');

      if (name && name.length > 2) {
        const phone = cleanPhone(phoneRaw);
        businesses.push({ name, phone, suburb: city });
      }
    });

    return businesses;
  } catch (err) {
    return [];
  }
}

// ── SUPABASE UPLOAD ───────────────────────────────────────────────────────────
async function uploadToSupabase(businesses) {
  if (!businesses.length) return 0;

  // Use upsert to avoid duplicates based on phone number
  const records = businesses.map(b => ({
    business_name: b.name,
    phone: b.phone || null,
    email: null,
    services: [b.serviceType],
    cities: [b.city + ', ' + b.state],
    credits: 0,        // No credits - they pay per lead
    tier: 'pay-per-lead',
    contact_name: null,
    source: 'yellowpages',
  }));

  // Filter out records without phone numbers
  const withPhone = records.filter(r => r.phone);
  const withoutPhone = records.filter(r => !r.phone);
  
  if (withoutPhone.length > 0) {
    console.log(`    ⚠️  ${withoutPhone.length} businesses skipped (no phone found)`);
  }

  if (!withPhone.length) return 0;

  try {
    const { data, error } = await supabase
      .from('partners')
      .upsert(withPhone, { 
        onConflict: 'phone',
        ignoreDuplicates: true 
      });
    
    if (error) throw error;
    return withPhone.length;
  } catch (err) {
    console.log(`    ❌ Supabase error: ${err.message}`);
    return 0;
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 MoveMate Business Scraper Starting...');
  console.log(`📍 ${CITIES.length} cities × ${SERVICES.length} services\n`);

  let totalFound = 0;
  let totalUploaded = 0;
  const allBusinesses = [];

  for (const city of CITIES) {
    console.log(`\n📍 ${city.name}, ${city.state}`);

    for (const service of SERVICES) {
      const query = service.queries[0]; // Use primary query
      console.log(`  🔍 Searching: ${query}...`);

      // Try Yellow Pages first
      let businesses = await scrapeYellowPages(query, city.name, city.state);
      
      // Fallback to True Local if no results
      if (!businesses.length) {
        console.log(`  ↩️  Trying True Local...`);
        businesses = await scrapeTrueLocal(query, city.name, city.state);
      }

      // Tag each business with city and service
      businesses = businesses.map(b => ({
        ...b,
        city: city.name,
        state: city.state,
        serviceType: service.name,
      }));

      console.log(`  ✅ Found ${businesses.length} businesses`);
      totalFound += businesses.length;
      allBusinesses.push(...businesses);

      // Upload this batch
      if (businesses.length > 0) {
        const uploaded = await uploadToSupabase(businesses);
        totalUploaded += uploaded;
        console.log(`  💾 Uploaded ${uploaded} to Supabase`);
      }

      // Be polite — don't hammer the server
      await sleep(2000 + Math.random() * 1000);
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log(`✅ DONE!`);
  console.log(`📊 Total found: ${totalFound}`);
  console.log(`💾 Total uploaded to Supabase: ${totalUploaded}`);
  console.log(`🏢 Businesses ready to receive SMS alerts!`);
  
  // Save a local CSV backup
  const csv = ['Business Name,Phone,City,State,Service Type,Suburb'];
  allBusinesses.forEach(b => {
    csv.push(`"${b.name}","${b.phone || ''}","${b.city}","${b.state}","${b.serviceType}","${b.suburb}"`);
  });
  require('fs').writeFileSync('businesses.csv', csv.join('\n'));
  console.log(`📄 CSV backup saved to businesses.csv`);
}

main().catch(console.error);
