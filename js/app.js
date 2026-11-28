/* Casa Campo Las Maravillas · web de reservas directas
   Los datos editables (precios, capacidad, fechas ocupadas) están en data/casa.json */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const money = n => '$' + Math.round(n).toLocaleString('es-AR');

  /* ---------- FOTOS ---------- */
  const CATS = [
    ['todas', 'Todas'], ['exterior', 'Exterior'], ['pileta', 'Pileta'], ['parque', 'Parque y asador'],
    ['interior', 'Living y cocina'], ['dormitorios', 'Dormitorios'], ['bano', 'Baño'], ['vistas', 'Vistas']
  ];
  // [número de foto, categoría, descripción] en el orden en que se muestran
  const FOTOS = [
    [21, 'exterior', 'Frente de la casa'], [7, 'pileta', 'Pileta'], [12, 'interior', 'Living comedor'],
    [3, 'parque', 'Mesas largas en el parque'], [31, 'dormitorios', 'Dormitorio con cama doble e individual'],
    [20, 'vistas', 'Vista a las sierras'], [14, 'interior', 'Cocina equipada'], [6, 'pileta', 'Pileta y parque'],
    [15, 'interior', 'Living'], [27, 'parque', 'Mesa de exterior con vista a las sierras'], [23, 'exterior', 'Frente y cochera'],
    [32, 'dormitorios', 'Dormitorio'], [4, 'pileta', 'Parque junto a la pileta'], [29, 'interior', 'Comedor, cocina y living'],
    [18, 'bano', 'Baño'], [5, 'parque', 'Asador y mesas'], [30, 'vistas', 'Vista desde el living'],
    [1, 'exterior', 'Frente de la casa'], [28, 'pileta', 'Sombrilla junto a la pileta'], [13, 'interior', 'Comedor'],
    [26, 'parque', 'Mesa bajo los árboles'], [19, 'vistas', 'Vista al parque y la pileta'], [16, 'interior', 'Living'],
    [8, 'parque', 'Hamaca paraguaya'], [10, 'exterior', 'Balcón de ingreso'], [11, 'interior', 'Comedor y cocina'],
    [9, 'parque', 'Asador'], [17, 'interior', 'Living'], [38, 'exterior', 'Ingreso y escalera a la terraza'],
    [2, 'parque', 'Parque'], [22, 'parque', 'Parque'], [24, 'exterior', 'Tranquera de ingreso'],
    [25, 'exterior', 'Ingreso a la propiedad'], [33, 'dormitorios', 'Placard'], [34, 'dormitorios', 'Vestidor'],
    [35, 'dormitorios', 'Vestidor'], [36, 'bano', 'Ducha'], [37, 'bano', 'Baño']
  ];
  const src = (n, sm) => `img/fotos/foto-${String(n).padStart(2, '0')}${sm ? '-sm' : ''}.jpg`;
  let cat = 'todas', expanded = false, lbList = [], lbIdx = 0;

  function renderFilters() {
    $('#filtros').innerHTML = CATS.map(([k, l]) =>
      `<button type="button" role="tab" data-cat="${k}" aria-selected="${k === cat}">${l}</button>`).join('');
  }
  function renderGrid() {
    const list = FOTOS.filter(f => cat === 'todas' || f[1] === cat);
    const limit = cat === 'todas' && !expanded ? 11 : list.length;
    lbList = list;
    $('#grid').innerHTML = list.slice(0, limit).map((f, i) =>
      `<button type="button" data-i="${i}" class="${i === 0 ? 'big' : ''}" aria-label="Ampliar: ${f[2]}">
         <img src="${src(f[0], i !== 0)}" alt="${f[2]}" loading="lazy"></button>`).join('') +
      (limit < list.length ? `<button type="button" class="btn btn--ghost-dark grid__more" id="ver-mas">Ver las ${list.length} fotos</button>` : '');
  }
  $('#filtros').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    cat = b.dataset.cat; expanded = false; renderFilters(); renderGrid();
  });
  $('#grid').addEventListener('click', e => {
    if (e.target.closest('#ver-mas')) { expanded = true; renderGrid(); return; }
    const b = e.target.closest('button[data-i]'); if (b) openLb(+b.dataset.i);
  });
  function openLb(i) {
    lbIdx = (i + lbList.length) % lbList.length;
    const f = lbList[lbIdx];
    $('#lb-img').src = src(f[0]); $('#lb-img').alt = f[2];
    $('#lb-cap').textContent = `${f[2]} · ${lbIdx + 1} de ${lbList.length}`;
    if ($('#lb').hidden) { lastFocus = document.activeElement; $('#lb').hidden = false; document.body.style.overflow = 'hidden'; $('#lb-x').focus(); }
    [1, -1].forEach(k => { const g = lbList[(lbIdx + k + lbList.length) % lbList.length]; new Image().src = src(g[0]); });
  }
  let lastFocus = null;
  function closeLb() { $('#lb').hidden = true; document.body.style.overflow = ''; if (lastFocus) lastFocus.focus(); }
  $('#lb-x').onclick = closeLb;
  $('#lb-prev').onclick = () => openLb(lbIdx - 1);
  $('#lb-next').onclick = () => openLb(lbIdx + 1);
  $('#lb').addEventListener('click', e => { if (e.target.id === 'lb') closeLb(); });
  document.addEventListener('keydown', e => {
    if ($('#lb').hidden) return;
    if (e.key === 'Escape') closeLb();
    if (e.key === 'ArrowLeft') openLb(lbIdx - 1);
    if (e.key === 'ArrowRight') openLb(lbIdx + 1);
  });
  let tx = null;
  $('#lb').addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
  $('#lb').addEventListener('touchend', e => {
    if (tx === null) return; const dx = e.changedTouches[0].clientX - tx; tx = null;
    if (Math.abs(dx) > 50) openLb(lbIdx + (dx < 0 ? 1 : -1));
  });
  renderFilters(); renderGrid();

  /* ---------- NAV / BARRA MÓVIL ---------- */
  const nav = $('#nav'), mbar = $('#mbar');
  function onScroll() {
    const y = window.scrollY, h = window.innerHeight;
    nav.classList.toggle('is-solid', y > 60);
    const r = $('#reservar').getBoundingClientRect();
    const inBook = r.top < h && r.bottom > 0;
    mbar.classList.toggle('show', y > h * .7 && !inBook);
    $('.fab').classList.toggle('hide', inBook);
  }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  /* ---------- RESERVAS ---------- */
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const nightsBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
  const fmtDate = s => parse(s).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  const today = iso(new Date());
  const maxDate = (() => { const d = new Date(); d.setMonth(d.getMonth() + 18); return iso(d); })();
  const st = { in: null, out: null, adultos: 2, menores: 0, view: new Date(new Date().getFullYear(), new Date().getMonth(), 1) };
  let CASA = null, busy = new Set(), MAX = 11, MIN_N = 2, SENA = 50;

  function pricePerNight(g) {
    const t = CASA.tarifas.por_huespedes;
    for (const k of Object.keys(t)) {
      const [a, b] = k.split('-').map(Number);
      if (g >= a && g <= (b || a)) return t[k];
    }
    return null; // sin tarifa: se consulta
  }
  const guests = () => st.adultos + st.menores;
  const firstBusyAfter = s => { let d = addDays(s, 1); while (d <= maxDate) { if (busy.has(d)) return d; d = addDays(d, 1); } return null; };
  const rangeFree = (a, b) => { for (let d = a; d < b; d = addDays(d, 1)) if (busy.has(d)) return false; return true; };

  function setMsg(t) { let m = $('#cal-msg'); if (!m) { m = document.createElement('p'); m.id = 'cal-msg'; m.className = 'cal__msg'; m.setAttribute('role', 'status'); $('#cal').appendChild(m); } m.textContent = t || ''; }

  function renderCal() {
    const wrap = $('#cal-months'); wrap.innerHTML = '';
    const limitOut = st.in && !st.out ? firstBusyAfter(st.in) : null;
    for (let k = 0; k < 2; k++) {
      const first = new Date(st.view.getFullYear(), st.view.getMonth() + k, 1);
      const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const lead = (first.getDay() + 6) % 7; // lunes primero
      let html = `<div class="month"><p class="month__t">${(m => m[0].toUpperCase() + m.slice(1))(first.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }))}</p>
        <div class="dow">${['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'].map(d => `<span>${d}</span>`).join('')}</div><div class="days">`;
      html += '<span></span>'.repeat(lead);
      for (let d = 1; d <= days; d++) {
        const s = iso(new Date(first.getFullYear(), first.getMonth(), d));
        const isBusy = busy.has(s);
        const cls = ['day']; let dis = s < today || s > maxDate;
        if (isBusy) cls.push('busy');
        if (s === today) cls.push('today');
        if (st.in && !st.out) {
          // eligiendo salida: se puede salir el día que empieza otra reserva
          if (s > st.in && limitOut && s > limitOut) dis = true;
          if (isBusy && s === limitOut) { cls.push('co'); } else if (isBusy) dis = true;
        } else if (isBusy) dis = true;
        if (s === st.in) cls.push('start');
        if (s === st.out) cls.push('end');
        if (st.in && st.out && s > st.in && s < st.out) cls.push('in');
        html += `<button type="button" class="${cls.join(' ')}" data-d="${s}" ${dis ? 'disabled' : ''} aria-label="${fmtDate(s)}${isBusy ? ', ocupado' : ''}"><span class="day__n">${d}</span></button>`;
      }
      wrap.insertAdjacentHTML('beforeend', html + '</div></div>');
    }
    const now = new Date(); $('#cal-prev').disabled = st.view <= new Date(now.getFullYear(), now.getMonth(), 1);
    $('#cal-hint').textContent = !st.in ? 'Elegí la fecha de ingreso' : !st.out ? 'Ahora elegí la fecha de salida' : `${nightsBetween(st.in, st.out)} noches seleccionadas`;
  }

  function pick(s) {
    setMsg('');
    if (!st.in || st.out || s <= st.in) {
      if (busy.has(s)) return;
      st.in = s; st.out = null;
    } else {
      const n = nightsBetween(st.in, s);
      if (!rangeFree(st.in, s)) { setMsg('Hay noches ocupadas en ese rango. Elegí otras fechas.'); return; }
      if (n < MIN_N) { setMsg(`La estadía mínima es de ${MIN_N} noches.`); return; }
      st.out = s;
    }
    renderCal(); renderQuote();
  }

  function renderQuote() {
    const q = $('#quote'), btn = $('#btn-seguir');
    $('#btn-limpiar').hidden = !st.in;
    if (!st.in || !st.out) {
      const t = CASA ? CASA.tarifas.por_huespedes : {};
      const inK = k => { const [a, b] = k.split('-').map(Number); return guests() >= a && guests() <= (b || a); };
      const tabla = Object.keys(t).sort((a, b) => parseInt(a) - parseInt(b)).map(k => `<li${inK(k) ? ' class="on"' : ''}><span>${k.includes('-') ? 'Hasta ' + k.split('-')[1] : k} huéspedes</span><b>${money(t[k])}</b></li>`).join('');
      q.innerHTML = `<p class="quote__empty">${st.in ? `Ingreso: <b>${fmtDate(st.in)}</b>. Elegí la fecha de salida.` : 'Elegí la fecha de ingreso y de salida para ver el precio de tu estadía.'}</p>
        ${tabla ? `<p class="rates__t">Precio por noche · casa completa</p><ul class="rates">${tabla}</ul>` : ''}`;
      btn.disabled = true; return;
    }
    const n = nightsBetween(st.in, st.out), g = guests(), p = pricePerNight(g);
    const dates = `<div class="quote__dates"><div><small>Ingreso</small><b>${fmtDate(st.in)}</b></div><div><small>Salida</small><b>${fmtDate(st.out)}</b></div></div>`;
    if (p == null) {
      q.innerHTML = dates + '<p class="quote__empty">Consultá el precio para esta cantidad de huéspedes.</p>';
    } else {
      const total = p * n, sena = total * SENA / 100;
      q.innerHTML = dates + `<div id="quote-filas">${filas(p, n, total, sena, total - sena)}</div>
         ${VERIFICADO ? '' : '<p class="quote__warn">Disponibilidad a confirmar por WhatsApp antes de pagar la seña.</p>'}
         <p class="quote__srv" id="quote-srv" role="status"></p>`;
    }
    btn.disabled = false;
    verificarServidor();
  }
  function filas(p, n, total, sena, saldo) {
    const g = guests();
    return `<div class="qrow"><span>${money(p)} × ${n} noches</span><span>${money(total)}</span></div>
      <div class="qrow"><span>${g} ${g === 1 ? 'huésped' : 'huéspedes'}</span><span>casa completa</span></div>
      <div class="qrow qrow--total"><span>Total</span><span>${money(total)}</span></div>
      <div class="qrow qrow--sena"><span>Seña ${SENA} % para reservar</span><span>${money(sena)}</span></div>
      <div class="qrow qrow--saldo"><span>Saldo al ingresar</span><span>${money(saldo)}</span></div>`;
  }

  /* ---------- VERIFICACIÓN CON EL SERVIDOR DE RESERVAS (solo cotización) ----------
     El servidor recalcula el precio y revisa disponibilidad (incluye reservas directas y bloqueos).
     No crea reservas ni bloqueos. Si no responde, la web sigue funcionando con WhatsApp. */
  let SRV = null, srvSeq = 0, srvTimer = null;
  const claveSrv = () => `${st.in}|${st.out}|${st.adultos}|${st.menores}`;
  function verificarServidor() {
    const el = $('#quote-srv'); if (!el) return;
    const api = CASA && CASA.cotizacion_en_linea && CASA.api_reservas;
    if (!api) { el.remove(); return; }
    const key = claveSrv();
    if (SRV && SRV.key === key) return mostrarSrv(SRV);
    el.className = 'quote__srv'; el.textContent = 'Verificando precio y disponibilidad…';
    const seq = ++srvSeq;
    clearTimeout(srvTimer);
    srvTimer = setTimeout(async () => {
      const res = { key, data: null, error: null };
      try {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 7000);
        const r = await fetch(api.replace(/\/$/, '') + '/api/cotizar', {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
          body: JSON.stringify({ ingreso: st.in, salida: st.out, adultos: st.adultos, menores: st.menores })
        });
        clearTimeout(to);
        res.data = await r.json().catch(() => null);
        if (!r.ok) res.error = r.status === 429 ? 'limite' : (res.data && res.data.mensaje) || 'error';
      } catch { res.error = 'red'; }
      if (seq !== srvSeq || key !== claveSrv()) return; // llegó una respuesta vieja
      SRV = res; mostrarSrv(res);
    }, 350);
  }
  function mostrarSrv({ data, error }) {
    const el = $('#quote-srv'), btn = $('#btn-seguir'); if (!el) return;
    if (error || !data) {
      el.className = 'quote__srv quote__srv--neutral';
      el.textContent = 'Disponibilidad pendiente de confirmación. ' + (error === 'limite'
        ? 'Hiciste muchas consultas seguidas: esperá un minuto o enviá la solicitud y te confirmamos por WhatsApp.'
        : (error && error !== 'red' && error !== 'error' ? error + ' ' : '') + 'No pudimos verificar en este momento: podés enviar la solicitud igual y te confirmamos precio y disponibilidad por WhatsApp.');
      return;
    }
    if (!data.disponible) {
      el.className = 'quote__srv quote__srv--no';
      el.textContent = 'Esas fechas no están disponibles. Elegí otras fechas o consultanos por WhatsApp.';
      btn.disabled = true; return;
    }
    const n = nightsBetween(st.in, st.out), p = pricePerNight(guests());
    if (p == null || data.total !== p * n) $('#quote-filas') && ($('#quote-filas').innerHTML = filas(data.precio_noche, n, data.total, data.sena, data.saldo));
    el.className = 'quote__srv quote__srv--ok';
    el.textContent = 'Precio verificado por el sistema. Te confirmamos la disponibilidad por WhatsApp antes de pagar la seña.';
  }

  function renderGuests() {
    $$('.step').forEach(el => {
      const k = el.dataset.k, [minus, plus] = $$('button', el);
      $('output', el).textContent = st[k];
      minus.disabled = st[k] <= (k === 'adultos' ? 1 : 0);
      plus.disabled = guests() >= MAX;
    });
    renderQuote();
  }
  $$('.step').forEach(el => el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const k = el.dataset.k, isPlus = b === $$('button', el)[1];
    st[k] += isPlus ? 1 : -1; renderGuests();
  }));

  $('#cal-months').addEventListener('click', e => { const b = e.target.closest('.day'); if (b && !b.disabled) pick(b.dataset.d); });
  // Vista previa del rango al pasar el mouse mientras se elige la salida
  $('#cal-months').addEventListener('mouseover', e => {
    const b = e.target.closest('.day'); if (!st.in || st.out) return;
    const h = b && !b.disabled && b.dataset.d > st.in ? b.dataset.d : null;
    $$('.day', $('#cal-months')).forEach(d => d.classList.toggle('hov', !!h && d.dataset.d > st.in && d.dataset.d <= h));
  });
  $('#cal-months').addEventListener('mouseleave', () => $$('.day.hov').forEach(d => d.classList.remove('hov')));
  $('#cal-prev').onclick = () => { st.view = new Date(st.view.getFullYear(), st.view.getMonth() - 1, 1); renderCal(); };
  $('#cal-next').onclick = () => { st.view = new Date(st.view.getFullYear(), st.view.getMonth() + 1, 1); renderCal(); };
  $('#btn-limpiar').onclick = () => { st.in = st.out = null; setMsg(''); $('#form').hidden = true; $('#done').hidden = true; renderCal(); renderQuote(); };
  $('#btn-seguir').onclick = () => { $('#form').hidden = false; $('#done').hidden = true; prepararTurnstile(); $('#form').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#form [name=nombre]').focus({ preventScroll: true }); };

  /* ---------- SOLICITUD EN LÍNEA (etapa 1) ----------
     Si está habilitada en casa.json, la solicitud se registra en el servidor (con Turnstile) y el huésped recibe
     un número. NO retiene fechas: los dueños aprueban la disponibilidad. WhatsApp sigue como alternativa. */
  // MODO PRUEBA PRIVADO (solo dueños): abrir la web con #prueba y pegar la clave de pruebas. Las solicitudes quedan
  // marcadas como PRUEBA y no bloquean calendarios. Sin la clave, el servidor las rechaza. Los visitantes no ven nada.
  const CLAVE_SS = 'cc_clave_pruebas';
  const ssGet = () => { try { return sessionStorage.getItem(CLAVE_SS) || ''; } catch { return ''; } };
  const clavePrueba = () => (CASA && CASA.api_reservas && CASA.turnstile_site_key ? ssGet() : '');
  function activarModoPrueba() { // se llama después de cargar casa.json
    if (location.hash === '#prueba' && clavePrueba() === '' && CASA && CASA.api_reservas && CASA.turnstile_site_key) {
      const k = (window.prompt('Modo prueba (solo dueños). Pegá la clave de pruebas:') || '').trim();
      if (k.length >= 32) { try { sessionStorage.setItem(CLAVE_SS, k); } catch { } }
    }
    if (!clavePrueba()) return;
    const b = document.createElement('div');
    b.textContent = '🧪 Modo prueba: las solicitudes se registran como PRUEBA. ';
    const x = document.createElement('button'); x.type = 'button'; x.textContent = 'Salir';
    x.onclick = () => { try { sessionStorage.removeItem(CLAVE_SS); } catch { } location.href = location.pathname; };
    b.appendChild(x);
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#964d2c;color:#fff;padding:8px 12px;font:14px system-ui,sans-serif;text-align:center';
    document.body.appendChild(b);
  }
  const enLinea = () => !!(CASA && CASA.api_reservas && CASA.turnstile_site_key && (CASA.solicitudes_en_linea || clavePrueba()));
  let tsToken = null, tsWidget = null;
  function prepararTurnstile() {
    if (!enLinea() || tsWidget !== null) return;
    const cont = $('#ts'); cont.hidden = false;
    const render = () => { tsWidget = window.turnstile.render(cont, { sitekey: CASA.turnstile_site_key, language: 'es', callback: t => { tsToken = t; }, 'expired-callback': () => { tsToken = null; } }); };
    if (window.turnstile) return render();
    tsWidget = 'cargando';
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true;
    s.onload = render; s.onerror = () => { tsWidget = null; cont.hidden = true; };
    document.head.appendChild(s);
  }
  async function enviarSolicitud(datos) {
    if (!enLinea() || !tsToken) return { error: 'sin_verificacion' };
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(CASA.api_reservas.replace(/\/$/, '') + '/api/solicitudes', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(clavePrueba() ? { 'x-clave-pruebas': clavePrueba() } : {}) }, signal: ctl.signal,
        body: JSON.stringify({ ingreso: st.in, salida: st.out, adultos: st.adultos, menores: st.menores, ...datos, acepto: true, turnstile: tsToken })
      });
      clearTimeout(to);
      const d = await r.json().catch(() => ({}));
      return r.ok ? d : { error: d.mensaje || 'error' };
    } catch { return { error: 'sin_conexion' }; }
    finally { tsToken = null; if (window.turnstile && typeof tsWidget === 'string' && tsWidget !== 'cargando') window.turnstile.reset(tsWidget); }
  }

  /* ---------- FORMULARIO → (SOLICITUD EN LÍNEA) + WHATSAPP ---------- */
  $('#form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, err = $('#form-err');
    const nombre = f.nombre.value.trim(), tel = f.telefono.value.trim(), email = f.email.value.trim(), obs = f.obs.value.trim();
    f.nombre.setAttribute('aria-invalid', !nombre); f.telefono.setAttribute('aria-invalid', tel.replace(/\D/g, '').length < 8);
    if (!nombre) return err.textContent = 'Completá tu nombre y apellido.';
    if (tel.replace(/\D/g, '').length < 8) return err.textContent = 'Completá un teléfono válido.';
    if (!f.acepto.checked) return err.textContent = 'Para continuar tenés que aceptar las condiciones de la reserva.';
    if (enLinea() && tsWidget !== null && !tsToken) return err.textContent = 'Completá la verificación de seguridad (el recuadro de arriba).';
    err.textContent = '';
    let sol = null;
    if (enLinea() && tsWidget !== null) {
      const boton = f.querySelector('button[type=submit]'), txt = boton.textContent;
      boton.disabled = true; boton.textContent = 'Enviando solicitud…';
      sol = await enviarSolicitud({ nombre, telefono: tel, email, observaciones: obs });
      boton.disabled = false; boton.textContent = txt;
    }
    const num = $('#sol-num');
    if (sol && sol.numero) {
      num.hidden = false; num.className = 'done__num';
      num.innerHTML = `Tu número de solicitud es <b>${sol.numero}</b>. Las fechas todavía no están reservadas: revisamos la disponibilidad y te respondemos por WhatsApp. Si querés, mandanos también el mensaje.`;
    } else if (sol && sol.error) {
      num.hidden = false; num.className = 'done__num done__num--aviso';
      num.textContent = 'No pudimos registrar la solicitud en línea. Enviala por WhatsApp con el botón de abajo.';
    } else num.hidden = true;
    const n = nightsBetween(st.in, st.out), g = guests();
    // Si el servidor verificó estas mismas fechas y huéspedes, se usan sus montos.
    const srvOk = SRV && SRV.key === claveSrv() && SRV.data && !SRV.error && SRV.data.disponible;
    const p = srvOk ? SRV.data.precio_noche : pricePerNight(g);
    const lines = [
      'Hola! Quiero solicitar una reserva en Casa Campo Las Maravillas.' + (sol && sol.numero ? ` (Solicitud N° ${sol.numero})` : ''), '',
      `• Ingreso: ${fmtDate(st.in)} (de 15 a 18 h)`,
      `• Salida: ${fmtDate(st.out)} (hasta las 11 h)`,
      `• Noches: ${n}`,
      `• Huéspedes: ${g} (${st.adultos} ${st.adultos === 1 ? 'adulto' : 'adultos'}${st.menores ? ` y ${st.menores} ${st.menores === 1 ? 'menor' : 'menores'}` : ''})`
    ];
    if (p != null) {
      const total = p * n;
      lines.push(`• Total: ${money(total)} (${money(p)} por noche)`, `• Seña ${SENA} %: ${money(total * SENA / 100)}`);
      $('#pay-amount').textContent = money(total * SENA / 100);
    } else { lines.push('• Precio: a consultar'); $('#pay-amount').textContent = 'el 50 % del total'; }
    lines.push('', `Nombre: ${nombre}`, `Teléfono: ${tel}`);
    if (email) lines.push(`Correo: ${email}`);
    if (obs) lines.push(`Comentario: ${obs}`);
    lines.push('', 'Leí y acepto las condiciones de la reserva.');
    $('#wa-msg').value = lines.join('\n'); updateWa();
    f.hidden = true; $('#done').hidden = false;
    $('#done').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  function updateWa() { $('#wa-link').href = `https://wa.me/${CASA ? CASA.contacto.whatsapp : '5492664546558'}?text=${encodeURIComponent($('#wa-msg').value)}`; }
  $('#wa-msg').addEventListener('input', updateWa);
  $('#btn-volver').onclick = () => { $('#done').hidden = true; $('#form').hidden = false; $('#form').scrollIntoView({ behavior: 'smooth' }); };
  $('#copy-alias').onclick = async () => {
    const t = $('#alias').textContent, b = $('#copy-alias');
    try { await navigator.clipboard.writeText(t); } catch {
      const r = document.createRange(); r.selectNodeContents($('#alias')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy');
    }
    b.textContent = '¡Copiado!'; setTimeout(() => { b.textContent = 'Copiar alias'; }, 2000);
  };

  /* ---------- VERIFICACIÓN DE LA SINCRONIZACIÓN ----------
     Un calendario vacío NO significa que no haya reservas: solo se considera
     verificado si todas las fuentes esperadas respondieron bien y hace poco. */
  let VERIFICADO = false;
  const nombreFuente = n => ({ booking: 'Booking', airbnb: 'Airbnb', vrbo: 'Vrbo' })[n] || n;
  function estadoSync(data, sync) {
    const p = [], esperadas = data.fuentes_esperadas || [], maxH = data.sync_max_horas || 26;
    if (!sync || !sync.actualizado) p.push('no pudimos comprobar la sincronización con las plataformas');
    else {
      const fuentes = sync.fuentes || {};
      if (!Object.keys(fuentes).length) p.push('no hay calendarios de plataformas conectados');
      else esperadas.forEach(n => { if (!fuentes[n]) p.push(`el calendario de ${nombreFuente(n)} no está conectado`); });
      Object.entries(fuentes).forEach(([n, f]) => { if (!f.ok) p.push(`no pudimos actualizar el calendario de ${nombreFuente(n)}`); });
      const horas = (Date.now() - new Date(sync.actualizado)) / 36e5;
      if (!(horas <= maxH)) p.push(`la última sincronización fue hace más de ${maxH} horas`);
    }
    if (!data.calendario_actualizado) p.push('las reservas directas todavía no están todas cargadas');
    if (![...busy].some(d => d >= today)) p.push('el calendario no muestra ninguna fecha ocupada');
    return p;
  }

  /* ---------- CARGA DE DATOS ---------- */
  const getJson = u => fetch(u, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  Promise.all([getJson('data/casa.json'), getJson('data/ocupadas-sync.json').catch(() => null)]).then(([data, sync]) => {
    CASA = data;
    MAX = data.capacidad_maxima || 11;
    MIN_N = data.tarifas.estadia_minima_noches || 2;
    SENA = data.reserva.sena_porcentaje || 50;
    busy = new Set();
    const bloques = [...(data.ocupadas || []), ...((sync && sync.ocupadas) || [])];
    const valido = b => b && /^\d{4}-\d{2}-\d{2}$/.test(b.desde) && /^\d{4}-\d{2}-\d{2}$/.test(b.hasta) && b.hasta > b.desde;
    bloques.filter(valido).forEach(b => { for (let d = b.desde; d < b.hasta; d = addDays(d, 1)) busy.add(d); });
    const problemas = estadoSync(data, sync);
    VERIFICADO = !problemas.length;
    if (VERIFICADO) {
      $('#aviso-cal').hidden = true;
      const mins = Math.max(1, Math.round((Date.now() - new Date(sync.actualizado)) / 6e4));
      const hace = mins < 60 ? `hace ${mins} min` : mins < 1440 ? `hace ${Math.round(mins / 60)} h` : (d => `hace ${d} ${d === 1 ? 'día' : 'días'}`)(Math.round(mins / 1440));
      const p = document.createElement('p'); p.className = 'cal__sync';
      p.textContent = `Sincronizado con ${Object.keys(sync.fuentes).map(nombreFuente).join(', ')} · actualizado ${hace}`;
      $('#cal').appendChild(p);
    } else {
      const t = problemas.join('; ');
      $('#aviso-cal').textContent = `Disponibilidad a confirmar: ${t}. Antes de reservar te confirmamos las fechas por WhatsApp.`;
      $('#aviso-cal').hidden = false;
    }
    $('#alias').textContent = data.reserva.pago.alias;
    if (data.contacto.tiktok_url) $('#tiktok').href = data.contacto.tiktok_url;
    const min = Math.min(...Object.values(data.tarifas.por_huespedes));
    $('#mbar-price').textContent = 'Desde ' + money(min);
    renderCal(); renderGuests();
    activarModoPrueba();
  }).catch(() => {
    $('#cal-months').innerHTML = '<p>No pudimos cargar el calendario. Escribinos por WhatsApp y te pasamos disponibilidad y precio.</p>';
  });
})();
