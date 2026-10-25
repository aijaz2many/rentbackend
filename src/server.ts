import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { prisma } from './lib/prisma';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { swaggerPaths } from './docs/swaggerPaths';

// Import routers
import authRouter from './routes/auth';
import orgRouter from './routes/organization';
import propertiesRouter from './routes/properties';
import apartmentsRouter from './routes/apartments';
import tenantsRouter from './routes/tenants';
import rentRouter from './routes/rent';
import leasesRouter from './routes/leases';
import dashboardRouter from './routes/dashboard';
import paymentsRouter from './routes/payments';
import receiptsRouter from './routes/receipts';
import expensesRouter from './routes/expenses';
import notificationsRouter from './routes/notifications';
import reportsRouter from './routes/reports';
import documentsRouter from './routes/documents';
import maintenanceRouter from './routes/maintenance';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Swagger configuration
const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Property & Apartment Management API',
      version: '1.0.0',
      description: 'API documentation for Property & Apartment Management Backend',
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Development Server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    paths: swaggerPaths,
  },
  apis: ['./src/routes/*.ts', './src/server.ts'],
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Mount API routes
app.use('/api/auth', authRouter);
app.use('/api/organization', orgRouter);
app.use('/api/properties', propertiesRouter);
app.use('/api/floors', propertiesRouter); // Supports direct /api/floors
app.use('/api/apartments', apartmentsRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/rent', rentRouter);
app.use('/api/leases', leasesRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/receipts', receiptsRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/maintenance', maintenanceRouter);

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Check API status and database connectivity
 *     tags:
 *       - System
 *     responses:
 *       200:
 *         description: Service is healthy and database is connected
 *       500:
 *         description: Database disconnected or internal server error
 */
// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  try {
    const orgCount = await prisma.tsmib_organizations.count();
    res.json({
      status: 'ok',
      service: 'Property & Apartment Management Backend API',
      timestamp: new Date().toISOString(),
      database: 'connected',
      organizationsCount: orgCount,
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      database: 'disconnected',
    });
  }
});

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'Welcome to Property & Apartment Management API',
    version: '1.0.0',
    endpoints: {
      docs: '/api-docs',
      health: '/health',
      auth: '/api/auth',
      organization: '/api/organization',
      properties: '/api/properties',
      apartments: '/api/apartments',
      tenants: '/api/tenants',
      rent: '/api/rent',
      dashboard: '/api/dashboard',
      payments: '/api/payments',
      expenses: '/api/expenses',
      notifications: '/api/notifications',
      reports: '/api/reports',
      documents: '/api/documents',
      maintenance: '/api/maintenance',
    },
  });
});

import { RentScheduler } from './services/scheduler';

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`Swagger documentation available at http://localhost:${PORT}/api-docs`);
  RentScheduler.start();
});
