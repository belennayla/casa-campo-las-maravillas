// Mercado Pago SIMULADO para pruebas locales (Orders API · Checkout Pro). Puerto 8790.
// Imita: GET /users/me, POST /v1/orders (con X-Idempotency-Key), GET /v1/orders/:id, POST /v1/orders/:id/cancel.
// Rutas de control para las pruebas: /__control/*
import http from 'node:http';

const ordenes = new Map();     // id -> orden
const porClave = new Map();    // idempotency key -> { id, cuerpo }
let creadas = 0, cuentaPrueba = true, fallarGet = 0;
const telegram = []; let telegramFalla = 0;
const ical = { booking: [], airbnb: [], fallar: [] }; let jwks = { keys: [] };

const responder = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
const leer = req => new Promise(ok => { let b = ''; req.on('data', c => b += c); req.on('end', () => ok(b)); });
const nuevoId = () => 'ORD01' + Array.from({ length: 21 }, () => 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'[Math.floor(Math.random() * 32)]).join('');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const cuerpo = await leer(req);
  // --- control ---
  if (url.pathname === '/__control/estado') {           // simula lo que hace el comprador / Mercado Pago
    const c = JSON.parse(cuerpo); const o = ordenes.get(c.order_id);
    if (!o) return responder(res, 404, { error: 'no existe' });
    o.status = c.status; o.status_detail = c.status_detail;
    if (c.pago) {
      o.transactions = { payments: [{ id: c.pago.id || 'PAY01' + Math.random().toString(36).slice(2, 12).toUpperCase(), amount: c.pago.amount ?? o.total_amount, paid_amount: c.pago.paid_amount ?? c.pago.amount ?? o.total_amount, status: c.pago.status, status_detail: c.pago.status_detail, payment_method: { id: 'master', type: 'credit_card' } }] };
      o.total_paid_amount = c.pago.status === 'processed' ? (c.pago.paid_amount ?? o.total_amount) : '0.00';
    }
    if (c.currency) o.currency = c.currency;
    return responder(res, 200, o);
  }
  if (url.pathname === '/__control/config') { const c = JSON.parse(cuerpo); if ('cuentaPrueba' in c) cuentaPrueba = c.cuentaPrueba; if ('fallarGet' in c) fallarGet = c.fallarGet; return responder(res, 200, { cuentaPrueba, fallarGet }); }
  if (url.pathname === '/__control/resumen') return responder(res, 200, { creadas, ordenes: [...ordenes.values()].map(o => ({ id: o.id, status: o.status, total_amount: o.total_amount, external_reference: o.external_reference, expiration_time: o.expiration_time, not_allowed_types: o.config?.payment_method?.not_allowed_types })) });

  // --- Turnstile simulado: token "ok" = humano; cualquier otro = rechazado ---
  if (url.pathname === '/turnstile/v0/siteverify' && req.method === 'POST') {
    const token = (cuerpo.match(/name="response"\r\n\r\n([^\r]*)/) || [])[1] || new URLSearchParams(cuerpo).get('response');
    const secreto = (cuerpo.match(/name="secret"\r\n\r\n([^\r]*)/) || [])[1] || new URLSearchParams(cuerpo).get('secret');
    if (!secreto) return responder(res, 200, { success: false, 'error-codes': ['missing-input-secret'] });
    return responder(res, 200, token === 'ok' ? { success: true, hostname: 'localhost' } : { success: false, 'error-codes': ['invalid-input-response'] });
  }
  // --- Telegram simulado ---
  if (/^\/bot[^/]+\/sendMessage$/.test(url.pathname) && req.method === 'POST') { telegram.push(JSON.parse(cuerpo)); return responder(res, telegramFalla-- > 0 ? 500 : 200, { ok: true }); }
  if (url.pathname === '/__control/telegram') { if (req.method === 'POST') { const c = JSON.parse(cuerpo || '{}'); telegramFalla = c.fallar || 0; } return responder(res, 200, { mensajes: telegram }); }

  // --- Calendarios iCal simulados de Booking y Airbnb (para la consulta en vivo del panel) ---
  if (url.pathname === '/__control/ical' && req.method === 'POST') { Object.assign(ical, JSON.parse(cuerpo)); return responder(res, 200, ical); }
  const mi = url.pathname.match(/^\/ical\/(booking|airbnb)\.ics$/);
  if (mi) {
    if ((ical.fallar || []).includes(mi[1])) { res.writeHead(503); return res.end('error'); }
    const ev = (ical[mi[1]] || []).map((b, i) => `BEGIN:VEVENT\r\nUID:${mi[1]}${i}\r\nDTSTART;VALUE=DATE:${b.desde.replace(/-/g, '')}\r\nDTEND;VALUE=DATE:${b.hasta.replace(/-/g, '')}\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\n`).join('');
    res.writeHead(200, { 'content-type': 'text/calendar' }); return res.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ev}END:VCALENDAR\r\n`);
  }
  // --- Claves públicas de Cloudflare Access simuladas (JWKS) ---
  if (url.pathname === '/__control/jwks' && req.method === 'POST') { jwks = JSON.parse(cuerpo); return responder(res, 200, { ok: true }); }
  if (url.pathname === '/certs') return responder(res, 200, jwks);

  // --- API simulada ---
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return responder(res, 401, { error: 'invalid_credentials' });
  if (url.pathname === '/users/me' && req.method === 'GET') return responder(res, 200, { id: 123, nickname: 'TESTVENDEDOR', tags: cuentaPrueba ? ['normal', 'test_user'] : ['normal'] });
  if (url.pathname === '/v1/orders' && req.method === 'POST') {
    const clave = req.headers['x-idempotency-key'];
    if (!clave) return responder(res, 400, { error: 'empty_required_header' });
    const previa = porClave.get(clave);
    if (previa) return previa.cuerpo === cuerpo ? responder(res, 201, ordenes.get(previa.id)) : responder(res, 409, { error: 'idempotency_key_already_used' });
    const b = JSON.parse(cuerpo);
    if (b.type !== 'online' || b.processing_mode !== 'manual' || !b.total_amount) return responder(res, 400, { error: 'invalid_body' });
    if ((b.items || []).some(i => String(i.external_code || '').length > 30)) return responder(res, 400, { errors: [{ code: 'property_value', message: 'Invalid value for property', details: ["'$.items[0].external_code' - length must be <= 30"] }] });
    if (String(b.external_reference || '').length > 64) return responder(res, 400, { errors: [{ code: 'property_value', message: 'external_reference too long' }] });
    const suma = (b.items || []).reduce((s, i) => s + Number(i.unit_price) * Number(i.quantity), 0);
    if (Math.round(suma * 100) !== Math.round(Number(b.total_amount) * 100)) return responder(res, 400, { error: 'order_items_total_amount_mismatch' });
    const id = nuevoId(); creadas++;
    const o = { id, type: 'online', processing_mode: 'manual', status: 'created', status_detail: 'created', external_reference: b.external_reference, total_amount: b.total_amount, total_paid_amount: '0.00', currency: 'ARS', expiration_time: b.expiration_time, config: b.config, checkout_url: `https://sandbox.mercadopago.test/checkout/v1/redirect?order_id=${id}`, transactions: { payments: [] } };
    ordenes.set(id, o); porClave.set(clave, { id, cuerpo });
    return responder(res, 201, o);
  }
  const m = url.pathname.match(/^\/v1\/orders\/([A-Z0-9]+)(\/cancel)?$/);
  if (m) {
    const o = ordenes.get(m[1]);
    if (!o) return responder(res, 404, { error: 'order_not_found' });
    if (!m[2] && req.method === 'GET') { if (fallarGet > 0) { fallarGet--; return responder(res, 500, { error: 'internal_error' }); } return responder(res, 200, o); }
    if (m[2] && req.method === 'POST') {
      if (!req.headers['x-idempotency-key']) return responder(res, 400, { error: 'empty_required_header' });
      if (o.status === 'canceled') return responder(res, 409, { error: 'order_already_canceled' });
      if (!['created', 'action_required'].includes(o.status)) return responder(res, 409, { error: 'cannot_cancel_order' });
      o.status = 'canceled'; o.status_detail = 'canceled_transaction';
      return responder(res, 200, o);
    }
  }
  if (url.pathname.startsWith('/v1/payments/')) return responder(res, 404, { error: 'not_found' });
  responder(res, 404, { error: 'not_found' });
}).listen(8790, '127.0.0.1', () => console.log('Mercado Pago simulado en http://127.0.0.1:8790'));
