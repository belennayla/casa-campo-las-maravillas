/*
  Servidor de reservas · Casa Campo Las Maravillas (Cloudflare Worker + D1)

  ETAPA 1 (actual):
  - Cotiza en el servidor (el navegador no decide el precio).
  - Crea bloqueos temporales de fechas con protección frente a solicitudes simultáneas.
  - Vence los bloqueos sin pago (tarea programada).
  - NO cobra ni confirma reservas: PAGOS_HABILITADOS y CONFIRMACION_AUTOMATICA están en "false".
    Mientras la disponibilidad dependa de calendarios iCal que pueden estar desactualizados,
    toda reserva queda sujeta a confirmación manual de los dueños.

  ETAPA 2 (solo PRUEBA, ver más abajo "MERCADO PAGO"):
  - Orden de seña (Checkout Pro vía Orders API) con idempotencia, solo con la clave de pruebas.
  - Webhook con firma HMAC, verificación del estado REAL de la orden, reintentos y conciliación periódica.
  - Un pago acreditado deja la reserva en "pago_verificado", nunca en "confirmada": la confirman los dueños.

  Los datos personales se guardan solo en la base D1 privada. Ninguna respuesta pública los devuelve.
*/

const MAX_NOCHES = 30;
const MAX_MESES_ADELANTE = 18;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/api/salud' && req.method === 'GET') return json(estadoServicio(env), 200, cors);
      if (url.pathname === '/api/cotizar' && req.method === 'POST') {
        const esPrueba = await claveDePruebaValida(req, env);
        if (!esPrueba) await limitar(env.LIMITE_COTIZAR, req);
        return json(await cotizar(await leerJson(req), env, esPrueba), 200, cors);
      }
      if (url.pathname === '/api/bloqueos' && req.method === 'POST') {
        if (!(await claveDePruebaValida(req, env))) await limitar(env.LIMITE_BLOQUEOS, req);
        return await crearBloqueo(req, env, cors);
      }
      const m = url.pathname.match(/^\/api\/reservas\/([0-9a-f-]{36})$/);
      if (m && req.method === 'GET') return await verReserva(m[1], env, cors);
      if (url.pathname === '/api/pagos/orden' && req.method === 'POST') {
        if (!(await claveDePruebaValida(req, env))) await limitar(env.LIMITE_BLOQUEOS, req);
        return await crearOrdenSena(req, env, cors);
      }
      if (url.pathname === '/api/webhooks/mercadopago' && req.method === 'POST') return await recibirWebhook(req, env, ctx);
      if (url.pathname === '/api/pruebas/mp-cuenta' && req.method === 'GET') return await diagnosticoCuenta(req, env, cors);
      const mp = url.pathname.match(/^\/api\/pruebas\/reservas\/([0-9a-f-]{36})$/);
      if (mp && req.method === 'GET') return await detallePrueba(mp[1], req, env, cors);
      return json({ error: 'no_encontrado' }, 404, cors);
    } catch (e) {
      if (e instanceof ErrorUsuario) return json({ error: e.codigo, mensaje: e.message }, e.status, e.status === 429 ? { ...cors, 'retry-after': '60' } : cors);
      console.error('Error interno', e && e.stack || e);
      return json({ error: 'error_interno', mensaje: 'No pudimos procesar la solicitud. Escribinos por WhatsApp.' }, 500, cors);
    }
  },

  // Tarea programada: libera bloqueos sin orden, reintenta avisos fallidos y concilia órdenes con Mercado Pago.
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(tareaProgramada(env));
  }
};

/* ---------------- utilidades ---------------- */

class ErrorUsuario extends Error {
  constructor(codigo, mensaje, status = 400) { super(mensaje); this.codigo = codigo; this.status = status; }
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

function corsHeaders(req, env) {
  const origen = req.headers.get('origin');
  const permitidos = (env.ORIGENES_PERMITIDOS || '').split(',').map(s => s.trim());
  const h = { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, idempotency-key', 'access-control-max-age': '86400', 'vary': 'origin' };
  if (origen && permitidos.includes(origen)) h['access-control-allow-origin'] = origen;
  return h;
}

// Límite por persona (IP) con el Rate Limiting de Workers (gratuito). Si el límite no está configurado, no bloquea.
async function limitar(limitador, req) {
  if (!limitador) return;
  const ip = req.headers.get('cf-connecting-ip') || 'sin-ip';
  const { success } = await limitador.limit({ key: ip });
  if (!success) throw new ErrorUsuario('demasiadas_solicitudes', 'Hiciste muchas consultas seguidas. Esperá un minuto o escribinos por WhatsApp.', 429);
}

async function leerJson(req) {
  const tipo = req.headers.get('content-type') || '';
  if (!tipo.includes('application/json')) throw new ErrorUsuario('formato_invalido', 'La solicitud debe ser JSON.');
  const texto = await req.text();
  if (texto.length > 5000) throw new ErrorUsuario('demasiado_grande', 'La solicitud es demasiado grande.');
  try { return JSON.parse(texto); } catch { throw new ErrorUsuario('formato_invalido', 'JSON inválido.'); }
}

const ahora = () => new Date().toISOString();
const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nochesEntre(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }
function listaNoches(ingreso, salida) { const out = []; for (let d = ingreso; d < salida; d = addDays(d, 1)) out.push(d); return out; }
function fechaValida(s) { return FECHA.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; }

function estadoServicio(env) {
  return {
    ok: true,
    etapa: 1,
    pagos_habilitados: env.PAGOS_HABILITADOS === 'true',
    modo_mercado_pago: env.MP_MODO || 'prueba',
    confirmacion_automatica: env.CONFIRMACION_AUTOMATICA === 'true'
  };
}

/* ---------------- datos públicos de la casa ---------------- */

async function datosCasa(env) {
  const base = env.SITE_URL.replace(/\/$/, '');
  const r = await fetch(base + '/data/casa.json', { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) throw new Error('No se pudo leer casa.json: HTTP ' + r.status);
  return r.json();
}

async function calendarioPublicado(env) {
  // Copia de Booking/Airbnb que genera GitHub Actions. Puede estar desactualizada: se usa para BLOQUEAR, nunca para garantizar.
  try {
    const base = env.SITE_URL.replace(/\/$/, '');
    const r = await fetch(base + '/data/ocupadas-sync.json', { cf: { cacheTtl: 60, cacheEverything: true } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function precioPorNoche(casa, huespedes) {
  const t = casa.tarifas.por_huespedes;
  for (const k of Object.keys(t)) {
    const [a, b] = k.split('-').map(Number);
    if (huespedes >= a && huespedes <= (b || a)) return Number(t[k]);
  }
  return null;
}

/* ---------------- validación y cotización ---------------- */

function validarEstadia(body, casa) {
  const ingreso = String(body.ingreso || ''), salida = String(body.salida || '');
  const adultos = Number.parseInt(body.adultos, 10), menores = Number.parseInt(body.menores ?? 0, 10);
  if (!fechaValida(ingreso) || !fechaValida(salida)) throw new ErrorUsuario('fechas_invalidas', 'Las fechas no son válidas.');
  if (salida <= ingreso) throw new ErrorUsuario('fechas_invalidas', 'La salida debe ser posterior al ingreso.');
  if (ingreso < hoyAR()) throw new ErrorUsuario('fecha_pasada', 'La fecha de ingreso ya pasó.');
  const limite = new Date(); limite.setMonth(limite.getMonth() + MAX_MESES_ADELANTE);
  if (ingreso > limite.toISOString().slice(0, 10)) throw new ErrorUsuario('fecha_lejana', 'Todavía no recibimos reservas para esas fechas.');
  const noches = nochesEntre(ingreso, salida);
  const minimo = casa.tarifas.estadia_minima_noches || 2;
  if (noches < minimo) throw new ErrorUsuario('estadia_minima', `La estadía mínima es de ${minimo} noches.`);
  if (noches > MAX_NOCHES) throw new ErrorUsuario('estadia_larga', `Para estadías de más de ${MAX_NOCHES} noches escribinos por WhatsApp.`);
  if (!Number.isInteger(adultos) || adultos < 1) throw new ErrorUsuario('huespedes_invalidos', 'Tiene que haber al menos 1 adulto.');
  if (!Number.isInteger(menores) || menores < 0) throw new ErrorUsuario('huespedes_invalidos', 'Cantidad de menores inválida.');
  const huespedes = adultos + menores;
  if (huespedes > (casa.capacidad_maxima || 11)) throw new ErrorUsuario('capacidad', `La capacidad máxima es de ${casa.capacidad_maxima} huéspedes.`);
  return { ingreso, salida, adultos, menores, huespedes, noches };
}

function calcularPrecio(casa, e) {
  const precio = precioPorNoche(casa, e.huespedes);
  if (precio == null) throw new ErrorUsuario('sin_tarifa', 'Consultá el precio por WhatsApp.');
  const total = precio * e.noches;
  const sena = Math.round(total * (casa.reserva.sena_porcentaje || 50) / 100);
  return { precio_noche: precio, total, sena, saldo: total - sena, moneda: casa.tarifas.moneda || 'ARS' };
}

async function revisarDisponibilidad(env, casa, e, { incluirPruebas = true } = {}) {
  const noches = listaNoches(e.ingreso, e.salida);
  const motivos = [];
  // 1) Base de datos propia (bloqueos vigentes y reservas).
  //    La cotización pública ignora las reservas de PRUEBA (origen = 'prueba') para no afectar a visitantes reales.
  await vencerBloqueos(env);
  const ph = noches.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT n.fecha FROM noches n JOIN reservas r ON r.id = n.reserva_id
    WHERE n.fecha IN (${ph}) AND (? = 1 OR r.origen <> 'prueba')`).bind(...noches, incluirPruebas ? 1 : 0).all();
  const ocupadasDB = new Set(results.map(r => r.fecha));
  // 2) Reservas directas cargadas a mano + 3) copia de Booking/Airbnb publicada.
  const sync = await calendarioPublicado(env);
  const externas = [...(casa.ocupadas || []), ...((sync && sync.ocupadas) || [])];
  const ocupadasExt = new Set();
  for (const b of externas) if (b && fechaValida(b.desde) && fechaValida(b.hasta)) for (const d of listaNoches(b.desde, b.hasta)) ocupadasExt.add(d);
  const choque = noches.filter(d => ocupadasDB.has(d) || ocupadasExt.has(d));

  // ¿Se puede GARANTIZAR? En la etapa 1 nunca: dependemos de iCal con demora.
  if (!sync) motivos.push('no se pudo leer la sincronización con Booking y Airbnb');
  else {
    const horas = (Date.now() - Date.parse(sync.actualizado)) / 36e5;
    for (const f of casa.fuentes_esperadas || []) if (!sync.fuentes?.[f]?.ok) motivos.push(`calendario de ${f} sin verificar`);
    if (!(horas <= (casa.sync_max_horas || 26))) motivos.push('sincronización desactualizada');
  }
  motivos.push('los calendarios de Booking y Airbnb (iCal) pueden tener horas de demora');
  return { disponible: choque.length === 0, noches_ocupadas: choque, garantizada: false, motivos };
}

async function cotizar(body, env, incluirPruebas = false) {
  const casa = await datosCasa(env);
  const e = validarEstadia(body, casa);
  const precio = calcularPrecio(casa, e);
  const disp = await revisarDisponibilidad(env, casa, e, { incluirPruebas });
  return {
    ingreso: e.ingreso, salida: e.salida, noches: e.noches, huespedes: e.huespedes, ...precio,
    disponible: disp.disponible,
    disponibilidad_garantizada: disp.garantizada,
    motivos_sin_garantia: disp.motivos,
    pago_online: false,
    modo: 'confirmacion_manual'
  };
}

/* ---------------- bloqueos temporales ---------------- */

function validarContacto(body) {
  const limpiar = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const nombre = limpiar(body.nombre, 100), telefono = limpiar(body.telefono, 30), email = limpiar(body.email, 120), obs = limpiar(body.observaciones, 1000);
  if (nombre.length < 2) throw new ErrorUsuario('nombre_invalido', 'Completá tu nombre y apellido.');
  if (telefono.replace(/\D/g, '').length < 8) throw new ErrorUsuario('telefono_invalido', 'Completá un teléfono válido.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErrorUsuario('email_invalido', 'El correo no es válido.');
  if (body.acepto !== true) throw new ErrorUsuario('condiciones', 'Tenés que aceptar las condiciones de la reserva.');
  return { nombre, telefono, email: email || null, observaciones: obs || null };
}

// Mientras la web no esté conectada, crear bloqueos solo se permite con la clave de pruebas
// (secreto CLAVE_PRUEBAS en Cloudflare). Sin ese secreto cargado, nadie puede crear bloqueos.
async function claveDePruebaValida(req, env) {
  const recibida = (req.headers.get('x-clave-pruebas') || '').trim();
  const esperada = (env.CLAVE_PRUEBAS || '').trim();
  if (esperada.length < 32 || recibida.length !== esperada.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(recibida), enc.encode(esperada));
}

async function crearBloqueo(req, env, cors) {
  const esPrueba = await claveDePruebaValida(req, env);
  if (env.BLOQUEOS_PUBLICOS !== 'true' && !esPrueba) {
    throw new ErrorUsuario('no_habilitado', 'Las reservas online todavía no están habilitadas. Escribinos por WhatsApp.', 403);
  }
  const clave = (req.headers.get('idempotency-key') || '').trim();
  if (!/^[A-Za-z0-9-]{16,64}$/.test(clave)) throw new ErrorUsuario('idempotencia', 'Falta el encabezado Idempotency-Key (16 a 64 caracteres).');

  // Misma solicitud repetida: devolver la reserva ya creada.
  const previa = await env.DB.prepare('SELECT reserva_id FROM idempotencia WHERE clave = ?').bind(clave).first();
  if (previa) return await verReserva(previa.reserva_id, env, cors, 200);

  const body = await leerJson(req);
  const casa = await datosCasa(env);
  const e = validarEstadia(body, casa);
  const c = validarContacto(body);
  const precio = calcularPrecio(casa, e);
  const disp = await revisarDisponibilidad(env, casa, e);
  if (!disp.disponible) throw new ErrorUsuario('no_disponible', 'Esas fechas ya no están disponibles. Elegí otras o escribinos por WhatsApp.', 409);

  const id = crypto.randomUUID(), t = ahora();
  // Solo en pruebas se puede acortar el vencimiento (5 a 600 segundos) para probar que se liberan las fechas.
  const segPrueba = esPrueba ? Number.parseInt(body.vence_en_segundos, 10) : NaN;
  const msVence = Number.isInteger(segPrueba) && segPrueba >= 5 && segPrueba <= 600 ? segPrueba * 1000 : Number(env.BLOQUEO_MINUTOS || 30) * 60e3;
  const vence = new Date(Date.now() + msVence).toISOString();
  const origen = esPrueba ? 'prueba' : 'web';
  const noches = listaNoches(e.ingreso, e.salida);

  // Todo en un único lote: es una transacción. Si UNA noche ya está tomada (clave primaria),
  // falla todo el lote y no queda nada a medias. Así dos solicitudes simultáneas no pueden ganar las dos.
  const stmts = [
    env.DB.prepare(`INSERT INTO reservas (id, creada, actualizada, estado, ingreso, salida, noches, adultos, menores, huespedes,
      precio_noche, total, sena, saldo, moneda, nombre, telefono, email, observaciones, vence_en, origen)
      VALUES (?, ?, ?, 'bloqueo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, t, t, e.ingreso, e.salida, e.noches, e.adultos, e.menores, e.huespedes,
        precio.precio_noche, precio.total, precio.sena, precio.saldo, precio.moneda, c.nombre, c.telefono, c.email, c.observaciones, vence, origen),
    ...noches.map(f => env.DB.prepare('INSERT INTO noches (fecha, reserva_id) VALUES (?, ?)').bind(f, id)),
    env.DB.prepare('INSERT INTO idempotencia (clave, reserva_id, creada) VALUES (?, ?, ?)').bind(clave, id, t),
    env.DB.prepare('INSERT INTO eventos (reserva_id, fecha, tipo, detalle) VALUES (?, ?, ?, ?)')
      .bind(id, t, 'bloqueo_creado', JSON.stringify({ vence, garantizada: false, motivos: disp.motivos }))
  ];
  try {
    await env.DB.batch(stmts);
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(msg)) {
      // ¿Fue la misma clave de idempotencia enviada dos veces a la vez?
      const otra = await env.DB.prepare('SELECT reserva_id FROM idempotencia WHERE clave = ?').bind(clave).first();
      if (otra) return await verReserva(otra.reserva_id, env, cors, 200);
      throw new ErrorUsuario('no_disponible', 'Otra persona acaba de reservar alguna de esas noches. Elegí otras fechas.', 409);
    }
    throw err;
  }
  return await verReserva(id, env, cors, 201);
}

async function verReserva(id, env, cors, status = 200) {
  const r = await env.DB.prepare('SELECT id, estado, ingreso, salida, noches, huespedes, precio_noche, total, sena, saldo, pagado, moneda, vence_en FROM reservas WHERE id = ?').bind(id).first();
  if (!r) return json({ error: 'no_encontrado' }, 404, cors);
  return json({ ...r, pago_online: env.PAGOS_HABILITADOS === 'true', mensaje: MENSAJES_HUESPED[r.estado] }, status, cors);
}

// Lo que se le informa al huésped. Un pago aprobado NUNCA se presenta como reserva confirmada.
const MENSAJES_HUESPED = {
  bloqueo: 'Fechas retenidas temporalmente. La reserva queda sujeta a confirmación de los dueños por WhatsApp.',
  pendiente_pago: 'Esperando el pago de la seña. La reserva no está confirmada.',
  pago_en_proceso: 'Mercado Pago está procesando tu pago. Te avisamos cuando se acredite. La reserva todavía no está confirmada.',
  pago_verificado: 'Recibimos tu seña. Los dueños van a revisar la disponibilidad y confirmarte la reserva por WhatsApp.',
  confirmada: 'Reserva confirmada por los dueños.',
  vencida: 'El tiempo para pagar la seña venció y las fechas se liberaron.',
  cancelada: 'Reserva cancelada.',
  conflicto: 'Hubo un problema con tu reserva. Los dueños se van a comunicar con vos por WhatsApp para resolverlo.'
};

// Libera SOLO bloqueos vencidos sin orden de pago. Los que tienen orden se liberan en la conciliación,
// después de consultar el estado real a Mercado Pago (nunca se liberan fechas de una seña acreditada).
async function vencerBloqueos(env) {
  const t = ahora();
  const viejo = new Date(Date.now() - 10 * 60e3).toISOString(); // orden "creando" colgada hace más de 10 min
  const { results } = await env.DB.prepare(
    `SELECT id FROM reservas WHERE estado IN ('bloqueo', 'pendiente_pago') AND vence_en IS NOT NULL AND vence_en < ?
       AND (mp_order_id IS NULL OR (mp_order_id = 'creando' AND vence_en < ?))`).bind(t, viejo).all();
  if (!results.length) return 0;
  const stmts = [];
  for (const { id } of results) {
    stmts.push(env.DB.prepare("UPDATE reservas SET estado = 'vencida', actualizada = ? WHERE id = ? AND estado IN ('bloqueo', 'pendiente_pago')").bind(t, id));
    stmts.push(env.DB.prepare('DELETE FROM noches WHERE reserva_id = ?').bind(id));
    stmts.push(env.DB.prepare('INSERT INTO eventos (reserva_id, fecha, tipo) VALUES (?, ?, ?)').bind(id, t, 'bloqueo_vencido'));
  }
  await env.DB.batch(stmts);
  return results.length;
}

/* =====================================================================
   MERCADO PAGO · Checkout Pro vía Orders API · SOLO MODO PRUEBA
   Documentación: /docs/checkout-pro-orders (crear, obtener, cancelar order; notificaciones).
   Firma del webhook: igual al validador oficial del SDK de Node (WebhookSignatureValidator):
   manifest "id:{data.id};request-id:{x-request-id};ts:{ts};" → HMAC-SHA256 hex.
   ===================================================================== */

const mpBase = env => (env.MP_API_BASE || 'https://api.mercadopago.com').replace(/\/$/, '');
const centavos = v => Math.round(Number(v) * 100);
const montoTexto = n => Number(n).toFixed(2);
const ESTADOS_CERRADOS = ['pago_verificado', 'confirmada', 'conflicto', 'cancelada'];

async function mpFetch(env, ruta, { method = 'GET', body, idempotencia } = {}) {
  const headers = { authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (idempotencia) headers['x-idempotency-key'] = idempotencia;
  const r = await fetch(mpBase(env) + ruta, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const texto = await r.text();
  let data = null; try { data = texto ? JSON.parse(texto) : null; } catch { /* respuesta no JSON */ }
  return { status: r.status, ok: r.ok, data };
}

// Doble traba: MP_MODO debe ser "prueba" y la cuenta del token debe ser una cuenta de prueba de Mercado Pago.
let cuentaPruebaOk = null;
async function exigirModoPrueba(env) {
  if (env.MP_MODO !== 'prueba') throw new ErrorUsuario('modo_no_permitido', 'Los pagos solo funcionan en modo de prueba.', 403);
  if (!env.MP_ACCESS_TOKEN) throw new ErrorUsuario('mp_sin_configurar', 'Mercado Pago no está configurado.', 503);
  const huella = env.MP_ACCESS_TOKEN.slice(-10);
  if (cuentaPruebaOk === huella) return;
  const r = await mpFetch(env, '/users/me');
  const tags = (r.data && r.data.tags) || [];
  if (!r.ok || !tags.includes('test_user')) {
    throw new ErrorUsuario('cuenta_no_prueba', 'Las credenciales cargadas no son de una cuenta de prueba: no se crean órdenes.', 403);
  }
  cuentaPruebaOk = huella;
}

function evento(env, reservaId, tipo, detalle) {
  return env.DB.prepare('INSERT INTO eventos (reserva_id, fecha, tipo, detalle) VALUES (?, ?, ?, ?)')
    .bind(reservaId, ahora(), tipo, detalle == null ? null : JSON.stringify(detalle));
}

/* ---------- 1) Orden de seña ---------- */

async function crearOrdenSena(req, env, cors) {
  // Mientras PAGOS_HABILITADOS sea false, solo se puede usar con la clave de pruebas.
  if (!(await claveDePruebaValida(req, env))) throw new ErrorUsuario('no_habilitado', 'Los pagos online todavía no están habilitados. Escribinos por WhatsApp.', 403);
  await exigirModoPrueba(env);
  const body = await leerJson(req);
  const id = String(body.reserva_id || '');
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ErrorUsuario('reserva_invalida', 'Reserva inválida.');
  const r = await env.DB.prepare('SELECT * FROM reservas WHERE id = ?').bind(id).first();
  if (!r) throw new ErrorUsuario('no_encontrado', 'Reserva inexistente.', 404);
  if (r.estado === 'pendiente_pago' && r.mp_checkout_url) return json(respuestaOrden(r), 200, cors); // repetida: misma orden
  if (r.estado !== 'bloqueo') throw new ErrorUsuario('estado_invalido', 'Esta reserva no admite un pago nuevo.', 409);
  const restante = (Date.parse(r.vence_en) - Date.now()) / 1000;
  if (!(restante >= Number(env.ORDEN_MIN_SEGUNDOS || 120))) throw new ErrorUsuario('bloqueo_por_vencer', 'El tiempo para pagar está por vencer. Volvé a elegir las fechas.', 409);

  // Reclamo atómico: solo una solicitud puede crear la orden de esta reserva.
  const t = ahora();
  const claim = await env.DB.prepare("UPDATE reservas SET mp_order_id = 'creando', actualizada = ? WHERE id = ? AND estado = 'bloqueo' AND mp_order_id IS NULL").bind(t, id).run();
  if (!claim.meta.changes) {
    const otra = await env.DB.prepare('SELECT * FROM reservas WHERE id = ?').bind(id).first();
    if (otra && otra.mp_checkout_url) return json(respuestaOrden(otra), 200, cors);
    throw new ErrorUsuario('orden_en_curso', 'El pago ya se está generando. Esperá unos segundos.', 409);
  }

  const base = env.SITE_URL.replace(/\/$/, '');
  const monto = montoTexto(r.sena);
  const orden = {
    type: 'online',
    processing_mode: 'manual',
    total_amount: monto,
    external_reference: r.id,
    expiration_time: `PT${Math.max(1, Math.floor(restante / 60))}M`, // vence junto con el bloqueo
    description: 'Seña 50 % · Casa Campo Las Maravillas',
    items: [{ title: `Seña 50 % · ${r.noches} noches desde ${r.ingreso}`, quantity: 1, unit_price: monto, external_code: `SENA-${r.id.slice(0, 8)}` }], // máx. 30 caracteres (límite real de la API)
    config: {
      online: {
        success_url: `${base}/?reserva=${r.id}&pago=aprobado`,
        failure_url: `${base}/?reserva=${r.id}&pago=rechazado`,
        pending_url: `${base}/?reserva=${r.id}&pago=pendiente`,
        auto_return: 'approved'
      },
      // Sin efectivo (Rapipago / Pago Fácil): demoran días y no son compatibles con un bloqueo temporal.
      payment_method: { not_allowed_types: ['ticket', 'atm'], max_installments: 1 }
    }
  };
  let res;
  try {
    res = await mpFetch(env, '/v1/orders', { method: 'POST', body: orden, idempotencia: `orden-${r.id}` });
  } catch (e) {
    await env.DB.prepare("UPDATE reservas SET mp_order_id = NULL WHERE id = ? AND mp_order_id = 'creando'").bind(id).run();
    throw e;
  }
  const o = res.data || {};
  if (!res.ok || !o.id || !o.checkout_url) {
    await env.DB.batch([
      env.DB.prepare("UPDATE reservas SET mp_order_id = NULL WHERE id = ? AND mp_order_id = 'creando'").bind(id),
      evento(env, id, 'orden_error', {
        status: res.status,
        error: o.error || o.message || null,
        errores: Array.isArray(o.errors) ? o.errors.slice(0, 5).map(x => ({ code: x.code, message: String(x.message || '').slice(0, 200), details: x.details })) : null
      })
    ]);
    throw new ErrorUsuario('mp_error', 'No pudimos generar el pago en Mercado Pago. Probá de nuevo o escribinos por WhatsApp.', 502);
  }
  if (centavos(o.total_amount) !== r.sena * 100 || o.external_reference !== r.id) {
    await env.DB.batch([
      env.DB.prepare("UPDATE reservas SET mp_order_id = ?, revision_manual = 1 WHERE id = ?").bind(o.id, id),
      evento(env, id, 'orden_inconsistente', { order: o.id, total: o.total_amount })
    ]);
    throw new ErrorUsuario('mp_error', 'Mercado Pago devolvió datos inconsistentes. Escribinos por WhatsApp.', 502);
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE reservas SET estado = 'pendiente_pago', mp_order_id = ?, mp_checkout_url = ?, mp_estado = ?, mp_estado_detalle = ?,
      mp_consultada = ?, actualizada = ? WHERE id = ? AND mp_order_id = 'creando'`)
      .bind(o.id, o.checkout_url, o.status || 'created', o.status_detail || null, ahora(), ahora(), id),
    evento(env, id, 'orden_creada', { order: o.id, monto, modo: 'prueba' })
  ]);
  const nueva = await env.DB.prepare('SELECT * FROM reservas WHERE id = ?').bind(id).first();
  return json(respuestaOrden(nueva), 201, cors);
}

function respuestaOrden(r) {
  return { reserva_id: r.id, estado: r.estado, mp_order_id: r.mp_order_id, checkout_url: r.mp_checkout_url, sena: r.sena, vence_en: r.vence_en, modo: 'prueba', mensaje: MENSAJES_HUESPED[r.estado] };
}

/* ---------- 2) Webhook ---------- */

async function hmacHex(secreto, texto) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(texto));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function igualesTiempoConstante(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  return ea.length === eb.length && crypto.subtle.timingSafeEqual(ea, eb);
}

export async function validarFirma(env, xSignature, xRequestId, dataId) {
  const secreto = (env.MP_WEBHOOK_SECRET || '').trim();
  if (!secreto) return { ok: false, motivo: 'sin_secreto' };
  if (!xSignature) return { ok: false, motivo: 'sin_firma' };
  let ts = null, v1 = null;
  for (const parte of xSignature.split(',')) {
    const i = parte.indexOf('='); if (i < 0) continue;
    const k = parte.slice(0, i).trim().toLowerCase(), v = parte.slice(i + 1).trim();
    if (k === 'ts') ts = v; else if (k === 'v1') v1 = v;
  }
  if (!ts || !/^\d+$/.test(ts) || !v1) return { ok: false, motivo: 'firma_mal_formada' };
  // Mercado Pago indica que, si el data.id es alfanumérico (como los ids de order "ORD..."), se firma en minúsculas.
  // Se aceptan las dos variantes documentadas; todo lo demás (secreto, request-id, ts) debe coincidir exactamente.
  const variantes = [...new Set([dataId, (dataId || '').toLowerCase()])];
  let coincidio = null;
  for (const id of variantes) {
    const partes = [];
    if (id) partes.push(`id:${id}`);
    if (xRequestId) partes.push(`request-id:${xRequestId}`);
    partes.push(`ts:${ts}`);
    const esperado = await hmacHex(secreto, partes.join(';') + ';');
    if (igualesTiempoConstante(esperado, v1.toLowerCase())) { coincidio = id === dataId ? 'data_id_original' : 'data_id_minusculas'; break; }
  }
  if (!coincidio) return { ok: false, motivo: 'firma_no_coincide', detalle: { ts_segundos: ts.length <= 10, con_request_id: !!xRequestId, largo_v1: v1.length } };
  // Ventana amplia (24 h por defecto): un aviso reenviado no puede cambiar nada, porque siempre se consulta el estado real.
  const tol = Number(env.MP_FIRMA_TOLERANCIA_SEG || 86400);
  if (Math.abs(Date.now() / 1000 - Number(ts)) > tol) return { ok: false, motivo: 'firma_vencida' };
  return { ok: true, variante: coincidio };
}

async function recibirWebhook(req, env, ctx) {
  const url = new URL(req.url);
  const texto = await req.text();
  if (texto.length > 20000) return new Response(null, { status: 413 });
  let body = {}; try { body = JSON.parse(texto || '{}'); } catch { /* cuerpo inválido */ }
  const dataId = (url.searchParams.get('data.id') || (body.data && body.data.id) || '').toString().trim();
  const tipo = (url.searchParams.get('type') || body.type || url.searchParams.get('topic') || '').toString();
  const requestId = req.headers.get('x-request-id') || '';
  const firma = await validarFirma(env, req.headers.get('x-signature'), requestId, dataId);
  if (!firma.ok) {
    console.warn('Webhook de Mercado Pago rechazado', firma.motivo, requestId, JSON.stringify(firma.detalle || {}));
    return json({ error: 'firma_invalida' }, 401, {});
  }
  console.log('Webhook de Mercado Pago con firma válida', firma.variante, requestId, tipo);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(dataId)) return json({ error: 'id_invalido' }, 400, {});
  const fila = await env.DB.prepare('INSERT INTO avisos_mp (recibido, tipo, accion, data_id, request_id) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(ahora(), tipo, body.action || null, dataId, requestId).first();
  // Se responde enseguida (Mercado Pago espera 200 en menos de 22 s) y se procesa después.
  ctx.waitUntil(procesarAviso(env, fila.id));
  return new Response(null, { status: 200 });
}

async function procesarAviso(env, avisoId) {
  const a = await env.DB.prepare('SELECT * FROM avisos_mp WHERE id = ?').bind(avisoId).first();
  if (!a || a.procesado) return;
  try {
    let orderId = null;
    if (a.tipo === 'order' || /^ORD/i.test(a.data_id)) orderId = a.data_id;
    else if (a.tipo === 'payment') {
      // Aviso de pago: se busca la orden a través de la reserva (external_reference del pago).
      const p = await mpFetch(env, `/v1/payments/${encodeURIComponent(a.data_id)}`);
      if (p.ok && p.data && p.data.external_reference) {
        const r = await env.DB.prepare('SELECT mp_order_id FROM reservas WHERE id = ?').bind(p.data.external_reference).first();
        orderId = r && r.mp_order_id;
      }
    }
    const resultado = orderId ? await conciliarOrden(env, orderId) : 'sin_orden';
    await env.DB.prepare('UPDATE avisos_mp SET procesado = 1, procesado_en = ?, intentos = intentos + 1, error = ? WHERE id = ?')
      .bind(ahora(), resultado === 'ok' ? null : resultado, avisoId).run();
  } catch (e) {
    console.error('Error procesando aviso de Mercado Pago', avisoId, e && e.stack || e);
    await env.DB.prepare('UPDATE avisos_mp SET intentos = intentos + 1, error = ? WHERE id = ?').bind(String(e && e.message || e).slice(0, 300), avisoId).run();
  }
}

/* ---------- 3) Estado real de la orden ---------- */

async function conciliarOrden(env, orderId) {
  const res = await mpFetch(env, `/v1/orders/${encodeURIComponent(orderId)}`);
  if (res.status === 404) return 'orden_inexistente';
  if (!res.ok || !res.data) throw new Error(`Mercado Pago GET order HTTP ${res.status}`);
  const o = res.data;
  const r = await env.DB.prepare('SELECT * FROM reservas WHERE id = ?').bind(o.external_reference || '').first();
  if (!r) return 'sin_reserva';
  if (r.mp_order_id !== o.id) { await evento(env, r.id, 'orden_no_coincide', { recibida: o.id }).run(); return 'orden_no_coincide'; }
  return await aplicarEstado(env, r, o);
}

async function aplicarEstado(env, r, o, reintento = false) {
  const t = ahora();
  const pagos = (o.transactions && o.transactions.payments) || [];
  const acreditados = pagos.filter(p => p.status === 'processed' && (!p.status_detail || p.status_detail === 'accredited'));
  const stmts = [env.DB.prepare('UPDATE reservas SET mp_estado = ?, mp_estado_detalle = ?, mp_consultada = ?, actualizada = ? WHERE id = ?')
    .bind(o.status || null, o.status_detail || null, t, t, r.id)];
  // Cada pago se registra una sola vez (clave primaria = id del pago de Mercado Pago).
  for (const p of pagos) {
    if (!p.id) continue;
    stmts.push(env.DB.prepare(`INSERT INTO pagos (id, reserva_id, monto, estado, estado_detalle, medio, modo_prueba, recibido) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (id) DO UPDATE SET estado = excluded.estado, estado_detalle = excluded.estado_detalle`)
      .bind(String(p.id), r.id, Math.round(Number(p.paid_amount ?? p.amount ?? 0)), p.status || '', p.status_detail || null, (p.payment_method && p.payment_method.id) || null, t));
  }

  // Reservas ya resueltas: solo se actualiza el registro.
  if (ESTADOS_CERRADOS.includes(r.estado)) {
    if (o.status === 'refunded') stmts.push(evento(env, r.id, 'orden_reembolsada', { order: o.id }));
    await env.DB.batch(stmts); return 'ok';
  }

  const acreditada = o.status === 'processed' && (o.status_detail === 'accredited' || acreditados.length > 0);
  if (acreditada) return await registrarAcreditacion(env, r, o, acreditados, stmts);

  // Rechazo: la API real deja la orden en "action_required / waiting_retry" cuando el pago falló y espera un reintento.
  // Si todos los pagos fallaron, es un RECHAZO (no un pago en proceso): no se extiende la retención.
  const todosFallaron = pagos.length > 0 && pagos.every(p => p.status === 'failed');
  const rechazada = o.status === 'failed' || (o.status === 'action_required' && todosFallaron);
  const enProceso = !rechazada && (o.status === 'processing' || pagos.some(p => p.status === 'processing') || (o.status === 'action_required' && pagos.length > 0));
  if (enProceso) {
    // Pago pendiente o en revisión: se retienen las fechas mientras Mercado Pago lo siga informando así,
    // renovando de a 30 min en cada consulta, con tope de 48 h desde la creación (después, revisión manual).
    const tope = Date.parse(r.creada) + 48 * 3600e3;
    const nuevo = Math.min(Math.max(Date.parse(r.vence_en || t), Date.now() + 30 * 60e3), tope);
    const superado = Date.now() >= tope;
    stmts.push(env.DB.prepare("UPDATE reservas SET estado = 'pago_en_proceso', vence_en = ?, revision_manual = CASE WHEN ? THEN 1 ELSE revision_manual END WHERE id = ?")
      .bind(new Date(nuevo).toISOString(), superado ? 1 : 0, r.id));
    if (r.estado !== 'pago_en_proceso') stmts.push(evento(env, r.id, 'pago_en_proceso', { detalle: o.status_detail }));
    if (superado) stmts.push(evento(env, r.id, 'pago_en_proceso_supera_48h', { order: o.id }));
    await env.DB.batch(stmts); return 'ok';
  }

  const terminada = ['canceled', 'expired', 'refunded'].includes(o.status);
  // Margen antes de cancelar una orden vencida, por si Mercado Pago todavía está terminando un pago (60 s por defecto).
  const vencida = r.vence_en && Date.parse(r.vence_en) + Number(env.MP_GRACIA_SEG ?? 60) * 1000 < Date.now();
  if (terminada) {
    // Se consultó el estado real y no hay seña acreditada: recién ahora se liberan las fechas.
    stmts.push(env.DB.prepare(`UPDATE reservas SET estado = ? WHERE id = ?`).bind(o.status === 'refunded' ? 'cancelada' : 'vencida', r.id));
    stmts.push(env.DB.prepare('DELETE FROM noches WHERE reserva_id = ?').bind(r.id));
    stmts.push(evento(env, r.id, 'fechas_liberadas', { motivo: `orden_${o.status}` }));
    await env.DB.batch(stmts); return 'ok';
  }
  if (vencida && !reintento && (o.status === 'created' || o.status === 'failed' || o.status === 'action_required')) {
    // Venció el bloqueo y no hay pago acreditado ni en proceso: se cancela la orden en Mercado Pago antes de liberar.
    await env.DB.batch(stmts);
    const c = await mpFetch(env, `/v1/orders/${encodeURIComponent(o.id)}/cancel`, { method: 'POST', idempotencia: `cancelar-${o.id}` });
    const nueva = await mpFetch(env, `/v1/orders/${encodeURIComponent(o.id)}`); // estado real después del intento
    if (!nueva.ok || !nueva.data) throw new Error(`Mercado Pago GET order tras cancelar HTTP ${nueva.status} (cancel ${c.status})`);
    return await aplicarEstado(env, r, nueva.data, true);
  }
  if (rechazada) {
    // Vuelve a "pendiente de pago" con el vencimiento ORIGINAL de la orden (sin extensiones por un rechazo).
    stmts.push(env.DB.prepare("UPDATE reservas SET estado = 'pendiente_pago' WHERE id = ? AND estado <> 'pendiente_pago'").bind(r.id));
    const yaRegistrado = (await env.DB.prepare("SELECT COUNT(*) n FROM eventos WHERE reserva_id = ? AND tipo = 'pago_rechazado'").bind(r.id).first()).n > 0;
    if (!yaRegistrado || r.estado !== 'pendiente_pago') stmts.push(evento(env, r.id, 'pago_rechazado', { orden: o.status, detalle: o.status_detail, pago: (pagos[pagos.length - 1] || {}).status_detail || null }));
  }
  await env.DB.batch(stmts); return 'ok';
}

async function registrarAcreditacion(env, r, o, acreditados, stmts) {
  const pagadoC = acreditados.reduce((s, p) => s + centavos(p.paid_amount ?? p.amount ?? 0), 0) || centavos(o.total_paid_amount || 0);
  const pagoId = acreditados[0] && acreditados[0].id ? String(acreditados[0].id) : null;
  const moneda = o.currency || 'ARS';
  const problemas = [];
  if (moneda !== r.moneda) problemas.push('moneda_incorrecta');
  if (pagadoC !== r.sena * 100 || centavos(o.total_amount) !== r.sena * 100) problemas.push('importe_incorrecto');
  if (o.external_reference !== r.id) problemas.push('reserva_no_coincide');

  // ¿Las fechas siguen libres en Booking/Airbnb y reservas directas? (se revisa también con pagos en término)
  if (!problemas.length) {
    const casa = await datosCasa(env);
    const sync = await calendarioPublicado(env);
    const ext = new Set();
    for (const b of [...(casa.ocupadas || []), ...((sync && sync.ocupadas) || [])]) if (b && fechaValida(b.desde) && fechaValida(b.hasta)) for (const d of listaNoches(b.desde, b.hasta)) ext.add(d);
    if (listaNoches(r.ingreso, r.salida).some(d => ext.has(d))) problemas.push('fechas_ocupadas_en_otro_calendario');
  }

  const conflicto = async motivo => {
    stmts.push(env.DB.prepare("UPDATE reservas SET estado = 'conflicto', pagado = ?, saldo = total - ?, revision_manual = 1, vence_en = NULL WHERE id = ?")
      .bind(Math.round(pagadoC / 100), Math.round(pagadoC / 100), r.id));
    stmts.push(env.DB.prepare(`INSERT INTO devoluciones (reserva_id, mp_order_id, mp_pago_id, monto, motivo, creada) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (mp_order_id, motivo) DO NOTHING`).bind(r.id, o.id, pagoId, Math.round(pagadoC / 100), motivo, ahora()));
    stmts.push(evento(env, r.id, 'conflicto_requiere_devolucion', { motivo, order: o.id }));
    await env.DB.batch(stmts); return 'ok';
  };
  if (problemas.length) return await conflicto(problemas.join(','));

  const verificado = env.DB.prepare(`UPDATE reservas SET estado = 'pago_verificado', pagado = sena, saldo = total - sena, vence_en = NULL,
    revision_manual = 1 WHERE id = ? AND estado NOT IN ('pago_verificado', 'confirmada', 'conflicto', 'cancelada')`).bind(r.id);
  const ok = evento(env, r.id, 'pago_acreditado_verificado', { order: o.id, pago: pagoId, monto: r.sena, confirmacion: 'manual' });
  const { results } = await env.DB.prepare('SELECT COUNT(*) n FROM noches WHERE reserva_id = ?').bind(r.id).all();
  if (results[0].n === r.noches) { await env.DB.batch([...stmts, verificado, ok]); return 'ok'; }

  // Pago tardío: el bloqueo ya había vencido. Se intenta volver a tomar las noches en una sola transacción.
  try {
    await env.DB.batch([...stmts, ...listaNoches(r.ingreso, r.salida).map(f => env.DB.prepare('INSERT INTO noches (fecha, reserva_id) VALUES (?, ?)').bind(f, r.id)),
      verificado, ok, evento(env, r.id, 'pago_tardio_fechas_recuperadas', { order: o.id })]);
    return 'ok';
  } catch (e) {
    if (!/UNIQUE|PRIMARY KEY|constraint/i.test(String(e && e.message || e))) throw e;
    return await conflicto('pago_tardio_fechas_tomadas');
  }
}

/* ---------- 4) Tarea programada: reintentos y conciliación ---------- */

async function tareaProgramada(env) {
  const tareas = [['vencer', () => vencerBloqueos(env)], ['avisos', () => reintentarAvisos(env)], ['conciliar', () => conciliarOrdenes(env)]];
  for (const [nombre, f] of tareas) {
    try { await f(); } catch (e) { console.error('Tarea programada falló:', nombre, e && e.stack || e); }
  }
}

async function reintentarAvisos(env) {
  if (!env.MP_ACCESS_TOKEN) return;
  const desde = new Date(Date.now() - 3 * 864e5).toISOString();
  const { results } = await env.DB.prepare('SELECT id FROM avisos_mp WHERE procesado = 0 AND intentos < 8 AND recibido > ? ORDER BY id LIMIT 25').bind(desde).all();
  for (const { id } of results) await procesarAviso(env, id);
}

async function conciliarOrdenes(env) {
  if (!env.MP_ACCESS_TOKEN) return;
  const t = ahora(), hace10 = new Date(Date.now() - 10 * 60e3).toISOString();
  const { results } = await env.DB.prepare(`SELECT id, mp_order_id FROM reservas
    WHERE estado IN ('pendiente_pago', 'pago_en_proceso') AND mp_order_id IS NOT NULL AND mp_order_id <> 'creando'
      AND (vence_en < ? OR mp_consultada IS NULL OR mp_consultada < ?) ORDER BY vence_en LIMIT 25`).bind(t, hace10).all();
  for (const r of results) {
    try { await conciliarOrden(env, r.mp_order_id); }
    catch (e) { console.error('Conciliación falló', r.id, e && e.message || e); }
  }
}

// Diagnóstico (solo con la clave de pruebas): qué tipo de cuenta es la del token. Nunca devuelve el token ni datos personales.
async function diagnosticoCuenta(req, env, cors) {
  if (!(await claveDePruebaValida(req, env))) return json({ error: 'no_encontrado' }, 404, cors);
  if (!env.MP_ACCESS_TOKEN) return json({ token_cargado: false }, 200, cors);
  const r = await mpFetch(env, '/users/me');
  const d = r.data || {};
  return json({
    token_cargado: true,
    respuesta_mp: r.status,
    es_cuenta_de_prueba: Array.isArray(d.tags) && d.tags.includes('test_user'),
    etiquetas: d.tags || null,
    pais: d.site_id || null,
    apodo_empieza_con_TEST: typeof d.nickname === 'string' ? /^TEST/i.test(d.nickname) : null,
    tipo_usuario: d.user_type || null,
    error_mp: r.ok ? null : (d.message || d.error || null)
  }, 200, cors);
}

/* ---------- 5) Detalle para pruebas (solo con la clave de pruebas; sin datos personales) ---------- */

async function detallePrueba(id, req, env, cors) {
  if (!(await claveDePruebaValida(req, env))) return json({ error: 'no_encontrado' }, 404, cors);
  const r = await env.DB.prepare(`SELECT id, estado, ingreso, salida, noches, total, sena, saldo, pagado, vence_en, mp_order_id, mp_estado,
    mp_estado_detalle, revision_manual, origen FROM reservas WHERE id = ?`).bind(id).first();
  if (!r) return json({ error: 'no_encontrado' }, 404, cors);
  const [pagos, devs, evs, noches] = await Promise.all([
    env.DB.prepare('SELECT id, monto, estado, estado_detalle FROM pagos WHERE reserva_id = ?').bind(id).all(),
    env.DB.prepare('SELECT monto, motivo, estado FROM devoluciones WHERE reserva_id = ?').bind(id).all(),
    env.DB.prepare('SELECT tipo FROM eventos WHERE reserva_id = ? ORDER BY id').bind(id).all(),
    env.DB.prepare('SELECT COUNT(*) n FROM noches WHERE reserva_id = ?').bind(id).all()
  ]);
  return json({ ...r, noches_retenidas: noches.results[0].n, pagos: pagos.results, devoluciones: devs.results, eventos: evs.results.map(e => e.tipo) }, 200, cors);
}

export const _internos = { precioPorNoche, listaNoches, nochesEntre, fechaValida };
