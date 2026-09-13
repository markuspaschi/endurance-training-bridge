/**
 * MCP Tool Router for Strava Ironman Coaching.
 * 
 * Dispatches MCP-style tool requests to appropriate handlers.
 * Validates inputs, handles errors uniformly, and formats responses.
 * 
 * MCP Request Format:
 * {
 *   "tool": "toolName",
 *   "arguments": { ... }
 * }
 * 
 * MCP Response Format:
 * Success: { "result": { ... } }
 * Error: { "error": { "message": "string" } }
 */

import { getWeeklyTrainingSummary } from './tools/weeklySummary.js';
import { analyzeActivity } from './tools/analyzeActivity.js';
import { getIronmanReadiness } from './tools/ironmanReadiness.js';
import { getGarminActivities, getGarminActivity, verifyGarminConnection } from './tools/garminTools.js';

/**
 * Tool registry with metadata for validation and documentation.
 * Each tool has a handler function and argument schema.
 */
const TOOLS = {
  getWeeklyTrainingSummary: {
    handler: getWeeklyTrainingSummary,
    description: 'Get Ironman-relevant weekly training load summary (Strava, Garmin, or combined)',
    requiredArgs: ['athleteId'],
    optionalArgs: ['weeks', 'source', 'days']
  },
  analyzeActivity: {
    handler: analyzeActivity,
    description: 'Deep dive analysis on a single workout (Strava or Garmin)',
    requiredArgs: ['activityId'],
    optionalArgs: ['athleteId', 'source'] // Required but often passed as context
  },
  getIronmanReadiness: {
    handler: getIronmanReadiness,
    description: 'Coach-style Ironman readiness assessment (Strava, Garmin, or combined)',
    requiredArgs: ['athleteId'],
    optionalArgs: ['source']
  },
  getGarminActivities: {
    handler: getGarminActivities,
    description: 'List recent Garmin Connect activities for an athlete',
    requiredArgs: ['athleteId'],
    optionalArgs: ['startDate', 'endDate', 'limit']
  },
  getGarminActivity: {
    handler: getGarminActivity,
    description: 'Get detailed data for a single Garmin Connect activity',
    requiredArgs: ['athleteId', 'activityId'],
    optionalArgs: []
  },
  verifyGarminConnection: {
    handler: verifyGarminConnection,
    description: 'Check whether stored Garmin tokens are valid',
    requiredArgs: ['athleteId'],
    optionalArgs: []
  }
};

/**
 * Validate that required arguments are present.
 * 
 * @param {object} args - Provided arguments
 * @param {string[]} required - Required argument names
 * @returns {string|null} Error message or null if valid
 */
function validateArguments(args, required) {
  if (!args || typeof args !== 'object') {
    return 'Arguments must be an object';
  }

  const missing = required.filter(arg => !(arg in args) || args[arg] === undefined);
  
  if (missing.length > 0) {
    return `Missing required arguments: ${missing.join(', ')}`;
  }

  return null;
}

/**
 * Route an MCP tool request to the appropriate handler.
 * 
 * @param {string} toolName - Name of the tool to invoke
 * @param {object} args - Tool arguments
 * @returns {Promise<object>} MCP-formatted response
 */
export async function routeTool(toolName, args) {
  // Validate tool exists
  const tool = TOOLS[toolName];
  if (!tool) {
    return {
      error: {
        message: `Unknown tool: ${toolName}. Available tools: ${Object.keys(TOOLS).join(', ')}`
      }
    };
  }

  // Validate arguments
  const validationError = validateArguments(args, tool.requiredArgs);
  if (validationError) {
    return {
      error: {
        message: validationError
      }
    };
  }

  try {
    // Call the tool handler with appropriate arguments
    let result;
    
    switch (toolName) {
      case 'getWeeklyTrainingSummary':
        result = await tool.handler(args.athleteId, args.weeks, args.source, args.days);
        break;
      
      case 'analyzeActivity':
        // analyzeActivity needs both activityId and athleteId for auth
        if (!args.athleteId) {
          return {
            error: {
              message: 'athleteId is required for authentication when analyzing activities'
            }
          };
        }
        result = await tool.handler(args.activityId, args.athleteId, args.source);
        break;
      
      case 'getIronmanReadiness':
        result = await tool.handler(args.athleteId, args.source);
        break;
      
      case 'getGarminActivities':
        result = await tool.handler(args.athleteId, args.startDate, args.endDate, args.limit);
        break;
      
      case 'getGarminActivity':
        result = await tool.handler(args.athleteId, args.activityId);
        break;
      
      case 'verifyGarminConnection':
        result = await tool.handler(args.athleteId);
        break;
      
      default:
        // Generic handler call (fallback)
        result = await tool.handler(args);
    }

    return { result };

  } catch (error) {
    // Log error for debugging (Cloud Functions logging)
    console.error(`Tool ${toolName} error:`, error);

    // Return sanitized error message
    // Don't expose internal error details that might leak sensitive info
    let message = error.message || 'An unexpected error occurred';
    
    // Sanitize messages that might contain tokens or secrets
    if (message.includes('access_token') || message.includes('refresh_token')) {
      message = 'Authentication error - please re-authenticate with Strava';
    }
    message = message
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
      .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]');

    return {
      error: {
        message
      }
    };
  }
}

/**
 * List available tools with their descriptions.
 * Useful for MCP tool discovery.
 * 
 * @returns {object[]} Array of tool definitions
 */
export function listTools() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    requiredArguments: tool.requiredArgs,
    optionalArguments: tool.optionalArgs
  }));
}
