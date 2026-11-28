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

  FASE 1 · RESERVA AUTOMÁTICA (ver automatico.js y disponibilidad.js):
  - Reserva instantánea con seña (Mercado Pago o transferencia), enlace privado del huésped, confirmación automática
    SEGURA (solo con un gestor de canales que cierre Booking y Airbnb de verdad; nunca con iCal) y excepciones.

  Los datos personales se guardan solo en la base D1 privada. Ninguna respuesta pública los devuelve.
*/
import { PANEL_HTML } from './panel-html.js';
import { iniciarReserva, miReserva, pagarMiReserva, intentarConfirmacion, procesarGestor, webhookGestor, apiAdminReservas, modoReserva, avisarConflictoPago } from './automatico.js';

const MAX_NOCHES = 30;
const MAX_MESES_ADELANTE = 18;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/api/salud' && req.method === 'GET') return json({ ...estadoServicio(env), modo_reserva: modoReserva(env, await claveDePruebaValida(req, env)) }, 200, cors);
      // Reserva automática: iniciar, enlace privado del huésped, pagar, avisos del gestor de canales.
      if (url.pathname === '/api/reservas' && req.method === 'POST') return await iniciarReserva(req, env, ctx, cors);
      if (url.pathname === '/api/mi-reserva' && req.method === 'GET') return await miReserva(req, env, cors);
      if (url.pathname === '/api/mi-reserva/pagar' && req.method === 'POST') return await pagarMiReserva(req, env, cors);
      const wg = url.pathname.match(/^\/api\/webhooks\/gestor\/([A-Za-z0-9_-]{1,100})$/);
      if (wg && req.method === 'POST') return await webhookGestor(req, env, wg[1]);
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
      if (url.pathname === '/api/solicitudes' && req.method === 'POST') {
        if (!(await claveDePruebaValida(req, env))) await limitar(env.LIMITE_BLOQUEOS, req); // 5 por minuto por persona
        return await crearSolicitud(req, env, ctx, cors);
      }
      // El panel NO vive en este Worker público: está en el Worker "panel-casacampo", protegido entero por Cloudflare Access.
      const cal = url.pathname.match(/^\/calendario-(booking|airbnb|vrbo|todas)\.ics$/);
      if (cal && req.method === 'GET') return await calendarioExportado(env, cal[1]);
      if (url.pathname === '/api/pruebas/mp-cuenta' && req.method === 'GET') return await diagnosticoCuenta(req, env, cors);
      if (url.pathname === '/api/pruebas/huella-clave' && req.method === 'GET') return json(await huellaClavePruebas(env), 200, cors);
      const mp = url.pathname.match(/^\/api\/pruebas\/reservas\/([0-9a-f-]{36}|CC-\d{6}-[A-Z0-9]{4})$/);
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
  const h = { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, idempotency-key, x-clave-pruebas, x-acceso', 'access-control-max-age': '86400', 'vary': 'origin' };
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
// Las noches de reservas de PRUEBA se guardan con prefijo "P:": entre pruebas se siguen excluyendo, pero nunca
// chocan con una reserva real ni aparecen en los calendarios exportados.
function claveNoche(fecha, origen) { return origen === 'prueba' ? 'P:' + fecha : fecha; }

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
  const claves = incluirPruebas ? [...noches, ...noches.map(f => 'P:' + f)] : noches;
  const ph = claves.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT n.fecha FROM noches n WHERE n.fecha IN (${ph})`).bind(...claves).all();
  const ocupadasDB = new Set(results.map(r => r.fecha.replace(/^P:/, '')));
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

// Diagnóstico TEMPORAL de la clave de pruebas: solo longitud, caracteres invisibles y los primeros 10 caracteres de su
// SHA-256 (no permiten reconstruirla). Sirve para comparar con la huella que calcula el navegador, sin mostrar la clave.
async function huellaClavePruebas(env) {
  const crudo = env.CLAVE_PRUEBAS == null ? null : String(env.CLAVE_PRUEBAS);
  if (crudo === null) return { configurada: false };
  const limpia = crudo.trim();
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(limpia)))].map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    configurada: true, largo: crudo.length, largo_util: limpia.length, minimo_requerido: 32,
    bom: crudo.includes('﻿'), espacios_o_saltos: crudo !== limpia, empieza_con_prueba: limpia.startsWith('prueba-'),
    huella_sha256: limpia.length ? h.slice(0, 10) : null
  };
}

// Si dos pedidos con la MISMA clave de idempotencia llegan a la vez, el segundo puede ver las noches ya tomadas por el
// primero antes de que su registro sea visible: se espera un instante y se devuelve la misma reserva en lugar de "ocupado".
async function esperarIdempotencia(env, clave) {
  for (let i = 0; i < 4; i++) {
    const r = await env.DB.prepare('SELECT reserva_id FROM idempotencia WHERE clave = ?').bind(clave).first();
    if (r) return r.reserva_id;
    await new Promise(ok => setTimeout(ok, 250));
  }
  return null;
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
  if (!disp.disponible) {
    const misma = await esperarIdempotencia(env, clave); // ¿la "ocupó" la misma solicitud enviada dos veces a la vez?
    if (misma) return await verReserva(misma, env, cors, 200);
    throw new ErrorUsuario('no_disponible', 'Esas fechas ya no están disponibles. Elegí otras o escribinos por WhatsApp.', 409);
  }

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
    ...noches.map(f => env.DB.prepare('INSERT INTO noches (fecha, reserva_id) VALUES (?, ?)').bind(claveNoche(f, origen), id)),
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
    stmts.push(env.DB.prepare("UPDATE solicitudes SET estado = 'vencida', actualizada = ? WHERE reserva_id = ? AND estado = 'aprobada'").bind(t, id));
    stmts.push(env.DB.prepare(`UPDATE reservas SET estado = 'vencida', actualizada = ?,
      cm_estado = CASE cm_estado WHEN 'retenida' THEN 'liberacion_pendiente' ELSE cm_estado END WHERE id = ? AND estado IN ('bloqueo', 'pendiente_pago')`).bind(t, id));
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
  const { fila: f, creada } = await generarOrden(env, id);
  return json(respuestaOrden(f), creada ? 201 : 200, cors);
}

// Crea (una sola vez) la orden de seña de una reserva retenida. La orden vence ORDEN_MARGEN_MIN minutos antes que la
// retención, así un pago tardío siempre llega mientras las fechas siguen siendo nuestras (y si no, es una excepción).
async function generarOrden(env, id) {
  const r = await env.DB.prepare('SELECT * FROM reservas WHERE id = ?').bind(id).first();
  if (!r) throw new ErrorUsuario('no_encontrado', 'Reserva inexistente.', 404);
  if (r.estado === 'pendiente_pago' && r.mp_checkout_url) return { fila: r, creada: false }; // repetida: misma orden
  if (r.estado !== 'bloqueo') throw new ErrorUsuario('estado_invalido', 'Esta reserva no admite un pago nuevo.', 409);
  if (r.medio_pago === 'transferencia') throw new ErrorUsuario('estado_invalido', 'Esta reserva se paga por transferencia.', 409);
  const restante = (Date.parse(r.vence_en) - Date.now()) / 1000;
  if (!(restante >= Number(env.ORDEN_MIN_SEGUNDOS || 120))) throw new ErrorUsuario('bloqueo_por_vencer', 'El tiempo para pagar está por vencer. Volvé a elegir las fechas.', 409);

  // Reclamo atómico: solo una solicitud puede crear la orden de esta reserva.
  const t = ahora();
  const claim = await env.DB.prepare("UPDATE reservas SET mp_order_id = 'creando', actualizada = ? WHERE id = ? AND estado = 'bloqueo' AND mp_order_id IS NULL").bind(t, id).run();
  if (!claim.meta.changes) {
    const otra = await env.DB.prepare('SELECT * FROM reservas WHERE id = ?').bind(id).first();
    if (otra && otra.mp_checkout_url) return { fila: otra, creada: false };
    throw new ErrorUsuario('orden_en_curso', 'El pago ya se está generando. Esperá unos segundos.', 409);
  }

  const base = env.SITE_URL.replace(/\/$/, '');
  const monto = montoTexto(r.sena);
  const vuelta = r.numero ? `${base}/reserva.html?n=${encodeURIComponent(r.numero)}&pago=` : `${base}/?reserva=${r.id}&pago=`;
  const orden = {
    type: 'online',
    processing_mode: 'manual',
    total_amount: monto,
    external_reference: r.id,
    expiration_time: `PT${Math.max(1, Math.floor(restante / 60) - Number(env.ORDEN_MARGEN_MIN ?? 5))}M`, // vence ANTES que la retención
    description: 'Seña 50 % · Casa Campo Las Maravillas',
    items: [{ title: `Seña 50 % · ${r.noches} noches desde ${r.ingreso}`, quantity: 1, unit_price: monto, external_code: `SENA-${r.id.slice(0, 8)}` }], // máx. 30 caracteres (límite real de la API)
    config: {
      online: {
        success_url: vuelta + 'aprobado',
        failure_url: vuelta + 'rechazado',
        pending_url: vuelta + 'pendiente',
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
  return { fila: nueva, creada: true };
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

  // Margen antes de cancelar una orden vencida, por si Mercado Pago todavía está terminando un pago (60 s por defecto).
  const vencida = r.vence_en && Date.parse(r.vence_en) + Number(env.MP_GRACIA_SEG ?? 60) * 1000 < Date.now();
  // Terminal: cancelada / vencida / reembolsada; también "failed/expired" (la API real deja así una orden rechazada que venció),
  // o una orden vencida que, después del intento de cancelación, sigue sin pago acreditado ni en proceso.
  const terminada = ['canceled', 'expired', 'refunded'].includes(o.status)
    || (o.status === 'failed' && o.status_detail === 'expired')
    || (reintento && vencida && !enProceso);
  if (terminada) {
    // Se consultó el estado real y no hay seña acreditada: recién ahora se liberan las fechas.
    stmts.push(env.DB.prepare(`UPDATE reservas SET estado = ?, cm_estado = CASE cm_estado WHEN 'retenida' THEN 'liberacion_pendiente' ELSE cm_estado END WHERE id = ?`)
      .bind(o.status === 'refunded' ? 'cancelada' : 'vencida', r.id));
    stmts.push(env.DB.prepare("UPDATE solicitudes SET estado = 'vencida', actualizada = ? WHERE reserva_id = ? AND estado = 'aprobada'").bind(t, r.id));
    stmts.push(env.DB.prepare('DELETE FROM noches WHERE reserva_id = ?').bind(r.id));
    if (r.estado !== 'vencida' && r.estado !== 'cancelada') stmts.push(evento(env, r.id, 'fechas_liberadas', { motivo: `orden_${o.status}${o.status_detail ? '_' + o.status_detail : ''}` }));
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
    await env.DB.batch(stmts);
    try { await avisarConflictoPago(env, r.id, motivo); } catch (e) { console.warn('Aviso de conflicto falló', e && e.message); }
    return 'ok';
  };
  if (problemas.length) return await conflicto(problemas.join(','));

  const verificado = env.DB.prepare(`UPDATE reservas SET estado = 'pago_verificado', pagado = sena, saldo = total - sena, vence_en = NULL,
    revision_manual = 1 WHERE id = ? AND estado NOT IN ('pago_verificado', 'confirmada', 'conflicto', 'cancelada')`).bind(r.id);
  const ok = evento(env, r.id, 'pago_acreditado_verificado', { order: o.id, pago: pagoId, monto: r.sena, confirmacion: 'manual' });
  const { results } = await env.DB.prepare('SELECT COUNT(*) n FROM noches WHERE reserva_id = ?').bind(r.id).all();
  if (results[0].n === r.noches) { await env.DB.batch([...stmts, verificado, ok]); await confirmarSiCorresponde(env, r.id); return 'ok'; }

  // Pago tardío: el bloqueo ya había vencido. Se intenta volver a tomar las noches en una sola transacción.
  try {
    await env.DB.batch([...stmts, ...listaNoches(r.ingreso, r.salida).map(f => env.DB.prepare('INSERT INTO noches (fecha, reserva_id) VALUES (?, ?)').bind(claveNoche(f, r.origen), r.id)),
      verificado, ok, evento(env, r.id, 'pago_tardio_fechas_recuperadas', { order: o.id })]);
    await confirmarSiCorresponde(env, r.id);
    return 'ok';
  } catch (e) {
    if (!/UNIQUE|PRIMARY KEY|constraint/i.test(String(e && e.message || e))) throw e;
    return await conflicto('pago_tardio_fechas_tomadas');
  }
}

// Seña verificada → intento de confirmación automática segura (o excepción con aviso). Nunca rompe el procesamiento del pago.
async function confirmarSiCorresponde(env, id) {
  try { await intentarConfirmacion(env, id); }
  catch (e) {
    console.error('Confirmación automática falló', id, e && e.stack || e);
    await env.DB.batch([env.DB.prepare("UPDATE reservas SET revision_manual = 1, excepcion = 'error_confirmacion' WHERE id = ?").bind(id),
      evento(env, id, 'excepcion', { motivo: 'error_confirmacion', error: String(e && e.message || e).slice(0, 200) })]);
  }
}

/* ---------- 4) Tarea programada: reintentos y conciliación ---------- */

async function tareaProgramada(env) {
  const tareas = [['vencer', () => vencerBloqueos(env)], ['avisos', () => reintentarAvisos(env)], ['conciliar', () => conciliarOrdenes(env)],
    ['notificaciones', () => reintentarNotificaciones(env)], ['gestor', () => procesarGestor(env)]];
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
  const r = await env.DB.prepare(`SELECT id, numero, estado, ingreso, salida, noches, total, sena, saldo, pagado, vence_en, mp_order_id, mp_estado,
    mp_estado_detalle, revision_manual, origen, modo, medio_pago, cm_proveedor, cm_ref, cm_estado, cm_intentos, excepcion, confirmada_por
    FROM reservas WHERE id = ? OR numero = ?`).bind(id, id).first();
  if (!r) return json({ error: 'no_encontrado' }, 404, cors);
  id = r.id; // se pudo buscar por número
  const [pagos, devs, evs, noches] = await Promise.all([
    env.DB.prepare('SELECT id, monto, estado, estado_detalle FROM pagos WHERE reserva_id = ?').bind(id).all(),
    env.DB.prepare('SELECT monto, motivo, estado FROM devoluciones WHERE reserva_id = ?').bind(id).all(),
    env.DB.prepare('SELECT tipo FROM eventos WHERE reserva_id = ? ORDER BY id').bind(id).all(),
    env.DB.prepare('SELECT COUNT(*) n FROM noches WHERE reserva_id = ?').bind(id).all()
  ]);
  return json({ ...r, noches_retenidas: noches.results[0].n, pagos: pagos.results, devoluciones: devs.results, eventos: evs.results.map(e => e.tipo) }, 200, cors);
}

/* =====================================================================
   ETAPA 1 · SOLICITUDES DE RESERVA (sin pagos)
   - El huésped envía una solicitud (con Turnstile). NO se retienen fechas.
   - Los dueños reciben un aviso (Telegram) y aprueban o rechazan desde el panel privado.
   - Al aprobar, recién ahí se retienen las fechas, con vencimiento controlado (RETENCION_HORAS).
   - Preparado para que, más adelante, al aprobar se genere y envíe el link de pago (ENVIO_LINK_AUTOMATICO).
   ===================================================================== */

const LETRAS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function numeroSolicitud(ingreso) {
  const r = crypto.getRandomValues(new Uint8Array(4));
  return `CC-${ingreso.slice(2, 4)}${ingreso.slice(5, 7)}${ingreso.slice(8, 10)}-${[...r].map(b => LETRAS[b % LETRAS.length]).join('')}`;
}

async function verificarTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return { ok: false, motivo: 'turnstile_sin_configurar' };
  if (!token || typeof token !== 'string' || token.length > 2048) return { ok: false, motivo: 'sin_token' };
  const fd = new FormData();
  fd.append('secret', env.TURNSTILE_SECRET);
  fd.append('response', token);
  if (ip) fd.append('remoteip', ip);
  try {
    const r = await fetch((env.TURNSTILE_API_BASE || 'https://challenges.cloudflare.com') + '/turnstile/v0/siteverify', { method: 'POST', body: fd });
    const d = await r.json();
    if (!d.success) {
      // Solo el código de error de Cloudflare (p. ej. invalid-input-secret = secreto mal cargado). Nunca el secreto ni el token.
      console.warn('Turnstile rechazó la verificación:', (d['error-codes'] || []).join(',') || 'sin código');
      return { ok: false, motivo: (d['error-codes'] || []).join(',') || 'rechazado' };
    }
    const hosts = (env.TURNSTILE_HOSTNAMES || '').split(',').map(s => s.trim()).filter(Boolean);
    if (hosts.length && d.hostname && !hosts.includes(d.hostname)) { console.warn('Turnstile: hostname no permitido', d.hostname); return { ok: false, motivo: 'hostname_no_permitido' }; }
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: 'turnstile_sin_respuesta' };
  }
}

async function crearSolicitud(req, env, ctx, cors) {
  const esPrueba = await claveDePruebaValida(req, env);
  // Cerrado al público mientras SOLICITUDES_HABILITADAS no sea "true" (la clave de pruebas permite probarlo).
  if (env.SOLICITUDES_HABILITADAS !== 'true' && !esPrueba) throw new ErrorUsuario('no_habilitado', 'Por ahora las solicitudes se reciben por WhatsApp.', 403);
  const body = await leerJson(req);
  const ts = await verificarTurnstile(env, body.turnstile, req.headers.get('cf-connecting-ip'));
  if (!ts.ok) throw new ErrorUsuario('verificacion_fallida', 'No pudimos verificar que no seas un robot. Probá de nuevo o escribinos por WhatsApp.', 403);
  const casa = await datosCasa(env);
  const e = validarEstadia(body, casa);
  const c = validarContacto(body);
  const precio = calcularPrecio(casa, e);
  const disp = await revisarDisponibilidad(env, casa, e, { incluirPruebas: false });
  if (!disp.disponible) throw new ErrorUsuario('no_disponible', 'Esas fechas no están disponibles. Elegí otras o escribinos por WhatsApp.', 409);

  // Evita duplicados: misma persona, mismas fechas, en los últimos 30 minutos → devuelve la misma solicitud.
  const hace30 = new Date(Date.now() - 30 * 60e3).toISOString();
  const dup = await env.DB.prepare(`SELECT numero FROM solicitudes WHERE telefono = ? AND ingreso = ? AND salida = ? AND estado = 'nueva' AND creada > ?`)
    .bind(c.telefono, e.ingreso, e.salida, hace30).first();
  if (dup) return json({ numero: dup.numero, estado: 'nueva', repetida: true, mensaje: MENSAJE_SOLICITUD }, 200, cors);

  const id = crypto.randomUUID(), t = ahora();
  let numero = null;
  for (let i = 0; i < 4 && !numero; i++) {
    const n = numeroSolicitud(e.ingreso);
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO solicitudes (id, numero, creada, actualizada, estado, ingreso, salida, noches, adultos, menores, huespedes,
          precio_noche, total, sena, saldo, nombre, telefono, email, observaciones, disponible_al_solicitar, origen)
          VALUES (?, ?, ?, ?, 'nueva', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
          .bind(id, n, t, t, e.ingreso, e.salida, e.noches, e.adultos, e.menores, e.huespedes, precio.precio_noche, precio.total, precio.sena, precio.saldo,
            c.nombre, c.telefono, c.email, c.observaciones, esPrueba ? 'prueba' : 'web'),
        env.DB.prepare('INSERT INTO eventos (reserva_id, fecha, tipo, detalle) VALUES (?, ?, ?, ?)').bind(null, t, 'solicitud_creada', JSON.stringify({ numero: n }))
      ]);
      numero = n;
    } catch (err) {
      if (!/UNIQUE/i.test(String(err && err.message || err))) throw err; // número repetido: se genera otro
    }
  }
  if (!numero) throw new Error('No se pudo generar un número de solicitud único');
  ctx.waitUntil(notificarSolicitud(env, id));
  ctx.waitUntil(notificarHuesped(env, 'solicitud_recibida', { numero, telefono: c.telefono }));
  return json({ numero, estado: 'nueva', ...precio, ingreso: e.ingreso, salida: e.salida, noches: e.noches, huespedes: e.huespedes, mensaje: MENSAJE_SOLICITUD }, 201, cors);
}
const MENSAJE_SOLICITUD = 'Recibimos tu solicitud. Las fechas todavía no están reservadas: los dueños revisan la disponibilidad y te responden por WhatsApp.';

/* ---------- Notificaciones ----------
   Dos destinatarios, canales independientes:
   - DUEÑOS (interno): Telegram. El panel privado sigue siendo la fuente principal de información.
   - HUÉSPED (externo): preparado para WhatsApp oficial (Cloud API de Meta) en el futuro. Hoy APAGADO:
     CANAL_HUESPED = "ninguno". Cuando se active ("whatsapp"), cada evento usará una plantilla aprobada por Meta
     (WHATSAPP_PHONE_ID + secreto WHATSAPP_TOKEN). Eventos previstos:
       solicitud_recibida · solicitud_aprobada (con link de pago) · solicitud_rechazada · pago_recibido ·
       reserva_confirmada · info_estadia
*/
export const EVENTOS_HUESPED = ['solicitud_recibida', 'solicitud_aprobada', 'solicitud_rechazada', 'pago_recibido', 'reserva_confirmada', 'info_estadia',
  'reserva_iniciada', 'transferencia_pendiente'];
// Hoy el canal del huésped es su ENLACE PRIVADO (reserva.html): ahí ve estado, pago y comprobante sin que nadie le escriba.
// Preparado para sumar correo ("correo", con un proveedor transaccional) o WhatsApp oficial ("whatsapp") sin cambiar los eventos.
async function notificarHuesped(env, evento, datos) {
  if (!EVENTOS_HUESPED.includes(evento)) return { enviado: false, motivo: 'evento_desconocido' };
  const canal = env.CANAL_HUESPED || 'ninguno';
  if (canal === 'ninguno') return { enviado: false, motivo: 'canal_huesped_desactivado' };
  if (canal === 'correo') return { enviado: false, motivo: 'correo_no_implementado' }; // futuro: proveedor de correo transaccional
  if (canal === 'whatsapp') {
    // Futuro: POST https://graph.facebook.com/<versión>/<WHATSAPP_PHONE_ID>/messages con una plantilla aprobada.
    // No se implementa todavía (requiere número propio de la casa, plantillas aprobadas y aceptación del huésped).
    return { enviado: false, motivo: 'whatsapp_no_implementado' };
  }
  return { enviado: false, motivo: 'canal_desconocido' };
}

/* ---------- Notificaciones a los dueños (Telegram) ---------- */

const fmtFecha = s => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const fmtPesos = n => '$' + Number(n).toLocaleString('es-AR');

async function enviarTelegram(env, texto) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, motivo: 'sin_configurar' };
  const r = await fetch(`${(env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: texto, disable_web_page_preview: true })
  });
  if (r.ok) return { ok: true, motivo: null };
  // Telegram explica el problema ("Unauthorized", "chat not found"...). Nunca se devuelve el token.
  const d = await r.json().catch(() => ({}));
  return { ok: false, motivo: `HTTP ${r.status}${d.description ? ' · ' + String(d.description).slice(0, 120) : ''}` };
}

async function avisoTelegramPrueba(env, quien) {
  const faltan = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter(n => !String(env[n] || '').trim());
  if (faltan.length) return { ok: false, motivo: `Falta o está vacío en este Worker: ${faltan.join(' y ')}.` };
  const hora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  const r = await enviarTelegram(env, `✅ Aviso de prueba del panel de Casa Campo Las Maravillas.\nEnviado por ${quien} el ${hora}.\nAsí van a llegar las nuevas solicitudes de reserva.`);
  return r.ok ? { ok: true } : { ok: false, motivo: 'Telegram respondió: ' + r.motivo };
}

async function notificarSolicitud(env, id) {
  try {
    const s = await env.DB.prepare('SELECT * FROM solicitudes WHERE id = ?').bind(id).first();
    if (!s || s.aviso_enviado) return;
    const panel = (env.PANEL_URL || '').trim();
    const texto = [
      s.origen === 'prueba' ? `🧪 PRUEBA · Nueva solicitud ${s.numero} (no es un huésped real)` : `🏡 Nueva solicitud ${s.numero}`,
      `${fmtFecha(s.ingreso)} → ${fmtFecha(s.salida)} · ${s.noches} noches · ${s.huespedes} huéspedes`,
      `Total ${fmtPesos(s.total)} · seña ${fmtPesos(s.sena)}`,
      `${s.nombre} · ${s.telefono}${s.email ? ' · ' + s.email : ''}`,
      s.observaciones ? `Nota: ${s.observaciones}` : null,
      'Revisá Booking y Airbnb y aprobá o rechazá desde el panel.',
      panel || null
    ].filter(Boolean).join('\n');
    const r = await enviarTelegram(env, texto);
    if (r.ok) await env.DB.prepare('UPDATE solicitudes SET aviso_enviado = 1 WHERE id = ?').bind(id).run();
    else console.warn('Aviso de solicitud no enviado', s.numero, r.motivo);
  } catch (e) {
    console.error('Error al notificar solicitud', id, e && e.message || e);
  }
}

async function reintentarNotificaciones(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const desde = new Date(Date.now() - 864e5).toISOString();
  const { results } = await env.DB.prepare("SELECT id FROM solicitudes WHERE aviso_enviado = 0 AND estado = 'nueva' AND creada > ? LIMIT 20").bind(desde).all();
  for (const { id } of results) await notificarSolicitud(env, id);
}

/* ---------- Acceso al panel privado ---------- */

// Producción: Cloudflare Access protege TODO el Worker del panel, y además acá se verifica el JWT de Access
// (encabezado Cf-Access-Jwt-Assertion: firma RS256 con las claves públicas del equipo, iss, aud, exp y nbf).
// Solo en desarrollo local (PERMITIR_CLAVE_ADMIN = "true"): clave de administración en el encabezado x-admin-clave.
let jwksCache = null;
export async function usuarioAdmin(req, env) {
  const jwt = req.headers.get('cf-access-jwt-assertion');
  if (jwt && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    try {
      const [h, p, s] = jwt.split('.');
      const dec = x => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
      const head = dec(h), pay = dec(p);
      if (head.alg !== 'RS256') return null;
      const equipo = `https://${env.ACCESS_TEAM_DOMAIN.replace(/^https:\/\//, '').replace(/\/$/, '')}`;
      if (pay.iss !== equipo) return null;
      if (!(Array.isArray(pay.aud) ? pay.aud : [pay.aud]).includes(env.ACCESS_AUD)) return null;
      const ahoraS = Date.now() / 1000;
      if (!pay.exp || pay.exp < ahoraS) return null;
      if (pay.nbf && pay.nbf > ahoraS + 60) return null;
      if (!jwksCache || jwksCache.vence < Date.now()) {
        const r = await fetch(env.ACCESS_CERTS_URL || `${equipo}/cdn-cgi/access/certs`); // ACCESS_CERTS_URL: solo para pruebas locales
        jwksCache = { claves: (await r.json()).keys || [], vence: Date.now() + 3600e3 };
      }
      const jwk = jwksCache.claves.find(k => k.kid === head.kid);
      if (!jwk) return null;
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const firma = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, firma, new TextEncoder().encode(`${h}.${p}`));
      return ok ? (pay.email || 'access') : null;
    } catch { return null; }
  }
  if (env.PERMITIR_CLAVE_ADMIN !== 'true') return null; // en producción, solo Access
  const clave = (req.headers.get('x-admin-clave') || '').trim(), esperada = (env.ADMIN_CLAVE || '').trim();
  if (esperada.length >= 32 && clave.length === esperada.length && igualesTiempoConstante(clave, esperada)) return 'admin-clave';
  return null;
}

/* ---------- Calendario exportado a Booking / Airbnb (desde el Worker, al momento) ----------
   Incluye: fechas de las otras plataformas (copia sincronizada), reservas directas de casa.json y TODAS las noches
   retenidas en nuestra base (aprobadas, pendientes de pago, pagadas, confirmadas, en conflicto), salvo las de prueba.
   A cada plataforma no se le devuelve lo que vino de ella. Solo fechas: nunca nombres ni datos. */
function unirBloques(bloques) {
  const ord = [...bloques].sort((a, b) => a.desde.localeCompare(b.desde)), out = [];
  for (const b of ord) { const u = out[out.length - 1]; if (u && b.desde <= u.hasta) { if (b.hasta > u.hasta) u.hasta = b.hasta; } else out.push({ desde: b.desde, hasta: b.hasta }); }
  return out;
}
async function bloquesPropios(env) {
  const { results } = await env.DB.prepare(`SELECT r.ingreso desde, r.salida hasta FROM reservas r
    WHERE r.origen <> 'prueba' AND EXISTS (SELECT 1 FROM noches n WHERE n.reserva_id = r.id)`).all();
  return results.map(r => ({ ...r, fuente: 'web' }));
}
async function calendarioExportado(env, plataforma) {
  const [casa, sync, propios] = await Promise.all([datosCasa(env), calendarioPublicado(env), bloquesPropios(env)]);
  const hoy = hoyAR();
  const externos = ((sync && sync.ocupadas) || []).filter(b => fechaValida(b.desde) && fechaValida(b.hasta));
  const directas = (casa.ocupadas || []).filter(b => b && fechaValida(b.desde) && fechaValida(b.hasta)).map(b => ({ desde: b.desde, hasta: b.hasta, fuente: 'directa' }));
  const todas = [...directas, ...propios, ...externos].filter(b => b.hasta > hoy && b.hasta > b.desde);
  const propiasDe = todas.filter(b => b.fuente === plataforma);
  const elegidas = plataforma === 'todas' ? todas
    : todas.filter(b => b.fuente !== plataforma && !propiasDe.some(a => a.desde <= b.desde && b.hasta <= a.hasta));
  const sello = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ev = unirBloques(elegidas).map(b => ['BEGIN:VEVENT', `UID:${b.desde}-${b.hasta}-${plataforma}@casacampolasmaravillas`, `DTSTAMP:${sello}`,
    `DTSTART;VALUE=DATE:${b.desde.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${b.hasta.replace(/-/g, '')}`, 'SUMMARY:No disponible', 'END:VEVENT'].join('\r\n'));
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//Casa Campo Las Maravillas//${plataforma}//ES`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Casa Campo Las Maravillas', ...ev, 'END:VCALENDAR', ''].join('\r\n');
  return new Response(ics, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}

/* ---------- Consulta EN VIVO a Booking y Airbnb al aprobar (no espera la sincronización de GitHub) ---------- */
function parseIcalSimple(texto) {
  const lineas = texto.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n'), out = []; let ev = null;
  for (const l of lineas) {
    if (l === 'BEGIN:VEVENT') ev = {};
    else if (l === 'END:VEVENT') { if (ev && ev.desde && ev.estado !== 'CANCELLED') out.push({ desde: ev.desde, hasta: ev.hasta && ev.hasta > ev.desde ? ev.hasta : addDays(ev.desde, 1) }); ev = null; }
    else if (ev) {
      const i = l.indexOf(':'); if (i < 0) continue;
      const k = l.slice(0, i).split(';')[0].toUpperCase(), v = l.slice(i + 1).trim(), m = v.match(/^(\d{4})(\d{2})(\d{2})/);
      if (k === 'DTSTART' && m) ev.desde = `${m[1]}-${m[2]}-${m[3]}`;
      if (k === 'DTEND' && m) ev.hasta = `${m[1]}-${m[2]}-${m[3]}`;
      if (k === 'STATUS') ev.estado = v.toUpperCase();
    }
  }
  return out;
}
function fuentesIcal(env) {
  const f = (env.ICAL_URLS || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const p = l.split(/\s+/), url = p.find(x => /^https?:\/\//i.test(x)); if (!url) return null;
    return { nombre: (p[0] !== url ? p[0] : new URL(url).hostname).toLowerCase(), url };
  }).filter(Boolean);
  const a = (env.AIRBNB_ICAL_URL || '').trim().split(/\s+/).find(x => /^https?:\/\//i.test(x));
  if (a) { for (let i = f.length - 1; i >= 0; i--) if (f[i].nombre === 'airbnb') f.splice(i, 1); f.push({ nombre: 'airbnb', url: a }); }
  return f;
}
export async function revisarEnVivo(env, ingreso, salida) {
  const fuentes = fuentesIcal(env), noches = listaNoches(ingreso, salida), resultado = { ocupadas_en: [], fallaron: [], consultadas: [] };
  if (!fuentes.length) { resultado.fallaron.push('sin calendarios configurados'); return resultado; }
  await Promise.all(fuentes.map(async f => {
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(f.url, { signal: ctl.signal, headers: { 'user-agent': 'CasaCampoLasMaravillas-panel/1.0' } }); clearTimeout(to);
      const t = await r.text();
      if (!r.ok || !t.includes('BEGIN:VCALENDAR') || !t.includes('END:VCALENDAR')) throw new Error('respuesta inválida');
      resultado.consultadas.push(f.nombre);
      const ocup = new Set(); for (const b of parseIcalSimple(t)) for (const d of listaNoches(b.desde, b.hasta)) ocup.add(d);
      if (noches.some(d => ocup.has(d))) resultado.ocupadas_en.push(f.nombre);
    } catch { resultado.fallaron.push(f.nombre); }
  }));
  return resultado;
}

/* ---------- API del panel ---------- */

export async function apiAdmin(req, env, ctx, url) {
  const quien = await usuarioAdmin(req, env);
  if (!quien) return json({ error: 'no_autorizado' }, 401, {});
  const sinCache = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
  if (url.pathname === '/api/admin/solicitudes' && req.method === 'GET') {
    const estado = url.searchParams.get('estado');
    const q = estado ? env.DB.prepare('SELECT * FROM solicitudes WHERE estado = ? ORDER BY creada DESC LIMIT 200').bind(estado)
      : env.DB.prepare("SELECT * FROM solicitudes ORDER BY CASE estado WHEN 'nueva' THEN 0 WHEN 'aprobada' THEN 1 ELSE 2 END, creada DESC LIMIT 200");
    const { results } = await q.all();
    return json({ usuario: quien, solicitudes: results, pagos_habilitados: env.PAGOS_HABILITADOS === 'true',
      telegram_configurado: !!(String(env.TELEGRAM_BOT_TOKEN || '').trim() && String(env.TELEGRAM_CHAT_ID || '').trim()) }, 200, sinCache);
  }
  if (url.pathname === '/api/admin/telegram/prueba' && req.method === 'POST') return json(await avisoTelegramPrueba(env, quien), 200, sinCache);
  const m = url.pathname.match(/^\/api\/admin\/solicitudes\/([0-9a-f-]{36})\/(aprobar|rechazar|revisar)$/);
  if (m && req.method === 'POST') {
    const body = await leerJson(req).catch(() => ({}));
    if (m[2] === 'revisar') return json(await revisarSolicitud(env, m[1]), 200, sinCache);
    if (m[2] === 'aprobar') return json(await aprobarSolicitud(env, m[1], quien, body), 200, sinCache);
    return json(await rechazarSolicitud(env, m[1], quien, body), 200, sinCache);
  }
  if (url.pathname === '/api/admin/yo' && req.method === 'GET') return json({ usuario: quien }, 200, sinCache);
  // Supervisión de reservas automáticas, pagos, calendario y excepciones (automatico.js).
  const r = await apiAdminReservas(req, env, url, quien);
  if (r) return r;
  return json({ error: 'no_encontrado' }, 404, sinCache);
}

async function revisarSolicitud(env, id) {
  const s = await env.DB.prepare('SELECT * FROM solicitudes WHERE id = ?').bind(id).first();
  if (!s) throw new ErrorUsuario('no_encontrado', 'Solicitud inexistente.', 404);
  const casa = await datosCasa(env);
  const [disp, vivo] = await Promise.all([revisarDisponibilidad(env, casa, s, { incluirPruebas: false }), revisarEnVivo(env, s.ingreso, s.salida)]);
  return { numero: s.numero, disponible: disp.disponible && !vivo.ocupadas_en.length, advertencias: disp.motivos, en_vivo: vivo };
}

async function aprobarSolicitud(env, id, quien, body) {
  const s = await env.DB.prepare('SELECT * FROM solicitudes WHERE id = ?').bind(id).first();
  if (!s) throw new ErrorUsuario('no_encontrado', 'Solicitud inexistente.', 404);
  if (!['nueva', 'vencida'].includes(s.estado)) throw new ErrorUsuario('estado_invalido', `La solicitud está "${s.estado}".`, 409);
  if (s.ingreso < hoyAR()) throw new ErrorUsuario('fecha_pasada', 'La fecha de ingreso ya pasó.', 409);
  const casa = await datosCasa(env);
  const disp = await revisarDisponibilidad(env, casa, s, { incluirPruebas: false });
  if (!disp.disponible) throw new ErrorUsuario('no_disponible', 'Según nuestros datos esas fechas ya no están libres (otra reserva, Booking o Airbnb).', 409);
  // Consulta EN VIVO a Booking y Airbnb (sus calendarios exportados), sin esperar la sincronización periódica.
  const vivo = await revisarEnVivo(env, s.ingreso, s.salida);
  if (vivo.ocupadas_en.length) throw new ErrorUsuario('no_disponible', `Consulta en vivo: hay una reserva o cierre en ${vivo.ocupadas_en.join(' y ')} para esas fechas.`, 409);
  if (vivo.fallaron.length && body.forzar !== true) {
    throw new ErrorUsuario('verificacion_en_vivo', `No se pudo consultar en vivo: ${vivo.fallaron.join(', ')}. Revisalo manualmente en la plataforma y, si está libre, confirmá para aprobar igual.`, 409);
  }

  const horas = Math.min(Math.max(Number(body.horas) || Number(env.RETENCION_HORAS || 24), 1), 72);
  // Solo para solicitudes de PRUEBA: retención en segundos (5 a 600) para probar el vencimiento sin esperar horas.
  const segPrueba = s.origen === 'prueba' ? Number.parseInt(body.segundos_prueba, 10) : NaN;
  const msRet = Number.isInteger(segPrueba) && segPrueba >= 5 && segPrueba <= 600 ? segPrueba * 1000 : horas * 3600e3;
  const t = ahora(), vence = new Date(Date.now() + msRet).toISOString();
  const rid = crypto.randomUUID();
  const noches = listaNoches(s.ingreso, s.salida);
  // Todo en una transacción: si alguna noche ya está tomada (otra aprobación simultánea), no se aprueba nada.
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO reservas (id, creada, actualizada, estado, ingreso, salida, noches, adultos, menores, huespedes, precio_noche, total, sena, saldo,
        moneda, nombre, telefono, email, observaciones, vence_en, origen, solicitud_id)
        VALUES (?, ?, ?, 'bloqueo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ARS', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(rid, t, t, s.ingreso, s.salida, s.noches, s.adultos, s.menores, s.huespedes, s.precio_noche, s.total, s.sena, s.saldo,
          s.nombre, s.telefono, s.email, s.observaciones, vence, s.origen === 'prueba' ? 'prueba' : 'web', s.id),
      ...noches.map(f => env.DB.prepare('INSERT INTO noches (fecha, reserva_id) VALUES (?, ?)').bind(claveNoche(f, s.origen), rid)),
      env.DB.prepare(`UPDATE solicitudes SET estado = 'aprobada', reserva_id = ?, retencion_vence = ?, revisada_por = ?, revisada_en = ?, actualizada = ?
        WHERE id = ? AND estado IN ('nueva', 'vencida')`).bind(rid, vence, quien, t, t, s.id),
      evento(env, rid, 'solicitud_aprobada', { numero: s.numero, por: quien, horas })
    ]);
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err && err.message || err))) throw new ErrorUsuario('no_disponible', 'Alguna de esas noches acaba de ser tomada por otra reserva.', 409);
    throw err;
  }
  // Aviso al huésped (canal preparado, apagado). Con WhatsApp activo, acá iría también el link de pago.
  await notificarHuesped(env, 'solicitud_aprobada', { numero: s.numero, telefono: s.telefono, retencion_vence: vence });
  // Paso siguiente (preparado, apagado): generar la orden de seña y enviarle el link al huésped.
  const pago = env.ENVIO_LINK_AUTOMATICO === 'true' && env.PAGOS_HABILITADOS === 'true'
    ? { estado: 'pendiente_de_implementar' }
    : { estado: 'manual', motivo: 'Pagos online deshabilitados: coordiná la seña por WhatsApp.' };
  return {
    numero: s.numero, estado: 'aprobada', retencion_vence: vence, horas, advertencias: disp.motivos, en_vivo: vivo, pago,
    // Booking y Airbnb leen nuestro calendario cada varias horas: hasta entonces, conviene cerrar las fechas a mano.
    siguiente_paso: `Cerrá ahora ${fmtFecha(s.ingreso)} a ${fmtFecha(s.salida)} (salida) en Booking y Airbnb. Nuestro calendario ya las incluye, pero las plataformas pueden tardar horas en leerlo.`
  };
}

async function rechazarSolicitud(env, id, quien, body) {
  const s = await env.DB.prepare('SELECT * FROM solicitudes WHERE id = ?').bind(id).first();
  if (!s) throw new ErrorUsuario('no_encontrado', 'Solicitud inexistente.', 404);
  if (!['nueva', 'aprobada', 'vencida'].includes(s.estado)) throw new ErrorUsuario('estado_invalido', `La solicitud está "${s.estado}".`, 409);
  const motivo = String(body.motivo || '').slice(0, 300) || null;
  const t = ahora();
  const stmts = [env.DB.prepare(`UPDATE solicitudes SET estado = 'rechazada', motivo = ?, revisada_por = ?, revisada_en = ?, actualizada = ? WHERE id = ?`)
    .bind(motivo, quien, t, t, id)];
  if (s.reserva_id) {
    const r = await env.DB.prepare('SELECT estado, mp_order_id FROM reservas WHERE id = ?').bind(s.reserva_id).first();
    if (r && r.mp_order_id && r.estado !== 'vencida') throw new ErrorUsuario('tiene_pago', 'Esta solicitud ya tiene un pago asociado: revisalo antes de rechazarla.', 409);
    if (r && r.estado === 'bloqueo') {
      stmts.push(env.DB.prepare("UPDATE reservas SET estado = 'cancelada', actualizada = ?, cm_estado = CASE cm_estado WHEN 'retenida' THEN 'liberacion_pendiente' ELSE cm_estado END WHERE id = ?").bind(t, s.reserva_id));
      stmts.push(env.DB.prepare('DELETE FROM noches WHERE reserva_id = ?').bind(s.reserva_id));
    }
  }
  stmts.push(evento(env, s.reserva_id, 'solicitud_rechazada', { numero: s.numero, por: quien, motivo }));
  await env.DB.batch(stmts);
  await notificarHuesped(env, 'solicitud_rechazada', { numero: s.numero, telefono: s.telefono });
  return { numero: s.numero, estado: 'rechazada' };
}

/* ---------- Panel (HTML) ---------- */

export async function panelAdmin(req, env) {
  return new Response(PANEL_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } });
}


export const _internos = { precioPorNoche, listaNoches, nochesEntre, fechaValida };
// Piezas compartidas con automatico.js (reserva automática) y disponibilidad.js (proveedores).
export {
  json, ErrorUsuario, leerJson, ahora, datosCasa, calendarioPublicado, validarEstadia, validarContacto, calcularPrecio,
  revisarDisponibilidad, claveDePruebaValida, verificarTurnstile, limitar, listaNoches, addDays, evento, generarOrden,
  exigirModoPrueba, enviarTelegram, notificarHuesped, fmtFecha, fmtPesos, numeroSolicitud, claveNoche, mpFetch, fechaValida, esperarIdempotencia
};
