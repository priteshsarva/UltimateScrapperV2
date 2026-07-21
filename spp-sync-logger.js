// ============================================================================
// spp-sync-logger.js  —  server-side logging for the WordPress plugin's sync
// ----------------------------------------------------------------------------
// The plugin (v3.6.0+) sends a header on every server call telling you WHY it
// is calling:
//     x-spp-trigger: auto        (the every-minute background heartbeat)
//     x-spp-trigger: manual      (the store owner clicked "Sync now")
//     x-spp-trigger: full-resync (scheduled 12h resync, or "Full resync now")
//     x-spp-trigger: check       (health check / connection test)
// plus x-site-domain and x-spp-version.
//
// This middleware prints a clear line for each sync-feed / status / refresh hit
// so you can watch manual vs automatic activity in `pm2 logs`.
//
// INSTALL (in your Express app, BEFORE your product routes are mounted):
//
//     import { sppSyncLogger } from './spp-sync-logger.js';
//     app.use(sppSyncLogger());
//
// (or `const { sppSyncLogger } = require('./spp-sync-logger.js');` for CommonJS)
//
// It only logs the plugin's own endpoints, so it won't spam the rest of your app.
// ============================================================================

const WATCH = ['/product/sync-feed', '/product/status', '/product/refresh-one'];

export function sppSyncLogger(opts = {}) {
  const label = opts.label || 'SPP';
  // set opts.onlyManual = true if you ONLY want to see manual + full-resync
  // (auto heartbeats every minute can be noisy once you trust it's working).
  const onlyManual = !!opts.onlyManual;

  return function (req, res, next) {
    const path = (req.path || req.url || '').split('?')[0];
    if (!WATCH.some((p) => path.startsWith(p))) return next();

    const trigger = (req.headers['x-spp-trigger'] || 'unknown').toString();
    if (onlyManual && trigger !== 'manual' && trigger !== 'full-resync') return next();

    const domain = (req.headers['x-site-domain'] || '?').toString();
    const ver    = (req.headers['x-spp-version'] || '?').toString();
    const by     = req.query.by || '';
    const after  = req.query.after || '';
    const cat    = req.query.category || '';
    const started = Date.now();

    // emphasise the events you actually care about
    const tag =
      trigger === 'manual'      ? '🟢 MANUAL Sync-now' :
      trigger === 'full-resync' ? '🔵 FULL RESYNC'     :
      trigger === 'auto'        ? '⚙️  auto'            :
      trigger === 'check'       ? '🔎 check'            : `· ${trigger}`;

    // log when the response finishes so we can include the row count + timing
    res.on('finish', () => {
      const ms = Date.now() - started;
      let extra = '';
      // sync-feed sets res.locals.sppCount if you add the one-liner below; else blank
      if (res.locals && typeof res.locals.sppCount !== 'undefined') {
        extra = ` returned=${res.locals.sppCount}`;
      }
      const q = path.endsWith('sync-feed')
        ? ` by=${by} after=${after}${cat ? ' cat=' + cat : ''}`
        : '';
      console.log(
        `[${label}] ${tag}  ${path}${q}  domain=${domain} v${ver} ` +
        `http=${res.statusCode} ${ms}ms${extra}`
      );
    });

    next();
  };
}

// ----------------------------------------------------------------------------
// OPTIONAL — to also log how many products each sync-feed returned, add ONE line
// inside your existing /product/sync-feed handler, right before you send the
// response:
//
//     res.locals.sppCount = results.length;   // <-- add this
//     return res.json({ by, after, count: results.length, results });
//
// The middleware above will then include `returned=N` in each log line.
// ----------------------------------------------------------------------------
