/**
 * Google Cloud Function entry point for Endurance Training Bridge.
 * 
 * Handles HTTP requests for:
 * - POST /mcp - MCP tool invocations
 * - GET /auth/strava/callback - OAuth callback from Strava
 * - GET /tools - List available MCP tools
 * 
 * Security:
 * - API key required for every private endpoint (Authorization: Bearer <key>)
 * - Optional Strava OAuth uses a short-lived signed state parameter
 * 
 * Deployment:
 * This function is designed for Google Cloud Functions 2nd gen with Node.js 22.
 */

import functions from '@google-cloud/functions-framework';
import crypto from 'node:crypto';
import { routeTool, listTools } from './mcpRouter.js';
import { exchangeAuthCode, getAuthorizationUrl } from './strava/client.js';
import { createGarminClientFromTokens } from './garmin/client.js';
import { storeGarminTokens, getGarminTokens, clearGarminAthleteCache } from './storage/firestore.js';
import {
  allowedOrigins,
  createSignedState,
  isOriginAllowed,
  validateApiKey,
  validateAthleteId,
  validateRedirectUrl,
  verifySignedState
} from './security.js';

/**
 * Send JSON response with appropriate headers.
 */
function sendJson(res, statusCode, data) {
  res.status(statusCode)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(data));
}

/**
 * Send error response in MCP format.
 */
function sendError(res, statusCode, message) {
  sendJson(res, statusCode, {
    error: { message }
  });
}

/**
 * Handle MCP tool requests.
 * 
 * Request body:
 * {
 *   "tool": "toolName",
 *   "arguments": { ... }
 * }
 */
async function handleMcpRequest(req, res) {
  // Parse and validate request body
  const body = req.body;
  
  if (!body || typeof body !== 'object') {
    sendError(res, 400, 'Request body must be a JSON object');
    return;
  }

  const { tool, arguments: args } = body;

  if (!tool || typeof tool !== 'string' || tool.length > 100) {
    sendError(res, 400, 'Missing or invalid "tool" field');
    return;
  }

  if (args?.athleteId !== undefined && !validateAthleteId(String(args.athleteId))) {
    sendError(res, 400, 'Invalid athleteId');
    return;
  }

  // Route to appropriate tool handler
  const result = await routeTool(tool, args || {});

  // Determine status code based on result
  const statusCode = result.error ? 400 : 200;
  sendJson(res, statusCode, result);
}

/**
 * Handle Strava OAuth callback.
 * 
 * Query params:
 * - code: Authorization code from Strava
 * - state: Short-lived HMAC-signed state parameter
 * - error: Error if user denied access
 */
async function handleStravaCallback(req, res) {
  const { code, state, error } = req.query;
  const statePayload = verifySignedState(state);
  if (!statePayload) {
    sendError(res, 400, 'Invalid or expired OAuth state');
    return;
  }
  const redirectUrl = statePayload.redirect || null;

  // Handle user denial
  if (error) {
    if (redirectUrl) {
      const target = new URL(redirectUrl);
      target.searchParams.set('error', error);
      res.redirect(target.toString());
    } else {
      sendJson(res, 400, {
        error: { message: `OAuth error: ${error}` }
      });
    }
    return;
  }

  if (!code) {
    if (redirectUrl) {
      const target = new URL(redirectUrl);
      target.searchParams.set('error', 'missing_code');
      res.redirect(target.toString());
    } else {
      sendError(res, 400, 'Missing authorization code');
    }
    return;
  }

  try {
    // Exchange code for tokens
    const result = await exchangeAuthCode(code);

    // Redirect back to web app if redirect URL provided
    if (redirectUrl) {
      const target = new URL(redirectUrl);
      target.searchParams.set('athleteId', result.athleteId);
      target.searchParams.set('athleteName', result.athleteName);
      res.redirect(target.toString());
      return;
    }

    // Return JSON response for API clients
    sendJson(res, 200, {
      message: 'Authentication successful',
      athleteId: result.athleteId,
      athleteName: result.athleteName
    });

  } catch (err) {
    console.error('OAuth callback error:', err);
    if (redirectUrl) {
      const target = new URL(redirectUrl);
      target.searchParams.set('error', 'auth_failed');
      res.redirect(target.toString());
    } else {
      sendError(res, 500, 'Failed to complete authentication');
    }
  }
}

/**
 * Handle tools listing request.
 * Returns available MCP tools and their schemas.
 */
function handleListTools(req, res) {
  // Optionally require API key for tool discovery
  // For now, allow public access to tool list
  
  const tools = listTools();
  sendJson(res, 200, { tools });
}

/**
 * Generate Strava authorization URL for initiating OAuth.
 * 
 * Query params (optional):
 * - redirect: allow-listed URL to redirect back to after auth
 */
async function handleAuthInit(req, res) {
  try {
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;
    if (!publicBaseUrl || !publicBaseUrl.startsWith('https://')) {
      sendError(res, 503, 'Strava integration is not configured');
      return;
    }
    const redirectUri = new URL('/auth/strava/callback', publicBaseUrl).toString();
    
    const redirectUrl = validateRedirectUrl(req.query.redirect);
    if (req.query.redirect && !redirectUrl) {
      sendError(res, 400, 'redirect origin is not allowed');
      return;
    }
    const state = createSignedState({
      nonce: crypto.randomBytes(16).toString('hex'),
      redirect: redirectUrl,
      iat: Date.now()
    });
    const authUrl = await getAuthorizationUrl(redirectUri, state);
    
    sendJson(res, 200, {
      authorizationUrl: authUrl,
      state
    });
  } catch (err) {
    console.error('Auth init error:', err);
    sendError(res, 500, 'Failed to generate authorization URL');
  }
}

/**
 * Store Garmin DI tokens obtained by the local Python helper.
 *
 * Body: { athleteId, athleteName?, tokens: { di_token, di_refresh_token, di_client_id } }
 */
async function handleGarminTokens(req, res) {
  const { athleteId, tokens, athleteName } = req.body || {};

  if (!validateAthleteId(String(athleteId || '')) || !tokens ||
      typeof tokens.di_token !== 'string' || typeof tokens.di_refresh_token !== 'string' ||
      typeof tokens.di_client_id !== 'string' || tokens.di_token.length > 16_384 ||
      tokens.di_refresh_token.length > 16_384 || tokens.di_client_id.length > 512) {
    sendError(res, 400, 'athleteId and tokens (di_token, di_refresh_token, di_client_id) are required');
    return;
  }

  try {
    const tokenData = { tokens, athlete_name: athleteName };
    const client = await createGarminClientFromTokens(tokens);
    await client.ensureValidToken();

    // Persist refreshed tokens if they changed
    tokenData.tokens = client.exportTokens();
    await storeGarminTokens(athleteId, tokenData);

    sendJson(res, 200, {
      message: 'Garmin tokens stored successfully',
      athleteId
    });
  } catch (err) {
    console.error('Garmin token storage error:', err);
    sendError(res, 401, 'Garmin authentication failed. Generate fresh tokens and retry.');
  }
}

/**
 * Check whether a Garmin connection is healthy for an athlete.
 */
async function handleGarminStatus(req, res) {
  const { athleteId } = req.query || {};

  if (!validateAthleteId(String(athleteId || ''))) {
    sendError(res, 400, 'Valid athleteId query parameter is required');
    return;
  }

  try {
    const tokens = await getGarminTokens(athleteId);
    if (!tokens) {
      sendJson(res, 200, { connected: false, athleteId });
      return;
    }

    const client = await createGarminClientFromTokens(tokens);
    const profile = await client.getUserProfile();

    sendJson(res, 200, {
      connected: true,
      athleteId,
      athleteName: tokens.athlete_name || profile.displayName || profile.fullName || null
    });
  } catch (err) {
    console.error('Garmin status error:', err);
    sendJson(res, 200, { connected: false, athleteId, error: 'Garmin authentication failed' });
  }
}

/**
 * Disconnect Garmin for an athlete by clearing stored tokens.
 */
async function handleGarminDisconnect(req, res) {
  const { athleteId } = req.body || {};

  if (!validateAthleteId(String(athleteId || ''))) {
    sendError(res, 400, 'athleteId is required');
    return;
  }

  try {
    await clearGarminAthleteCache(athleteId);
    sendJson(res, 200, { message: 'Garmin connection removed', athleteId });
  } catch (err) {
    console.error('Garmin disconnect error:', err);
    sendError(res, 500, 'Failed to remove Garmin connection');
  }
}

/**
 * Main HTTP handler for Google Cloud Functions.
 * Routes requests based on path and method.
 */
async function mcpHandler(req, res) {
  const origin = req.headers.origin;
  const originAllowed = isOriginAllowed(origin, allowedOrigins());
  if (origin && originAllowed) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    if (!originAllowed) {
      sendError(res, 403, 'Origin not allowed');
      return;
    }
    res.status(204).send('');
    return;
  }

  // Parse path from the URL
  const path = req.path || '/';
  if (path.startsWith('/auth/strava/') && process.env.ENABLE_STRAVA !== 'true') {
    sendError(res, 404, 'Strava integration is disabled');
    return;
  }
  const protectedRoute = path === '/mcp' || path === '/auth/strava/init' || path.startsWith('/auth/garmin/');

  const contentLength = Number(req.headers['content-length'] || 0);
  let parsedBodyLength = 0;
  try {
    parsedBodyLength = req.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(req.body), 'utf8');
  } catch {
    sendError(res, 400, 'Request body must be valid JSON');
    return;
  }
  if (contentLength > 64 * 1024 || parsedBodyLength > 64 * 1024) {
    sendError(res, 413, 'Request body too large');
    return;
  }

  if (protectedRoute && !validateApiKey(req.headers.authorization)) {
    res.set('WWW-Authenticate', 'Bearer');
    sendError(res, 401, 'Unauthorized - invalid or missing API key');
    return;
  }

  try {
    // Route based on path and method
    if (req.method === 'POST' && path === '/mcp') {
      await handleMcpRequest(req, res);
    } else if (req.method === 'GET' && path === '/auth/strava/callback') {
      await handleStravaCallback(req, res);
    } else if (req.method === 'GET' && path === '/auth/strava/init') {
      await handleAuthInit(req, res);
    } else if (req.method === 'GET' && path === '/tools') {
      handleListTools(req, res);
    } else if (req.method === 'GET' && path === '/health') {
      // Health check endpoint
      const configured = typeof process.env.MCP_API_KEY === 'string' && Buffer.byteLength(process.env.MCP_API_KEY, 'utf8') >= 32;
      sendJson(res, configured ? 200 : 503, {
        status: configured ? 'healthy' : 'misconfigured',
        timestamp: new Date().toISOString()
      });
    } else if (req.method === 'POST' && path === '/auth/garmin/tokens') {
      await handleGarminTokens(req, res);
    } else if (req.method === 'GET' && path === '/auth/garmin/status') {
      await handleGarminStatus(req, res);
    } else if (req.method === 'POST' && path === '/auth/garmin/disconnect') {
      await handleGarminDisconnect(req, res);
    } else {
      sendError(res, 404, `Not found: ${req.method} ${path}`);
    }
  } catch (err) {
    console.error('Unhandled error:', err);
    sendError(res, 500, 'Internal server error');
  }
}

// Register the function with Google Cloud Functions framework
functions.http('mcpHandler', mcpHandler);

// Export for testing
export { mcpHandler };
