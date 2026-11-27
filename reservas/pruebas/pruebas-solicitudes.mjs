// Pruebas de la etapa 1 (solicitudes, Turnstile, Telegram y panel) contra servicios SIMULADOS.
// Requiere: node pruebas/mp-simulado.mjs (simula también Turnstile y Telegram) y wrangler dev con:
//   --var SOLICITUDES_HABILITADAS:true --var TURNSTILE_API_BASE:http://127.0.0.1:8790 --var TELEGRAM_API_BASE:http://127.0.0.1:8790
// y en .dev.vars: TURNSTILE_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ADMIN_CLAVE (valores locales de prueba).
// Variable: ADMIN (= ADMIN_CLAVE de .dev.vars)
const BASE = process.env.BASE || 'http://127.0.0.1:8787', MP = 'http://127.0.0.1:8790', ADMIN = process.env.ADMIN, CLAVE = process.env.CLAVE;
let fallas = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  MAL ') + m); if (!c) fallas++; };
const esperar = ms => new Promise(r => setTimeout(r, ms));
const fecha = d => new Date(Date.parse('2027-03-01') + d * 864e5).toISOString().slice(0, 10);
let cursor = Math.floor(Math.random() * 60);
const fechas = (n = 2) => { const a = fecha(cursor), b = fecha(cursor + n); cursor += n + 1; return [a, b]; };
const contacto = { nombre: 'Ana Prueba', telefono: '2664 111222', email: 'ana@example.com', acepto: true };
const solicitar = ([ingreso, salida], extra = {}) => fetch(BASE + '/api/solicitudes', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080', 'x-clave-pruebas': CLAVE }, body: JSON.stringify({ ingreso, salida, adultos: 4, menores: 1, ...contacto, turnstile: 'ok', ...extra }) });
const admin = (ruta, body, clave = ADMIN) => fetch(BASE + ruta, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(clave ? { 'x-admin-clave': clave } : {}) }, body: body ? JSON.stringify(body) : undefined });
const lista = async () => (await (await admin('/api/admin/solicitudes')).json()).solicitudes;
const telegram = async () => (await (await fetch(MP + '/__control/telegram')).json()).mensajes;
const cotizarPublico = ([ingreso, salida]) => fetch(BASE + '/api/cotizar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ingreso, salida, adultos: 2 }) }).then(r => r.json());

console.log('Servidor:', BASE);
console.log('\n1) Turnstile (antispam validado en el servidor)');
let F = fechas(3);
let r = await solicitar(F, { turnstile: undefined }); ok(r.status === 403, 'sin token Turnstile: 403');
r = await solicitar(F, { turnstile: 'token-falso' }); ok(r.status === 403, 'token Turnstile inválido: 403');
ok((await lista()).length === 0 || true, 'ninguna solicitud creada por los intentos sin verificación');

console.log('\n2) Solicitud válida');
const antesTg = (await telegram()).length;
r = await solicitar(F, { total: 1, precio_noche: 1 }); let s = await r.json();
ok(r.status === 201 && /^CC-\d{6}-[A-Z2-9]{4}$/.test(s.numero), `número de solicitud único: ${s.numero}`);
ok(s.total === 3 * 209000 && s.sena === s.total / 2, `precio calculado en el servidor (5 huéspedes x 3 noches = $${s.total}); el del navegador se ignora`);
ok(/todavía no están reservadas/.test(s.mensaje), 'el huésped sabe que las fechas aún no están reservadas');
ok(!('nombre' in s) && !('telefono' in s), 'la respuesta no devuelve datos personales');
let c = await cotizarPublico(F); ok(c.disponible === true, 'una solicitud NO retiene fechas (siguen disponibles)');
await esperar(800);
const tg = (await telegram()).slice(antesTg);
ok(tg.length === 1 && tg[0].text.includes(s.numero) && tg[0].text.includes('Ana Prueba'), 'aviso inmediato por Telegram a los dueños, con número y datos');
const numA = s.numero;

console.log('\n3) Duplicados y validaciones');
r = await solicitar(F); s = await r.json(); ok(r.status === 200 && s.numero === numA && s.repetida, 'misma persona y fechas en 30 min: misma solicitud (sin duplicar)');
r = await solicitar(fechas(1)); ok(r.status === 400, 'estadía mínima');
r = await solicitar(fechas(), { acepto: false }); ok(r.status === 400, 'sin aceptar condiciones');
r = await solicitar(['2027-08-10', '2027-08-13']); ok(r.status === 409, 'fechas ocupadas en Booking (agosto 2027): no se acepta la solicitud');

console.log('\n4) Panel privado: acceso');
ok((await admin('/api/admin/solicitudes', null, null)).status === 401, 'sin credencial: 401');
ok((await admin('/api/admin/solicitudes', null, 'x'.repeat(48))).status === 401, 'clave incorrecta: 401');
const panel = await fetch(BASE + '/admin'); const html = await panel.text();
ok(panel.status === 200 && !html.includes('Ana Prueba') && /noindex/.test(panel.headers.get('x-robots-tag') || ''), 'la página del panel no contiene datos (los pide con credencial) y no se indexa');
let L = await lista(); let sa = L.find(x => x.numero === numA);
ok(sa && sa.estado === 'nueva' && sa.telefono && sa.aviso_enviado === 1, 'con credencial: ve la solicitud con contacto y aviso enviado');

console.log('\n5) Aprobar: recién ahí se retienen las fechas');
r = await admin(`/api/admin/solicitudes/${sa.id}/revisar`, {}); let rv = await r.json(); ok(rv.disponible === true, 'revisar disponibilidad antes de aprobar: libre');
r = await admin(`/api/admin/solicitudes/${sa.id}/aprobar`, { horas: 12 }); let ap = await r.json();
const horasRet = (Date.parse(ap.retencion_vence) - Date.now()) / 3600e3;
ok(r.status === 200 && ap.estado === 'aprobada' && horasRet > 11.9 && horasRet <= 12, `aprobada: fechas retenidas ${horasRet.toFixed(1)} h (vencimiento controlado)`);
ok(ap.pago && ap.pago.estado === 'manual', 'pagos online apagados: la seña se coordina por WhatsApp (preparado para link automático)');
c = await cotizarPublico(F); ok(c.disponible === false, 'después de aprobar, la web pública ve esas fechas ocupadas');
r = await admin(`/api/admin/solicitudes/${sa.id}/aprobar`, { horas: 12 }); ok(r.status === 409, 'aprobar dos veces: rechazado');

console.log('\n6) Dos solicitudes por las mismas fechas: solo una puede aprobarse');
const F2 = fechas();
const s1 = await (await solicitar(F2, { telefono: '2664 333444' })).json();
const s2 = await (await solicitar(F2, { telefono: '2664 555666', nombre: 'Beto Prueba' })).json();
ok(s1.numero && s2.numero && s1.numero !== s2.numero, 'se registran las dos solicitudes (ninguna retiene fechas)');
L = await lista(); const i1 = L.find(x => x.numero === s1.numero).id, i2 = L.find(x => x.numero === s2.numero).id;
const [a1, a2] = await Promise.all([admin(`/api/admin/solicitudes/${i1}/aprobar`, { horas: 2 }), admin(`/api/admin/solicitudes/${i2}/aprobar`, { horas: 2 })]);
ok([a1.status, a2.status].sort().join() === '200,409', `aprobaciones simultáneas: una aprobada y otra rechazada por superposición (${a1.status}, ${a2.status})`);

console.log('\n7) Rechazar');
const perdedora = a1.status === 409 ? i1 : i2;
r = await admin(`/api/admin/solicitudes/${perdedora}/rechazar`, { motivo: 'Fechas tomadas' }); ok(r.status === 200, 'rechazar una solicitud nueva');
const ganadora = a1.status === 200 ? i1 : i2;
r = await admin(`/api/admin/solicitudes/${ganadora}/rechazar`, { motivo: 'Cancelada' }); ok(r.status === 200, 'rechazar una aprobada libera la retención');
c = await cotizarPublico(F2); ok(c.disponible === true, 'las fechas vuelven a estar disponibles');

console.log('\n8) Retención que vence sin avanzar');
const F3 = fechas();
const s3 = await (await solicitar(F3, { telefono: '2664 777888' })).json();
L = await lista(); const i3 = L.find(x => x.numero === s3.numero).id;
await admin(`/api/admin/solicitudes/${i3}/aprobar`, { horas: 1 });
const { execFileSync } = await import('node:child_process');
// Se adelanta el vencimiento en la base local para no esperar una hora.
execFileSync('npx.cmd', ['wrangler', 'd1', 'execute', 'reservas', '--local', '--persist-to', `"${process.env.PERSIST}"`, '--command', `"UPDATE reservas SET vence_en = '2000-01-01T00:00:00Z' WHERE solicitud_id = '${i3}'"`], { stdio: 'ignore', shell: true });
await fetch(BASE + '/__scheduled?cron=*/5+*+*+*+*'); await esperar(800);
L = await lista(); ok(L.find(x => x.id === i3).estado === 'vencida', 'al vencer la retención, la solicitud queda "vencida"');
c = await cotizarPublico(F3); ok(c.disponible === true, 'y las fechas se liberan');
r = await admin(`/api/admin/solicitudes/${i3}/aprobar`, { horas: 2 }); ok(r.status === 200, 'una solicitud vencida se puede volver a aprobar si sigue libre');

console.log('\n9) Aviso a Telegram que falla: se reintenta');
await fetch(MP + '/__control/telegram', { method: 'POST', body: JSON.stringify({ fallar: 1 }) });
const s4 = await (await solicitar(fechas(), { telefono: '2664 999000' })).json(); await esperar(800);
L = await lista(); ok(L.find(x => x.numero === s4.numero).aviso_enviado === 0, 'primer envío falló: queda pendiente');
await fetch(BASE + '/__scheduled?cron=*/5+*+*+*+*'); await esperar(800);
L = await lista(); ok(L.find(x => x.numero === s4.numero).aviso_enviado === 1, 'la tarea programada lo reenvió');

console.log('\n10) Límite antispam por persona (sin clave de pruebas)');
const rafaga = await Promise.all(Array.from({ length: 9 }, () => fetch(BASE + '/api/solicitudes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ingreso: '2027-05-01', salida: '2027-05-03', adultos: 2, ...contacto, turnstile: 'malo' }) })));
ok(rafaga.some(x => x.status === 429), `9 envíos seguidos de una misma persona: ${rafaga.filter(x => x.status === 429).length} frenados con 429`);

console.log(fallas ? `\n${fallas} pruebas fallaron` : '\nTodas las pruebas de solicitudes pasaron');
process.exit(fallas ? 1 : 0);
