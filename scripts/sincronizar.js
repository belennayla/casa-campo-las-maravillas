#!/usr/bin/env node
/*
  Sincronización de calendarios · Casa Campo Las Maravillas

  1. Lee los calendarios iCal de Airbnb, Booking, Vrbo, etc. (variable ICAL_URLS).
  2. Junta esas fechas con las reservas directas cargadas en data/casa.json.
  3. Escribe:
     - data/ocupadas-sync.json  → lo usa la web para mostrar fechas ocupadas.
     - calendario.ics           → todas las fechas ocupadas.
     - calendario-<fuente>.ics  → todo MENOS lo que vino de esa fuente
                                  (es el link que se pega en cada plataforma, así no se pisa a sí misma).

  ICAL_URLS: una línea por plataforma, "nombre URL". Ejemplo:
     airbnb https://www.airbnb.com.ar/calendar/ical/123.ics?s=abc
     booking https://ical.booking.com/v1/export?t=xyz

  Si una plataforma no responde, se reutilizan sus fechas de la última sincronización publicada
  (SITE_URL), para no mostrar como libres fechas que estaban ocupadas.

  Uso local:  node scripts/sincronizar.js
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLATAFORMAS = ['airbnb', 'booking', 'vrbo'];
const DOMINIO = 'casacampolasmaravillas';

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

/* ---------- Lectura de iCal ---------- */
function parseIcal(texto) {
  const lineas = texto.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n'); // desplegar líneas partidas
  const eventos = []; let ev = null;
  for (const l of lineas) {
    if (l === 'BEGIN:VEVENT') ev = {};
    else if (l === 'END:VEVENT') { if (ev && ev.desde) eventos.push(ev); ev = null; }
    else if (ev) {
      const i = l.indexOf(':'); if (i < 0) continue;
      const clave = l.slice(0, i).split(';')[0].toUpperCase(), valor = l.slice(i + 1).trim();
      if (clave === 'DTSTART') ev.desde = fecha(valor);
      if (clave === 'DTEND') ev.hasta = fecha(valor);
      if (clave === 'STATUS') ev.estado = valor.toUpperCase();
    }
  }
  return eventos
    .filter(e => e.estado !== 'CANCELLED')
    .map(e => ({ desde: e.desde, hasta: e.hasta && e.hasta > e.desde ? e.hasta : addDays(e.desde, 1) }));
}
function fecha(v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/* ---------- Escritura de iCal ---------- */
function crearIcal(bloques, nombre) {
  const sello = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ev = bloques.map(b => [
    'BEGIN:VEVENT',
    `UID:${b.desde}-${b.hasta}-${b.fuente}@${DOMINIO}`,
    `DTSTAMP:${sello}`,
    `DTSTART;VALUE=DATE:${b.desde.replace(/-/g, '')}`,
    `DTEND;VALUE=DATE:${b.hasta.replace(/-/g, '')}`,
    'SUMMARY:No disponible',
    'END:VEVENT'
  ].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//Casa Campo Las Maravillas//${nombre}//ES`,
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Casa Campo Las Maravillas', ...ev, 'END:VCALENDAR', ''].join('\r\n');
}

/* ---------- Principal ---------- */
async function main() {
  const casa = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/casa.json'), 'utf8').replace(/^﻿/, ''));
  const desdeHoy = hoy();
  const fuentes = (process.env.ICAL_URLS || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => {
      // Acepta "booking https://..." o solo el link (el nombre se deduce del dominio)
      const partes = l.split(/\s+/), url = partes.find(p => /^https?:\/\//i.test(p));
      if (!url) return null;
      let nombre = partes[0] !== url ? partes[0].toLowerCase() : '';
      if (!nombre) { const h = new URL(url).hostname; nombre = ['airbnb', 'booking', 'vrbo'].find(n => h.includes(n)) || h.split('.').slice(-2, -1)[0]; }
      return { nombre, url };
    })
    .filter(Boolean);

  let anterior = null;
  if (process.env.SITE_URL) {
    try { anterior = await (await fetch(process.env.SITE_URL.replace(/\/$/, '') + '/data/ocupadas-sync.json', { cache: 'no-store' })).json(); }
    catch { /* primera vez o sitio no publicado */ }
  }

  const estado = {}, bloques = [];
  for (const f of fuentes) {
    try {
      const r = await fetch(f.url, { headers: { 'User-Agent': 'CasaCampoLasMaravillas-calendario/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const texto = await r.text();
      if (!texto.includes('BEGIN:VCALENDAR')) throw new Error('la respuesta no es un calendario');
      const evs = parseIcal(texto).filter(b => b.hasta > desdeHoy);
      evs.forEach(b => bloques.push({ ...b, fuente: f.nombre }));
      estado[f.nombre] = { ok: true, eventos: evs.length, actualizado: new Date().toISOString() };
      console.log(`✓ ${f.nombre}: ${evs.length} bloques`);
    } catch (e) {
      const prev = anterior && anterior.ocupadas ? anterior.ocupadas.filter(b => b.fuente === f.nombre && b.hasta > desdeHoy) : [];
      prev.forEach(b => bloques.push(b));
      estado[f.nombre] = { ok: false, error: e.message, eventos: prev.length, actualizado: anterior?.fuentes?.[f.nombre]?.actualizado || null };
      console.log(`✗ ${f.nombre}: ${e.message} (se reutilizan ${prev.length} bloques anteriores)`);
    }
  }

  bloques.sort((a, b) => a.desde.localeCompare(b.desde));
  const sync = { actualizado: new Date().toISOString(), fuentes: estado, ocupadas: bloques };
  fs.writeFileSync(path.join(ROOT, 'data/ocupadas-sync.json'), JSON.stringify(sync, null, 1));

  // Reservas directas y bloqueos manuales (sin datos personales)
  const directas = (casa.ocupadas || []).filter(b => b.hasta > desdeHoy).map(b => ({ desde: b.desde, hasta: b.hasta, fuente: 'directa' }));
  const todas = [...directas, ...bloques];
  fs.writeFileSync(path.join(ROOT, 'calendario.ics'), crearIcal(todas, 'todas'));
  const nombres = new Set([...PLATAFORMAS, ...fuentes.map(f => f.nombre)]);
  for (const n of nombres) fs.writeFileSync(path.join(ROOT, `calendario-${n}.ics`), crearIcal(todas.filter(b => b.fuente !== n), n));
  console.log(`Listo: ${directas.length} directas + ${bloques.length} de plataformas · calendarios: ${[...nombres].join(', ')}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { parseIcal, crearIcal };
