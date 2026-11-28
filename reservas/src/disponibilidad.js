/*
  PROVEEDOR DE DISPONIBILIDAD (intercambiable) · Casa Campo Las Maravillas

  Una misma interfaz para saber si las fechas están libres FUERA de nuestra base y para retenerlas
  en los canales externos mientras el huésped paga:

    consultar({ ingreso, salida, excluirRef }) → { estado: 'libre' | 'ocupado' | 'duda', detalle }
    retener(reserva)                            → { estado: 'retenida' | 'no_aplica' | 'ocupado' | 'error', ref, detalle }
    confirmar(reserva)                          → { ok, detalle }
    liberar(reserva)                            → { ok, detalle }   (cancela la retención provisional)
    limpiar(reserva)                            → { ok, detalle }   (busca y cancela una retención huérfana por su número)
    bloqueaCanales                              → true SOLO si está comprobado que una retención cierra Booking y Airbnb

  Proveedores:
  - "ical"     (hoy): consulta EN VIVO los calendarios iCal de Booking y Airbnb. NO puede retener ni cerrar fechas en
                las plataformas: ellas leen nuestro calendario con horas de demora. Por eso bloqueaCanales = false y la
                confirmación automática de reservas reales queda prohibida con este proveedor.
  - "smoobu"   (fase 2): API de Smoobu (https://docs.smoobu.com, autenticación HMAC). La retención es una reserva
                provisional en el canal propio (SMOOBU_CANAL_ID). La documentación NO garantiza que Smoobu la envíe a
                Booking y Airbnb: hasta comprobarlo en una prueba real, SMOOBU_BLOQUEO_VERIFICADO = "false".
  - "simulado": solo para reservas de PRUEBA. Nunca toca un gestor real, nunca afecta Booking ni Airbnb.
*/
import { revisarEnVivo } from './index.js';

const TIMEOUT_MS = 8000;

export function proveedorPara(env, reserva = {}) {
  // Las reservas ficticias jamás llegan a un gestor real (salvo en las pruebas locales contra el gestor SIMULADO).
  if (reserva.origen === 'prueba' && env.PRUEBAS_USAN_PROVEEDOR !== 'true') return simulado();
  return (env.PROVEEDOR_DISPONIBILIDAD || 'ical') === 'smoobu' ? smoobu(env) : ical(env);
}

/* ---------- iCal (sin gestor de canales) ---------- */
function ical(env) {
  return {
    nombre: 'ical',
    bloqueaCanales: false,
    async consultar({ ingreso, salida }) {
      const v = await revisarEnVivo(env, ingreso, salida);
      if (v.ocupadas_en.length) return { estado: 'ocupado', detalle: `ocupado en ${v.ocupadas_en.join(' y ')}` };
      if (v.fallaron.length) return { estado: 'duda', detalle: `sin respuesta de ${v.fallaron.join(', ')}` };
      return { estado: 'libre', detalle: `consultado en vivo: ${v.consultadas.join(', ')}` };
    },
    async retener() { return { estado: 'no_aplica', detalle: 'iCal no permite retener fechas en Booking ni Airbnb' }; },
    async confirmar() { return { ok: true, detalle: 'sin gestor' }; },
    async liberar() { return { ok: true, detalle: 'sin gestor' }; },
    async limpiar() { return { ok: true, detalle: 'sin gestor' }; }
  };
}

/* ---------- Simulado (solo reservas de prueba en producción) ---------- */
function simulado() {
  return {
    nombre: 'simulado',
    bloqueaCanales: true, // ficticio: la reserva de prueba no existe fuera de nuestra base
    async consultar() { return { estado: 'libre', detalle: 'proveedor simulado (prueba)' }; },
    async retener(r) { return { estado: 'retenida', ref: 'SIM-' + String(r.id).slice(0, 8), detalle: 'retención simulada (prueba)' }; },
    async confirmar() { return { ok: true, detalle: 'simulado' }; },
    async liberar() { return { ok: true, detalle: 'simulado' }; },
    async limpiar() { return { ok: true, detalle: 'simulado' }; }
  };
}

/* ---------- Smoobu ---------- */
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const rfc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Firma HMAC documentada por Smoobu:
// METHOD \n PATH \n QUERY_ORDENADA \n TIMESTAMP \n NONCE \n SHA256_HEX(BODY) \n API_KEY  →  base64(HMAC-SHA256(secreto, ...))
export async function firmaSmoobu({ metodo, ruta, query = {}, cuerpo = '', apiKey, secreto, timestamp, nonce }) {
  const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [rfc3986(String(k)), rfc3986(String(v))]).sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canon = [metodo.toUpperCase(), ruta, q, timestamp, nonce, hex(await crypto.subtle.digest('SHA-256', enc.encode(cuerpo))), apiKey].join('\n');
  const k = await crypto.subtle.importKey('raw', enc.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { firma: b64(await crypto.subtle.sign('HMAC', k, enc.encode(canon))), query: q };
}

function smoobu(env) {
  const base = (env.SMOOBU_API_BASE || 'https://login.smoobu.com').replace(/\/$/, '');
  const apt = Number(env.SMOOBU_APARTAMENTO_ID);
  const canal = Number(env.SMOOBU_CANAL_ID || 13); // 13 = "Direct booking" en la tabla de canales de Smoobu
  const configurado = !!(env.SMOOBU_API_KEY && env.SMOOBU_API_SECRET && apt);

  async function llamar(metodo, ruta, { query = {}, body } = {}) {
    const cuerpo = body ? JSON.stringify(body) : '';
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), nonce = crypto.randomUUID();
    const { firma, query: q } = await firmaSmoobu({ metodo, ruta, query, cuerpo, apiKey: env.SMOOBU_API_KEY, secreto: env.SMOOBU_API_SECRET, timestamp, nonce });
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(base + ruta + (q ? '?' + q : ''), {
        method: metodo, signal: ctl.signal,
        headers: { 'X-API-Key': env.SMOOBU_API_KEY, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': firma, accept: 'application/json', ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
        body: cuerpo || undefined
      });
      const t = await r.text(); let data = null; try { data = t ? JSON.parse(t) : null; } catch { /* no JSON */ }
      return { status: r.status, ok: r.ok, data };
    } finally { clearTimeout(to); }
  }

  // Reservas de la casa que se superponen con [ingreso, salida), sin las canceladas.
  async function superpuestas(ingreso, salida) {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const r = await llamar('GET', '/api/reservations', { query: { apartmentId: apt, from: ingreso, to: salida, page, pageSize: 100 } });
      if (!r.ok || !r.data || !Array.isArray(r.data.bookings)) throw new Error(`Smoobu GET reservations HTTP ${r.status}`);
      for (const b of r.data.bookings) {
        if (b.type === 'cancellation') continue;
        if (b.arrival < salida && b.departure > ingreso) out.push(b);
      }
      if (page >= (r.data.page_count || 1)) break;
    }
    return out;
  }

  return {
    nombre: 'smoobu',
    // Solo después de comprobar con una prueba real que una retención creada por API cierra Booking y Airbnb.
    bloqueaCanales: configurado && env.SMOOBU_BLOQUEO_VERIFICADO === 'true',
    async consultar({ ingreso, salida, excluirRef }) {
      if (!configurado) return { estado: 'duda', detalle: 'Smoobu sin configurar' };
      try {
        const otras = (await superpuestas(ingreso, salida)).filter(b => String(b.id) !== String(excluirRef || ''));
        return otras.length ? { estado: 'ocupado', detalle: `reserva ${otras[0].id} (${(otras[0].channel && otras[0].channel.name) || 'otro canal'})` } : { estado: 'libre', detalle: 'Smoobu' };
      } catch (e) { return { estado: 'duda', detalle: String(e && e.message || e).slice(0, 120) }; }
    },
    async retener(r) {
      if (!configurado) return { estado: 'error', detalle: 'Smoobu sin configurar' };
      const [nombre, ...resto] = String(r.nombre || '').split(/\s+/);
      try {
        const res = await llamar('POST', '/api/reservations', { body: {
          arrivalDate: r.ingreso, departureDate: r.salida, apartmentId: apt, channelId: canal, arrivalTime: '15:00', departureTime: '11:00',
          firstName: nombre || 'Huésped', lastName: resto.join(' ') || '-', email: r.email || undefined, phone: r.telefono || undefined,
          adults: r.adultos, children: r.menores, price: r.total, priceStatus: 0, prepayment: r.sena, prepaymentStatus: 0, language: 'es',
          notice: `PROVISIONAL ${r.numero} · seña pendiente (${r.medio_pago}) · vence ${r.vence_en}. Se cancela sola si no se paga.`
        } });
        if (res.ok && res.data && res.data.id) return { estado: 'retenida', ref: String(res.data.id) };
        const msg = JSON.stringify((res.data && (res.data.validation_messages || res.data.detail)) || '');
        if (res.status === 400 && /reservation|exists|available|occupied/i.test(msg)) return { estado: 'ocupado', detalle: msg.slice(0, 160) };
        return { estado: 'error', detalle: `HTTP ${res.status} ${msg.slice(0, 120)}` };
      } catch (e) { return { estado: 'error', detalle: String(e && e.message || e).slice(0, 120) }; }
    },
    async confirmar(r) {
      if (!configurado || !r.cm_ref) return { ok: false, detalle: 'sin referencia en Smoobu' };
      try {
        const res = await llamar('PUT', `/api/reservations/${encodeURIComponent(r.cm_ref)}`, { body: {
          arrivalTime: '15:00', prepayment: r.sena, prepaymentStatus: 1,
          notice: `CONFIRMADA ${r.numero} · seña pagada (${r.medio_pago}) · saldo $${r.saldo} al ingresar`
        } });
        return { ok: res.ok, detalle: `HTTP ${res.status}` };
      } catch (e) { return { ok: false, detalle: String(e && e.message || e).slice(0, 120) }; }
    },
    async liberar(r) {
      if (!r.cm_ref) return this.limpiar(r);
      if (!configurado) return { ok: false, detalle: 'Smoobu sin configurar' };
      try {
        const res = await llamar('DELETE', `/api/reservations/${encodeURIComponent(r.cm_ref)}`);
        return { ok: res.ok || res.status === 404, detalle: `HTTP ${res.status}` };
      } catch (e) { return { ok: false, detalle: String(e && e.message || e).slice(0, 120) }; }
    },
    // Si la creación respondió con error o se cortó, puede haber quedado una retención sin referencia: se busca por número.
    async limpiar(r) {
      if (!configurado) return { ok: false, detalle: 'Smoobu sin configurar' };
      try {
        const huerfanas = (await superpuestas(r.ingreso, r.salida)).filter(b => String(b.notice || '').includes(r.numero));
        for (const b of huerfanas) {
          const res = await llamar('DELETE', `/api/reservations/${encodeURIComponent(b.id)}`);
          if (!res.ok && res.status !== 404) return { ok: false, detalle: `HTTP ${res.status}` };
        }
        return { ok: true, detalle: `${huerfanas.length} retenciones canceladas` };
      } catch (e) { return { ok: false, detalle: String(e && e.message || e).slice(0, 120) }; }
    }
  };
}
