// Pruebas de la RESERVA AUTOMÁTICA (Fase 1) contra servicios SIMULADOS: Mercado Pago, Turnstile, Telegram, iCal,
// Cloudflare Access y un gestor de canales con la API de Smoobu. Se corre en varios ESCENARIOS (ver correr-todo.mjs):
//   produccion          configuración real de producción (todo apagado)
//   ical                sin gestor de canales: jamás confirma solo, aunque esté autorizado
//   smoobu              gestor verificado: recorrido automático completo, fallas y conflictos
//   smoobu_sin_verificar gestor conectado pero sin comprobar que cierra Booking/Airbnb: no confirma solo
//   aislamiento         las reservas de prueba nunca tocan el gestor real ni los calendarios
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'http://127.0.0.1:8787', PANEL = process.env.PANEL || 'http://127.0.0.1:8788', MP = 'http://127.0.0.1:8790';
const CLAVE = process.env.CLAVE, SECRETO = process.env.SECRETO, ESC = process.env.ESCENARIO || 'smoobu';
const WEBHOOK_TOKEN = 'token-webhook-gestor-simulado-0123456789abcdef';
let fallas = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  MAL ') + m); if (!c) fallas++; };
const esperar = ms => new Promise(r => setTimeout(r, ms));
const j = r => r.json();
const fecha = d => new Date(Date.parse('2027-04-01') + d * 864e5).toISOString().slice(0, 10);
let cursor = Math.floor(Math.random() * 40);
const fechas = (n = 2) => { const a = fecha(cursor), b = fecha(cursor + n); cursor += n + 1; return [a, b]; };
const contacto = { nombre: 'Lucía Prueba', telefono: '2664 333444', email: 'lucia@example.com', acepto: true };

// --- Access simulado para el panel ---
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
await fetch(MP + '/__control/jwks', { method: 'POST', body: JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }) });
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const ahoraS = Math.floor(Date.now() / 1000);
const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), p = b64({ iss: 'https://equipo-prueba.cloudflareaccess.com', aud: ['aud-de-prueba'], email: 'duenos@example.com', iat: ahoraS, nbf: ahoraS, exp: ahoraS + 7200 });
const TOKEN = `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
const admin = (ruta, body) => fetch(PANEL + ruta, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': TOKEN }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, ...(await j(r)) }));

// --- helpers ---
const reservar = async ([ingreso, salida], { medio = 'mercadopago', venceSeg, turnstile = 'ok', conClave = true, clave = crypto.randomUUID(), extra = {} } = {}) => {
  const r = await fetch(BASE + '/api/reservas', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': clave, ...(conClave ? { 'x-clave-pruebas': CLAVE } : {}) },
    body: JSON.stringify({ ingreso, salida, adultos: 2, menores: 1, ...contacto, medio_pago: medio, turnstile, ...(venceSeg ? { vence_en_segundos: venceSeg } : {}), ...extra }) });
  return { status: r.status, ...(await j(r)) };
};
const mi = async acceso => { const r = await fetch(BASE + '/api/mi-reserva', { headers: { 'x-acceso': acceso } }); return { status: r.status, ...(await j(r)) }; };
const det = numero => fetch(`${BASE}/api/pruebas/reservas/${numero}`, { headers: { 'x-clave-pruebas': CLAVE } }).then(j);
const mpEstado = (order_id, c) => fetch(MP + '/__control/estado', { method: 'POST', body: JSON.stringify({ order_id, ...c }) }).then(j);
const mpResumen = () => fetch(MP + '/__control/resumen').then(j);
const cron = async () => { await fetch(BASE + '/__scheduled?cron=*/5+*+*+*+*'); await esperar(1200); };
const webhook = async orderId => {
  const reqId = crypto.randomUUID(), ts = Math.floor(Date.now() / 1000);
  const firma = crypto.createHmac('sha256', SECRETO).update(`id:${orderId};request-id:${reqId};ts:${ts};`).digest('hex');
  await fetch(`${BASE}/api/webhooks/mercadopago?data.id=${orderId}&type=order`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': reqId, 'x-signature': `ts=${ts},v1=${firma}` }, body: JSON.stringify({ type: 'order', data: { id: orderId } }) });
  await esperar(1800);
};
const APROBADO = { status: 'processed', status_detail: 'accredited', pago: { status: 'processed', status_detail: 'accredited' } };
const RECHAZADO = { status: 'action_required', status_detail: 'waiting_retry', pago: { status: 'failed', status_detail: 'rejected_by_issuer', paid_amount: '0.00' } };
const PENDIENTE = { status: 'processing', status_detail: 'in_process', pago: { status: 'processing', status_detail: 'in_process' } };
const pagar = async (numero, estado) => { const d = await det(numero); await mpEstado(d.mp_order_id, estado); await webhook(d.mp_order_id); return det(numero); };
const sm = c => fetch(MP + '/__control/smoobu', { method: 'POST', body: JSON.stringify(c || {}) }).then(j);
const smDe = async numero => (await sm()).reservas.filter(b => String(b.notice || '').includes(numero));
const telegram = async () => (await (await fetch(MP + '/__control/telegram')).json()).mensajes.map(m => m.text);
const nuevosTg = async desde => (await telegram()).slice(desde);
const icalCtl = c => fetch(MP + '/__control/ical', { method: 'POST', body: JSON.stringify({ booking: [], airbnb: [], fallar: [], ...c }) });
const cotizar = ([ingreso, salida], conClave) => fetch(BASE + '/api/cotizar', { method: 'POST', headers: { 'content-type': 'application/json', ...(conClave ? { 'x-clave-pruebas': CLAVE } : {}) }, body: JSON.stringify({ ingreso, salida, adultos: 2 }) }).then(j);
const ics = async () => (await fetch(`${BASE}/calendario-booking.ics`)).text();
const enIcs = (t, [a]) => t.includes(`DTSTART;VALUE=DATE:${a.replace(/-/g, '')}`);

await icalCtl({}); await sm({ reset: true });
console.log(`Escenario: ${ESC}`);

/* ---------------- comunes a todos los escenarios ---------------- */
console.log('\n0) Entrada, seguridad y enlace privado');
let F = fechas(3);
let r = await reservar(F, { turnstile: 'malo' }); ok(r.status === 403 && r.error === 'verificacion_fallida', 'Turnstile inválido: 403');
r = await reservar(F, { extra: { email: '' } }); ok(r.status === 400 && r.error === 'email_invalido', 'sin correo (para el comprobante): 400');
r = await reservar(F, { extra: { acepto: false } }); ok(r.status === 400, 'sin aceptar condiciones: 400');
let s = await fetch(BASE + '/api/reservas', { method: 'POST', headers: { 'content-type': 'application/json', 'x-clave-pruebas': CLAVE }, body: '{}' }); ok(s.status === 400, 'sin Idempotency-Key: 400');
r = await mi('x'.repeat(43)); ok(r.status === 404, 'enlace privado inventado: 404');
r = await mi('corto'); ok(r.status === 404, 'enlace mal formado: 404');

if (ESC === 'produccion') {
  console.log('\n1) Configuración de producción: todo apagado');
  const salud = await j(await fetch(BASE + '/api/salud'));
  ok(salud.modo_reserva === 'whatsapp' && salud.pagos_habilitados === false && salud.confirmacion_automatica === false && salud.modo_mercado_pago === 'prueba', 'modo WhatsApp, pagos reales y confirmación automática apagados');
  const saludP = await j(await fetch(BASE + '/api/salud', { headers: { 'x-clave-pruebas': CLAVE } }));
  ok(saludP.modo_reserva === 'instantanea', 'con la clave de pruebas, la web privada usa el recorrido automático');
  r = await reservar(F, { conClave: false }); ok(r.status === 403 && r.error === 'no_habilitado', 'reserva pública: cerrada (403)');
  r = await reservar(F); ok(r.status === 201 && /^CC-\d{6}-[A-Z0-9]{4}$/.test(r.numero) && r.acceso && r.pago && r.pago.checkout_url, `reserva de prueba: número ${r.numero}, enlace privado y botón de pago`);
  // Configuración autorizada: confirmación automática SOLO para reservas de prueba (proveedor simulado); para huéspedes reales, apagada.
  const tg0 = (await telegram()).length;
  let d = await pagar(r.numero, APROBADO);
  ok(d.estado === 'confirmada' && d.confirmada_por === 'automatica' && d.cm_proveedor === 'simulado', 'reserva de PRUEBA: seña acreditada → confirmada automáticamente (proveedor simulado, sin tocar Booking/Airbnb)');
  ok((await nuevosTg(tg0)).some(t => /PRUEBA/.test(t) && /CONFIRMADA automáticamente/.test(t)), 'aviso por Telegram marcado como PRUEBA');
  const v = await mi(r.acceso); ok(v.estado === 'confirmada' && v.confirmacion && v.prueba === true, 'el huésped ve la confirmación y el comprobante, identificada como prueba');
  ok(salud.confirmacion_automatica === false, 'para huéspedes reales la confirmación automática sigue apagada');
  const clave = crypto.randomUUID(), G = fechas(3);
  const tres = await Promise.all([1, 2, 3].map(() => reservar(G, { clave })));
  ok(tres.every(x => x.status === 200 || x.status === 201) && new Set(tres.map(x => x.numero)).size === 1, `misma reserva enviada 3 veces a la vez: una sola reserva (${tres.map(x => x.status).join(', ')})`);
  const otras = await Promise.all([1, 2, 3].map(() => reservar(G)));
  ok(otras.every(x => x.status === 409), '3 personas distintas por las mismas fechas ya retenidas: todas 409');
}

if (ESC === 'ical') {
  console.log('\n1) Sin gestor de canales (iCal en vivo)');
  F = fechas(3);
  r = await reservar(F); ok(r.status === 201, 'reserva iniciada con consulta en vivo a Booking y Airbnb');
  let d = await det(r.numero); ok(d.cm_proveedor === 'ical' && d.cm_estado === 'no_aplica', 'iCal no puede retener fechas en las plataformas (no_aplica)');
  const G = fechas(3); await icalCtl({ booking: [{ desde: G[0], hasta: G[1] }] });
  let r2 = await reservar(G); ok(r2.status === 409 && r2.error === 'no_disponible', 'fechas ocupadas en Booking (en vivo): 409, no se cobra');
  await icalCtl({ fallar: ['airbnb'] });
  r2 = await reservar(fechas(3)); ok(r2.status === 503 && r2.error === 'disponibilidad_no_verificada', 'Airbnb sin respuesta: 503 "no pudimos verificar", no se cobra');
  await icalCtl({});
  const tg0 = (await telegram()).length;
  d = await pagar(r.numero, APROBADO);
  ok(d.estado === 'pago_verificado' && d.excepcion === 'sin_gestor_verificado', 'seña acreditada → NO se confirma (depende de iCal), aunque la confirmación automática esté autorizada');
  ok((await nuevosTg(tg0)).some(t => /calendarios iCal/.test(t)), 'aviso por Telegram: revisar Booking/Airbnb y confirmar');
  const id = d.id;
  let a = await admin(`/api/admin/reservas/${id}/confirmar`, {}); ok(a.status === 200 && a.resultado === 'confirmada', 'los dueños confirman desde el panel');
  ok((await mi(r.acceso)).confirmacion && (await det(r.numero)).confirmada_por === 'duenos@example.com', 'el huésped ve la confirmación; queda registrado quién confirmó');
  console.log('\n2) Transferencia (sin gestor)');
  r = await reservar(fechas(3), { medio: 'transferencia' });
  a = await admin(`/api/admin/reservas/${(await det(r.numero)).id}/acreditar-transferencia`, {});
  ok(a.status === 200 && a.resultado === 'excepcion:sin_gestor_verificado', 'transferencia acreditada → tampoco se confirma sola con iCal');
  console.log('\n3) Cancelar desde el panel una retención sin pago');
  F = fechas(3); r = await reservar(F);
  a = await admin(`/api/admin/reservas/${(await det(r.numero)).id}/cancelar`, { motivo: 'prueba' });
  ok(a.status === 200 && (await det(r.numero)).noches_retenidas === 0 && (await cotizar(F, true)).disponible === true, 'cancelada: noches liberadas y orden de Mercado Pago cancelada');
}

if (ESC === 'smoobu') {
  console.log('\n1) Recorrido feliz: retener → pagar → confirmar solo');
  F = fechas(3);
  const clave = crypto.randomUUID();
  r = await reservar(F, { clave });
  ok(r.status === 201 && r.estado === 'pendiente_pago' && r.pago && r.pago.checkout_url, `reserva ${r.numero} retenida con link de pago`);
  const rep = await reservar(F, { clave }); ok(rep.status === 200 && rep.numero === r.numero && rep.acceso === r.acceso, 'misma solicitud repetida: misma reserva y mismo enlace (idempotencia)');
  let d = await det(r.numero);
  ok(d.cm_estado === 'retenida' && d.cm_ref, `retención provisional en el gestor (ref ${d.cm_ref})`);
  let b = await smDe(r.numero); ok(b.length === 1 && b[0].type === 'reservation' && /PROVISIONAL/.test(b[0].notice), 'el gestor tiene UNA reserva provisional con el número');
  const orden = (await mpResumen()).ordenes.find(o => o.id === d.mp_order_id);
  const min = Number((orden.expiration_time.match(/PT(\d+)M/) || [])[1]);
  ok(min >= 20 && min < 30, `la orden de Mercado Pago vence antes que la retención (${orden.expiration_time} < 30 min)`);
  let v = await mi(r.acceso); ok(v.estado_texto.includes('falta pagar') && v.vence_en && !v.confirmacion && !('telefono' in v), 'enlace privado: estado, vencimiento real, sin datos de contacto expuestos');
  const tg0 = (await telegram()).length;
  d = await pagar(r.numero, APROBADO);
  ok(d.estado === 'confirmada' && d.confirmada_por === 'automatica' && d.cm_estado === 'confirmada', 'seña acreditada y verificada → CONFIRMADA AUTOMÁTICAMENTE');
  b = await smDe(r.numero); ok(b[0]['prepayment-paid'] === 'Yes' && /CONFIRMADA/.test(b[0].notice), 'el gestor pasó la reserva a confirmada (seña pagada)');
  v = await mi(r.acceso); ok(v.estado === 'confirmada' && v.confirmacion && v.confirmacion.direccion && v.pagado === v.sena, 'el huésped ve la confirmación con dirección, horarios y saldo (comprobante)');
  ok((await nuevosTg(tg0)).some(t => /CONFIRMADA automáticamente/.test(t) && /No hace falta hacer nada/.test(t)), 'Telegram informativo: "no hace falta hacer nada"');

  console.log('\n2) Pago rechazado y reintento');
  r = await reservar(fechas(3));
  d = await pagar(r.numero, RECHAZADO);
  v = await mi(r.acceso); ok(d.estado === 'pendiente_pago' && v.pago && v.pago.rechazado && v.pago.checkout_url, 'rechazado: sigue retenida y el huésped puede reintentar');
  d = await pagar(r.numero, APROBADO); ok(d.estado === 'confirmada', 'reintento aprobado → confirmada sola');

  console.log('\n3) Pago pendiente (en proceso)');
  r = await reservar(fechas(3));
  d = await pagar(r.numero, PENDIENTE); v = await mi(r.acceso);
  ok(d.estado === 'pago_en_proceso' && /procesando/.test(v.estado_texto), 'pendiente: retención extendida mientras Mercado Pago procesa');
  d = await pagar(r.numero, APROBADO); ok(d.estado === 'confirmada', 'acreditado después → confirmada sola');

  console.log('\n4) Vence sin pago');
  F = fechas(3); r = await reservar(F, { venceSeg: 6 });
  await esperar(7500); await cron();
  d = await det(r.numero); b = await smDe(r.numero);
  ok(d.estado === 'vencida' && d.noches_retenidas === 0 && d.cm_estado === 'liberada' && b[0].type === 'cancellation', 'vencida: noches liberadas, orden cancelada y retención del gestor cancelada');
  ok((await cotizar(F, true)).disponible === true && (await mi(r.acceso)).pago === null, 'las fechas vuelven a estar disponibles y ya no se puede pagar');

  console.log('\n5) Pago fuera de plazo con fechas libres');
  r = await reservar(fechas(3), { venceSeg: 6 });
  const ord = (await det(r.numero)).mp_order_id;
  await esperar(7500); await cron();
  ok((await det(r.numero)).estado === 'vencida', 'primero vence y se libera todo');
  await mpEstado(ord, APROBADO); await webhook(ord);
  d = await det(r.numero); b = (await smDe(r.numero)).filter(x => x.type !== 'cancellation');
  ok(d.estado === 'confirmada' && d.cm_estado === 'confirmada' && b.length === 1, 'pago tardío: vuelve a retener en el gestor, verifica y confirma');

  console.log('\n6) Pago fuera de plazo con fechas tomadas por otra reserva');
  F = fechas(3); r = await reservar(F, { venceSeg: 6 });
  const ordA = (await det(r.numero)).mp_order_id;
  await esperar(7500); await cron();
  const otra = await reservar(F); ok(otra.status === 201, 'otra persona reserva las fechas liberadas');
  let t0 = (await telegram()).length;
  await mpEstado(ordA, APROBADO); await webhook(ordA);
  d = await det(r.numero);
  ok(d.estado === 'conflicto' && d.devoluciones.length === 1 && d.devoluciones[0].estado === 'pendiente_revision', `conflicto: no se confirma y queda la devolución del 100 % registrada (${d.estado}, ${JSON.stringify(d.devoluciones)})`);
  ok((await nuevosTg(t0)).some(t => /PROBLEMA/.test(t)), 'aviso urgente por Telegram');

  console.log('\n7) Conflicto detectado por el gestor al confirmar (reserva de Airbnb en la ventana de sincronización)');
  F = fechas(3); r = await reservar(F);
  await sm({ externa: { arrival: F[0], departure: F[1], canal: 'Airbnb' } });
  t0 = (await telegram()).length;
  d = await pagar(r.numero, APROBADO);
  ok(d.estado === 'conflicto' && d.devoluciones.length === 1 && d.noches_retenidas === 0, `el gestor informa otra reserva → conflicto + devolución, no se confirma (${d.estado}, ${JSON.stringify(d.devoluciones)}, noches ${d.noches_retenidas})`);
  ok(d.cm_estado === 'liberada' && (await smDe(r.numero))[0].type === 'cancellation', 'la retención provisional se cancela en el gestor');
  ok((await nuevosTg(t0)).some(t => /CONFLICTO/.test(t)), 'aviso urgente por Telegram');
  ok(/problema de disponibilidad/.test((await mi(r.acceso)).estado_texto), 'el huésped ve que hubo un problema (sin confirmación)');

  console.log('\n8) Gestor caído al iniciar: no se cobra');
  await sm({ caido: true });
  F = fechas(3); r = await reservar(F);
  ok(r.status === 503 && r.error === 'disponibilidad_no_verificada' && !r.acceso, 'gestor sin respuesta → 503, sin reserva ni pago');
  await sm({ caido: false });
  ok((await cotizar(F, true)).disponible === true && (await mpResumen()).ordenes.every(o => o.external_reference), 'las fechas no quedaron retenidas');

  console.log('\n9) Falla al crear la retención en el gestor');
  await sm({ fallarPost: 2 });
  F = fechas(3); r = await reservar(F);
  ok(r.status === 503 && r.error === 'gestor_no_disponible', 'no se pudo retener (2 intentos) → 503, no se cobra');
  ok((await cotizar(F, true)).disponible === true && (await sm()).reservas.filter(x => x.arrival === F[0] && x.type !== 'cancellation').length === 0, 'nada retenido en D1 ni en el gestor');
  await sm({ perderRespuesta: 1 });
  r = await reservar(fechas(3));
  b = (await smDe(r.numero)).filter(x => x.type !== 'cancellation');
  ok(r.status === 201 && b.length === 1 && (await det(r.numero)).cm_estado === 'retenida', 'respuesta perdida: limpia la retención huérfana y reintenta (queda UNA sola)');

  console.log('\n10) Gestor caído al confirmar: duda → no confirma y avisa');
  r = await reservar(fechas(3));
  await sm({ caido: true }); t0 = (await telegram()).length;
  d = await pagar(r.numero, APROBADO);
  ok(d.estado === 'pago_verificado' && d.excepcion === 'disponibilidad_dudosa', 'no se pudo verificar → NO se confirma, queda como excepción');
  ok((await nuevosTg(t0)).some(t => /no se pudo verificar la disponibilidad/.test(t)) && (await mi(r.acceso)).en_revision === true, 'aviso por Telegram; el huésped ve "en revisión"');
  await sm({ caido: false });
  let a = await admin(`/api/admin/reservas/${d.id}/confirmar`, {});
  ok(a.resultado === 'confirmada' && (await smDe(r.numero))[0]['prepayment-paid'] === 'Yes', 'los dueños revisan y confirman desde el panel (también en el gestor)');

  console.log('\n11) Liberación con el gestor caído: reintentos y aviso');
  r = await reservar(fechas(3), { medio: 'transferencia', venceSeg: 6 });
  await esperar(7500); await sm({ caido: true }); t0 = (await telegram()).length;
  await cron(); await cron(); await cron();
  d = await det(r.numero);
  ok(d.estado === 'vencida' && d.cm_estado === 'liberacion_pendiente' && d.cm_intentos === 3, 'vencida; la liberación en el gestor queda pendiente y se reintenta');
  ok((await nuevosTg(t0)).some(t => /No pudimos liberar/.test(t)), 'al tercer intento fallido, aviso por Telegram');
  await sm({ caido: false }); await cron();
  ok((await det(r.numero)).cm_estado === 'liberada' && (await smDe(r.numero))[0].type === 'cancellation', 'cuando el gestor vuelve, se libera');

  console.log('\n12) Transferencia: 48 h, verificación de los dueños y confirmación sola');
  t0 = (await telegram()).length;
  r = await reservar(fechas(3), { medio: 'transferencia' });
  const horas = (Date.parse(r.vence_en) - Date.now()) / 36e5;
  ok(r.status === 201 && horas > 47.9 && horas <= 48 && r.transferencia && r.transferencia.alias && !r.pago, `retención de ${horas.toFixed(2)} h con los datos de la transferencia, sin link de Mercado Pago`);
  ok((await nuevosTg(t0)).some(t => /TRANSFERENCIA pendiente/.test(t)), 'aviso por Telegram para verificar la acreditación');
  a = await admin(`/api/admin/reservas/${(await det(r.numero)).id}/acreditar-transferencia`, {});
  ok(a.resultado === 'confirmada' && (await smDe(r.numero))[0]['prepayment-paid'] === 'Yes', 'un clic en "seña acreditada" → confirmación automática');

  console.log('\n13) Avisos del gestor (webhook)');
  s = await fetch(`${BASE}/api/webhooks/gestor/token-equivocado-${'x'.repeat(30)}`, { method: 'POST', body: '{}' }); ok(s.status === 404, 'token equivocado: 404');
  F = fechas(3); r = await reservar(F); d = await pagar(r.numero, APROBADO);
  t0 = (await telegram()).length;
  s = await fetch(`${BASE}/api/webhooks/gestor/${WEBHOOK_TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'newReservation', user: 1, data: { id: 777001, type: 'reservation', arrival: F[0], departure: F[1], apartment: { id: 501 }, channel: { id: 74, name: 'Airbnb' } } }) });
  d = await det(r.numero);
  ok(s.status === 200 && d.excepcion === 'superposicion_otro_canal' && (await nuevosTg(t0)).some(t => /se superpone/.test(t)), 'reserva de Airbnb superpuesta con una confirmada → excepción y aviso inmediato');
  r = await reservar(fechas(3)); d = await det(r.numero);
  await fetch(`${BASE}/api/webhooks/gestor/${WEBHOOK_TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancelReservation', data: { id: Number(d.cm_ref), type: 'cancellation', apartment: { id: 501 } } }) });
  ok((await det(r.numero)).excepcion === 'gestor_cancelo', 'alguien canceló en el gestor una retención activa → excepción');

  console.log('\n14) Panel de supervisión');
  const res = await admin('/api/admin/resumen');
  ok(res.status === 200 && res.sistema.proveedor === 'smoobu' && Array.isArray(res.excepciones) && res.excepciones.length >= 2 && res.devoluciones.length >= 2, `resumen: ${res.excepciones.length} excepciones, ${res.devoluciones.length} devoluciones, ${res.proximas.length} próximas llegadas`);
  const cal = await admin(`/api/admin/calendario?desde=2027-04-01&meses=3`);
  ok(cal.status === 200 && Object.values(cal.dias).flat().some(x => x.tipo === 'prueba'), 'calendario de ocupación con las reservas de prueba identificadas');
  const lista = await admin('/api/admin/reservas?vista=confirmadas');
  ok(lista.reservas.length >= 5 && lista.reservas.every(x => x.estado === 'confirmada'), `reservas confirmadas: ${lista.reservas.length}`);
  const dd = await admin(`/api/admin/reservas/${lista.reservas[0].id}`);
  ok(dd.eventos.some(e => e.tipo === 'reserva_confirmada') && dd.pagos.length >= 1, 'detalle con historial de eventos y pagos');
  const dev = res.devoluciones[0];
  a = await admin(`/api/admin/devoluciones/${dev.id}/realizada`, {}); ok(a.ok === true, 'devolución marcada como realizada');
  a = await admin(`/api/admin/reservas/${res.excepciones[0].id}/resolver`, { nota: 'revisado' }); ok(a.ok === true, 'excepción marcada como resuelta');
}

if (ESC === 'smoobu_sin_verificar') {
  console.log('\n1) Gestor conectado pero sin comprobar que cierra Booking y Airbnb');
  r = await reservar(fechas(3));
  let d = await det(r.numero); ok(d.cm_estado === 'retenida', 'retiene en el gestor');
  d = await pagar(r.numero, APROBADO);
  ok(d.estado === 'pago_verificado' && d.excepcion === 'sin_gestor_verificado', 'NO confirma solo hasta que se verifique el bloqueo real (SMOOBU_BLOQUEO_VERIFICADO)');
}

if (ESC === 'aislamiento') {
  console.log('\n1) Las reservas de prueba nunca tocan el gestor real');
  F = fechas(3);
  r = await reservar(F);
  let d = await det(r.numero); ok(d.cm_proveedor === 'simulado' && d.cm_estado === 'retenida', 'reserva de prueba con proveedor simulado');
  d = await pagar(r.numero, APROBADO); ok(d.estado === 'confirmada', 'recorrido completo hasta "confirmada"');
  ok((await sm()).llamadas === 0, 'el gestor de canales (Smoobu) no recibió NINGUNA llamada');
  ok((await cotizar(F, false)).disponible === true, 'la cotización pública sigue viendo esas fechas libres');
  ok(!enIcs(await ics(), F), 'los calendarios exportados a Booking/Airbnb no incluyen la prueba');
}

console.log(fallas ? `\n${fallas} pruebas fallaron` : '\nTodas las pruebas pasaron');
process.exit(fallas ? 1 : 0);
