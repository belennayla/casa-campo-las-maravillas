// Corre todas las baterías de pruebas, cada una con base local LIMPIA, servicios simulados (Mercado Pago, Turnstile,
// Telegram, iCal, Access y un gestor de canales con la API de Smoobu), el Worker público (8787) y el del panel (8788).
// Uso (desde reservas/): node pruebas/correr-todo.mjs            → todas
//                        node pruebas/correr-todo.mjs smoobu ical → solo esas
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const PERSIST = path.join(os.homedir(), '.cc-reservas-local');
const vars = Object.fromEntries(fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const esperar = ms => new Promise(r => setTimeout(r, ms));
const listo = async url => { for (let i = 0; i < 90; i++) { try { await fetch(url); return; } catch { await esperar(1000); } } throw new Error('no arrancó ' + url); };
const iniciar = args => spawn('npx.cmd', args, { stdio: 'ignore', shell: true });
const v = o => Object.entries(o).flatMap(([k, x]) => ['--var', `${k}:${x}`]);

// Servicios simulados: los usan los dos Workers.
const SIM = 'http://127.0.0.1:8790';
const COMUNES = { MP_API_BASE: SIM, ORDEN_MIN_SEGUNDOS: 3, MP_GRACIA_SEG: 0, TURNSTILE_API_BASE: SIM, TURNSTILE_HOSTNAMES: 'localhost', TELEGRAM_API_BASE: SIM };
const SMOOBU = { PROVEEDOR_DISPONIBILIDAD: 'smoobu', SMOOBU_API_BASE: SIM, SMOOBU_API_KEY: 'clave-smoobu-simulada', SMOOBU_API_SECRET: 'secreto-smoobu-simulado-0123456789',
  SMOOBU_APARTAMENTO_ID: 501, SMOOBU_WEBHOOK_TOKEN: 'token-webhook-gestor-simulado-0123456789abcdef' };
const baterias = [
  ['pagos', 'pruebas/pruebas-pagos.mjs', {}],
  ['solicitudes', 'pruebas/pruebas-solicitudes.mjs', { SOLICITUDES_HABILITADAS: 'true' }],
  ['reservas', 'pruebas/pruebas.mjs', {}],
  ['auto-produccion', 'pruebas/pruebas-automaticas.mjs', {}, 'produccion'],
  ['auto-ical', 'pruebas/pruebas-automaticas.mjs', { PRUEBAS_USAN_PROVEEDOR: 'true', CONFIRMACION_AUTOMATICA_PRUEBAS: 'true' }, 'ical'],
  ['auto-smoobu', 'pruebas/pruebas-automaticas.mjs', { ...SMOOBU, SMOOBU_BLOQUEO_VERIFICADO: 'true', PRUEBAS_USAN_PROVEEDOR: 'true', CONFIRMACION_AUTOMATICA_PRUEBAS: 'true' }, 'smoobu'],
  ['auto-smoobu-sin-verificar', 'pruebas/pruebas-automaticas.mjs', { ...SMOOBU, PRUEBAS_USAN_PROVEEDOR: 'true', CONFIRMACION_AUTOMATICA_PRUEBAS: 'true' }, 'smoobu_sin_verificar'],
  ['auto-aislamiento', 'pruebas/pruebas-automaticas.mjs', { ...SMOOBU, SMOOBU_BLOQUEO_VERIFICADO: 'true', CONFIRMACION_AUTOMATICA_PRUEBAS: 'true' }, 'aislamiento']
];
const elegidas = process.argv.slice(2);

const simulado = spawn(process.execPath, ['pruebas/mp-simulado.mjs'], { stdio: 'ignore' });
await listo(SIM + '/__control/resumen');
const resultado = {};
for (const [nombre, archivo, extra, escenario] of baterias) {
  if (elegidas.length && !elegidas.some(e => nombre.includes(e))) continue;
  fs.rmSync(PERSIST, { recursive: true, force: true });
  execSync(`npx.cmd wrangler d1 migrations apply reservas --local --persist-to "${PERSIST}"`, { stdio: 'ignore' });
  const publico = iniciar(['wrangler', 'dev', '--local', '--test-scheduled', '--port', '8787', '--inspector-port', '9229', '--persist-to', `"${PERSIST}"`, ...v({ ...COMUNES, ...extra })]);
  await listo('http://127.0.0.1:8787/api/salud'); // primero el público, después el panel
  const panel = iniciar(['wrangler', 'dev', '-c', 'wrangler.panel.toml', '--local', '--port', '8788', '--inspector-port', '9230', '--persist-to', `"${PERSIST}"`,
    ...v({ ...COMUNES, ...extra, ACCESS_TEAM_DOMAIN: 'equipo-prueba.cloudflareaccess.com', ACCESS_AUD: 'aud-de-prueba', ACCESS_CERTS_URL: SIM + '/certs' })]);
  await listo('http://127.0.0.1:8788/');
  const salida = await new Promise(ok => {
    const p = spawn(process.execPath, [archivo], { env: { ...process.env, BASE: 'http://127.0.0.1:8787', PANEL: 'http://127.0.0.1:8788', CLAVE: vars.CLAVE_PRUEBAS, SECRETO: vars.MP_WEBHOOK_SECRET, PERSIST, ESCENARIO: escenario || '' } });
    let t = ''; p.stdout.on('data', d => t += d); p.stderr.on('data', d => t += d); p.on('close', c => ok({ c, t }));
  });
  const oks = (salida.t.match(/^  OK /gm) || []).length, mal = salida.t.split('\n').filter(l => l.startsWith('  MAL') || /Error/.test(l));
  resultado[nombre] = { ok: oks, fallas: mal };
  console.log(`== ${nombre}: ${oks} OK, ${mal.length} fallas`); mal.forEach(l => console.log('   ' + l));
  if (process.env.DETALLE) console.log(salida.t);
  for (const w of [publico, panel]) { try { execSync(`taskkill /PID ${w.pid} /T /F`, { stdio: 'ignore' }); } catch { } }
  await esperar(2500);
}
simulado.kill();
fs.rmSync(PERSIST, { recursive: true, force: true });
process.exit(Object.values(resultado).some(r => r.fallas.length) ? 1 : 0);
