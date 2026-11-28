// Carga TURNSTILE_SECRET en el Worker público de forma VERIFICABLE, sin mostrarlo nunca:
//  1) lee la Secret Key desde el portapapeles de Windows (copiala antes desde Cloudflare → Turnstile → widget → Settings);
//  2) controla el formato (empieza con 0x, sin espacios, no es la Site Key pública);
//  3) se la pasa a Wrangler como bytes exactos por la entrada estándar (sin pegar en la pregunta oculta);
//  4) le pregunta a Cloudflare, a través del Worker, si el secreto es válido;
//  5) vacía el portapapeles.
// Uso (desde reservas/):  node scripts-locales/cargar-secreto-turnstile.mjs
import { spawn } from 'node:child_process';

const API = 'https://reservas-casacampo.reservas-casacampo.workers.dev';
const SITE_KEY = '0x4AAAAAAGWei8r_RVtyCtJk'; // pública (casa.json): sirve para detectar si se copió la clave equivocada
const correr = (cmd, args, entrada) => new Promise((ok, mal) => {
  const p = spawn(cmd, args, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let salida = ''; p.stdout.on('data', d => salida += d); p.stderr.on('data', d => salida += d);
  p.on('close', c => (c === 0 ? ok(salida) : mal(new Error(salida.split('\n').filter(l => /rror/.test(l)).join(' ') || 'código ' + c))));
  p.stdin.end(entrada == null ? undefined : Buffer.from(entrada, 'utf8'));
});
const esperar = ms => new Promise(r => setTimeout(r, ms));

const secreto = (await correr('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'])).replace(/^﻿/, '').trim();
const problemas = [];
if (!secreto) problemas.push('el portapapeles está vacío');
if (secreto === SITE_KEY) problemas.push('copiaste la SITE KEY (pública); hace falta la SECRET KEY');
if (secreto && !secreto.startsWith('0x')) problemas.push('no empieza con "0x"');
if (/\s/.test(secreto)) problemas.push('tiene espacios o saltos de línea en el medio');
if (secreto && (secreto.length < 25 || secreto.length > 80)) problemas.push(`largo inusual (${secreto.length} caracteres)`);
if (problemas.length) { console.log('❌ No se cargó nada: ' + problemas.join('; ') + '.'); process.exit(1); }
console.log(`Secreto leído del portapapeles: ${secreto.length} caracteres, formato correcto (no se muestra).`);

const out = await correr('npx.cmd', ['wrangler', 'secret', 'put', 'TURNSTILE_SECRET'], secreto);
console.log(/Success/.test(out) ? 'Wrangler: secreto cargado en "reservas-casacampo".' : 'Wrangler respondió sin "Success": ' + out.slice(-200));
await correr('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value $null']).catch(() => {});
console.log('Portapapeles vaciado.');

let t = null;
for (let i = 0; i < 20; i++) {
  await esperar(3000);
  t = await (await fetch(API + '/api/pruebas/turnstile', { cache: 'no-store' })).json();
  if (t.largo === secreto.length && t.secreto_valido) break;
}
console.log(`Servidor: ${t.largo} caracteres · Cloudflare responde: ${(t.cloudflare || []).join(', ')}`);
console.log(t.secreto_valido ? '✅ Cloudflare ACEPTA el secreto: Turnstile puede validar las verificaciones de la web.' : '❌ Cloudflare RECHAZA el secreto: revisá que sea la Secret Key del widget «Formulario Casa Campo».');
process.exit(t.secreto_valido ? 0 : 1);
