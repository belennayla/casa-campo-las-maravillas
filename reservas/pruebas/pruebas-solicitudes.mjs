// Pruebas de la etapa 1 contra servicios SIMULADOS (Turnstile, Telegram, iCal de Booking/Airbnb y claves de Cloudflare Access).
// Worker público en BASE (8787) y Worker del PANEL en PANEL (8788), en modo producción: solo entra con un token de Access válido.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const BASE = process.env.BASE || 'http://127.0.0.1:8787', PANEL = process.env.PANEL || 'http://127.0.0.1:8788', MP = 'http://127.0.0.1:8790';
const CLAVE = process.env.CLAVE, EQUIPO = 'https://equipo-prueba.cloudflareaccess.com', AUD = 'aud-de-prueba';
let fallas = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  MAL ') + m); if (!c) fallas++; };
const esperar = ms => new Promise(r => setTimeout(r, ms));
const fecha = d => new Date(Date.parse('2027-03-01') + d * 864e5).toISOString().slice(0, 10);
let cursor = Math.floor(Math.random() * 60);
const fechas = (n = 2) => { const a = fecha(cursor), b = fecha(cursor + n); cursor += n + 1; return [a, b]; };
const contacto = { nombre: 'Ana Prueba', telefono: '2664 111222', email: 'ana@example.com', acepto: true };

// --- Cloudflare Access simulado: par de claves RSA y tokens firmados RS256 ---
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
await fetch(MP + '/__control/jwks', { method: 'POST', body: JSON.stringify({ keys: [jwk] }) });
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const token = (cambios = {}, clave = privateKey) => {
  const ahora = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), p = b64({ iss: EQUIPO, aud: [AUD], email: 'duenos@example.com', iat: ahora, nbf: ahora, exp: ahora + 3600, ...cambios });
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), clave).toString('base64url')}`;
};
const TOKEN = token();
const admin = (ruta, body, tk = TOKEN) => fetch(PANEL + ruta, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(tk ? { 'cf-access-jwt-assertion': tk } : {}) }, body: body ? JSON.stringify(body) : undefined });
const lista = async () => (await (await admin('/api/admin/solicitudes')).json()).solicitudes;
const telegram = async () => (await (await fetch(MP + '/__control/telegram')).json()).mensajes;
const icalCtl = c => fetch(MP + '/__control/ical', { method: 'POST', body: JSON.stringify({ booking: [], airbnb: [], fallar: [], ...c }) });
const solicitar = ([ingreso, salida], extra = {}, conClave = true) => fetch(BASE + '/api/solicitudes', { method: 'POST', headers: { 'content-type': 'application/json', ...(conClave ? { 'x-clave-pruebas': CLAVE } : {}) }, body: JSON.stringify({ ingreso, salida, adultos: 4, menores: 1, ...contacto, turnstile: 'ok', ...extra }) });
const cotizar = ([ingreso, salida], conClave) => fetch(BASE + '/api/cotizar', { method: 'POST', headers: { 'content-type': 'application/json', ...(conClave ? { 'x-clave-pruebas': CLAVE } : {}) }, body: JSON.stringify({ ingreso, salida, adultos: 2 }) }).then(r => r.json());
const ics = async p => (await fetch(`${BASE}/calendario-${p}.ics`)).text();
const tieneFechas = (texto, [a, b]) => texto.includes(`DTSTART;VALUE=DATE:${a.replace(/-/g, '')}`) && texto.includes(`DTEND;VALUE=DATE:${b.replace(/-/g, '')}`);
await icalCtl({});

console.log('1) El Worker público no expone el panel');
ok((await fetch(BASE + '/admin')).status === 404, 'GET /admin en el Worker público: 404');
ok((await fetch(BASE + '/api/admin/solicitudes')).status === 404, 'API de administración en el Worker público: 404');

console.log('\n2) Panel: solo con token válido de Cloudflare Access');
ok((await fetch(PANEL + '/')).status === 403, 'página del panel sin token: 403 (no entrega ni el HTML)');
ok((await admin('/api/admin/solicitudes', null, null)).status === 401, 'API sin token: 401');
ok((await admin('/api/admin/solicitudes', null, token({ aud: ['otra-app'] }))).status === 401, 'token de otra aplicación (aud): 401');
ok((await admin('/api/admin/solicitudes', null, token({ iss: 'https://otro.cloudflareaccess.com' }))).status === 401, 'token de otro equipo (iss): 401');
ok((await admin('/api/admin/solicitudes', null, token({ exp: Math.floor(Date.now() / 1000) - 10 }))).status === 401, 'token vencido: 401');
const { privateKey: otra } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
ok((await admin('/api/admin/solicitudes', null, token({}, otra))).status === 401, 'token con firma falsa: 401');
ok((await admin('/api/admin/solicitudes', null, 'x.y.z')).status === 401, 'token mal formado: 401');
ok((await admin('/api/admin/solicitudes', null, null, { 'x-admin-clave': 'a'.repeat(48) })).status === 401, 'clave de administración en producción: no sirve');
const pag = await fetch(PANEL + '/', { headers: { 'cf-access-jwt-assertion': TOKEN } });
ok(pag.status === 200 && /noindex/.test(pag.headers.get('x-robots-tag') || ''), 'con token válido: entra al panel (y no se indexa)');
ok((await admin('/api/admin/telegram/prueba', {}, null)).status === 401, 'aviso de prueba de Telegram sin token: 401');
const tg0 = (await telegram()).length;
let tp = await (await admin('/api/admin/telegram/prueba', {})).json();
ok(tp.ok === true && (await telegram()).slice(tg0).some(m => m.text.includes('Aviso de prueba')), 'botón "Enviar aviso de prueba": llega el mensaje a Telegram');
ok((await (await admin('/api/admin/solicitudes')).json()).telegram_configurado === true, 'el panel muestra Telegram configurado');
await fetch(MP + '/__control/telegram', { method: 'POST', body: JSON.stringify({ fallar: 1 }) });
tp = await (await admin('/api/admin/telegram/prueba', {})).json();
ok(tp.ok === false && /HTTP 500/.test(tp.motivo) && !/bot\d|TOKEN/i.test(tp.motivo), 'si Telegram falla, el panel lo explica sin mostrar el token');

console.log('\n3) Solicitudes: Turnstile, número, precio y aviso');
let F = fechas(3);
ok((await solicitar(F, { turnstile: 'malo' })).status === 403, 'Turnstile inválido: 403');
const antesTg = (await telegram()).length;
let r = await solicitar(F, { total: 1 }); let s = await r.json();
ok(r.status === 201 && /^CC-\d{6}-[A-Z2-9]{4}$/.test(s.numero) && s.total === 3 * 209000, `solicitud ${s.numero}, precio del servidor $${s.total}`);
ok((await cotizar(F, true)).disponible === true, 'una solicitud NO retiene fechas');
await esperar(800);
ok((await telegram()).slice(antesTg).some(m => m.text.includes(s.numero)), 'aviso por Telegram a los dueños');
r = await solicitar(F); ok((await r.json()).numero === s.numero, 'repetida en 30 min: misma solicitud');
const numA = s.numero;

console.log('\n4) Aprobar con consulta EN VIVO a Booking y Airbnb');
let L = await lista(); let sa = L.find(x => x.numero === numA);
await icalCtl({ booking: [{ desde: F[0], hasta: F[1] }] });  // Booking acaba de recibir una reserva en esas fechas
r = await admin(`/api/admin/solicitudes/${sa.id}/aprobar`, { horas: 12 }); let j = await r.json();
ok(r.status === 409 && /Booking|booking/.test(j.mensaje), 'reserva reciente en Booking (todavía no sincronizada): NO se aprueba');
await icalCtl({ fallar: ['airbnb'] });
r = await admin(`/api/admin/solicitudes/${sa.id}/aprobar`, { horas: 12 }); j = await r.json();
ok(r.status === 409 && j.error === 'verificacion_en_vivo', 'Airbnb no responde: pide confirmar que se revisó a mano');
r = await admin(`/api/admin/solicitudes/${sa.id}/aprobar`, { horas: 12, forzar: true }); j = await r.json();
const h = (Date.parse(j.retencion_vence) - Date.now()) / 3600e3;
ok(r.status === 200 && h > 11.9 && h <= 12 && /Booking y Airbnb/.test(j.siguiente_paso), `aprobada con confirmación manual: retención ${h.toFixed(1)} h e indicación de cerrar en las plataformas`);
await icalCtl({});
ok((await cotizar(F, true)).disponible === false, 'después de aprobar, las fechas quedan retenidas');

console.log('\n5) Calendario exportado a Booking y Airbnb (desde el Worker)');
const F5 = fechas();
// Solicitud REAL (sin clave de pruebas), para verificar que las aprobaciones reales sí se exportan
const sReal = await (await solicitar(F5, { telefono: '2664 909090', nombre: 'Laura Real' }, false)).json();
L = await lista(); const idReal = L.find(x => x.numero === sReal.numero).id;
ok((await admin(`/api/admin/solicitudes/${idReal}/aprobar`, { horas: 6 })).status === 200, 'solicitud real aprobada');
const icsB = await ics('booking'), icsA = await ics('airbnb'), icsT = await ics('todas');
ok(tieneFechas(icsB, F5) && tieneFechas(icsA, F5) && tieneFechas(icsT, F5), 'las fechas aprobadas aparecen en los calendarios para Booking, Airbnb y general');
ok(!tieneFechas(icsB, F), 'las aprobaciones de PRUEBA no se exportan a las plataformas');
ok(!/Laura|Ana|2664|example\.com/.test(icsB + icsA + icsT), 'los calendarios no contienen nombres, teléfonos ni mails');
const ext = (await (await fetch('https://casacampolasmaravillas.github.io/data/ocupadas-sync.json')).json()).ocupadas || [];
const delBooking = ext.find(b => b.fuente === 'booking'), delAirbnb = ext.find(b => b.fuente === 'airbnb');
if (delBooking) ok(!tieneFechas(icsB, [delBooking.desde, delBooking.hasta]), 'a Booking no se le devuelven sus propias reservas');
if (delAirbnb) ok(!icsA.includes(`DTSTART;VALUE=DATE:${delAirbnb.desde.replace(/-/g, '')}\r\nDTEND;VALUE=DATE:${delAirbnb.hasta.replace(/-/g, '')}`), 'a Airbnb no se le devuelven sus propias reservas');
r = await admin(`/api/admin/solicitudes/${idReal}/rechazar`, { motivo: 'fin de prueba' });
ok(r.status === 200 && !tieneFechas(await ics('booking'), F5), 'al rechazar/liberar, las fechas salen del calendario exportado');

console.log('\n6) Aprobaciones simultáneas de la misma fecha');
const F6 = fechas();
const s1 = await (await solicitar(F6, { telefono: '2664 333444' })).json(), s2 = await (await solicitar(F6, { telefono: '2664 555666' })).json();
L = await lista(); const i1 = L.find(x => x.numero === s1.numero).id, i2 = L.find(x => x.numero === s2.numero).id;
const [a1, a2] = await Promise.all([admin(`/api/admin/solicitudes/${i1}/aprobar`, { horas: 2 }), admin(`/api/admin/solicitudes/${i2}/aprobar`, { horas: 2 })]);
ok([a1.status, a2.status].sort().join() === '200,409', `una aprobada y otra rechazada (${a1.status}, ${a2.status})`);

console.log('\n7) Retención aprobada que vence');
const F7 = fechas();
const s7 = await (await solicitar(F7, { telefono: '2664 777888' })).json();
L = await lista(); const i7 = L.find(x => x.numero === s7.numero).id;
await admin(`/api/admin/solicitudes/${i7}/aprobar`, { horas: 1, segundos_prueba: 5 });
await esperar(6500);
await fetch(BASE + '/__scheduled?cron=*/5+*+*+*+*'); await esperar(800);
L = await lista(); ok(L.find(x => x.id === i7).estado === 'vencida' && (await cotizar(F7, true)).disponible === true, 'vence: solicitud "vencida" y fechas liberadas');

console.log(fallas ? `\n${fallas} pruebas fallaron` : '\nTodas las pruebas de solicitudes pasaron');
process.exit(fallas ? 1 : 0);
