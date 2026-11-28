// Genera y carga CLAVE_PRUEBAS en el Worker público de forma VERIFICABLE, sin mostrarla nunca:
//  1) genera una clave aleatoria ("prueba-" + 64 hex);
//  2) se la pasa a Wrangler como bytes exactos por la entrada estándar (sin pegar en la pregunta oculta, sin BOM ni saltos);
//  3) espera a que el servidor la tenga y comprueba que la RECONOCE (y que longitud y huella coinciden);
//  4) la deja en el portapapeles de Windows para pegarla UNA vez en diagnostico.html.
// Uso (desde reservas/):  node scripts-locales/cargar-clave-pruebas.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const API = 'https://reservas-casacampo.reservas-casacampo.workers.dev';
const clave = 'prueba-' + crypto.randomBytes(32).toString('hex');
const huella = crypto.createHash('sha256').update(clave).digest('hex').slice(0, 10);
const correr = (cmd, args, entrada) => new Promise((ok, mal) => {
  const p = spawn(cmd, args, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let salida = ''; p.stdout.on('data', d => salida += d); p.stderr.on('data', d => salida += d);
  p.on('close', c => (c === 0 ? ok(salida) : mal(new Error(salida.split('\n').filter(l => /rror/.test(l)).join(' ') || 'código ' + c))));
  p.stdin.end(Buffer.from(entrada, 'ascii'));
});
const esperar = ms => new Promise(r => setTimeout(r, ms));

console.log(`Clave nueva generada: ${clave.length} caracteres · huella SHA-256 ${huella} (la clave no se muestra)`);
const out = await correr('npx.cmd', ['wrangler', 'secret', 'put', 'CLAVE_PRUEBAS'], clave);
console.log(/Success/.test(out) ? 'Wrangler: secreto cargado en "reservas-casacampo".' : 'Wrangler respondió sin "Success": ' + out.slice(-200));

let h = null, reconoce = false;
for (let i = 0; i < 20 && !reconoce; i++) {
  await esperar(3000);
  h = await (await fetch(API + '/api/pruebas/huella-clave', { cache: 'no-store' })).json();
  const s = await (await fetch(API + '/api/salud', { headers: { 'x-clave-pruebas': clave }, cache: 'no-store' })).json();
  reconoce = s.modo_reserva === 'instantanea';
}
console.log(`Servidor: largo ${h.largo} · útil ${h.largo_util} · BOM ${h.bom} · espacios/saltos ${h.espacios_o_saltos} · huella ${h.huella_sha256}`);
console.log(h.huella_sha256 === huella && h.largo === clave.length ? '✅ La huella y la longitud del servidor COINCIDEN con la clave generada.' : '❌ La huella del servidor NO coincide.');
console.log(reconoce ? '✅ El servidor RECONOCE la clave (modo de reserva automática para pruebas).' : '❌ El servidor todavía no reconoce la clave.');
if (reconoce) { await correr('clip', [], clave); console.log('📋 La clave quedó en el portapapeles de Windows (no se muestra).'); }
process.exit(reconoce ? 0 : 1);
