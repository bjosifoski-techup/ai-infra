export const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Emerico Memory API',
    version: '1.0.0',
    description:
      'Conversation memory service for the Emerico AI Commerce Platform. Stores short-term session messages and long-term user preferences, summaries, and purchase history. All endpoints require a valid Keycloak JWT — data is strictly scoped to the authenticated user.',
  },
  servers: [{ url: '/', description: 'Current host' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Keycloak JWT issued by the emerico-commerce realm. Obtain via: POST /realms/emerico-commerce/protocol/openid-connect/token with client_credentials or password grant.',
      },
    },
    schemas: {
      Message: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Who sent the message' },
          content: { type: 'string', description: 'Message text' },
          timestamp: { type: 'string', format: 'date-time', description: 'When the message was stored' },
        },
      },
      LongTermMemory: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: 'Keycloak user ID (sub claim)' },
          preferences: {
            type: 'object',
            additionalProperties: true,
            description: 'Arbitrary key-value user preferences (e.g. language, currency)',
          },
          conversationSummaries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Capped at 50 most recent summaries',
          },
          purchaseHistory: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                orderId: { type: 'string' },
                source: { type: 'string', description: 'e.g. aliexpress, bigbuy' },
                productId: { type: 'string' },
                productName: { type: 'string' },
                amount: { type: 'number' },
                currency: { type: 'string' },
                purchasedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Error message' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        description: 'Returns service status. No authentication required.',
        security: [],
        responses: {
          200: {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/short-term/sessions': {
      get: {
        tags: ['Short-Term Memory'],
        summary: 'List all sessions',
        description: 'Returns all active session IDs for the authenticated user. Sessions expire automatically after 24 hours of inactivity.',
        responses: {
          200: {
            description: 'List of session IDs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessions: {
                      type: 'array',
                      items: { type: 'string' },
                      example: ['session-1', 'session-abc123'],
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Missing or invalid JWT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/short-term/{sessionId}': {
      get: {
        tags: ['Short-Term Memory'],
        summary: 'Get session messages',
        description: 'Returns all messages stored in the session. The session is scoped to the authenticated user — another user cannot access this session even if they know the ID.',
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' }, description: 'Session identifier', example: 'session-1' },
        ],
        responses: {
          200: {
            description: 'Session messages',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessionId: { type: 'string' },
                    messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
                  },
                },
              },
            },
          },
          401: { description: 'Missing or invalid JWT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Short-Term Memory'],
        summary: 'Clear a session',
        description: 'Deletes all messages in the session. Typically called after the conversation has been summarised and saved to long-term memory.',
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' }, example: 'session-1' },
        ],
        responses: {
          200: {
            description: 'Session cleared',
            content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
          },
          401: { description: 'Missing or invalid JWT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/short-term/{sessionId}/messages': {
      post: {
        tags: ['Short-Term Memory'],
        summary: 'Append a message',
        description: 'Adds a message to the session. The session is created automatically on first write. A sliding window keeps the last 100 messages — older ones are dropped.',
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' }, example: 'session-1' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Who sent the message' },
                  content: { type: 'string', description: 'Message text', example: 'I am looking for running shoes under $100' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Message appended',
            content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
          },
          400: { description: 'Missing or invalid fields', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Missing or invalid JWT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/long-term': {
      get: {
        tags: ['Long-Term Memory'],
        summary: 'Get long-term memory',
        description: 'Returns the full long-term memory document for the authenticated user — preferences, conversation summaries, and purchase history. Returns an empty document if no data exists yet.',
        responses: {
          200: {
            description: 'Long-term memory document',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LongTermMemory' } } },
          },
          401: { description: 'Missing or invalid JWT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/long-term/preferences': {
      patch: {
        tags: ['Long-Term Memory'],
        summary: 'Update preferences',
        description: 'Merges the provided key-value pairs into the user\'s preferences. Existing keys are overwritten, unmentioned keys are left unchanged. Accepts any JSON object.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true,
                example: { language: 'en', currency: 'USD', preferredCategories: ['shoes', 'sportswear'] },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Preferences updated',
            content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
          },
          400: { description: 'Body must be a JSON object', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Missing or invalid JWT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/long-term/summaries': {
      post: {
        tags: ['Long-Term Memory'],
        summary: 'Append a conversation summary',
        description: 'Saves a summary of a completed conversation. Capped at 50 entries — oldest summaries are removed when the cap is reached. Call this after clearing a short-term session.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['summary'],
                properties: {
                  summary: { type: 'string', example: 'User was looking for red running shoes under $100. Showed 3 AliExpress options.' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Summary saved',
            content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
          },
          400: { description: 'Summary must be a non-empty string', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Missing or invalid JWT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/long-term/purchases': {
      post: {
        tags: ['Long-Term Memory'],
        summary: 'Record a purchase',
        description: 'Appends a purchase event to the user\'s history. Called after a successful order from any partner (AliExpress, BigBuy, CJDropshipping, etc.).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderId', 'source', 'productId', 'productName', 'amount', 'currency', 'purchasedAt'],
                properties: {
                  orderId: { type: 'string', example: 'ORD-20260603-001' },
                  source: { type: 'string', example: 'aliexpress', description: 'Partner source (aliexpress, bigbuy, cjdropshipping, etc.)' },
                  productId: { type: 'string', example: '4000012345678' },
                  productName: { type: 'string', example: 'Nike Air Max 90 Red' },
                  amount: { type: 'number', example: 89.99 },
                  currency: { type: 'string', example: 'USD' },
                  purchasedAt: { type: 'string', format: 'date-time', example: '2026-06-03T12:00:00Z' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Purchase recorded',
            content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
          },
          400: { description: 'Missing or invalid fields', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Missing or invalid JWT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
};
