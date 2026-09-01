const crypto = require('node:crypto');
const express = require('express');
const openapi = require('../openapi.json');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const normalizeFqdn = (value) => String(value || '').trim().toLowerCase().replace(/\.$/, '');
const page = (items, req) => {
  const number = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 50));
  return {
    items: items.slice((number - 1) * size, number * size),
    total: items.length,
    page: number,
    size,
    pages: Math.ceil(items.length / size),
  };
};
const problem = (res, status, code, message) => res.status(status).json({
  code,
  message,
});
const secretsEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};
const basicPassword = (req) => {
  const authorization = req.get('authorization') || '';
  if (!authorization.startsWith('Basic ')) return '';
  const credentials = Buffer.from(authorization.slice(6), 'base64').toString();
  return credentials.slice(credentials.indexOf(':') + 1);
};
const dnsRecordFields = {
  A: ['rdata_address'],
  AAAA: ['rdata_address'],
  ANAME: ['rdata'],
  CAA: ['rdata_flags', 'rdata_tag', 'rdata_value'],
  CNAME: ['rdata_cname'],
  HTTPS: ['rdata_priority', 'rdata_target', 'rdata_parameters'],
  MX: ['rdata_preference', 'rdata_exchange'],
  SRV: ['rdata_priority', 'rdata_weight', 'rdata_port', 'rdata_target'],
  SSHFP: ['rdata_algorithm', 'rdata_fingerprint_type', 'rdata_fingerprint'],
  SVCB: ['rdata_priority', 'rdata_target', 'rdata_parameters'],
  TLSA: [
    'rdata_certificate_usage',
    'rdata_selector',
    'rdata_matching_type',
    'rdata_certificate_association_data',
  ],
  TXT: ['rdata_txt_data'],
};

function validateDnsRecord(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'JSON object is required';
  if (!dnsRecordFields[body.record_type]) return 'record_type is required and must be supported';
  if (typeof body.name !== 'string') return 'name is required';
  if (!Number.isInteger(body.ttl) || body.ttl < 0) return 'ttl must be a non-negative integer';
  const missing = dnsRecordFields[body.record_type].filter((field) => body[field] === undefined);
  return missing.length ? `${missing.join(', ')} is required for ${body.record_type}` : null;
}

function validateDnsRecordUpdate(body, domainId, recordId, existingRecord) {
  const validationError = validateDnsRecord(body);
  if (validationError) return validationError;
  if (!body.record_id) return 'record_id is required';
  if (body.record_id !== recordId) return 'Body record_id must match path record_id';
  if (body.domain_id && body.domain_id !== domainId) return 'Body domain_id must match path domain_id';
  if (body.note === undefined) return 'note is required';
  if (body.record_type !== existingRecord.record_type) return 'record_type cannot be changed';
  return null;
}

function domainListItem(domain) {
  return {
    fqdn: domain.fqdn,
    registration_datetime: domain.registration_datetime,
    suspension_datetime: domain.suspension_datetime,
    deletion_datetime: domain.deletion_datetime,
    snapshot_id: domain.snapshot_id,
    state: domain.state,
    domain_id: domain.domain_id,
    registrant_id: domain.registrant.registrant,
    registrant_name: domain.registrant.name,
    managing_contact_name: domain.managing_contact,
  };
}

function tokenDetail(token, includeSecret = false) {
  const result = {
    token_id: token.token_id,
    token_name: token.token_name,
    token: includeSecret ? token.token : '',
    contact_id: token.contact_id,
    issuer_ref_id: token.issuer_ref_id,
    issuer_name: token.issuer_name,
    scopes: token.scopes,
    issued: token.issued,
    last_used: token.last_used,
    expiration: token.expiration,
    managed_domains: token.managed_domains,
  };
  return result;
}

function userInfo(body = {}) {
  return {
    sub: body.sub || 'mock-user',
    handle: body.handle || 'MOCK',
    email: body.email || 'mock@example.test',
    scopes: body.scopes || ['dns_admin_read', 'dns_admin_write'],
    org_name: body.org_name || 'Mock organisation',
    company_registration_number: body.public_organization_identifier || '00000000',
    org_short_name: body.org_short_name || 'MOCK',
    name: `${body.given_name || 'Mock'} ${body.family_name || 'User'}`,
    family_name: body.family_name || 'User',
    given_name: body.given_name || 'Mock',
    phone: body.phone || null,
    managed_domain_ids: ['*'],
    contact: {
      id: body.sub || 'mock-user',
      handle: body.handle || 'MOCK',
      name: `${body.given_name || 'Mock'} ${body.family_name || 'User'}`,
    },
  };
}

function createApp({ store, portalPassword = 'change-me' }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({
    type: ['text/plain', 'application/x-www-form-urlencoded'],
    limit: '1mb',
  }));
  app.use((req, res, next) => {
    if (typeof req.body !== 'string') return next();
    const body = req.body.trim();
    if (!body) {
      req.body = {};
      return next();
    }
    try {
      req.body = JSON.parse(body);
      next();
    } catch {
      problem(res, 400, 'INVALID_JSON', 'Request body must contain valid JSON');
    }
  });

  app.get('/openapi.json', (_req, res) => res.json(openapi));
  app.get('/v1/healthcheck/', (_req, res) => res.json({ status: 'ok' }));

  app.post('/v1/login/', (req, res) => {
    res.cookie('access_token', 'mock-access-token', { httpOnly: true, sameSite: 'lax' });
    res.json(userInfo(req.body));
  });
  app.post('/v1/logout/', (_req, res) => {
    res.clearCookie('access_token');
    res.json({});
  });
  app.post('/v1/refresh/', (_req, res) => res.json(userInfo()));

  app.use('/v1', async (req, res, next) => {
    const apiKey = req.get('x-api-key');
    const portalCredential = req.get('x-portal-password') || basicPassword(req);
    const portalAccess = secretsEqual(portalCredential, portalPassword);
    if (portalAccess) return next();
    if (!apiKey || !apiKey.trim()) {
      return problem(res, 401, 'MISSING_API_KEY', 'X-API-Key header is required');
    }
    try {
      const state = await store.read();
      const tokenAccess = state.tokens.some((token) => secretsEqual(apiKey, token.token));
      if (!tokenAccess) {
        return problem(res, 401, 'INVALID_API_KEY', 'X-API-Key is not valid');
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/domains/', async (req, res, next) => {
    try {
      const state = await store.read();
      let domains = state.domains;
      if (req.query.search_term) {
        const term = String(req.query.search_term).toLowerCase();
        domains = domains.filter((domain) => domain.fqdn.includes(term));
      }
      if (req.query.include_history !== 'true') {
        domains = domains.filter((domain) => domain.state !== 'deleted');
      }
      res.json(page(domains.map(domainListItem), req));
    } catch (error) { next(error); }
  });

  app.post('/v1/domains/', async (req, res, next) => {
    try {
      const body = req.body || {};
      const fqdn = normalizeFqdn(body.fqdn);
      if (!fqdn) return problem(res, 422, 'INVALID_REQUEST', 'fqdn is required');
      const response = await store.update((state) => {
        if (state.domains.some((domain) => domain.fqdn === fqdn && domain.state !== 'deleted')) return null;
        const timestamp = now();
        const domainId = uuid();
        const requestId = uuid();
        state.domains.push({
          domain_id: domainId,
          fqdn,
          registration_datetime: timestamp,
          suspension_datetime: null,
          deletion_datetime: null,
          updated_datetime: timestamp,
          state: 'registered',
          registrant: {
            registrant: body.registrant_contact_id || 'mock-contact',
            email: body.registrant_email || body.solicitant_email || 'mock@example.test',
            phone: body.registrant_phone || body.solicitant_phone || '+420.123456789',
            address: {
              street: body.registrant_street || ['Mock street 1'],
              city: body.registrant_city || 'Prague',
              state_or_province: '',
              postal_code: body.registrant_postal_code || '10000',
              country_code: body.registrant_country_code || 'CZ',
            },
            name: body.registrant_name || 'Mock Registrant',
            company_registration_number: body.company_registration_number || '00000000',
          },
          snapshot_id: uuid(),
          solicitant: {
            name: body.solicitant_name || 'Mock User',
            email: body.solicitant_email || 'mock@example.test',
            phone: body.solicitant_phone || '+420.123456789',
          },
          deletable: true,
          managing_contact: body.managing_contact || null,
          note: body.note || '',
          records: [],
        });
        const request = {
          registration_request_id: requestId,
          domain_id: domainId,
          fqdn,
          note: body.note || '',
          registrant_contact_id: body.registrant_contact_id || 'mock-contact',
          registrant_name: body.registrant_name || 'Mock Registrant',
          registrant_handle: body.registrant_handle || 'MOCK',
          resolved_by_ref_id: 'mock-user',
          resolved_by_name: 'Mock User',
          solicitant_ref_id: 'mock-user',
          solicitant_email: body.solicitant_email || 'mock@example.test',
          solicitant_name: body.solicitant_name || 'Mock User',
          solicitant_phone: body.solicitant_phone || '+420.123456789',
          created: timestamp,
          updated: timestamp,
          state: 'accepted',
          state_changed: timestamp,
          direct_registration: true,
        };
        state.requests.push(request);
        return request;
      });
      if (!response) return problem(res, 409, 'DOMAIN_CONFLICT', 'Domain already exists');
      res.status(201).json(response);
    } catch (error) { next(error); }
  });

  app.get('/v1/domains/stats/', async (_req, res, next) => {
    try {
      const { domains } = await store.read();
      res.json({
        total: domains.length,
        registered: domains.filter((item) => item.state === 'registered').length,
        suspended: domains.filter((item) => item.state === 'suspended').length,
        deleted: domains.filter((item) => item.state === 'deleted').length,
      });
    } catch (error) { next(error); }
  });

  app.get('/v1/domains/:domainId/', async (req, res, next) => {
    try {
      const state = await store.read();
      const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
      if (!domain) return problem(res, 404, 'DOMAIN_NOT_FOUND', 'Domain not found');
      res.json(domain);
    } catch (error) { next(error); }
  });

  app.patch('/v1/domains/:domainId/', async (req, res, next) => {
    try {
      const result = await store.update((state) => {
        const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
        if (!domain) return null;
        if (req.body.registrant_id) domain.registrant.registrant = req.body.registrant_id;
        if (req.body.note !== undefined) domain.note = req.body.note;
        domain.snapshot_id = uuid();
        domain.updated_datetime = now();
        return { domain_id: domain.domain_id, history_id: domain.snapshot_id };
      });
      if (!result) return problem(res, 404, 'DOMAIN_NOT_FOUND', 'Domain not found');
      res.json(result);
    } catch (error) { next(error); }
  });

  app.delete('/v1/domains/:domainId/', async (req, res, next) => {
    try {
      const result = await store.update((state) => {
        const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
        if (!domain) return null;
        domain.state = 'deleted';
        domain.deletion_datetime = now();
        domain.updated_datetime = domain.deletion_datetime;
        domain.snapshot_id = uuid();
        return { domain_id: domain.domain_id, history_id: domain.snapshot_id };
      });
      if (!result) return problem(res, 404, 'DOMAIN_NOT_FOUND', 'Domain not found');
      res.json(result);
    } catch (error) { next(error); }
  });

  for (const [action, stateName] of [['suspend', 'suspended'], ['resume', 'registered']]) {
    app.post(`/v1/domains/:domainId/${action}/`, async (req, res, next) => {
      try {
        const result = await store.update((state) => {
          const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
          if (!domain) return null;
          domain.state = stateName;
          domain.suspension_datetime = stateName === 'suspended' ? now() : null;
          domain.updated_datetime = now();
          domain.snapshot_id = uuid();
          return { domain_id: domain.domain_id, history_id: domain.snapshot_id };
        });
        if (!result) return problem(res, 404, 'DOMAIN_NOT_FOUND', 'Domain not found');
        res.json(result);
      } catch (error) { next(error); }
    });
  }

  app.get('/v1/domains/:domainId/history/', async (req, res, next) => {
    try {
      const state = await store.read();
      const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
      if (!domain) return problem(res, 404, 'DOMAIN_NOT_FOUND', 'Domain not found');
      res.json(page([domain], req));
    } catch (error) { next(error); }
  });

  app.get('/v1/domains/:domainId/dns_records/', async (req, res, next) => {
    try {
      const state = await store.read();
      const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
      if (!domain) return problem(res, 404, 'DOMAIN_NOT_FOUND', 'Domain not found');
      let records = domain.records.filter((item) => req.query.include_history === 'true' || !item.valid_to);
      const types = req.query.record_types;
      if (types) {
        const accepted = Array.isArray(types) ? types : String(types).split(',');
        records = records.filter((item) => accepted.includes(item.record_type));
      }
      res.json(page(records, req));
    } catch (error) { next(error); }
  });

  app.post('/v1/domains/:domainId/dns_records/', async (req, res, next) => {
    try {
      const validationError = validateDnsRecord(req.body);
      if (validationError) return problem(res, 422, 'INVALID_REQUEST', validationError);
      if (req.body.domain_id && req.body.domain_id !== req.params.domainId) {
        return problem(res, 400, 'INVALID_REQUEST', 'Body domain_id must match path domain_id');
      }
      const result = await store.update((state) => {
        const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
        if (!domain) return null;
        const record = {
          ...req.body,
          id: uuid(),
          history_id: uuid(),
          domain_id: domain.domain_id,
          note: req.body.note || '',
          valid_from: now(),
          valid_to: null,
          record_type: req.body.record_type,
        };
        domain.records.push(record);
        return record;
      });
      if (!result) return problem(res, 404, 'DOMAIN_NOT_FOUND', 'Domain not found');
      res.status(201).json(result);
    } catch (error) { next(error); }
  });

  app.put('/v1/domains/:domainId/dns_records/:recordId/', async (req, res, next) => {
    try {
      const state = await store.read();
      const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
      const existingRecord = domain?.records.find(
        (item) => item.id === req.params.recordId && !item.valid_to,
      );
      if (!existingRecord) {
        return problem(res, 404, 'DNS_RECORD_NOT_FOUND', 'DNS record not found');
      }
      const validationError = validateDnsRecordUpdate(
        req.body,
        req.params.domainId,
        req.params.recordId,
        existingRecord,
      );
      if (validationError) return problem(res, 422, 'INVALID_REQUEST', validationError);

      const result = await store.update((state) => {
        const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
        const record = domain?.records.find((item) => item.id === req.params.recordId && !item.valid_to);
        if (!record) return null;
        const { record_id: _recordId, ...changes } = req.body;
        Object.assign(record, changes, {
          id: record.id,
          domain_id: domain.domain_id,
          history_id: uuid(),
          valid_from: now(),
          valid_to: null,
        });
        return record;
      });
      if (!result) return problem(res, 404, 'DNS_RECORD_NOT_FOUND', 'DNS record not found');
      res.json(result);
    } catch (error) { next(error); }
  });

  app.delete('/v1/domains/:domainId/dns_records/:recordId/', async (req, res, next) => {
    try {
      const deleted = await store.update((state) => {
        const domain = state.domains.find((item) => item.domain_id === req.params.domainId);
        const record = domain?.records.find((item) => item.id === req.params.recordId && !item.valid_to);
        if (!record) return false;
        record.valid_to = now();
        return true;
      });
      if (!deleted) return problem(res, 404, 'DNS_RECORD_NOT_FOUND', 'DNS record not found');
      res.json({});
    } catch (error) { next(error); }
  });

  app.get('/v1/tokens/', async (req, res, next) => {
    try {
      const state = await store.read();
      res.json(page(state.tokens.map((token) => tokenDetail(token)), req));
    } catch (error) { next(error); }
  });

  app.post('/v1/tokens/', async (req, res, next) => {
    try {
      const token = await store.update((state) => {
        const managedIds = req.body.managed_domain_ids || ['*'];
        const item = {
          token_id: uuid(),
          token_name: req.body.token_name || 'Mock API key',
          token: `dnsp_mock_${crypto.randomBytes(24).toString('hex')}`,
          contact_id: 'mock-contact',
          issuer_ref_id: 'mock-user',
          issuer_name: 'Mock User',
          scopes: [req.body.scope || 'dns_token_write'],
          issued: now(),
          last_used: null,
          expiration: req.body.expiration || null,
          managed_domains: managedIds.map((id) => {
            const domain = state.domains.find((item) => item.domain_id === id);
            return { domain_id: id, fqdn: domain?.fqdn || null };
          }),
        };
        state.tokens.push(item);
        return item;
      });
      res.status(201).json(tokenDetail(token, true));
    } catch (error) { next(error); }
  });

  app.get('/v1/tokens/:tokenId/', async (req, res, next) => {
    try {
      const state = await store.read();
      const token = state.tokens.find((item) => item.token_id === req.params.tokenId);
      if (!token) return problem(res, 404, 'TOKEN_NOT_FOUND', 'API token not found');
      res.json(tokenDetail(token));
    } catch (error) { next(error); }
  });

  app.delete('/v1/tokens/:tokenId/', async (req, res, next) => {
    try {
      const deleted = await store.update((state) => {
        const index = state.tokens.findIndex((item) => item.token_id === req.params.tokenId);
        if (index < 0) return false;
        state.tokens.splice(index, 1);
        return true;
      });
      if (!deleted) return problem(res, 404, 'TOKEN_NOT_FOUND', 'API token not found');
      res.json({});
    } catch (error) { next(error); }
  });

  app.get('/v1/zones/', async (_req, res, next) => {
    try {
      const state = await store.read();
      res.json(state.domains.filter((item) => item.state !== 'deleted')
        .map((item) => ({ fqdn: item.fqdn, domain_id: item.domain_id })));
    } catch (error) { next(error); }
  });

  app.get('/v1/fqdn_check/', async (req, res, next) => {
    try {
      const fqdn = normalizeFqdn(req.query.fqdn);
      const state = await store.read();
      res.json({ fqdn, available: !state.domains.some((item) => item.fqdn === fqdn && item.state !== 'deleted') });
    } catch (error) { next(error); }
  });
  app.get('/v1/fqdn_translation/', async (req, res, next) => {
    try {
      const fqdn = normalizeFqdn(req.query.fqdn);
      const state = await store.read();
      const domain = state.domains.find((item) => item.fqdn === fqdn && item.state !== 'deleted');
      if (!domain) return problem(res, 404, 'DOMAIN_NOT_FOUND', 'Domain not found');
      res.json(domain.domain_id);
    } catch (error) { next(error); }
  });
  app.post('/v1/fqdn_cname_conflict_check/', (_req, res) => res.json({ conflict: false }));

  const portalAuth = (req, res, next) => {
    const supplied = req.get('x-portal-password') || basicPassword(req) || req.query.password || req.body?.password;
    if (!secretsEqual(supplied, portalPassword)) {
      res.set('www-authenticate', 'Basic realm="DNSPortal mock admin"');
      return res.status(401).send('Invalid portal password');
    }
    next();
  };

  app.get('/admin', portalAuth, (_req, res) => res.type('html').send(adminHtml()));
  app.get('/admin/state', portalAuth, async (_req, res, next) => {
    try { res.json(await store.read()); } catch (error) { next(error); }
  });
  app.post('/admin/reset', portalAuth, async (_req, res, next) => {
    try { await store.reset(); res.json({ ok: true }); } catch (error) { next(error); }
  });

  app.use((req, res) => problem(res, 404, 'NOT_IMPLEMENTED', `Mock route not implemented: ${req.method} ${req.path}`));
  app.use((error, _req, res, _next) => {
    console.error(error);
    problem(res, 500, 'MOCK_ERROR', error.message);
  });
  return app;
}

function adminHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>DNSPortal mock admin</title>
<style>
body{font:15px system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#17202a}input,select,button{padding:.55rem;margin:.2rem}fieldset{margin:1rem 0;border:1px solid #ccd1d1;border-radius:6px}pre{background:#f4f6f7;padding:1rem;overflow:auto}button{cursor:pointer}.row{display:flex;gap:1rem;flex-wrap:wrap}.row fieldset{flex:1;min-width:280px}.danger{color:#922b21}
</style></head><body>
<h1>DNSPortal mock admin</h1>
<p>Changes use the same API as integration tests. Enter the configured <code>PORTAL_PASSWORD</code>.</p>
<input id="password" type="password" placeholder="Portal password"><button onclick="refresh()">View live state</button>
<div class="row">
<fieldset><legend>Create domain</legend>
<input id="fqdn" placeholder="example.gov.cz"><button onclick="createDomain()">Create</button></fieldset>
<fieldset><legend>Create API key</legend>
<input id="tokenName" placeholder="Demo key"><select id="scope"><option>dns_token_write</option><option>dns_token_read</option></select>
<button onclick="createToken()">Create</button></fieldset>
<fieldset><legend>Create DNS record</legend>
<input id="domainId" placeholder="Domain ID"><input id="recordName" placeholder="www"><select id="recordType"><option>A</option><option>AAAA</option><option>CNAME</option><option>TXT</option></select>
<input id="recordData" placeholder="127.0.0.1"><button onclick="createRecord()">Create</button></fieldset>
</div>
<button class="danger" onclick="resetState()">Delete all mock data</button>
<h2>Currently alive</h2><pre id="state">Authenticate to load state.</pre>
<script>
const p=()=>document.querySelector('#password').value;
async function call(url, options={}) {
  options.credentials='same-origin';
  options.headers={...(options.headers||{}),'content-type':'application/json'};
  if(p()) options.headers['x-portal-password']=p();
  const response=await fetch(url,options); const text=await response.text();
  if(!response.ok) throw new Error(text); return text ? JSON.parse(text) : {};
}
async function refresh(){try{state.textContent=JSON.stringify(await call('/admin/state'),null,2)}catch(e){alert(e.message)}}
async function createDomain(){try{await call('/v1/domains/',{method:'POST',body:JSON.stringify({fqdn:fqdn.value,registrant_contact_id:'demo-contact',solicitant_name:'Portal Admin',solicitant_email:'admin@example.test',solicitant_phone:'+420.123456789',note:'Created in mock portal'})});await refresh()}catch(e){alert(e.message)}}
async function createToken(){try{const result=await call('/v1/tokens/',{method:'POST',body:JSON.stringify({token_name:tokenName.value||'Demo key',scope:scope.value,managed_domain_ids:['*']})});alert('Save this token: '+result.token);await refresh()}catch(e){alert(e.message)}}
async function createRecord(){try{const data={record_type:recordType.value,name:recordName.value,ttl:300,note:'Created in mock portal'};data[recordType.value==='A'||recordType.value==='AAAA'?'rdata_address':recordType.value==='CNAME'?'rdata_cname':'rdata_txt_data']=recordData.value;await call('/v1/domains/'+domainId.value+'/dns_records/',{method:'POST',body:JSON.stringify(data)});await refresh()}catch(e){alert(e.message)}}
async function resetState(){if(confirm('Delete all mock data?')){try{await call('/admin/reset',{method:'POST',body:'{}'});await refresh()}catch(e){alert(e.message)}}}
</script></body></html>`;
}

module.exports = { createApp };
