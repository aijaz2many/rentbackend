export const swaggerPaths = {
  '/health': {
    get: {
      tags: ['System'],
      summary: 'Health check endpoint',
      description: 'Returns API health status and database connectivity',
      responses: {
        200: { description: 'API is running and database is connected' },
        500: { description: 'Database disconnected or server error' },
      },
    },
  },
  '/': {
    get: {
      tags: ['System'],
      summary: 'Root API endpoint',
      description: 'Lists all available API route groups and version info',
      responses: {
        200: { description: 'API welcome information' },
      },
    },
  },
  '/api/auth/register': {
    post: {
      tags: ['Auth'],
      summary: 'Register initial Owner & Organization',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['firstName', 'email', 'password'],
              properties: {
                firstName: { type: 'string', example: 'John' },
                lastName: { type: 'string', example: 'Doe' },
                email: { type: 'string', format: 'email', example: 'john@example.com' },
                phone: { type: 'string', example: '+919876543210' },
                password: { type: 'string', format: 'password', example: 'password123' },
                organizationName: { type: 'string', example: 'Skyline Properties' },
                organizationCode: { type: 'string', example: 'SKYL' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Registration successful with auth token' },
        400: { description: 'Validation error or email already in use' },
      },
    },
  },
  '/api/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Login with Email or Phone',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['emailOrPhone', 'password'],
              properties: {
                emailOrPhone: { type: 'string', example: 'john@example.com' },
                password: { type: 'string', format: 'password', example: 'password123' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Login successful' },
        401: { description: 'Invalid credentials' },
      },
    },
  },
  '/api/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'Get current user profile',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Current authenticated user profile' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Logout user',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Logged out successfully' },
      },
    },
  },
  '/api/auth/change-password': {
    post: {
      tags: ['Auth'],
      summary: 'Change password',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['currentPassword', 'newPassword'],
              properties: {
                currentPassword: { type: 'string', format: 'password' },
                newPassword: { type: 'string', format: 'password' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Password updated successfully' },
        400: { description: 'Incorrect current password or validation error' },
      },
    },
  },
  '/api/organization/my': {
    get: {
      tags: ['Organization'],
      summary: 'Get organization details',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Organization information and counts' },
        401: { description: 'Unauthorized' },
      },
    },
    patch: {
      tags: ['Organization'],
      summary: 'Update organization details (Owner/Admin only)',
      security: [{ bearerAuth: [] }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
                phone: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Organization updated' },
        403: { description: 'Forbidden' },
      },
    },
  },
  '/api/properties': {
    get: {
      tags: ['Properties'],
      summary: 'List all properties',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'List of organization properties' },
      },
    },
    post: {
      tags: ['Properties'],
      summary: 'Create a new property',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', example: 'Grand Residency' },
                code: { type: 'string', example: 'GR-01' },
                addressLine1: { type: 'string' },
                city: { type: 'string' },
                state: { type: 'string' },
                country: { type: 'string', default: 'India' },
                postalCode: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Property created' },
        400: { description: 'Validation error' },
      },
    },
  },
  '/api/properties/{id}': {
    get: {
      tags: ['Properties'],
      summary: 'Get property by ID',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Property details' },
        404: { description: 'Property not found' },
      },
    },
    patch: {
      tags: ['Properties'],
      summary: 'Update property',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                addressLine1: { type: 'string' },
                city: { type: 'string' },
                state: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Property updated' },
      },
    },
    delete: {
      tags: ['Properties'],
      summary: 'Delete property',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Property deleted' },
      },
    },
  },
  '/api/apartments': {
    get: {
      tags: ['Apartments'],
      summary: 'List all apartments',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'propertyId', in: 'query', schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['VACANT', 'OCCUPIED', 'UNDER_MAINTENANCE'] } },
      ],
      responses: {
        200: { description: 'List of apartments' },
      },
    },
    post: {
      tags: ['Apartments'],
      summary: 'Create apartment',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['apartmentNumber', 'buildingId'],
              properties: {
                apartmentNumber: { type: 'string', example: '101' },
                buildingId: { type: 'string' },
                floorNumber: { type: 'integer', example: 1 },
                bedroomCount: { type: 'integer', example: 2 },
                bathroomCount: { type: 'integer', example: 2 },
                monthlyRentAmount: { type: 'number', example: 15000 },
                securityDepositAmount: { type: 'number', example: 30000 },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Apartment created' },
      },
    },
  },
  '/api/apartments/{id}': {
    get: {
      tags: ['Apartments'],
      summary: 'Get apartment by ID',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Apartment details' },
        404: { description: 'Apartment not found' },
      },
    },
  },
  '/api/tenants': {
    get: {
      tags: ['Tenants'],
      summary: 'List all tenants',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'List of tenants' },
      },
    },
    post: {
      tags: ['Tenants'],
      summary: 'Create a tenant',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['firstName', 'phone'],
              properties: {
                firstName: { type: 'string', example: 'Ravi' },
                lastName: { type: 'string', example: 'Kumar' },
                email: { type: 'string', format: 'email', example: 'ravi@example.com' },
                phone: { type: 'string', example: '+919123456789' },
                idType: { type: 'string', example: 'AADHAAR' },
                idNumber: { type: 'string', example: '1234-5678-9012' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Tenant created' },
      },
    },
  },
  '/api/leases': {
    get: {
      tags: ['Leases'],
      summary: 'List all leases',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'List of lease agreements' },
      },
    },
    post: {
      tags: ['Leases'],
      summary: 'Create lease agreement',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['apartmentId', 'tenantId', 'startDate', 'rentAmount'],
              properties: {
                apartmentId: { type: 'string' },
                tenantId: { type: 'string' },
                startDate: { type: 'string', format: 'date', example: '2026-01-01' },
                endDate: { type: 'string', format: 'date', example: '2026-12-31' },
                rentAmount: { type: 'number', example: 15000 },
                securityDepositAmount: { type: 'number', example: 30000 },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Lease created' },
      },
    },
  },
  '/api/rent/charges': {
    get: {
      tags: ['Rent Engine'],
      summary: 'List monthly rent charges with filters',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'year', in: 'query', schema: { type: 'integer' } },
        { name: 'month', in: 'query', schema: { type: 'integer' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'] } },
        { name: 'apartmentId', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'List of monthly rent charges' },
      },
    },
  },
  '/api/rent/generate-charges': {
    post: {
      tags: ['Rent Engine'],
      summary: 'Generate monthly rent charges (Idempotent)',
      description: 'Generates rent charges for all active leases with duplicate avoidance and proration calculation',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['billingYear', 'billingMonth'],
              properties: {
                billingYear: { type: 'integer', example: 2026 },
                billingMonth: { type: 'integer', example: 10 },
                dryRun: { type: 'boolean', default: false, description: 'If true, returns preview without writing to database' },
                prorate: { type: 'boolean', default: true, description: 'Prorate rent for leases starting or ending mid-month' },
                propertyId: { type: 'string', format: 'uuid', description: 'Optionally generate charges only for a specific property' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Rent generation or preview results' },
        400: { description: 'Validation error' },
      },
    },
  },
  '/api/rent/process-overdue': {
    post: {
      tags: ['Rent Engine'],
      summary: 'Process overdue charges and apply lease late fees',
      description: 'Finds unpaid charges past due date, marks as OVERDUE, and automatically calculates and applies late fees',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Overdue processing summary' },
      },
    },
  },
  '/api/rent/summary': {
    get: {
      tags: ['Rent Engine'],
      summary: 'Get rent collection summary and collection rate %',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'year', in: 'query', schema: { type: 'integer' } },
        { name: 'month', in: 'query', schema: { type: 'integer' } },
      ],
      responses: {
        200: { description: 'Financial metrics and collection status breakdown' },
      },
    },
  },
  '/api/rent/payments': {
    post: {
      tags: ['Rent Engine'],
      summary: 'Record rent payment & allocate to charges',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tenantId', 'apartmentId', 'amount'],
              properties: {
                tenantId: { type: 'string' },
                apartmentId: { type: 'string' },
                amount: { type: 'number', example: 15000 },
                paymentMethodCode: { type: 'string', enum: ['CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'ONLINE'], default: 'UPI' },
                transactionId: { type: 'string', example: 'UPI-TXN-1298492' },
                rentChargeId: { type: 'string' },
                notes: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Payment recorded and receipt generated' },
      },
    },
  },
  '/api/dashboard/metrics': {
    get: {
      tags: ['Dashboard'],
      summary: 'Get organization dashboard metrics and current-month financials',
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: 'Dashboard metrics including property counts, live occupancy, current-month rent, expenses, and maintenance counts',
        },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/payments': {
    get: {
      tags: ['Payment Management'],
      summary: 'List payment history with filters & pagination',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'tenantId', in: 'query', schema: { type: 'string' } },
        { name: 'apartmentId', in: 'query', schema: { type: 'string' } },
        { name: 'method', in: 'query', schema: { type: 'string' } },
        { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        200: { description: 'Paginated payment records with tenant, apartment, and receipt details' },
      },
    },
    post: {
      tags: ['Payment Management'],
      summary: 'Record payment with intelligent multi-charge allocation & receipt generation',
      description: 'Records payments (Cash, UPI, Bank Transfer, Card) and automatically allocates to outstanding rent charges chronologically or to a targeted charge. Generates payment receipt.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tenantId', 'apartmentId', 'amount'],
              properties: {
                tenantId: { type: 'string', format: 'uuid' },
                apartmentId: { type: 'string', format: 'uuid' },
                amount: { type: 'number', example: 15000 },
                paymentMethodCode: { type: 'string', enum: ['CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'ONLINE', 'OTHER'], default: 'UPI' },
                paymentDate: { type: 'string', format: 'date-time' },
                transactionId: { type: 'string', example: 'UPI-REF-99281' },
                rentChargeId: { type: 'string', format: 'uuid', description: 'Optional: target a specific rent charge' },
                notes: { type: 'string' },
                autoAllocate: { type: 'boolean', default: true },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Payment recorded, charges updated, and receipt issued' },
        400: { description: 'Validation error' },
      },
    },
  },
  '/api/payments/methods': {
    get: {
      tags: ['Payment Management'],
      summary: 'Get all available payment methods (Cash, UPI, Bank Transfer, etc.)',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'List of payment methods' },
      },
    },
  },
  '/api/payments/outstanding': {
    get: {
      tags: ['Payment Management'],
      summary: 'Get outstanding balance & unpaid charges for apartment or tenant',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'apartmentId', in: 'query', schema: { type: 'string' } },
        { name: 'tenantId', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Total outstanding balance and breakdown of unpaid charges' },
      },
    },
  },
  '/api/payments/{id}': {
    get: {
      tags: ['Payment Management'],
      summary: 'Get single payment by ID with receipt and allocation details',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Detailed payment record with receipt and allocations' },
        404: { description: 'Payment not found' },
      },
    },
  },
  '/api/receipts': {
    get: {
      tags: ['Receipt Management'],
      summary: 'List receipts with filters & pagination',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'receiptNumber', in: 'query', schema: { type: 'string' }, description: 'Search by receipt number' },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        200: { description: 'Paginated list of receipts' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/receipts/{receiptNumber}': {
    get: {
      tags: ['Receipt Management'],
      summary: 'Get receipt details by receipt number',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'receiptNumber', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Receipt details' },
        404: { description: 'Receipt not found' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/receipts/{receiptNumber}/html': {
    get: {
      tags: ['Receipt Management'],
      summary: 'Render receipt as HTML',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'receiptNumber', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'HTML receipt' },
        404: { description: 'Receipt not found' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/expenses': {
    get: {
      tags: ['Expense Management'],
      summary: 'List organization expenses with optional filters and pagination',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'propertyId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'buildingId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'apartmentId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'categoryId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
      ],
      responses: {
        200: { description: 'Paginated organization expense records' },
        401: { description: 'Unauthorized' },
      },
    },
    post: {
      tags: ['Expense Management'],
      summary: 'Record an expense',
      security: [{ bearerAuth: [] }],
      responses: {
        201: { description: 'Expense recorded' },
        400: { description: 'Invalid expense data or references' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/expenses/summary': {
    get: {
      tags: ['Expense Management'],
      summary: 'Get monthly, property, building, category, and maintenance expense totals',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: {
        200: { description: 'Expense summary for a date range of up to 366 days' },
        400: { description: 'Invalid date range' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/expenses/categories': {
    get: {
      tags: ['Expense Management'],
      summary: 'List active organization and shared expense categories',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Expense categories' },
        401: { description: 'Unauthorized' },
      },
    },
    post: {
      tags: ['Expense Management'],
      summary: 'Create an organization expense category',
      security: [{ bearerAuth: [] }],
      responses: {
        201: { description: 'Expense category created' },
        409: { description: 'Category already exists' },
      },
    },
  },
  '/api/expenses/{id}': {
    patch: {
      tags: ['Expense Management'],
      summary: 'Update an organization expense',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Expense updated' },
        404: { description: 'Expense not found' },
      },
    },
    delete: {
      tags: ['Expense Management'],
      summary: 'Delete an organization expense',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Expense deleted' },
        404: { description: 'Expense not found' },
      },
    },
  },
  '/api/expenses/categories/{id}': {
    patch: {
      tags: ['Expense Management'],
      summary: 'Rename an organization expense category',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Expense category updated' },
        404: { description: 'Expense category not found' },
      },
    },
    delete: {
      tags: ['Expense Management'],
      summary: 'Deactivate an organization expense category',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Expense category deactivated' },
        404: { description: 'Expense category not found' },
      },
    },
  },
  '/api/notifications': {
    get: {
      tags: ['Notifications'],
      summary: 'List notifications for the authenticated user',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'unreadOnly', in: 'query', schema: { type: 'boolean', default: false } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
      ],
      responses: {
        200: { description: 'Paginated notifications' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/notifications/unread-count': {
    get: {
      tags: ['Notifications'],
      summary: 'Count unread notifications for the authenticated user',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Unread notification count' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/notifications/read-all': {
    patch: {
      tags: ['Notifications'],
      summary: 'Mark all notifications for the authenticated user as read',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Notifications marked as read' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/notifications/{id}/read': {
    patch: {
      tags: ['Notifications'],
      summary: 'Mark one notification as read',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Notification marked as read' },
        404: { description: 'Notification not found' },
      },
    },
  },
  '/api/notifications/announcements': {
    post: {
      tags: ['Notifications'],
      summary: 'Publish an in-app and push announcement',
      security: [{ bearerAuth: [] }],
      responses: {
        201: { description: 'Announcement published' },
        400: { description: 'Invalid recipients or announcement data' },
      },
    },
  },
  '/api/notifications/push-tokens': {
    post: {
      tags: ['Notifications'],
      summary: 'Register an Expo push token for the authenticated user',
      security: [{ bearerAuth: [] }],
      responses: {
        201: { description: 'Push token registered' },
        409: { description: 'Push token belongs to another user' },
      },
    },
    delete: {
      tags: ['Notifications'],
      summary: 'Remove an Expo push token from the authenticated user',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Push token removed' },
        404: { description: 'Push token not found' },
      },
    },
  },
  '/api/reports/rent': {
    get: {
      tags: ['Reports'],
      summary: 'Report expected, collected, outstanding, and overdue rent',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: {
        200: { description: 'Rent report and charge details' },
        400: { description: 'Invalid date range' },
      },
    },
  },
  '/api/reports/tenant-payments': {
    get: {
      tags: ['Reports'],
      summary: 'Report tenant payment history and receipts',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'tenantId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: {
        200: { description: 'Payment history with rent allocations' },
        400: { description: 'Invalid tenant or date range' },
      },
    },
  },
  '/api/reports/occupancy': {
    get: {
      tags: ['Reports'],
      summary: 'Report occupancy, vacancies, and tenant turnover',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
      ],
      responses: {
        200: { description: 'Occupancy statistics and paginated vacant apartments' },
        400: { description: 'Invalid date range' },
      },
    },
  },
  '/api/reports/expenses': {
    get: {
      tags: ['Reports'],
      summary: 'Report expenses by month, category, and property, including maintenance cost',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: {
        200: { description: 'Expense totals and categorized line items' },
        400: { description: 'Invalid date range' },
      },
    },
  },
  '/api/reports/maintenance': {
    get: {
      tags: ['Reports'],
      summary: 'Report open and completed maintenance requests, costs, and completion time',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: {
        200: { description: 'Maintenance report and completed request details' },
        400: { description: 'Invalid date range' },
      },
    },
  },
  '/api/documents': {
    get: {
      tags: ['Documents'],
      summary: 'List documents visible to the authenticated organization user',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'entityType', in: 'query', schema: { type: 'string', enum: ['PROPERTY', 'TENANT', 'LEASE', 'APARTMENT', 'MAINTENANCE_REQUEST'] } },
        { name: 'entityId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
      ],
      responses: {
        200: { description: 'Organization-scoped document metadata' },
        401: { description: 'Unauthorized' },
      },
    },
  },
  '/api/documents/upload-url': {
    post: {
      tags: ['Documents'],
      summary: 'Create document metadata and a short-lived S3-compatible upload URL',
      description: 'Upload directly to object storage using PUT and the returned Content-Type header, then call the completion endpoint.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['entityType', 'entityId', 'documentType', 'fileName', 'mimeType', 'fileSize'],
              properties: {
                entityType: { type: 'string', enum: ['PROPERTY', 'TENANT', 'LEASE', 'APARTMENT', 'MAINTENANCE_REQUEST'] },
                entityId: { type: 'string', format: 'uuid' },
                documentType: { type: 'string', maxLength: 50 },
                fileName: { type: 'string', maxLength: 255 },
                mimeType: { type: 'string', maxLength: 100 },
                fileSize: { type: 'integer', minimum: 1, maximum: 26214400 },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Upload URL and document ID' },
        400: { description: 'Invalid metadata or unsupported file type' },
        403: { description: 'Not authorized for the document target' },
      },
    },
  },
  '/api/documents/{id}/complete': {
    post: {
      tags: ['Documents'],
      summary: 'Verify the uploaded object and finalize document metadata',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Upload verified' },
        400: { description: 'Upload metadata or object does not match' },
        404: { description: 'Document not found' },
      },
    },
  },
  '/api/documents/{id}/download-url': {
    get: {
      tags: ['Documents'],
      summary: 'Create a short-lived download URL for a completed document',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Download URL' },
        404: { description: 'Document not found or not yet uploaded' },
      },
    },
  },
  '/api/documents/{id}': {
    delete: {
      tags: ['Documents'],
      summary: 'Delete document metadata and the stored object',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Document deleted' },
        404: { description: 'Document not found' },
      },
    },
  },
};
