import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { jarvisStore } from './server/store';
import {
  synthesizeIncidentInvestigation,
  validateAndSanitizeSynthesis,
} from './server/geminiService';
import {
  IncidentSynthesisPayload,
} from './src/services/intelligence/aiSynthesisTypes';
import {
  parseTelemetryContent,
  parseTelemetryCsv,
  parseTelemetryJson,
} from './src/services/intelligence/telemetryParser';
import { extractTelemetryFromRequest } from './server/uploadParser';
import { generateIncidentReport } from './src/services/intelligence/reportGenerator';
import { createJarvisRouter } from './src/jarvis-ai/integration/expressRouter';

// README documents .env.local; also accept .env. With multiple paths the first definition of a variable wins.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = 'gemini-2.5-flash';

// ==========================================
// PORT DETERMINATION (Dev vs Production Cloud Run)
// ==========================================
function getPort(): number {
  const portArgIndex = process.argv.indexOf('--port');
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    return Number(process.argv[portArgIndex + 1]);
  }
  return Number(process.env.PORT) || 3000;
}

// ==========================================
// EXPRESS ROUTER SETUP
// ==========================================
export function createApiRouter(): express.Router {
  const router = express.Router();

  // 1. Health Probe
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'J.A.R.V.I.S. Incident Intelligence Engine',
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      stats: {
        totalEvents: jarvisStore.getEvents().total,
        incidentsCount: jarvisStore.getIncidents().length,
        servicesCount: jarvisStore.getServices().length,
      },
    });
  });

  // 2. AI Status Probe
  router.get('/ai/status', (_req: Request, res: Response) => {
    const hasKey =
      !!process.env.GEMINI_API_KEY &&
      process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' &&
      process.env.GEMINI_API_KEY.trim() !== '';

    res.json({
      geminiConfigured: hasKey,
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      engineMode: hasKey ? 'gemini_enhanced' : 'deterministic_only',
      notice: hasKey
        ? 'Gemini 2.5 Flash server-side integration active.'
        : 'GEMINI_API_KEY not configured on server. Operating in deterministic SRE mode.',
    });
  });

  // 3. AI Synthesis
  router.post('/ai/synthesize', async (req: Request, res: Response) => {
    try {
      const payload = req.body as IncidentSynthesisPayload;
      if (!payload || !payload.incidentId || !payload.topCandidate) {
        res.status(400).json({
          success: false,
          error: 'Invalid payload: incidentId and topCandidate are required.',
        });
        return;
      }

      const response = await synthesizeIncidentInvestigation(payload);

      // Persist the AI synthesis to the incident store and update the report
      if (response.result) {
        jarvisStore.saveAiSynthesis(payload.incidentId, response.result);
      }

      res.json(response);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        success: false,
        error: `Server internal error during synthesis: ${error}`,
      });
    }
  });

  // 4. Incident Retrieval
  router.get('/incidents', (req: Request, res: Response) => {
    try {
      const severity = req.query.severity as string | undefined;
      const status = req.query.status as string | undefined;
      const search = req.query.search as string | undefined;

      const incidents = jarvisStore.getIncidents({ severity, status, search });
      res.json(incidents);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to retrieve incidents: ${error}` });
    }
  });

  // 5. Incident Details
  router.get('/incidents/:id', (req: Request, res: Response) => {
    try {
      const incident = jarvisStore.getIncidentById(req.params.id);
      if (!incident) {
        res.status(404).json({ error: `Incident ${req.params.id} not found` });
        return;
      }
      res.json(incident);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to retrieve incident: ${error}` });
    }
  });

  // 6. Event Retrieval
  router.get('/events', (req: Request, res: Response) => {
    try {
      const service = req.query.service as string | undefined;
      const severity = req.query.severity as string | undefined;
      const search = req.query.search as string | undefined;
      const incidentId = req.query.incidentId as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const result = jarvisStore.getEvents({ service, severity, search, incidentId, limit, offset });
      res.json(result.events);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to retrieve events: ${error}` });
    }
  });

  // 7. Event Ingestion (JSON payload)
  router.post('/events/ingest', (req: Request, res: Response) => {
    try {
      const body = req.body;
      if (!body) {
        res.status(400).json({ success: false, error: 'Request body is empty.' });
        return;
      }

      const jsonStr = typeof body === 'string' ? body : JSON.stringify(body);
      const parseResult = parseTelemetryJson(jsonStr, 'api-ingest');

      if (!parseResult.success || parseResult.events.length === 0) {
        res.status(400).json({
          success: false,
          error: parseResult.errors.join('; ') || 'No valid events found in payload.',
          warnings: parseResult.warnings,
        });
        return;
      }

      const storeResult = jarvisStore.addEvents(parseResult.events);

      res.status(201).json({
        success: true,
        count: storeResult.addedCount,
        duplicatesSkipped: storeResult.duplicatesCount,
        totalEvents: storeResult.totalEvents,
        incidentsCount: storeResult.incidentsCount,
        incidents: storeResult.incidents,
        parsedEvents: parseResult.events,
        warnings: parseResult.warnings,
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: `Failed to ingest events: ${error}` });
    }
  });

  // 8. Telemetry File Upload (Supports CSV, JSON, Multipart, and Raw text)
  const handleUpload = (req: Request, res: Response) => {
    try {
      const extracted = extractTelemetryFromRequest(req);
      if (!extracted || !extracted.content || !extracted.content.trim()) {
        res.status(400).json({
          success: false,
          error: 'No file content or telemetry data received. Ensure a file is attached or body is provided.',
        });
        return;
      }

      const parseResult = parseTelemetryContent(extracted.content, extracted.fileNameHint);

      if (!parseResult.success || parseResult.events.length === 0) {
        res.status(400).json({
          success: false,
          error: parseResult.errors.join('; ') || 'Failed to parse telemetry file. Please verify CSV/JSON structure.',
          warnings: parseResult.warnings,
        });
        return;
      }

      const storeResult = jarvisStore.addEvents(parseResult.events);

      res.status(200).json({
        success: true,
        count: storeResult.addedCount,
        duplicatesSkipped: storeResult.duplicatesCount,
        totalEvents: storeResult.totalEvents,
        incidentsCount: storeResult.incidentsCount,
        incidents: storeResult.incidents,
        parsedEvents: parseResult.events,
        warnings: parseResult.warnings,
        message: `Successfully validated, normalized, and ingested ${storeResult.addedCount} events (${storeResult.duplicatesCount} duplicates skipped). ${storeResult.incidentsCount} active incident clusters identified.`,
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: `Upload processing failed: ${error}` });
    }
  };

  router.post('/events/upload', handleUpload);
  router.post('/telemetry/upload', handleUpload);

  // 9. Clear Events
  router.delete('/events', (_req: Request, res: Response) => {
    try {
      jarvisStore.clearEvents();
      res.json({ success: true, message: 'All telemetry events cleared and intelligence pipeline reset.' });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to clear events: ${error}` });
    }
  });

  // 10. Service Topology
  router.get('/services', (_req: Request, res: Response) => {
    try {
      res.json(jarvisStore.getServices());
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to retrieve services: ${error}` });
    }
  });

  router.get('/topology', (_req: Request, res: Response) => {
    try {
      res.json(jarvisStore.getTopology());
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to retrieve topology: ${error}` });
    }
  });

  // 11. Investigation Steps
  router.get('/investigations/:incidentId', (req: Request, res: Response) => {
    try {
      const steps = jarvisStore.getInvestigationSteps(req.params.incidentId);
      if (steps.length === 0) {
        res.status(404).json({ error: `No investigation data found for incident ${req.params.incidentId}` });
        return;
      }
      res.json(steps);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to retrieve investigation: ${error}` });
    }
  });

  router.post('/investigations', (req: Request, res: Response) => {
    try {
      const incidentId = req.body?.incidentId;
      if (!incidentId) {
        res.status(400).json({ error: 'incidentId is required to start an investigation' });
        return;
      }
      const steps = jarvisStore.getInvestigationSteps(incidentId);
      res.json(steps);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to launch investigation: ${error}` });
    }
  });

  // 12. Report Generation
  router.get('/reports/:incidentId', (req: Request, res: Response) => {
    try {
      const report = jarvisStore.getReport(req.params.incidentId);
      if (!report) {
        res.status(404).json({ error: `Report for incident ${req.params.incidentId} not found` });
        return;
      }
      res.json(report);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to retrieve report: ${error}` });
    }
  });

  router.post('/reports/generate', (req: Request, res: Response) => {
    try {
      const incidentId = req.body?.incidentId;
      if (!incidentId) {
        res.status(400).json({ error: 'incidentId is required to generate report' });
        return;
      }
      const report = jarvisStore.getReport(incidentId);
      if (!report) {
        res.status(404).json({ error: `Incident ${incidentId} not found` });
        return;
      }
      res.json(report);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to generate report: ${error}` });
    }
  });

  // 13. System Reset to Defaults
  router.post('/reset', (_req: Request, res: Response) => {
    try {
      jarvisStore.resetToDefaults();
      res.json({
        success: true,
        message: 'Platform state reset to initial seed telemetry baseline.',
        incidents: jarvisStore.getIncidents(),
        services: jarvisStore.getServices(),
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to reset state: ${error}` });
    }
  });

  return router;
}

// ==========================================
// EXPRESS SERVER SETUP & LIFECYCLE
// ==========================================
export async function createServerApp(): Promise<express.Application> {
  const app = express();

  // Multi-format body parsing: JSON, Text/CSV, Raw Multipart, URL-encoded
  app.use(express.json({ limit: '20mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '20mb' }));
  app.use(express.raw({ type: 'multipart/form-data', limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  const apiRouter = createApiRouter();
  app.use('/api', apiRouter);
  app.use('/api/v1', apiRouter);

  // Mount J.A.R.V.I.S. AI Intelligence Layer (Product C)
  const jarvisRouter = createJarvisRouter();
  app.use('/api/jarvis', jarvisRouter);

  return app;
}

async function startServer() {
  const app = await createServerApp();
  const PORT = getPort();
  const isProduction =
    process.env.NODE_ENV === 'production' || process.argv.includes('--production');

  // Static Assets / Vite Integration
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[J.A.R.V.I.S.] Server listening on http://0.0.0.0:${PORT}`);
  });
}

// Only start the listener if run directly (not during unit testing)
if (process.env.NODE_ENV !== 'test' && !process.env.TEST_RUNNER) {
  startServer().catch((err) => {
    console.error('[J.A.R.V.I.S.] Failed to start server:', err);
    process.exit(1);
  });
}
