/* Casa Campo Las Maravillas · enlace privado de la reserva
   El huésped ve acá el estado real de su reserva, paga la seña, sigue la verificación y, al confirmarse, su comprobante.
   El enlace (#t=…) nunca viaja a ningún servidor salvo al nuestro, en un encabezado. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const money = n => '$' + Math.round(n).toLocaleString('es-AR');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fecha = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
  const hora = iso => new Date(iso).toLocaleString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const caja = $('#res');
  const params = new URLSearchParams(location.search);

  function leerAcceso() {
    const h = new URLSearchParams(location.hash.slice(1)).get('t');
    if (h) return h;
    const n = params.get('n');
    try { const m = JSON.parse(localStorage.getItem('cc_reservas') || '{}'); if (n && m[n]) return m[n]; } catch { }
    return null;
  }
  const acceso = leerAcceso();
  if (acceso && !location.hash) history.replaceState(null, '', location.pathname + location.search + '#t=' + encodeURIComponent(acceso));

  let API = null, WA = '5492664546558', sondeos = 0;
  const llamar = (ruta, metodo = 'GET') => fetch(API + ruta, { method: metodo, headers: { 'x-acceso': acceso, ...(metodo === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: metodo === 'POST' ? '{}' : undefined })
    .then(async r => ({ status: r.status, d: await r.json().catch(() => ({})) }));

  function error(msg) {
    caja.innerHTML = `<h1 class="res__t">No encontramos tu reserva</h1><p>${esc(msg)}</p>
      <p><a class="btn" href="./#reservar">Ver disponibilidad</a> <a class="btn btn--ghost-dark" href="https://wa.me/${WA}" target="_blank" rel="noopener">Escribinos por WhatsApp</a></p>`;
  }

  const ETAPAS = [['Fechas retenidas', ['bloqueo', 'pendiente_pago', 'pago_en_proceso']], ['Seña acreditada', ['pago_verificado']], ['Reserva confirmada', ['confirmada']]];
  function lineaDeTiempo(e) {
    const idx = ETAPAS.findIndex(x => x[1].includes(e));
    if (idx < 0) return '';
    const fin = e === 'confirmada';
    return `<ol class="res__pasos">${ETAPAS.map(([t], i) => `<li class="${i < idx || fin ? 'hecho' : i === idx ? 'actual' : ''}">${t}</li>`).join('')}</ol>`;
  }

  function render(v) {
    const clase = { confirmada: 'ok', conflicto: 'mal', vencida: 'gris', cancelada: 'gris' }[v.estado] || 'pend';
    const titulo = {
      confirmada: '¡Tu reserva está confirmada!', conflicto: 'Hubo un problema con tu reserva', pago_en_proceso: 'Estamos procesando tu pago',
      pago_verificado: 'Recibimos tu seña', vencida: 'El plazo para pagar venció', cancelada: 'Reserva cancelada'
    }[v.estado] || (v.medio_pago === 'transferencia' ? 'Transferí la seña para completar tu reserva' : 'Completá el pago de la seña');
    let acciones = '';
    if (v.pago) {
      acciones += v.pago.rechazado ? '<p class="res__aviso">Tu pago no se aprobó. Podés intentar de nuevo con otra tarjeta o medio de pago.</p>' : '';
      acciones += v.pago.checkout_url
        ? `<a class="btn btn--block res__pagar" href="${esc(v.pago.checkout_url)}" rel="noopener noreferrer">Pagar la seña de ${money(v.sena)} con Mercado Pago</a>`
        : `<button type="button" class="btn btn--block" id="generar">Pagar la seña de ${money(v.sena)} con Mercado Pago</button>`;
    }
    if (v.vence_en) acciones += `<p class="res__vence">Tus fechas están retenidas hasta el <b>${hora(v.vence_en)}</b>. Si la seña no se acredita en ese plazo, se liberan.</p>`;
    if (v.transferencia) {
      const msg = `Hola! Envío el comprobante de la seña de la reserva ${v.numero} (${money(v.transferencia.monto)}).`;
      acciones += `<div class="pay"><h4>Transferí la seña de ${money(v.transferencia.monto)}</h4>
        <div class="pay__alias"><div><small>Alias</small><b id="alias">${esc(v.transferencia.alias)}</b><small>Titular: ${esc(v.transferencia.titular)}</small></div>
        <button type="button" class="btn btn--sm" id="copiar-alias">Copiar alias</button></div>
        <p>Cuando verifiquemos la acreditación, tu reserva se confirma y lo vas a ver en esta misma página. Para agilizarlo, podés mandarnos el comprobante:</p>
        <a class="btn btn--wa btn--block" href="https://wa.me/${WA}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Enviar comprobante por WhatsApp</a></div>`;
    }
    if (v.estado === 'pago_en_proceso') acciones += '<p class="res__aviso">Mercado Pago está procesando tu pago. Esta página se actualiza sola: no hace falta que pagues de nuevo.</p>';
    if (v.estado === 'pago_verificado') acciones += v.en_revision
      ? '<p class="res__aviso">Recibimos tu seña. Estamos verificando la disponibilidad con las otras plataformas y te contactamos a la brevedad. <b>Tu reserva todavía no está confirmada.</b></p>'
      : '<p class="res__aviso">Recibimos tu seña. Estamos terminando las verificaciones: esta página se actualiza sola.</p>';
    if (v.estado === 'vencida' || v.estado === 'cancelada') acciones += `<p>${v.estado === 'vencida' ? 'El plazo para pagar la seña venció y las fechas se liberaron.' : 'Esta reserva fue cancelada.'} Podés volver a elegir fechas cuando quieras.</p><a class="btn" href="./#reservar">Elegir fechas</a>`;
    if (v.estado === 'conflicto') acciones += `<p class="res__aviso">Recibimos tu pago, pero las fechas se ocuparon en otra plataforma antes de confirmarlas. <b>Te vamos a devolver el 100 % de la seña</b> y te contactamos para ofrecerte alternativas.</p>
      <a class="btn btn--wa" href="https://wa.me/${WA}?text=${encodeURIComponent('Hola! Consulto por mi reserva ' + v.numero)}" target="_blank" rel="noopener">Escribinos por WhatsApp</a>`;

    let comprobante = '';
    if (v.confirmacion) {
      const c = v.confirmacion;
      comprobante = `<section class="res__comp" aria-label="Comprobante de reserva">
        <h2>Comprobante de reserva</h2>
        <dl>
          <dt>Número</dt><dd>${esc(v.numero)}</dd>
          <dt>A nombre de</dt><dd>${esc(v.nombre)}</dd>
          <dt>Ingreso</dt><dd>${fecha(v.ingreso)} · de ${esc(v.horarios && v.horarios.ingreso || '15:00 a 18:00')}</dd>
          <dt>Salida</dt><dd>${fecha(v.salida)} · ${esc(v.horarios && v.horarios.salida || 'hasta las 11:00')}</dd>
          <dt>Seña pagada</dt><dd>${money(v.pagado)}${v.medio_pago === 'transferencia' ? ' (transferencia)' : ' (Mercado Pago)'}</dd>
          <dt>Saldo al ingresar</dt><dd><b>${money(c.saldo_al_ingresar)}</b></dd>
          <dt>Dirección</dt><dd>${esc(c.direccion || '')}</dd>
          <dt>Confirmada el</dt><dd>${c.confirmada_en ? hora(c.confirmada_en) : ''}</dd>
        </dl>
        <p class="res__acc">${c.mapa ? `<a class="btn btn--sm" href="${esc(c.mapa)}" target="_blank" rel="noopener">Ver en Google Maps</a>` : ''}
          <button type="button" class="btn btn--sm btn--ghost-dark" id="imprimir">Imprimir o guardar el comprobante</button></p>
      </section>`;
    }

    caja.innerHTML = `
      ${v.prueba ? '<p class="res__prueba">🧪 Reserva de PRUEBA: no es una reserva real.</p>' : ''}
      <p class="res__num">Reserva N° ${esc(v.numero)}</p>
      <h1 class="res__t">${titulo}</h1>
      <p class="res__estado res__estado--${clase}">${esc(v.estado_texto)}</p>
      ${lineaDeTiempo(v.estado)}
      <div class="res__resumen">
        <div><small>Ingreso</small><b>${fecha(v.ingreso)}</b></div>
        <div><small>Salida</small><b>${fecha(v.salida)}</b></div>
        <div><small>Estadía</small><b>${v.noches} noches · ${v.huespedes} ${v.huespedes === 1 ? 'huésped' : 'huéspedes'}</b></div>
        <div><small>Total</small><b>${money(v.total)}</b></div>
        <div><small>Seña (50 %)</small><b>${money(v.sena)}</b></div>
        <div><small>Saldo al ingresar</small><b>${money(v.saldo)}</b></div>
      </div>
      <div class="res__acciones">${acciones}</div>
      ${comprobante}
      ${['vencida', 'cancelada'].includes(v.estado) ? '' : `<div class="res__guardar"><p><b>Guardá este enlace:</b> es tu acceso privado para ver el estado de la reserva y el comprobante.</p>
        <button type="button" class="link" id="copiar-enlace">Copiar enlace</button></div>`}
      <p class="res__ayuda">¿Dudas? <a href="https://wa.me/${WA}?text=${encodeURIComponent('Hola! Consulto por mi reserva ' + v.numero)}" target="_blank" rel="noopener">Escribinos por WhatsApp</a></p>`;

    const g = $('#generar');
    if (g) g.onclick = async () => { g.disabled = true; g.textContent = 'Preparando el pago…'; const r = await llamar('/api/mi-reserva/pagar', 'POST'); if (r.status === 200 && r.d.pago && r.d.pago.checkout_url) location.href = r.d.pago.checkout_url; else { render(r.status === 200 ? r.d : v); if (r.d.mensaje) caja.insertAdjacentHTML('afterbegin', `<p class="res__aviso">${esc(r.d.mensaje)}</p>`); } };
    const copiar = async (texto, b, ok) => { try { await navigator.clipboard.writeText(texto); } catch { } b.textContent = ok; setTimeout(() => render(v), 2000); };
    const ca = $('#copiar-alias'); if (ca) ca.onclick = () => copiar(v.transferencia.alias, ca, '¡Copiado!');
    const ce = $('#copiar-enlace'); if (ce) ce.onclick = () => copiar(location.href, ce, '¡Enlace copiado!');
    const im = $('#imprimir'); if (im) im.onclick = () => window.print();

    // Se actualiza solo mientras hay algo en curso (al volver de Mercado Pago, pago en proceso o verificación).
    const enCurso = v.estado === 'pago_en_proceso' || (v.estado === 'pago_verificado' && !v.en_revision) || (params.get('pago') && ['bloqueo', 'pendiente_pago'].includes(v.estado));
    if (enCurso && sondeos < 60) { sondeos++; setTimeout(cargar, sondeos < 15 ? 4000 : 15000); }
  }

  async function cargar() {
    try {
      const r = await llamar('/api/mi-reserva');
      if (r.status !== 200) return error(r.d.mensaje || 'El enlace no es válido o la reserva no existe.');
      try { const m = JSON.parse(localStorage.getItem('cc_reservas') || '{}'); m[r.d.numero] = acceso; localStorage.setItem('cc_reservas', JSON.stringify(m)); } catch { }
      render(r.d);
    } catch { caja.innerHTML = '<p>No pudimos conectarnos. Revisá tu conexión y recargá la página.</p>'; }
  }

  fetch('data/casa.json', { cache: 'no-cache' }).then(r => r.json()).then(casa => {
    API = String(casa.api_reservas || '').replace(/\/$/, '');
    if (casa.contacto && casa.contacto.whatsapp) WA = casa.contacto.whatsapp;
    if (!acceso) return error('Abrí el enlace privado que recibiste al reservar.');
    cargar();
  }).catch(() => error('No pudimos cargar la información. Recargá la página.'));
})();
