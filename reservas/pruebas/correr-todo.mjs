// Corre las tres baterías de pruebas, cada una con base local LIMPIA y servicios simulados.
// Uso (desde reservas/): node pruebas/correr-todo.mjs
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const PERSIST = path.join(os.homedir(), '.cc-reservas-local');
const vars = Object.fromEntries(fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const esperar = ms => new Promise(r => setTimeout(r, ms));
const listo = async url => { for (let i = 0; i < 60; i++) { try { await fetch(url); return; } catch { await esperar(1000); } } throw new Error('no arrancó ' + url); };

const simulado = spawn(process.execPath, ['pruebas/mp-simulado.mjs'], { stdio: 'ignore' });
await listo('http://127.0.0.1:8790/__control/resumen');
const baterias = [
  ['pagos', 'pruebas/pruebas-pagos.mjs'],
  ['solicitudes', 'pruebas/pruebas-solicitudes.mjs'],
  ['reservas', 'pruebas/pruebas.mjs']
];
const resultado = {};
for (const [nombre, archivo] of baterias) {
  fs.rmSync(PERSIST, { recursive: true, force: true });
  execSync(`npx.cmd wrangler d1 migrations apply reservas --local --persist-to "${PERSIST}"`, { stdio: 'ignore' });
  const dev = spawn('npx.cmd', ['wrangler', 'dev', '--local', '--test-scheduled', '--port', '8787', '--persist-to', `"${PERSIST}"`,
    '--var', 'MP_API_BASE:http://127.0.0.1:8790', '--var', 'ORDEN_MIN_SEGUNDOS:3', '--var', 'MP_GRACIA_SEG:0', '--var', 'SOLICITUDES_HABILITADAS:true',
    '--var', 'TURNSTILE_API_BASE:http://127.0.0.1:8790', '--var', 'TELEGRAM_API_BASE:http://127.0.0.1:8790'], { stdio: 'ignore', shell: true });
  await listo('http://127.0.0.1:8787/api/salud');
  const salida = await new Promise(ok => {
    const p = spawn(process.execPath, [archivo], { env: { ...process.env, BASE: 'http://127.0.0.1:8787', CLAVE: vars.CLAVE_PRUEBAS, SECRETO: vars.MP_WEBHOOK_SECRET, ADMIN: vars.ADMIN_CLAVE, PERSIST } });
    let t = ''; p.stdout.on('data', d => t += d); p.stderr.on('data', d => t += d); p.on('close', c => ok({ c, t }));
  });
  const oks = (salida.t.match(/^  OK /gm) || []).length, mal = salida.t.split('\n').filter(l => l.startsWith('  MAL') || /Error/.test(l));
  resultado[nombre] = { ok: oks, fallas: mal };
  console.log(`== ${nombre}: ${oks} OK, ${mal.length} fallas`); mal.forEach(l => console.log('   ' + l));
  execSync(`taskkill /PID ${dev.pid} /T /F`, { stdio: 'ignore' });
  await esperar(2000);
}
simulado.kill();
fs.rmSync(PERSIST, { recursive: true, force: true });
process.exit(Object.values(resultado).some(r => r.fallas.length) ? 1 : 0);
