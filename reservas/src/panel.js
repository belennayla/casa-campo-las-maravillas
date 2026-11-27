/*
  Panel privado · Casa Campo Las Maravillas (Worker SEPARADO: "panel-casacampo")

  - Este Worker se protege ENTERO con Cloudflare Access ("All traffic"), así no afecta al Worker público
    (cotización, solicitudes, calendario ni webhooks de Mercado Pago).
  - Además, acá se exige y verifica el token de Access (Cf-Access-Jwt-Assertion) en TODAS las rutas, incluida la página:
    sin token válido no se entrega ni el HTML del panel.
  - Comparte la base D1 con el Worker público.
*/
import { usuarioAdmin, apiAdmin, panelAdmin } from './index.js';

const noAutorizado = () => new Response('Acceso restringido.', {
  status: 403,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' }
});

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // Sin configuración de Access (ni clave local habilitada), el panel queda cerrado por completo.
    const configurado = (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) || env.PERMITIR_CLAVE_ADMIN === 'true';
    if (!configurado) return noAutorizado();
    try {
      if ((url.pathname === '/' || url.pathname === '/admin') && req.method === 'GET') {
        // En producción la página también exige Access; en local, la página pide la clave y la usa en las llamadas.
        if (env.PERMITIR_CLAVE_ADMIN !== 'true' && !(await usuarioAdmin(req, env))) return noAutorizado();
        return await panelAdmin(req, env);
      }
      if (url.pathname.startsWith('/api/admin/')) return await apiAdmin(req, env, ctx, url); // verifica el usuario adentro
      return new Response('No encontrado', { status: 404, headers: { 'x-robots-tag': 'noindex' } });
    } catch (e) {
      if (e && e.codigo) return new Response(JSON.stringify({ error: e.codigo, mensaje: e.message }), { status: e.status || 400, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      console.error('Error en el panel', e && e.stack || e);
      return new Response(JSON.stringify({ error: 'error_interno' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  }
};
