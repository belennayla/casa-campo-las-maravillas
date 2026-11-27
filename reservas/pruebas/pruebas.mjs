// Pruebas del servidor de reservas.
// Local:   (terminal 1) wrangler dev ...   (terminal 2) CLAVE=<clave de .dev.vars> node pruebas/pruebas.mjs
// Remoto:  BASE=https://...workers.dev CLAVE=<clave temporal> REMOTO=1 node pruebas/pruebas.mjs
// Todos los registros que crean estas pruebas quedan con origen = 'prueba' para poder borrarlos.
const BASE = process.env.BASE || 'http://localhost:8787';
const CLAVE = process.env.CLAVE || '';
const REMOTO = !!process.env.REMOTO;
let fallas = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  MAL ') + m); if (!c) fallas++; };
const uuid = () => crypto.randomUUID();
const esperar = ms => new Promise(r => setTimeout(r, ms));
const post = (ruta, body, headers = {}) => fetch(BASE + ruta, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
// Cotizar como visitante (sin clave) o como prueba (ve también las reservas de prueba)
const cotizarP = body => post('/api/cotizar', body, { 'x-clave-pruebas': CLAVE });
const bloquear = (body, extra = {}) => post('/api/bloqueos', body, { 'idempotency-key': uuid(), 'x-clave-pruebas': CLAVE, ...extra });
const fecha = dias => { const d = new Date(); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); };
// Fechas aleatorias entre marzo y junio de 2027 (libres en Booking/Airbnb)
const base = Math.round((Date.parse('2027-03-10') - Date.now()) / 864e5) + Math.floor(Math.random() * 100);
const A = fecha(base), B = fecha(base + 3), C = fecha(base + 5), D = fecha(base + 1), E = fecha(base + 7), F = fecha(base + 9);
const contacto = { nombre: 'Prueba Automática', telefono: '2664000000', email: 'prueba@example.com', acepto: true };
const creados = new Set();

console.log(`Servidor: ${BASE} · fechas de prueba ${A} → ${F}`);

console.log('1) Modo seguro');
let r = await (await fetch(BASE + '/api/salud')).json();
ok(r.pagos_habilitados === false && r.confirmacion_automatica === false && r.modo_mercado_pago === 'prueba', 'pagos apagados, confirmación automática apagada, Mercado Pago en prueba');

console.log('2) Crear bloqueos está cerrado al público');
let s = await post('/api/bloqueos', { ingreso: A, salida: B, adultos: 2, ...contacto }, { 'idempotency-key': uuid() });
ok(s.status === 403, `sin clave de pruebas: ${s.status} (esperado 403)`);
s = await post('/api/bloqueos', { ingreso: A, salida: B, adultos: 2, ...contacto }, { 'idempotency-key': uuid(), 'x-clave-pruebas': 'x'.repeat(CLAVE.length || 40) });
ok(s.status === 403, `con clave incorrecta: ${s.status} (esperado 403)`);

console.log('3) Cotización calculada en el servidor');
r = await (await post('/api/cotizar', { ingreso: A, salida: B, adultos: 8, menores: 1, precio: 1, total: 1 })).json();
ok(r.total === 729000 && r.sena === 364500 && r.saldo === 364500, `9 huéspedes x 3 noches = $${r.total}, seña $${r.sena}; montos enviados por el navegador ignorados`);
ok(r.disponibilidad_garantizada === false && r.pago_online === false, 'disponibilidad no garantizada y sin pago online');
r = await (await post('/api/cotizar', { ingreso: '2027-08-10', salida: '2027-08-13', adultos: 2 })).json();
ok(r.disponible === false, 'agosto 2027 (cerrado en Booking) figura no disponible');

console.log('4) Validaciones');
const v = async (body, codigo, txt) => { const x = await post('/api/cotizar', body); const j = await x.json(); ok(x.status === 400 && j.error === codigo, txt); };
await v({ ingreso: A, salida: D, adultos: 2 }, 'estadia_minima', 'estadía mínima de 2 noches');
await v({ ingreso: A, salida: B, adultos: 10, menores: 2 }, 'capacidad', 'máximo 11 huéspedes');
await v({ ingreso: fecha(-3), salida: fecha(-1), adultos: 2 }, 'fecha_pasada', 'fechas pasadas');
await v({ ingreso: '2027-02-30', salida: '2027-03-03', adultos: 2 }, 'fechas_invalidas', 'fecha inexistente');
await v({ ingreso: A, salida: B, adultos: 0 }, 'huespedes_invalidos', 'sin adultos');
s = await bloquear({ ingreso: A, salida: B, adultos: 2, ...contacto, acepto: false }); ok(s.status === 400, 'sin aceptar condiciones');
s = await bloquear({ ingreso: A, salida: B, adultos: 2, ...contacto, telefono: '12' }); ok(s.status === 400, 'teléfono inválido');
s = await post('/api/bloqueos', { ingreso: A, salida: B, adultos: 2, ...contacto }, { 'x-clave-pruebas': CLAVE }); ok(s.status === 400, 'sin Idempotency-Key');

console.log('5) 20 solicitudes SIMULTÁNEAS por las mismas fechas');
const resp = await Promise.all(Array.from({ length: 20 }, () => bloquear({ ingreso: A, salida: B, adultos: 2, ...contacto })));
const st = resp.map(x => x.status);
ok(st.filter(x => x === 201).length === 1, `gana una sola (201: ${st.filter(x => x === 201).length} · 409: ${st.filter(x => x === 409).length})`);
ok(st.every(x => x === 201 || x === 409), 'las demás reciben 409, sin errores internos');
const g = await resp[st.indexOf(201)].json(); creados.add(g.id);
ok(g.estado === 'bloqueo' && !!g.vence_en && !('nombre' in g) && !('telefono' in g) && !('email' in g), 'bloqueo temporal, sin datos personales en la respuesta');

console.log('6) Superposición y día de salida');
s = await bloquear({ ingreso: D, salida: C, adultos: 2, ...contacto }); ok(s.status === 409, 'superposición parcial rechazada');
r = await (await cotizarP({ ingreso: A, salida: B, adultos: 2 })).json(); ok(r.disponible === false, 'la cotización de prueba ve las fechas bloqueadas');
r = await (await post('/api/cotizar', { ingreso: A, salida: B, adultos: 2 })).json(); ok(r.disponible === true, 'AISLAMIENTO: la cotización pública ignora las reservas de prueba');
s = await bloquear({ ingreso: B, salida: C, adultos: 2, ...contacto }); ok(s.status === 201, 'ingreso el día de salida de otra reserva permitido'); creados.add((await s.json()).id);

console.log('7) Idempotencia (misma solicitud 3 veces a la vez)');
const k = uuid(), cuerpo = { ingreso: C, salida: E, adultos: 3, ...contacto };
const tres = await Promise.all([1, 2, 3].map(() => post('/api/bloqueos', cuerpo, { 'idempotency-key': k, 'x-clave-pruebas': CLAVE })));
const ids = await Promise.all(tres.map(x => x.json()));
ok(tres.every(x => x.status === 200 || x.status === 201) && new Set(ids.map(x => x.id)).size === 1, 'una sola reserva'); creados.add(ids[0].id);

console.log('8) Vencimiento de bloqueos');
s = await bloquear({ ingreso: E, salida: F, adultos: 2, ...contacto, vence_en_segundos: 5 }); const corto = await s.json(); creados.add(corto.id);
ok(s.status === 201, 'bloqueo de 5 segundos creado');
await esperar(7000);
r = await (await cotizarP({ ingreso: E, salida: F, adultos: 2 })).json(); ok(r.disponible === true, 'al vencer, las fechas vuelven a estar disponibles');
r = await (await fetch(`${BASE}/api/reservas/${corto.id}`)).json(); ok(r.estado === 'vencida', `estado: ${r.estado}`);

console.log('9) Seguridad');
s = await post('/api/cotizar', 'esto no es json', {}); ok(s.status === 400, 'cuerpo que no es JSON: 400');
s = await fetch(BASE + '/api/cotizar', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }); ok(s.status === 400, 'tipo de contenido incorrecto: 400');
s = await post('/api/cotizar', JSON.stringify({ x: 'a'.repeat(6000) })); ok(s.status === 400, 'cuerpo demasiado grande: 400');
s = await bloquear({ ingreso: F, salida: fecha(base + 11), adultos: 2, ...contacto, nombre: "Robert'); DROP TABLE reservas;--" });
const inj = await s.json(); creados.add(inj.id);
r = await (await cotizarP({ ingreso: A, salida: B, adultos: 2 })).json();
ok(s.status === 201 && r.disponible === false, 'texto con inyección SQL se guarda como texto y la base sigue intacta');
s = await fetch(`${BASE}/api/reservas/1%20OR%201=1`); ok(s.status === 404, 'id manipulado: 404');
s = await fetch(`${BASE}/api/reservas/${g.id}`, { method: 'DELETE' }); ok(s.status === 404, 'métodos no previstos: 404');
s = await fetch(BASE + '/api/salud', { headers: { origin: 'https://sitio-ajeno.example' } }); ok(!s.headers.get('access-control-allow-origin'), 'CORS: sitio ajeno sin permiso');
s = await fetch(BASE + '/api/salud', { headers: { origin: 'https://casacampolasmaravillas.github.io' } }); ok(s.headers.get('access-control-allow-origin') === 'https://casacampolasmaravillas.github.io', 'CORS: la web oficial sí');
if (REMOTO) { s = await fetch(BASE + '/__scheduled'); ok(s.status === 404, 'la ruta de pruebas /__scheduled no existe en el servidor publicado'); }
s = await fetch(BASE + '/api/salud'); const txt = await s.text(); ok(!/CLAVE|token|secret/i.test(txt), 'la respuesta pública no expone secretos');

console.log('9b) Funciones nuevas apagadas en el Worker público');
s = await post('/api/solicitudes', { ingreso: A, salida: B, adultos: 2, ...contacto, turnstile: 'x' }); ok(s.status === 403, 'solicitudes en línea apagadas para el público (SOLICITUDES_HABILITADAS = false)');
s = await fetch(BASE + '/admin'); ok(s.status === 404, 'el Worker público no tiene panel (/admin: 404)');
s = await fetch(BASE + '/api/admin/solicitudes'); ok(s.status === 404, 'ni API de administración (404)');
s = await post('/api/pagos/orden', { reserva_id: '00000000-0000-4000-8000-000000000000' }); ok(s.status === 403 || s.status === 429, 'crear órdenes de pago sin clave: cerrado');
s = await fetch(BASE + '/calendario-booking.ics'); ok(s.status === 200 && (await s.text()).startsWith('BEGIN:VCALENDAR'), 'calendario exportado disponible (solo fechas)');

console.log('10) Límite de consultas por persona (va al final: deja la IP limitada un minuto)');
const rafaga = await Promise.all(Array.from({ length: 35 }, () => post('/api/cotizar', { ingreso: A, salida: B, adultos: 2 })));
const n429 = rafaga.filter(x => x.status === 429).length;
ok(n429 > 0 && rafaga.every(x => x.status === 200 || x.status === 429), `35 consultas seguidas: ${n429} frenadas con 429, sin errores`);
const una429 = rafaga.find(x => x.status === 429);
ok(una429 && una429.headers.get('retry-after') === '60', 'el 429 indica cuándo reintentar (Retry-After: 60)');

console.log(fallas ? `\n${fallas} pruebas fallaron` : '\nTodas las pruebas pasaron');
console.log('IDS_CREADOS=' + [...creados].filter(Boolean).join(','));
process.exit(fallas ? 1 : 0);
