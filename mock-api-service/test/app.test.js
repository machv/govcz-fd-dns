const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createApp } = require('../src/app');
const { FileStore, MemoryStore } = require('../src/store');

let server;
let baseUrl;

before(async () => {
  server = createApp({
    store: new MemoryStore({
      domains: [],
      requests: [],
      tokens: [{
        token_id: 'test-token',
        token_name: 'Test key',
        token: 'test-key',
        contact_id: 'mock-contact',
        issuer_ref_id: 'mock-user',
        issuer_name: 'Mock User',
        scopes: ['dns_token_write'],
        issued: new Date().toISOString(),
        last_used: null,
        expiration: null,
        managed_domains: [{ domain_id: '*', fqdn: null }],
      }],
    }),
    portalPassword: 'secret',
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', ...(options.headers || {}) },
  });
  const body = await response.json();
  return { response, body };
}

test('rejects protected API requests without X-API-Key', async () => {
  const response = await fetch(`${baseUrl}/v1/domains/`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'MISSING_API_KEY');
});

test('rejects an unknown X-API-Key', async () => {
  const response = await fetch(`${baseUrl}/v1/domains/`, {
    headers: { 'x-api-key': 'wrong-key' },
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'INVALID_API_KEY');
});

test('allows authenticated admin portal calls without X-API-Key', async () => {
  const response = await fetch(`${baseUrl}/v1/tokens/`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token_name: 'Portal key', scope: 'dns_token_read' }),
  });
  assert.equal(response.status, 201);
  assert.match((await response.json()).token, /^dnsp_mock_/);
});

test('creates a domain, DNS record, and API token', async () => {
  const createdDomain = await request('/v1/domains/', {
    method: 'POST',
    body: JSON.stringify({
      fqdn: 'Demo.GOV.CZ.',
      registrant_contact_id: 'contact-1',
      solicitant_name: 'Tester',
      solicitant_email: 'test@example.test',
      solicitant_phone: '+420.123456789',
      note: 'integration test',
    }),
  });
  assert.equal(createdDomain.response.status, 201);
  assert.equal(createdDomain.body.fqdn, 'demo.gov.cz');

  const domainId = createdDomain.body.domain_id;
  const domain = await request(`/v1/domains/${domainId}/`);
  assert.equal(domain.body.registrant.registrant, 'contact-1');
  assert.equal(domain.body.registrant.address.country_code, 'CZ');

  const createdRecord = await request(`/v1/domains/${domainId}/dns_records/`, {
    method: 'POST',
    body: JSON.stringify({ record_type: 'A', name: 'www', ttl: 300, rdata_address: '127.0.0.1' }),
  });
  assert.equal(createdRecord.response.status, 201);
  assert.equal(createdRecord.body.domain_id, domainId);

  const records = await request(`/v1/domains/${domainId}/dns_records/`);
  assert.equal(records.body.total, 1);
  assert.equal(records.body.items[0].record_type, 'A');

  const powershellRecord = await request(`/v1/domains/${domainId}/dns_records/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: JSON.stringify({
      domain_id: domainId,
      name: '_dnsauth',
      ttl: 3600,
      rdata_txt_data: 'tralala',
      note: '',
      record_type: 'TXT',
    }),
  });
  assert.equal(powershellRecord.response.status, 201);
  assert.equal(powershellRecord.body.record_type, 'TXT');
  assert.equal(powershellRecord.body.rdata_txt_data, 'tralala');
  assert.equal(powershellRecord.body.name, '_dnsauth');

  const invalidUpdate = await request(
    `/v1/domains/${domainId}/dns_records/${powershellRecord.body.id}/`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: JSON.stringify({
        domain_id: powershellRecord.body.id,
        name: '_dnsauth',
        ttl: 3600,
        rdata_txt_data: 'trololo',
        record_type: 'TXT',
      }),
    },
  );
  assert.equal(invalidUpdate.response.status, 422);
  assert.equal(invalidUpdate.body.message, 'record_id is required');

  const updatedRecord = await request(
    `/v1/domains/${domainId}/dns_records/${powershellRecord.body.id}/`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: JSON.stringify({
        record_id: powershellRecord.body.id,
        domain_id: domainId,
        name: '_dnsauth',
        ttl: 3600,
        rdata_txt_data: 'trololo',
        note: '',
        record_type: 'TXT',
      }),
    },
  );
  assert.equal(updatedRecord.response.status, 200);
  assert.equal(updatedRecord.body.rdata_txt_data, 'trololo');

  const recordsAfterUpdate = await request(`/v1/domains/${domainId}/dns_records/`);
  const persistedRecord = recordsAfterUpdate.body.items.find(
    (item) => item.id === powershellRecord.body.id,
  );
  assert.equal(persistedRecord.rdata_txt_data, 'trololo');

  const createdToken = await request('/v1/tokens/', {
    method: 'POST',
    body: JSON.stringify({ token_name: 'CI token', scope: 'dns_token_write', managed_domain_ids: [domainId] }),
  });
  assert.equal(createdToken.response.status, 201);
  assert.match(createdToken.body.token, /^dnsp_mock_/);

  const tokenAuthenticated = await request('/v1/zones/', {
    headers: { 'x-api-key': createdToken.body.token },
  });
  assert.equal(tokenAuthenticated.response.status, 200);

  const translated = await request('/v1/fqdn_translation/?fqdn=demo.gov.cz', {
    headers: { 'x-api-key': createdToken.body.token },
  });
  assert.equal(translated.response.status, 200);
  assert.equal(translated.body, domainId);

  const tokenList = await request('/v1/tokens/');
  const listedToken = tokenList.body.items.find((item) => item.token_id === createdToken.body.token_id);
  assert.ok(listedToken);
  assert.equal(listedToken.token, '');
});

test('protects portal state with the configured password', async () => {
  const denied = await fetch(`${baseUrl}/admin/state`);
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${baseUrl}/admin/state`, {
    headers: { 'x-portal-password': 'secret' },
  });
  assert.equal(allowed.status, 200);
});

test('persists local state across FileStore instances', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dnsportal-mock-'));
  const statePath = path.join(directory, 'state.json');
  try {
    const first = new FileStore(statePath);
    await first.update((state) => state.domains.push({ domain_id: 'persisted' }));
    const second = new FileStore(statePath);
    assert.equal((await second.read()).domains[0].domain_id, 'persisted');
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});
