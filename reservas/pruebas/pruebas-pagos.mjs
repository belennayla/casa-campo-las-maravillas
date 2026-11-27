// Pruebas de pagos (Checkout Pro vía Orders API) contra el Mercado Pago SIMULADO.
// Requiere: node pruebas/mp-simulado.mjs  y  wrangler dev --local --test-scheduled --var MP_API_BASE:http://127.0.0.1:8790 --var ORDEN_MIN_SEGUNDOS:3
// Variables: CLAVE (clave de pruebas) y SECRETO (MP_WEBHOOK_SECRET), las mismas de .dev.vars.
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const MP = 'http://127.0.0.1:8790';
const CLAVE = process.env.CLAVE, SECRETO = process.env.SECRETO;
let fallas = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  MAL ') + m); if (!c) fallas++; };
const esperar = ms => new Promise(r => setTimeout(r, ms));
const j = r => r.json();
const fecha = d => { const x = new Date(Date.parse('2027-03-01') + d * 864e5); return x.toISOString().slice(0, 10); };
let cursor = Math.floor(Math.random() * 60);
const nuevasFechas = (n = 2) => { const a = fecha(cursor), b = fecha(cursor + n); cursor += n + 1; return [a, b]; };
const contacto = { nombre: 'Prueba Automática', telefono: '2664000000', acepto: true };

const bloquear = async ([ingreso, salida], venceSeg) => {
  const r = await fetch(BASE + '/api/bloqueos', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-clave-pruebas': CLAVE }, body: JSON.stringify({ ingreso, salida, adultos: 2, ...contacto, ...(venceSeg ? { vence_en_segundos: venceSeg } : {}) }) });
  return { status: r.status, ...(await j(r)) };
};
const orden = async (reserva_id, conClave = true) => {
  const r = await fetch(BASE + '/api/pagos/orden', { method: 'POST', headers: { 'content-type': 'application/json', ...(conClave ? { 'x-clave-pruebas': CLAVE } : {}) }, body: JSON.stringify({ reserva_id, sena: 1 }) });
  return { status: r.status, ...(await j(r)) };
};
const detalle = async id => j(await fetch(`${BASE}/api/pruebas/reservas/${id}`, { headers: { 'x-clave-pruebas': CLAVE } }));
const publico = async id => j(await fetch(`${BASE}/api/reservas/${id}`));
const mpEstado = (order_id, cambios) => fetch(MP + '/__control/estado', { method: 'POST', body: JSON.stringify({ order_id, ...cambios }) }).then(j);
const mpConfig = c => fetch(MP + '/__control/config', { method: 'POST', body: JSON.stringify(c) }).then(j);
const mpResumen = () => fetch(MP + '/__control/resumen').then(j);
const cron = async () => { await fetch(BASE + '/__scheduled?cron=*/5+*+*+*+*'); await esperar(800); };
const firmar = (dataId, reqId, ts, secreto = SECRETO) => crypto.createHmac('sha256', secreto).update(`id:${dataId};request-id:${reqId};ts:${ts};`).digest('hex');
const webhook = async (orderId, { firma, ts = Math.floor(Date.now() / 1000), secreto, sinFirma } = {}) => {
  const reqId = crypto.randomUUID();
  const headers = { 'content-type': 'application/json', 'x-request-id': reqId };
  if (!sinFirma) headers['x-signature'] = `ts=${ts},v1=${firma || firmar(orderId, reqId, ts, secreto)}`;
  const r = await fetch(`${BASE}/api/webhooks/mercadopago?data.id=${orderId}&type=order`, { method: 'POST', headers, body: JSON.stringify({ action: 'order.processed', type: 'order', data: { id: orderId } }) });
  await esperar(900); // procesamiento en segundo plano (ctx.waitUntil)
  return r.status;
};
const pagado = (amount, extra = {}) => ({ status: 'processed', status_detail: 'accredited', pago: { status: 'processed', status_detail: 'accredited', amount, ...extra } });

console.log('Servidor:', BASE);
const salud = await j(await fetch(BASE + '/api/salud'));
ok(salud.pagos_habilitados === false && salud.confirmacion_automatica === false && salud.modo_mercado_pago === 'prueba', 'pagos reales y confirmación automática apagados, modo prueba');

console.log('\n1) Crear orden de seña');
let b = await bloquear(nuevasFechas(3));
let o = await orden(b.id, false); ok(o.status === 403, 'sin clave de pruebas: 403 (no hay botón de pago público)');
await mpConfig({ cuentaPrueba: false });
o = await orden(b.id); ok(o.status === 403 && o.error === 'cuenta_no_prueba', 'credenciales que NO son de cuenta de prueba: rechazado');
await mpConfig({ cuentaPrueba: true });
const antes = (await mpResumen()).creadas;
const dobles = await Promise.all([orden(b.id), orden(b.id), orden(b.id)]);
o = dobles.find(x => x.status === 201) || dobles[0];
const ids = new Set(dobles.filter(x => x.mp_order_id).map(x => x.mp_order_id));
ok(dobles.every(x => [200, 201, 409].includes(x.status)) && ids.size === 1, `3 pedidos simultáneos de orden: una sola orden (${[...ids][0]})`);
ok((await mpResumen()).creadas - antes === 1, 'Mercado Pago recibió una sola orden (idempotencia)');
const res = await mpResumen(); const om = res.ordenes.find(x => x.id === o.mp_order_id);
ok(om && Number(om.total_amount) === b.sena && om.external_reference === b.id, `monto enviado = seña calculada en el servidor ($${om && om.total_amount}); el monto del navegador se ignora`);
ok(om && /^PT\d+M$/.test(om.expiration_time) && om.not_allowed_types.includes('ticket'), `vencimiento ${om && om.expiration_time} y sin efectivo`);
ok(o.checkout_url && o.estado === 'pendiente_pago', 'devuelve checkout_url y la reserva queda pendiente de pago');
const ordenA = o.mp_order_id, resA = b.id;

console.log('\n2) Notificaciones falsas o inválidas');
await mpEstado(ordenA, pagado(String(b.sena) + '.00'));
ok(await webhook(ordenA, { sinFirma: true }) === 401, 'sin firma: 401');
ok(await webhook(ordenA, { firma: 'a'.repeat(64) }) === 401, 'firma falsa: 401');
ok(await webhook(ordenA, { secreto: 'otro-secreto' }) === 401, 'firmada con otro secreto: 401');
ok(await webhook(ordenA, { ts: Math.floor(Date.now() / 1000) - 3 * 86400 }) === 401, 'firma de hace 3 días (reenvío viejo): 401');
let d = await detalle(resA); ok(d.estado === 'pendiente_pago' && d.pagos.length === 0, 'ninguna notificación inválida cambió la reserva');
ok(await webhook('ORD01INVENTADA0000000000000') === 200 && true, 'orden inexistente con firma válida: se acepta el aviso pero no cambia nada');

console.log('\n3) Pago aprobado + avisos repetidos');
ok(await webhook(ordenA) === 200, 'aviso válido: 200 inmediato');
d = await detalle(resA);
ok(d.estado === 'pago_verificado' && d.pagado === b.sena && d.saldo === b.total - b.sena, `pago verificado: pagado $${d.pagado}, saldo $${d.saldo}`);
ok(d.estado !== 'confirmada' && d.revision_manual === 1, 'NO queda confirmada: requiere confirmación de los dueños');
const pub = await publico(resA);
ok(!/confirmada/i.test(pub.mensaje || '') || /confirmarte/i.test(pub.mensaje), `mensaje al huésped: "${pub.mensaje}"`);
await Promise.all([webhook(ordenA), webhook(ordenA), webhook(ordenA)]);
d = await detalle(resA); ok(d.pagos.length === 1 && d.estado === 'pago_verificado', '3 avisos repetidos: sigue habiendo un solo pago registrado');
ok(d.noches_retenidas === d.noches, 'las noches siguen retenidas');

console.log('\n4) Pago rechazado (como la API real: orden action_required / waiting_retry, pago failed)');
b = await bloquear(nuevasFechas()); o = await orden(b.id);
const venceAntes = (await detalle(b.id)).vence_en;
await mpEstado(o.mp_order_id, { status: 'action_required', status_detail: 'waiting_retry', pago: { status: 'failed', status_detail: 'rejected_by_issuer', paid_amount: '0.00' } });
await webhook(o.mp_order_id); d = await detalle(b.id);
ok(d.estado === 'pendiente_pago' && d.noches_retenidas === d.noches && d.pagado === 0, 'rechazado: no se registra seña, las fechas siguen retenidas hasta el vencimiento (puede reintentar)');
ok(d.vence_en === venceAntes, 'un rechazo NO extiende la retención (no se trata como pago en proceso)');
ok(d.eventos.includes('pago_rechazado') && !d.eventos.includes('pago_en_proceso'), 'queda registrado como rechazo, no como pago en proceso');
ok(!/procesando/i.test((await publico(b.id)).mensaje || ''), 'al huésped no se le dice que el pago se está procesando');
await webhook(o.mp_order_id); d = await detalle(b.id);
ok(d.eventos.filter(e => e === 'pago_rechazado').length === 1, 'aviso repetido del rechazo: un solo registro');
b = await bloquear(nuevasFechas()); o = await orden(b.id);
await mpEstado(o.mp_order_id, { status: 'failed', status_detail: 'rejected_by_issuer', pago: { status: 'failed', status_detail: 'rejected_by_issuer', paid_amount: '0.00' } });
await webhook(o.mp_order_id); d = await detalle(b.id);
ok(d.estado === 'pendiente_pago' && d.eventos.includes('pago_rechazado'), 'orden "failed": también se registra como rechazo');

console.log('\n5) Pago pendiente (en revisión) y luego acreditado');
b = await bloquear(nuevasFechas(), 20); o = await orden(b.id);
await mpEstado(o.mp_order_id, { status: 'processing', status_detail: 'in_process', pago: { status: 'processing', status_detail: 'in_process' } });
await webhook(o.mp_order_id); d = await detalle(b.id);
const extension = (Date.parse(d.vence_en) - Date.now()) / 60e3;
ok(d.estado === 'pago_en_proceso' && extension > 25 && extension < 31, `pendiente: retención renovada ${extension.toFixed(0)} min según el estado real (no 48 h fijas)`);
await esperar(1000); await cron(); d = await detalle(b.id);
ok(d.estado === 'pago_en_proceso' && d.noches_retenidas === d.noches, 'la conciliación periódica no libera un pago en proceso');
await mpEstado(o.mp_order_id, pagado(String(b.sena))); await webhook(o.mp_order_id); d = await detalle(b.id);
ok(d.estado === 'pago_verificado', 'cuando se acredita: pago verificado (sin confirmar)');

console.log('\n6) Bloqueo que vence sin pago');
b = await bloquear(nuevasFechas(), 5); o = await orden(b.id);
await esperar(6500); await cron(); d = await detalle(b.id);
const om6 = (await mpResumen()).ordenes.find(x => x.id === o.mp_order_id);
ok(om6.status === 'canceled', 'antes de liberar, se consultó y se canceló la orden en Mercado Pago');
ok(d.estado === 'vencida' && d.noches_retenidas === 0, 'recién después se liberaron las fechas');

console.log('\n6b) Orden rechazada que vence (como la API real: failed / expired) → libera fechas');
b = await bloquear(nuevasFechas(), 5); o = await orden(b.id);
await mpEstado(o.mp_order_id, { status: 'action_required', status_detail: 'waiting_retry', pago: { status: 'failed', status_detail: 'rejected_by_issuer', paid_amount: '0.00' } });
await webhook(o.mp_order_id);
await esperar(6000);
await mpEstado(o.mp_order_id, { status: 'failed', status_detail: 'expired' }); // Mercado Pago la venció
await cron(); d = await detalle(b.id);
ok(d.estado === 'vencida' && d.noches_retenidas === 0, 'orden failed/expired: se liberan las fechas (no queda trabada)');
b = await bloquear(nuevasFechas(), 5); o = await orden(b.id);
await mpEstado(o.mp_order_id, { status: 'failed', status_detail: 'rejected_by_issuer', pago: { status: 'failed', status_detail: 'rejected_by_issuer', paid_amount: '0.00' } });
await esperar(6000); await cron(); d = await detalle(b.id);
ok(d.estado === 'vencida' && d.noches_retenidas === 0, 'orden "failed" vencida que no se puede cancelar: igual se liberan las fechas tras consultar');

console.log('\n7) Seña acreditada cuyo aviso se perdió: el vencimiento NO libera las fechas');
b = await bloquear(nuevasFechas(), 5); o = await orden(b.id);
await mpEstado(o.mp_order_id, pagado(String(b.sena)));   // se acredita pero NO mandamos aviso
await esperar(6500); await cron(); d = await detalle(b.id);
ok(d.estado === 'pago_verificado' && d.noches_retenidas === d.noches, 'la conciliación encontró la seña acreditada y mantuvo las fechas');

console.log('\n8) Pago tardío con fechas todavía libres');
const f8 = nuevasFechas(); b = await bloquear(f8, 5); o = await orden(b.id);
await esperar(6500); await cron();                       // vence: orden cancelada, fechas liberadas
await mpEstado(o.mp_order_id, pagado(String(b.sena)));   // el pago llegó igual (carrera con la cancelación)
await webhook(o.mp_order_id); d = await detalle(b.id);
ok(d.estado === 'pago_verificado' && d.noches_retenidas === d.noches && d.eventos.includes('pago_tardio_fechas_recuperadas'), 'pago tardío: volvió a tomar las fechas en una sola operación');

console.log('\n9) Pago tardío con fechas ya tomadas por otra persona → conflicto');
const f9 = nuevasFechas(); b = await bloquear(f9, 5); o = await orden(b.id);
await esperar(6500); await cron();
const otra = await bloquear(f9); ok(otra.status === 201, 'otra persona tomó esas fechas');
await mpEstado(o.mp_order_id, pagado(String(b.sena))); await webhook(o.mp_order_id); d = await detalle(b.id);
ok(d.estado === 'conflicto' && d.revision_manual === 1, 'queda en CONFLICTO y no se confirma');
ok(d.devoluciones.length === 1 && d.devoluciones[0].estado === 'pendiente_revision' && d.devoluciones[0].monto === b.sena, `devolución preparada por $${d.devoluciones[0] && d.devoluciones[0].monto} (pendiente de revisión manual)`);
ok(/problema/i.test((await publico(b.id)).mensaje), 'al huésped se le informa que lo van a contactar, no que está confirmada');

console.log('\n10) Importe o moneda alterados');
b = await bloquear(nuevasFechas()); o = await orden(b.id);
await mpEstado(o.mp_order_id, pagado('100.00')); await webhook(o.mp_order_id); d = await detalle(b.id);
ok(d.estado === 'conflicto' && d.devoluciones.some(x => /importe/.test(x.motivo)), 'importe pagado distinto de la seña: conflicto + devolución');
b = await bloquear(nuevasFechas()); o = await orden(b.id);
await mpEstado(o.mp_order_id, { ...pagado(String(b.sena)), currency: 'USD' }); await webhook(o.mp_order_id); d = await detalle(b.id);
ok(d.estado === 'conflicto' && d.devoluciones.some(x => /moneda/.test(x.motivo)), 'moneda distinta de ARS: conflicto + devolución');

console.log('\n11) Falla al consultar Mercado Pago: reintento');
b = await bloquear(nuevasFechas()); o = await orden(b.id);
await mpEstado(o.mp_order_id, pagado(String(b.sena)));
await mpConfig({ fallarGet: 1 });
ok(await webhook(o.mp_order_id) === 200, 'el aviso se acepta aunque Mercado Pago falle (no se pierde)');
d = await detalle(b.id); ok(d.estado === 'pendiente_pago', 'primer intento falló: todavía sin verificar');
await cron(); d = await detalle(b.id); ok(d.estado === 'pago_verificado', 'la tarea programada reintentó y lo verificó');

console.log('\n12) Orden para una reserva no apta');
o = await orden(resA); ok(o.status === 409, 'reserva ya pagada: no se crea otra orden');
b = await bloquear(nuevasFechas(), 5); await esperar(3500);
o = await orden(b.id); ok(o.status === 409 && o.error === 'bloqueo_por_vencer', 'bloqueo por vencer: no se crea la orden');

console.log(fallas ? `\n${fallas} pruebas fallaron` : '\nTodas las pruebas de pagos pasaron');
process.exit(fallas ? 1 : 0);
