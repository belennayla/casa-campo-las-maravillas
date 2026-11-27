// Pruebas del servidor de reservas en local.
// Uso: en una terminal `npm run dev` y en otra `npm test`  (usa http://localhost:8787 y la base LOCAL).
const BASE = process.env.BASE || 'http://localhost:8787';
let fallas = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  MAL ') + m); if (!c) fallas++; };
const clave = () => crypto.randomUUID();
const post = (ruta, body, headers = {}) => fetch(BASE + ruta, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080', ...headers }, body: JSON.stringify(body) });
const fecha = dias => { const d = new Date(); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); };
// Fechas aleatorias entre marzo y junio de 2027 (libres en Booking/Airbnb) para no chocar con corridas anteriores
const base = Math.round((Date.parse('2027-03-10') - Date.now()) / 864e5) + Math.floor(Math.random() * 100);
const A = fecha(base), B = fecha(base + 3), C = fecha(base + 5), D = fecha(base + 1);
const contacto = { nombre: 'Prueba Automática', telefono: '2664000000', email: 'prueba@example.com', acepto: true };

console.log('Fechas de prueba:', A, '→', B);

console.log('1) Salud y modo seguro');
let r = await (await fetch(BASE + '/api/salud')).json();
ok(r.pagos_habilitados === false && r.confirmacion_automatica === false && r.modo_mercado_pago === 'prueba', 'pagos y confirmación automática apagados, Mercado Pago en prueba');

console.log('2) Cotización calculada en el servidor');
r = await (await post('/api/cotizar', { ingreso: A, salida: B, adultos: 8, menores: 1, precio: 1 })).json();
ok(r.noches === 3 && r.precio_noche === 243000 && r.total === 729000 && r.sena === 364500 && r.saldo === 364500, `9 huéspedes x 3 noches = ${r.total} (seña ${r.sena}); el precio enviado por el navegador se ignora`);
ok(r.disponibilidad_garantizada === false && r.pago_online === false, 'disponibilidad NO garantizada y sin pago online (etapa 1)');

console.log('3) Validaciones');
let s = await post('/api/cotizar', { ingreso: A, salida: fecha(base + 1), adultos: 2 }); ok(s.status === 400 && (await s.json()).error === 'estadia_minima', 'estadía mínima de 2 noches');
s = await post('/api/cotizar', { ingreso: A, salida: B, adultos: 10, menores: 2 }); ok(s.status === 400 && (await s.json()).error === 'capacidad', 'máximo 11 huéspedes');
s = await post('/api/cotizar', { ingreso: fecha(-3), salida: fecha(-1), adultos: 2 }); ok(s.status === 400 && (await s.json()).error === 'fecha_pasada', 'fechas pasadas rechazadas');
s = await post('/api/cotizar', { ingreso: '2027-02-30', salida: '2027-03-03', adultos: 2 }); ok(s.status === 400, 'fecha inexistente rechazada');
s = await post('/api/bloqueos', { ingreso: A, salida: B, adultos: 2, ...contacto }); ok(s.status === 400 && (await s.json()).error === 'idempotencia', 'bloqueo sin Idempotency-Key rechazado');
s = await post('/api/bloqueos', { ingreso: A, salida: B, adultos: 2, ...contacto, acepto: false }, { 'idempotency-key': clave() }); ok(s.status === 400, 'sin aceptar condiciones: rechazado');

console.log('4) 20 solicitudes SIMULTÁNEAS por las mismas fechas');
const resp = await Promise.all(Array.from({ length: 20 }, () => post('/api/bloqueos', { ingreso: A, salida: B, adultos: 2, ...contacto }, { 'idempotency-key': clave() })));
const estados = resp.map(x => x.status);
ok(estados.filter(x => x === 201).length === 1, `una sola gana (201: ${estados.filter(x => x === 201).length}, 409: ${estados.filter(x => x === 409).length})`);
ok(estados.every(x => x === 201 || x === 409), 'el resto recibe 409 "no disponible", sin errores internos');
const ganador = await resp[estados.indexOf(201)].json();
ok(ganador.estado === 'bloqueo' && !!ganador.vence_en, 'queda como bloqueo temporal con vencimiento');
ok(!('nombre' in ganador) && !('telefono' in ganador) && !('email' in ganador), 'la respuesta no devuelve datos personales');

console.log('5) Superposición parcial y día de salida');
s = await post('/api/bloqueos', { ingreso: D, salida: C, adultos: 2, ...contacto }, { 'idempotency-key': clave() }); ok(s.status === 409, 'reserva que se superpone parcialmente: rechazada');
s = await post('/api/cotizar', { ingreso: B, salida: C, adultos: 2 }); r = await s.json(); ok(r.disponible === true, 'ingresar el día de salida de otra reserva: permitido');
s = await post('/api/cotizar', { ingreso: A, salida: B, adultos: 2 }); r = await s.json(); ok(r.disponible === false, 'la cotización ve las fechas bloqueadas');

console.log('6) Idempotencia: la misma solicitud repetida (también a la vez)');
const k = clave(), cuerpo = { ingreso: B, salida: C, adultos: 3, ...contacto };
const dobles = await Promise.all([post('/api/bloqueos', cuerpo, { 'idempotency-key': k }), post('/api/bloqueos', cuerpo, { 'idempotency-key': k }), post('/api/bloqueos', cuerpo, { 'idempotency-key': k })]);
const ids = await Promise.all(dobles.map(x => x.json()));
ok(dobles.every(x => x.status === 200 || x.status === 201) && new Set(ids.map(x => x.id)).size === 1, 'tres envíos con la misma clave = una sola reserva');

console.log('7) Consulta de estado');
s = await fetch(`${BASE}/api/reservas/${ganador.id}`); r = await s.json(); ok(s.status === 200 && r.estado === 'bloqueo' && r.sena === ganador.sena, 'consulta por id');
s = await fetch(`${BASE}/api/reservas/00000000-0000-4000-8000-000000000000`); ok(s.status === 404, 'id inexistente: 404');

console.log('8) CORS');
s = await fetch(BASE + '/api/salud', { headers: { origin: 'https://sitio-ajeno.example' } }); ok(!s.headers.get('access-control-allow-origin'), 'un sitio ajeno no recibe permiso CORS');
s = await fetch(BASE + '/api/salud', { headers: { origin: 'https://casacampolasmaravillas.github.io' } }); ok(s.headers.get('access-control-allow-origin') === 'https://casacampolasmaravillas.github.io', 'la web oficial sí');

console.log(fallas ? `\n${fallas} pruebas fallaron` : '\nTodas las pruebas pasaron');
console.log(JSON.stringify({ reserva_bloqueo: ganador.id, fechas: [A, B, C] }));
process.exit(fallas ? 1 : 0);
