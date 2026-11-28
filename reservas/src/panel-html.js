// Panel privado (HTML + JS sin dependencias). Centro de SUPERVISIÓN: el sistema reserva, cobra y confirma solo;
// los dueños miran el estado, atienden las excepciones y, si el modo lo requiere, aprueban solicitudes.
// Ojo: es String.raw y el JS del navegador no usa template literals (no hay comillas invertidas adentro).
export const PANEL_HTML = String.raw`<!doctype html><html lang="es-AR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Panel · Casa Campo Las Maravillas</title>
<style>
:root{--bg:#f7f2e9;--card:#fff;--ink:#2a2822;--mut:#6b665a;--sage:#5b6b4a;--terra:#964d2c;--line:#e5dccb}
*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
header{background:var(--sage);color:#fff;padding:10px 16px;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;justify-content:space-between}
header small{opacity:.85}nav{display:flex;gap:4px;flex-wrap:wrap;padding:8px 16px;background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
nav button{border:0;background:none;padding:8px 12px;border-radius:8px;font:inherit;cursor:pointer;color:var(--mut)}nav button.on{background:#e3e8da;color:var(--ink);font-weight:700}
nav .n{display:inline-block;min-width:1.4em;padding:0 .35em;border-radius:99px;background:var(--terra);color:#fff;font-size:12px;margin-left:4px}
main{max-width:1100px;margin:0 auto;padding:16px}h2{font-size:1.1rem;margin:22px 0 8px}h2:first-child{margin-top:4px}
.s{background:var(--card);border-radius:10px;padding:12px 14px;margin:8px 0;box-shadow:0 1px 3px #0001}
.e{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:700;background:#eee;margin-right:4px}
.confirmada,.ok{background:#e3e8da}.bloqueo,.pendiente_pago,.pago_en_proceso,.nueva{background:#fbeedd}.pago_verificado{background:#dfe8f3}
.conflicto,.mal{background:#f6dcd0;color:var(--terra)}.vencida,.cancelada,.rechazada{background:#eee;color:#777}.prueba{background:#964d2c;color:#fff}
button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer;margin:6px 6px 0 0}
.pri{background:var(--sage);color:#fff;border-color:var(--sage)}.no{color:var(--terra)}.m{color:var(--mut);font-size:13px}.msg{color:var(--terra);margin:6px 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}.kv{background:var(--card);border-radius:10px;padding:10px 12px;box-shadow:0 1px 3px #0001}
.kv small{display:block;color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em}.kv b.si{color:var(--sage)}.kv b.nn{color:var(--terra)}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:10px;overflow:hidden;box-shadow:0 1px 3px #0001;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}tr.fila{cursor:pointer}tr.fila:hover{background:#faf6ee}
.vacio{color:var(--mut);padding:8px 0}select,input{font:inherit;padding:6px 8px;border:1px solid #ccc;border-radius:8px}
.cal{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}.mes{background:var(--card);border-radius:10px;padding:10px;box-shadow:0 1px 3px #0001}
.mes h3{margin:0 0 6px;font-size:1rem}.dias{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.dia{min-height:42px;border-radius:6px;padding:2px 4px;font-size:12px;background:#f3efe6}.dia b{display:block}.dia span{font-size:10px;display:block;line-height:1.15;overflow:hidden}
.t-confirmada{background:#c9d6b8}.t-retenida{background:#f4d9b3}.t-externa{background:#d9d4e8}.t-directa_manual{background:#cfe0ea}.t-prueba{background:repeating-linear-gradient(45deg,#f3efe6,#f3efe6 4px,#e8c9b9 4px,#e8c9b9 8px)}
.ley{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0}.ley i{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;margin-right:4px}
dialog{border:0;border-radius:12px;max-width:760px;width:94vw;padding:18px;box-shadow:0 10px 40px #0004}dialog::backdrop{background:#0005}
.ev{font-size:13px;border-left:3px solid var(--line);padding:2px 0 2px 10px;margin:4px 0}.ev b{font-weight:600}
#login{max-width:420px}#login input{width:100%}
</style></head><body>
<header><b>Casa Campo Las Maravillas · Panel</b><small id="info">Cargando…</small></header>
<nav id="tabs"><button data-t="resumen" class="on">Resumen</button><button data-t="reservas">Reservas</button><button data-t="calendario">Calendario</button><button data-t="solicitudes">Solicitudes</button><button data-t="sistema">Sistema</button></nav>
<main>
<div id="login" hidden><p>Clave de administración (solo pruebas locales; en producción se entra con Cloudflare Access):</p><input id="clave" type="password" autocomplete="off"><button class="pri" id="entrar">Entrar</button></div>
<section id="v-resumen"></section><section id="v-reservas" hidden></section><section id="v-calendario" hidden></section><section id="v-solicitudes" hidden></section><section id="v-sistema" hidden></section>
</main>
<dialog id="dlg"><div id="dlg-c"></div><button id="dlg-x">Cerrar</button></dialog>
<script>
var H = function () { var c = sessionStorage.getItem('clave'); return c ? { 'x-admin-clave': c } : {}; };
var api = async function (u, o) { o = o || {}; var h = Object.assign({ 'content-type': 'application/json' }, H(), o.headers || {}); var r = await fetch(u, Object.assign({}, o, { headers: h })); var d = await r.json().catch(function () { return {}; }); if (r.status === 401) { document.getElementById('login').hidden = false; throw new Error('no autorizado'); } if (!r.ok) { var er = new Error(d.mensaje || d.error || r.status); er.codigo = d.error; throw er; } return d; };
var post = function (u, b) { return api(u, { method: 'POST', body: JSON.stringify(b || {}) }); };
var $ = function (s) { return document.querySelector(s); };
var f = function (s) { return s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : ''; };
var fh = function (s) { return s ? new Date(s).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''; };
var p = function (n) { return '$' + Number(n || 0).toLocaleString('es-AR'); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
var ESTADOS = { bloqueo: 'retenida', pendiente_pago: 'esperando pago', pago_en_proceso: 'pago en proceso', pago_verificado: 'seña acreditada', confirmada: 'confirmada', vencida: 'vencida', cancelada: 'cancelada', conflicto: 'conflicto' };
var MOTIVOS = {
  confirmacion_manual: 'Seña acreditada. La confirmación automática está apagada: confirmala si todo está bien.',
  sin_gestor_verificado: 'Seña acreditada, pero sin gestor de canales verificado (iCal). Revisá Booking y Airbnb, cerrá las fechas y confirmá.',
  disponibilidad_dudosa: 'Seña acreditada, pero no se pudo verificar la disponibilidad. Revisá las plataformas antes de confirmar.',
  gestor_no_retuvo: 'Seña acreditada, pero el gestor de canales no pudo retener las fechas.',
  gestor_no_confirmo: 'Seña acreditada, pero el gestor no registró la confirmación (las fechas siguen como provisionales).',
  gestor_cancelo: 'La retención fue cancelada en el gestor de canales mientras seguía activa aquí.',
  superposicion_otro_canal: 'Entró una reserva de otro canal que se superpone con esta. Revisá de inmediato.',
  ocupado_en_gestor: 'Las fechas se ocuparon en otro canal antes de confirmar: devolver el 100 % de la seña.',
  pago_tardio_fechas_tomadas: 'El pago llegó después de vencer la retención y las fechas ya estaban tomadas: devolver la seña.',
  error_confirmacion: 'Error técnico al intentar confirmar. Revisá el detalle.'
};
var motivo = function (r) { return MOTIVOS[r.excepcion] || (r.estado === 'conflicto' ? 'Conflicto con el pago (' + esc(r.excepcion || 'revisar') + '): corresponde devolver la seña.' : esc(r.excepcion || '')); };
var etiq = function (r) { return '<span class="e ' + r.estado + '">' + (ESTADOS[r.estado] || r.estado) + '</span>' + (r.origen === 'prueba' ? '<span class="e prueba">prueba</span>' : ''); };
var medio = function (r) { return r.medio_pago === 'transferencia' ? 'transferencia' : r.medio_pago === 'mercadopago' ? 'Mercado Pago' : (r.modo === 'solicitud' ? 'solicitud' : '—'); };
var linea = function (r) { return '<b>' + esc(r.numero || r.id.slice(0, 8)) + '</b> · ' + f(r.ingreso) + ' → ' + f(r.salida) + ' · ' + r.noches + ' noches · ' + r.huespedes + ' huéspedes · seña ' + p(r.sena) + ' · ' + medio(r) + '<div class="m">' + esc(r.nombre) + ' · <a href="https://wa.me/' + esc(String(r.telefono).replace(/[^0-9]/g, '')) + '" target="_blank" rel="noopener">' + esc(r.telefono) + '</a>' + (r.email ? ' · ' + esc(r.email) : '') + '</div>'; };
var boton = function (txt, accion, id, cls) { return '<button class="' + (cls || '') + '" data-acc="' + accion + '" data-id="' + id + '">' + txt + '</button>'; };

async function verResumen() {
  var d = await api('/api/admin/resumen'), s = d.sistema, el = $('#v-resumen'), h = '';
  $('#tabs [data-t=resumen]').innerHTML = 'Resumen' + (d.excepciones.length ? '<span class="n">' + d.excepciones.length + '</span>' : '');
  h += '<h2>Requieren su atención (' + d.excepciones.length + ')</h2>';
  h += d.excepciones.length ? d.excepciones.map(function (r) { return '<div class="s">' + etiq(r) + linea(r) + '<p class="msg">' + motivo(r) + '</p>' + boton('Ver detalle', 'ver', r.id) + (r.estado === 'pago_verificado' ? boton('Confirmar reserva', 'confirmar', r.id, 'pri') : '') + boton('Marcar como resuelto', 'resolver', r.id) + '</div>'; }).join('') : '<p class="vacio">Nada pendiente. El sistema está funcionando solo. ✓</p>';
  if (d.devoluciones.length) h += '<h2>Devoluciones pendientes (' + d.devoluciones.length + ')</h2>' + d.devoluciones.map(function (x) { return '<div class="s">' + (x.origen === 'prueba' ? '<span class="e prueba">prueba</span>' : '') + '<b>' + esc(x.numero) + '</b> · devolver <b>' + p(x.monto) + '</b> · ' + esc(x.nombre) + ' · ' + esc(x.telefono) + '<div class="m">' + esc(MOTIVOS[x.motivo] || x.motivo) + ' · ' + fh(x.creada) + '</div>' + boton('Devolución realizada', 'dev-realizada', x.id, 'pri') + boton('Descartar', 'dev-descartada', x.id) + '</div>'; }).join('');
  h += '<h2>En curso: esperando pago (' + d.pendientes.length + ')</h2>';
  h += d.pendientes.length ? d.pendientes.map(function (r) { return '<div class="s">' + etiq(r) + linea(r) + '<div class="m">Retenida hasta ' + fh(r.vence_en) + '</div>' + (r.medio_pago === 'transferencia' && r.estado === 'bloqueo' ? boton('Seña acreditada (transferencia verificada)', 'acreditar', r.id, 'pri') : '') + boton('Ver detalle', 'ver', r.id) + (['bloqueo', 'pendiente_pago'].includes(r.estado) ? boton('Cancelar y liberar fechas', 'cancelar', r.id, 'no') : '') + '</div>'; }).join('') : '<p class="vacio">No hay pagos en curso.</p>';
  h += '<h2>Próximas llegadas confirmadas (' + d.proximas.length + ')</h2>';
  h += d.proximas.length ? d.proximas.map(function (r) { return '<div class="s">' + etiq(r) + linea(r) + '<div class="m">Saldo a cobrar al ingresar: <b>' + p(r.saldo) + '</b> · confirmada ' + (r.confirmada_por === 'automatica' ? 'automáticamente' : 'por ' + esc(r.confirmada_por)) + ' el ' + fh(r.confirmada_en) + '</div>' + boton('Ver detalle', 'ver', r.id) + '</div>'; }).join('') : '<p class="vacio">No hay llegadas confirmadas.</p>';
  el.innerHTML = h; pintarSistema(s);
}
function pintarSistema(s) {
  var si = function (b, t, n) { return '<b class="' + (b ? 'si' : 'nn') + '">' + (b ? t : n) + '</b>'; };
  $('#v-sistema').innerHTML = '<h2>Estado del sistema</h2><div class="grid">' +
    '<div class="kv"><small>Modo de reserva en la web</small><b>' + ({ whatsapp: 'WhatsApp (actual)', solicitud: 'Solicitud con aprobación', instantanea: 'Reserva automática' }[s.modo_reserva] || s.modo_reserva) + '</b></div>' +
    '<div class="kv"><small>Disponibilidad externa</small><b>' + (s.proveedor === 'smoobu' ? 'Smoobu (gestor de canales)' : 'iCal de Booking y Airbnb') + '</b></div>' +
    '<div class="kv"><small>Gestor cierra Booking/Airbnb</small>' + si(s.gestor_bloqueo_verificado, 'Verificado', 'No verificado') + '</div>' +
    '<div class="kv"><small>Confirmación automática</small>' + si(s.confirmacion_automatica, 'Activada', 'Apagada') + '</div>' +
    '<div class="kv"><small>Cobros con Mercado Pago</small>' + si(s.pagos_habilitados, 'Activados', 'Apagados') + ' <span class="m">(' + esc(s.mp_modo) + ')</span></div>' +
    '<div class="kv"><small>Retención para pagar</small><b>' + s.retencion_mp_min + ' min (Mercado Pago) · ' + s.retencion_transferencia_h + ' h (transferencia)</b></div>' +
    '<div class="kv"><small>Avisos por Telegram</small>' + si(s.telegram, 'Configurados', 'Sin configurar') + '<br><button id="tg-probar">Enviar aviso de prueba</button> <span id="tg-msg" class="m"></span></div></div>' +
    '<p class="m">Los interruptores se cambian en la configuración del servidor (no desde el panel), con autorización.</p>';
  $('#tg-probar').onclick = async function () { var m = $('#tg-msg'); m.textContent = 'Enviando…'; try { var r = await post('/api/admin/telegram/prueba'); m.textContent = r.ok ? '✓ Enviado: revisá Telegram.' : '✗ ' + r.motivo; } catch (e) { m.textContent = '✗ ' + e.message; } };
}
async function verReservas() {
  var vista = (document.getElementById('vista') || {}).value || 'activas';
  var d = await api('/api/admin/reservas?vista=' + vista);
  $('#v-reservas').innerHTML = '<h2>Reservas</h2><p><select id="vista"><option value="activas">Activas</option><option value="confirmadas">Confirmadas</option><option value="excepciones">Con excepción</option><option value="terminadas">Vencidas y canceladas</option><option value="todas">Todas</option></select></p>' +
    (d.reservas.length ? '<table><tr><th>Reserva</th><th>Estado</th><th>Fechas</th><th>Huésped</th><th>Seña / pagado</th><th>Saldo</th><th>Medio</th></tr>' + d.reservas.map(function (r) { return '<tr class="fila" data-id="' + r.id + '"><td><b>' + esc(r.numero || r.id.slice(0, 8)) + '</b></td><td>' + etiq(r) + (r.excepcion ? '<div class="m">⚠ ' + esc(r.excepcion) + '</div>' : '') + '</td><td>' + f(r.ingreso) + ' → ' + f(r.salida) + '<div class="m">' + r.noches + ' noches · ' + r.huespedes + ' h.</div></td><td>' + esc(r.nombre) + '<div class="m">' + esc(r.telefono) + '</div></td><td>' + p(r.sena) + '<div class="m">pagado ' + p(r.pagado) + '</div></td><td>' + p(r.saldo) + '</td><td>' + medio(r) + '</td></tr>'; }).join('') + '</table>' : '<p class="vacio">No hay reservas en esta vista.</p>');
  $('#vista').value = vista; $('#vista').onchange = verReservas;
}
async function verDetalle(id) {
  var d = await api('/api/admin/reservas/' + id), r = d.reserva;
  $('#dlg-c').innerHTML = '<h2>' + etiq(r) + ' Reserva ' + esc(r.numero || r.id.slice(0, 8)) + '</h2>' + linea(r) +
    (r.excepcion ? '<p class="msg">' + motivo(r) + '</p>' : '') +
    '<p class="m">Total ' + p(r.total) + ' · seña ' + p(r.sena) + ' · pagado ' + p(r.pagado) + ' · saldo ' + p(r.saldo) + ' · ' + r.adultos + ' adultos, ' + r.menores + ' menores' + (r.observaciones ? '<br>Nota: ' + esc(r.observaciones) : '') + '<br>Gestor: ' + esc(r.cm_proveedor || '—') + ' (' + esc(r.cm_estado || '—') + (r.cm_ref ? ', ref ' + esc(r.cm_ref) : '') + ') · Mercado Pago: ' + esc(r.mp_estado || '—') + '</p>' +
    '<h3>Pagos</h3>' + (d.pagos.length ? d.pagos.map(function (x) { return '<div class="ev">' + p(x.monto) + ' · ' + esc(x.estado) + ' ' + esc(x.estado_detalle || '') + ' · ' + esc(x.medio || '') + (x.modo_prueba ? ' · prueba' : '') + ' · ' + fh(x.recibido) + '</div>'; }).join('') : '<p class="m">Sin pagos.</p>') +
    (d.devoluciones.length ? '<h3>Devoluciones</h3>' + d.devoluciones.map(function (x) { return '<div class="ev">' + p(x.monto) + ' · ' + esc(x.estado) + ' · ' + esc(x.motivo) + '</div>'; }).join('') : '') +
    '<h3>Historial</h3>' + d.eventos.map(function (e) { return '<div class="ev"><b>' + esc(e.tipo.replace(/_/g, ' ')) + '</b> · ' + fh(e.fecha) + '</div>'; }).join('');
  $('#dlg').showModal();
}
var calOff = 0;
async function verCalendario() {
  var base = new Date(), hoy = new Date(base.getFullYear(), base.getMonth() + calOff, 1), desde = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-01';
  var d = await api('/api/admin/calendario?desde=' + desde + '&meses=4'), html = '<h2>Calendario de ocupación</h2><p><button id="cal-ant"' + (calOff <= 0 ? ' disabled' : '') + '>‹ Meses anteriores</button><button id="cal-sig">Meses siguientes ›</button></p><div class="ley"><span><i class="t-confirmada"></i>Confirmada (web)</span><span><i class="t-retenida"></i>Retenida / pago en curso</span><span><i class="t-externa"></i>Booking / Airbnb</span><span><i class="t-directa_manual"></i>Directa cargada a mano</span><span><i class="t-prueba"></i>Prueba (no bloquea)</span></div><div class="cal">';
  for (var k = 0; k < 4; k++) {
    var m0 = new Date(hoy.getFullYear(), hoy.getMonth() + k, 1), dias = new Date(m0.getFullYear(), m0.getMonth() + 1, 0).getDate(), lead = (m0.getDay() + 6) % 7;
    var tm = m0.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    html += '<div class="mes"><h3>' + tm.charAt(0).toUpperCase() + tm.slice(1) + '</h3><div class="dias">' + 'lu ma mi ju vi sá do'.split(' ').map(function (x) { return '<div class="m">' + x + '</div>'; }).join('') + '<div></div>'.repeat(lead);
    for (var i = 1; i <= dias; i++) {
      var fe = m0.getFullYear() + '-' + String(m0.getMonth() + 1).padStart(2, '0') + '-' + String(i).padStart(2, '0'), it = d.dias[fe] || [];
      var real = it.filter(function (x) { return x.tipo !== 'prueba'; }), t = real[0] ? real[0].tipo : (it[0] ? 'prueba' : '');
      html += '<div class="dia ' + (t ? 't-' + t : '') + '" title="' + esc(it.map(function (x) { return x.tipo + (x.numero ? ' ' + x.numero : '') + (x.fuente ? ' ' + x.fuente : ''); }).join(', ')) + '"><b>' + i + '</b>' + (real[0] && real[0].numero ? '<span>' + esc(real[0].numero.slice(-4)) + '</span>' : real[0] && real[0].fuente ? '<span>' + esc(real[0].fuente) + '</span>' : '') + '</div>';
    }
    html += '</div></div>';
  }
  $('#v-calendario').innerHTML = html + '</div><p class="m">Sincronización con Booking/Airbnb: ' + (d.sincronizado ? fh(d.sincronizado) : 'sin datos') + '. Bloqueos manuales: próximamente.</p>';
  $('#cal-ant').onclick = function () { calOff = Math.max(0, calOff - 4); verCalendario(); };
  $('#cal-sig').onclick = function () { calOff = Math.min(16, calOff + 4); verCalendario(); };
}
async function verSolicitudes() {
  var d = await api('/api/admin/solicitudes');
  $('#v-solicitudes').innerHTML = '<h2>Solicitudes (modo con aprobación manual)</h2><p class="m">Se usan solo si la web está en modo "solicitud", o como alternativa ante excepciones.</p>' + (d.solicitudes.map(function (s) { return '<div class="s" data-sid="' + s.id + '"><span class="e ' + s.estado + '">' + s.estado + '</span>' + (s.origen === 'prueba' ? '<span class="e prueba">prueba</span>' : '') + '<b>' + esc(s.numero) + '</b> · ' + f(s.ingreso) + ' → ' + f(s.salida) + ' · ' + s.noches + ' noches · ' + s.huespedes + ' huéspedes · total ' + p(s.total) + ' · seña ' + p(s.sena) +
    '<div class="m">' + esc(s.nombre) + ' · ' + esc(s.telefono) + (s.email ? ' · ' + esc(s.email) : '') + (s.retencion_vence ? ' · retenida hasta ' + fh(s.retencion_vence) : '') + '</div>' + (s.observaciones ? '<div class="m">Nota: ' + esc(s.observaciones) + '</div>' : '') +
    (['nueva', 'vencida'].includes(s.estado) ? '<button data-sa="revisar">Revisar disponibilidad</button><button class="pri" data-sa="aprobar">Aprobar y retener fechas</button>' : '') + (['nueva', 'aprobada', 'vencida'].includes(s.estado) ? '<button class="no" data-sa="rechazar">Rechazar</button>' : '') + '<p class="msg"></p></div>'; }).join('') || '<p class="vacio">No hay solicitudes.</p>');
}
var VISTAS = { resumen: verResumen, reservas: verReservas, calendario: verCalendario, solicitudes: verSolicitudes, sistema: verResumen };
var actual = 'resumen';
function mostrar(t) { actual = t; document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.t === t); }); Object.keys(VISTAS).forEach(function (k) { $('#v-' + k).hidden = k !== t; }); return VISTAS[t]().catch(function (e) { $('#v-' + t).innerHTML = '<p class="msg">' + esc(e.message) + '</p>'; }); }
$('#tabs').onclick = function (e) { var b = e.target.closest('button[data-t]'); if (b) mostrar(b.dataset.t); };
$('#dlg-x').onclick = function () { $('#dlg').close(); };
document.addEventListener('click', async function (e) {
  var fila = e.target.closest('tr.fila'); if (fila) return verDetalle(fila.dataset.id);
  var b = e.target.closest('button[data-acc]');
  if (b) {
    var id = b.dataset.id, a = b.dataset.acc;
    try {
      if (a === 'ver') return verDetalle(id);
      if (a === 'confirmar' && !confirm('¿Confirmás esta reserva? Verificá antes que las fechas estén cerradas en Booking y Airbnb.')) return;
      if (a === 'acreditar' && !confirm('¿Verificaste en tu cuenta que la transferencia de la seña está acreditada?')) return;
      if (a === 'cancelar' && !confirm('¿Cancelar la reserva y liberar las fechas?')) return;
      if (a === 'dev-realizada' && !confirm('¿Ya devolviste el dinero al huésped?')) return;
      var r = a === 'confirmar' ? await post('/api/admin/reservas/' + id + '/confirmar') : a === 'acreditar' ? await post('/api/admin/reservas/' + id + '/acreditar-transferencia')
        : a === 'cancelar' ? await post('/api/admin/reservas/' + id + '/cancelar', { motivo: prompt('Motivo (opcional):') || '' }) : a === 'resolver' ? await post('/api/admin/reservas/' + id + '/resolver', { nota: prompt('Nota (opcional):') || '' })
        : a === 'dev-realizada' ? await post('/api/admin/devoluciones/' + id + '/realizada') : a === 'dev-descartada' ? await post('/api/admin/devoluciones/' + id + '/descartada') : null;
      if (r && r.resultado) alert(r.resultado === 'confirmada' ? 'Reserva confirmada. El huésped ya lo ve en su enlace.' : 'Resultado: ' + r.resultado);
      mostrar(actual);
    } catch (err) { alert(err.message); }
    return;
  }
  var sb = e.target.closest('button[data-sa]'); if (!sb) return;
  var card = sb.closest('[data-sid]'), msg = card.querySelector('.msg'), sid = card.dataset.sid, sa = sb.dataset.sa, body = {};
  if (sa === 'aprobar') { var hh = prompt('¿Cuántas horas retener las fechas? (1 a 72)', '48'); if (hh === null) return; body.horas = Number(hh); if (!confirm('¿Confirmás que revisaste Booking y Airbnb y las fechas están libres?')) return; }
  if (sa === 'rechazar') { var mm = prompt('Motivo (opcional, no se envía al huésped):', 'Fechas no disponibles'); if (mm === null) return; body.motivo = mm; }
  var enviar = function () { return post('/api/admin/solicitudes/' + sid + '/' + sa, body); };
  try {
    var r;
    try { r = await enviar(); } catch (err) { if (err.codigo !== 'verificacion_en_vivo' || !confirm(err.message + '\n\n¿Lo revisaste a mano y está libre?')) throw err; body.forzar = true; r = await enviar(); }
    if (sa === 'revisar') { var v = r.en_vivo || {}; msg.textContent = (r.disponible ? '✓ Libre. ' : '✗ No disponible. ') + 'En vivo: ' + ((v.consultadas || []).join(', ') || 'ninguna') + (v.ocupadas_en && v.ocupadas_en.length ? ' · OCUPADO en ' + v.ocupadas_en.join(', ') : '') + (v.fallaron && v.fallaron.length ? ' · sin respuesta: ' + v.fallaron.join(', ') : '') + '. ' + (r.advertencias || []).join(' · '); return; }
    if (sa === 'aprobar' && r.siguiente_paso) alert('Aprobada. ' + r.siguiente_paso);
    verSolicitudes();
  } catch (err) { msg.textContent = err.message; }
});
async function iniciar() { var yo = await api('/api/admin/yo'); document.getElementById('login').hidden = true; $('#info').textContent = 'Ingresaste como ' + yo.usuario; mostrar(actual); }
$('#entrar').onclick = function () { sessionStorage.setItem('clave', $('#clave').value); iniciar().catch(function () {}); };
iniciar().catch(function () {});
</script></body></html>`;
