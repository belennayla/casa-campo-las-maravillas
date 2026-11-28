#!/usr/bin/env node
/*
  Arma la carpeta _site con SOLO los archivos públicos de la web (lista blanca).
  Todo lo demás (reservas/, scripts/, .github/, INSTRUCTIVO.md, servidor.js, etc.) NO se publica.
  Uso: node scripts/armar-sitio.js   (después de scripts/sincronizar.js)
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');

// Archivos y carpetas que forman la web pública.
const PUBLICOS = [
  'index.html', 'reserva.html', 'robots.txt', 'sitemap.xml', 'llms.txt',
  'css', 'js', 'img',
  'data/casa.json', 'data/ocupadas-sync.json'
];
// Archivos públicos por patrón en la raíz: calendarios generados y verificación de Google Search Console.
const PATRONES = [/^calendario(-[a-z0-9]+)?\.ics$/, /^google[0-9a-f]+\.html$/];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copiados = [];
for (const rel of PUBLICOS) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { console.log(`⚠ No existe (se omite): ${rel}`); continue; }
  fs.cpSync(src, path.join(OUT, rel), { recursive: true });
  copiados.push(rel);
}
for (const f of fs.readdirSync(ROOT)) {
  if (PATRONES.some(p => p.test(f))) { fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f)); copiados.push(f); }
}

// Versionado de CSS y JS: las páginas piden "js/app.js?v=<huella>". Si el archivo cambia, cambia la dirección y ningún
// navegador puede combinar una página nueva con un script viejo guardado en caché (GitHub Pages cachea 10 minutos).
const crypto = require('crypto');
const huella = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, rel))).digest('hex').slice(0, 10);
for (const pagina of ['index.html', 'reserva.html']) {
  const p = path.join(OUT, pagina);
  if (!fs.existsSync(p)) continue;
  let html = fs.readFileSync(p, 'utf8');
  html = html.replace(/(src|href)="((?:js|css)\/[a-z0-9-]+\.(?:js|css))"/g, (m, attr, rel) =>
    fs.existsSync(path.join(OUT, rel)) ? `${attr}="${rel}?v=${huella(rel)}"` : m);
  fs.writeFileSync(p, html);
}

// Control de seguridad: nada interno puede quedar dentro de _site.
const PROHIBIDOS = [/^reservas(\/|$)/, /^scripts(\/|$)/, /^\.github/, /^\.git(\/|$)/, /\.dev\.vars/, /node_modules/, /^INSTRUCTIVO\.md$/, /^servidor\.js$/, /wrangler\.toml$/, /\.wrangler/];
const todos = [];
(function recorrer(dir, base = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) recorrer(path.join(dir, e.name), rel); else todos.push(rel);
  }
})(OUT);
const mal = todos.filter(f => PROHIBIDOS.some(p => p.test(f)));
if (mal.length) { console.error('✗ Archivos internos en _site: ' + mal.join(', ')); process.exit(1); }
console.log(`✓ _site armado: ${todos.length} archivos (${copiados.join(', ')})`);
