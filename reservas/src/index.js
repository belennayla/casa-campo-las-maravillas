/*
  Servidor de reservas · Casa Campo Las Maravillas (Cloudflare Worker + D1)

  ETAPA 1 (actual):
  - Cotiza en el servidor (el navegador no decide el precio).
  - Crea bloqueos temporales de fechas con protección frente a solicitudes simultáneas.
  - Vence los bloqueos sin pago (tarea programada).
  - NO cobra ni confirma reservas: PAGOS_HABILITADOS y CONFIRMACION_AUTOMATICA están en "false".
    Mientras la disponibilidad dependa de calendarios iCal que pueden estar desactualizados,
    toda reserva queda sujeta a confirmación manual de los dueños.

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
      if (url.pathname === '/api/cotizar' && req.method === 'POST') return json(await cotizar(await leerJson(req), env), 200, cors);
      if (url.pathname === '/api/bloqueos' && req.method === 'POST') return await crearBloqueo(req, env, cors);
      const m = url.pathname.match(/^\/api\/reservas\/([0-9a-f-]{36})$/);
      if (m && req.method === 'GET') return await verReserva(m[1], env, cors);
      return json({ error: 'no_encontrado' }, 404, cors);
    } catch (e) {
      if (e instanceof ErrorUsuario) return json({ error: e.codigo, mensaje: e.message }, e.status, cors);
      console.error('Error interno', e && e.stack || e);
      return json({ error: 'error_interno', mensaje: 'No pudimos procesar la solicitud. Escribinos por WhatsApp.' }, 500, cors);
    }
  },

  // Tarea programada: libera bloqueos vencidos.
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(vencerBloqueos(env));
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
  const h = { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, idempotency-key', 'vary': 'origin' };
  if (origen && permitidos.includes(origen)) h['access-control-allow-origin'] = origen;
  return h;
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

async function revisarDisponibilidad(env, casa, e) {
  const noches = listaNoches(e.ingreso, e.salida);
  const motivos = [];
  // 1) Base de datos propia (bloqueos vigentes y reservas).
  await vencerBloqueos(env);
  const ph = noches.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT fecha FROM noches WHERE fecha IN (${ph})`).bind(...noches).all();
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

async function cotizar(body, env) {
  const casa = await datosCasa(env);
  const e = validarEstadia(body, casa);
  const precio = calcularPrecio(casa, e);
  const disp = await revisarDisponibilidad(env, casa, e);
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
  return json({
    ...r,
    pago_online: env.PAGOS_HABILITADOS === 'true',
    mensaje: r.estado === 'bloqueo'
      ? 'Fechas retenidas temporalmente. La reserva queda sujeta a confirmación de los dueños por WhatsApp.'
      : undefined
  }, status, cors);
}

async function vencerBloqueos(env) {
  const t = ahora();
  const { results } = await env.DB.prepare(
    "SELECT id FROM reservas WHERE estado IN ('bloqueo', 'pendiente_pago') AND vence_en IS NOT NULL AND vence_en < ?").bind(t).all();
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

export const _internos = { precioPorNoche, listaNoches, nochesEntre, fechaValida };
