const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

test('addresses page uses real SQLite data integration points', () => {
  const source = readFileSync('apps/web/app/addresses/page.tsx', 'utf8');

  assert.match(source, /getPublicAddressesPageData/);
  assert.match(source, /searchParams/);
  assert.match(source, /FAQPage/);
  assert.doesNotMatch(source, /const addressRows = \[/);
  assert.doesNotMatch(source, /const commonStates = \[/);
  assert.doesNotMatch(source, /'use client'|"use client"/);
});

test('public address helpers format fields and generated links', async () => {
  const helpers = await import('./apps/web/app/_lib/public-address-data.ts');

  assert.equal(helpers.formatPublicPrice(1999), 'US$ 19.99');
  assert.equal(helpers.formatPublicMailboxRange(null, null), '0 - 0');
  assert.equal(helpers.formatPublicMailboxRange(1018, 1119), '1018 - 1119');
  assert.equal(
    helpers.buildAddressDetailRedirectUrl('https://www.anytimemailbox.com/s/fayetteville-3011-town-center-drive'),
    '/go/address-detail?target=https%3A%2F%2Fwww.anytimemailbox.com%2Fs%2Ffayetteville-3011-town-center-drive',
  );
  assert.equal(
    helpers.buildPublicGoogleMapsUrl('7720 NE Hwy 99 Ste D, Vancouver, WA 98665, United States'),
    'https://www.google.com/maps/search/?api=1&query=7720%20NE%20Hwy%2099%20Ste%20D%2C%20Vancouver%2C%20WA%2098665%2C%20United%20States',
  );
});

test('public address detail links use the referral-gated redirect', () => {
  const source = readFileSync('apps/web/app/addresses/page.tsx', 'utf8');

  assert.match(source, /href=\{address\.detailUrl\}/);
  assert.match(source, /addresses-detail-button/);
  assert.doesNotMatch(source, /href=\{address\.anytimeUrl\}/);
});

test('public address page urls preserve filters and scroll back to results', async () => {
  const helpers = await import('./apps/web/app/_lib/public-address-data.ts');
  const filters = {
    q: 'mail',
    state: 'CA',
    rdi: 'Residential',
    cmra: 'No',
    minPrice: '10',
    maxPrice: '20',
    priceError: '',
    page: 3,
  };

  assert.equal(
    helpers.buildAddressesPageUrl(filters, { page: 2 }),
    '/addresses?q=mail&state=CA&rdi=Residential&cmra=No&minPrice=10&maxPrice=20&page=2#address-list-title',
  );
  assert.equal(
    helpers.buildAddressesPageUrl(filters, { state: 'TX', page: 1 }),
    '/addresses?q=mail&state=TX&rdi=Residential&cmra=No&minPrice=10&maxPrice=20#address-list-title',
  );
});

test('public address price filters validate dollars and preserve legacy links', async () => {
  const helpers = await import('./apps/web/app/_lib/public-address-data.ts');

  const range = helpers.parsePublicAddressFilters({ minPrice: '10.50', maxPrice: '20' });
  assert.equal(range.minPrice, '10.50');
  assert.equal(range.maxPrice, '20');
  assert.equal(range.priceError, '');

  assert.match(
    helpers.parsePublicAddressFilters({ minPrice: '20', maxPrice: '10' }).priceError,
    /最低价格不能高于最高价格/,
  );
  assert.match(
    helpers.parsePublicAddressFilters({ minPrice: '-1' }).priceError,
    /大于等于 0/,
  );
  assert.match(
    helpers.parsePublicAddressFilters({ maxPrice: '10.123' }).priceError,
    /最多保留两位小数/,
  );

  const legacyUpperBound = helpers.parsePublicAddressFilters({ price: 'lt20' });
  assert.equal(legacyUpperBound.minPrice, '');
  assert.equal(legacyUpperBound.maxPrice, '19.99');
  const legacyLowerBound = helpers.parsePublicAddressFilters({ price: 'gte20' });
  assert.equal(legacyLowerBound.minPrice, '20');
  assert.equal(legacyLowerBound.maxPrice, '');
});

test('public address price range query includes both boundaries and supports one-sided filters', async () => {
  const helpers = await import('./apps/web/app/_lib/public-address-data.ts');
  const tempDirectory = mkdtempSync(join(tmpdir(), 'atmb-price-range-'));
  const databaseUrl = join(tempDirectory, 'addresses.sqlite');
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const sqlite = new Database(databaseUrl);

  try {
    sqlite.exec(`
      CREATE TABLE states (code TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE addresses (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        anytime_url TEXT NOT NULL,
        state TEXT NOT NULL,
        state_name TEXT NOT NULL,
        city TEXT NOT NULL,
        street_address TEXT NOT NULL,
        postal_code TEXT NOT NULL,
        full_address TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        rdi TEXT,
        cmra TEXT,
        smarty_match_status TEXT NOT NULL DEFAULT 'verified',
        smarty_match_message TEXT,
        mailbox_min INTEGER,
        mailbox_max INTEGER,
        updated_at TEXT NOT NULL,
        is_active INTEGER NOT NULL,
        is_visible INTEGER NOT NULL
      );
      INSERT INTO states (code, name) VALUES ('CA', 'California');
    `);

    const insertAddress = sqlite.prepare(`
      INSERT INTO addresses (
        id, name, anytime_url, state, state_name, city, street_address, postal_code,
        full_address, price_cents, rdi, cmra, mailbox_min, mailbox_max, updated_at,
        is_active, is_visible
      ) VALUES (
        @id, @name, @url, 'CA', 'California', 'Los Angeles', '1 Main St', '90001',
        '1 Main St, Los Angeles, CA 90001', @priceCents, 'Residential', 'No', 1, 10,
        '2026-08-08T00:00:00.000Z', 1, 1
      )
    `);

    [999, 1000, 1500, 2000, 2001].forEach((priceCents, index) => {
      insertAddress.run({
        id: index + 1,
        name: `Address ${index + 1}`,
        url: `https://example.test/address-${index + 1}`,
        priceCents,
      });
    });
    sqlite.close();
    process.env.DATABASE_URL = databaseUrl;

    const rangeData = await helpers.getPublicAddressesPageData(
      helpers.parsePublicAddressFilters({ minPrice: '10', maxPrice: '20' }),
    );
    assert.equal(rangeData.total, 3);
    assert.deepEqual(rangeData.items.map((item) => item.price), ['US$ 20.00', 'US$ 15.00', 'US$ 10.00']);

    const maximumData = await helpers.getPublicAddressesPageData(
      helpers.parsePublicAddressFilters({ maxPrice: '10' }),
    );
    assert.equal(maximumData.total, 2);

    const minimumData = await helpers.getPublicAddressesPageData(
      helpers.parsePublicAddressFilters({ minPrice: '20' }),
    );
    assert.equal(minimumData.total, 2);

    const invalidData = await helpers.getPublicAddressesPageData(
      helpers.parsePublicAddressFilters({ minPrice: '20', maxPrice: '10' }),
    );
    assert.equal(invalidData.total, 0);
    assert.equal(invalidData.stats.totalAddresses, 5);
    assert.equal(invalidData.states.length, 1);
  } finally {
    if (sqlite.open) sqlite.close();
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

test('addresses filter form submits to the result section anchor', () => {
  const source = readFileSync('apps/web/app/addresses/page.tsx', 'utf8');
  const priceFields = readFileSync('apps/web/app/_components/PublicPriceRangeFields.tsx', 'utf8');

  assert.match(source, /action="\/addresses#address-list-title"/);
  assert.match(source, /PublicPriceRangeFields/);
  assert.match(priceFields, /name="minPrice"/);
  assert.match(priceFields, /name="maxPrice"/);
  assert.match(priceFields, /type="number"/);
  assert.match(priceFields, /step="0\.01"/);
  assert.doesNotMatch(source, /name="price"/);
});

test('public address rows expose hover and visited visual states', () => {
  const css = readFileSync('apps/web/app/globals.css', 'utf8');

  assert.match(css, /\.addresses-row:hover/);
  assert.match(css, /\.addresses-row:focus-within/);
  assert.match(css, /\.addresses-row\.is-clicked/);
  assert.match(css, /\.addresses-row:has\(a:visited\)/);
  assert.match(css, /transition:[^;]*(background|box-shadow|border-color|transform)/);
});

test('public address list hides sorting and labels key metrics', () => {
  const source = readFileSync('apps/web/app/addresses/page.tsx', 'utf8');

  assert.doesNotMatch(source, /addresses-sort/);
  assert.match(source, /address\.rdi\}[\s\S]*RDI/);
  assert.match(source, /address\.cmra\}[\s\S]*CMRA/);
  assert.match(source, /address\.price\}[\s\S]*价格/);
  assert.match(source, /address\.mailbox\}[\s\S]*邮箱编号/);
});

test('public address result toolbar is compact on mobile', () => {
  const css = readFileSync('apps/web/app/globals.css', 'utf8');

  assert.match(css, /@media \(max-width: 680px\)[\s\S]*\.addresses-result-toolbar\s*\{[\s\S]*min-height:\s*auto/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*\.addresses-result-toolbar\s*\{[\s\S]*padding:\s*12px 14px/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*\.addresses-result-count\s*\{[\s\S]*font-size:\s*15px/);
});

test('public address pages use compact list sizing', () => {
  const css = readFileSync('apps/web/app/globals.css', 'utf8');

  assert.match(css, /\.addresses-inner\s*\{[\s\S]*width:\s*min\(1440px,/);
  assert.match(css, /\.addresses-hero h1\s*\{[\s\S]*font-size:\s*clamp\(34px,\s*2\.35vw,\s*44px\)/);
  assert.match(css, /\.addresses-input-like,[\s\S]*?\.addresses-search-form button\s*\{[\s\S]*min-height:\s*46px/);
  assert.match(css, /\.addresses-row\s*\{[\s\S]*min-height:\s*98px/);
  assert.match(css, /\.addresses-row\s*\{[\s\S]*padding:\s*15px 17px/);
  assert.match(css, /\.addresses-detail-button,[\s\S]*?\.addresses-photo-button\s*\{[\s\S]*min-height:\s*36px/);
});

test('public address pages persist clicked row state', () => {
  const component = readFileSync('apps/web/app/_components/AddressRowClickState.tsx', 'utf8');
  const addressesPage = readFileSync('apps/web/app/addresses/page.tsx', 'utf8');
  const residentialPage = readFileSync('apps/web/app/residential-addresses/page.tsx', 'utf8');

  assert.match(component, /'use client'/);
  assert.match(component, /localStorage/);
  assert.match(component, /data-address-row-id/);
  assert.match(addressesPage, /AddressRowClickState/);
  assert.match(addressesPage, /data-address-row-id=\{address\.id\}/);
  assert.match(residentialPage, /AddressRowClickState/);
  assert.match(residentialPage, /data-address-row-id=\{address\.id\}/);
});
