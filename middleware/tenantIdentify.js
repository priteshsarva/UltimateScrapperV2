// src/middleware/tenantIdentify.js
import { CLIENT_CONFIGS } from '../config/clients.js';

export const tenantIdentify = (req, res, next) => {
    // 1. Check Origin or Referer (Frontend Domain), fallback to Host or Custom Header
    const clientOrigin =
        req.headers['x-enrollment-key'] ||
        req.headers.origin ||
        req.headers.referer ||
        req.headers.host ||
        "";

    // 2. Logic to match the client's origin to our config keys
    let selectedConfig = null;

    if (clientOrigin.includes("kicksmania")) {
        selectedConfig = CLIENT_CONFIGS["kicksmania.co.in"];
    } else if (clientOrigin.includes("timekeepers")) {
        selectedConfig = CLIENT_CONFIGS["timekeepers.in"];
    } else if (clientOrigin.includes("theaquawatch")) {
        selectedConfig = CLIENT_CONFIGS["theaquawatch.com"];
    }else if (clientOrigin.includes("stylenova")) {
        selectedConfig = CLIENT_CONFIGS["stylenova.co.in"];
    } else {
        // DEFAULT: Fallback if no match is found (useful for local development)
        selectedConfig = CLIENT_CONFIGS["theaquawatch.com"];
        // selectedConfig = CLIENT_CONFIGS["kicksmania.co.in"];
        // selectedConfig = CLIENT_CONFIGS["timekeepers.in"];
    }

    // 3. Attach the config to the request object so routes can use it
    req.clientConfig = selectedConfig;

    console.log(`[Tenant] Identified: ${selectedConfig.name} from Origin: ${clientOrigin}`);

    next();
};