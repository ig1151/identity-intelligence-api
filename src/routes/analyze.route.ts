import { Router, Request, Response, NextFunction } from 'express';
import { analyzeSchema, batchSchema } from '../utils/validation';
import { analyzeIdentity } from '../services/intelligence.service';
import type { AnalyzeRequest } from '../types/index';
export const analyzeRouter = Router();

analyzeRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error, value } = analyzeSchema.validate(req.body, { abortEarly: false });
    if (error) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: error.details.map((d) => d.message) } }); return; }
    res.status(200).json(await analyzeIdentity(value as AnalyzeRequest));
  } catch (err) { next(err); }
});

analyzeRouter.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error, value } = batchSchema.validate(req.body, { abortEarly: false });
    if (error) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: error.details.map((d) => d.message) } }); return; }
    const t0 = Date.now();
    const results = await Promise.allSettled(value.leads.map((l: AnalyzeRequest) => analyzeIdentity(l)));
    const out = results.map((r) => r.status === 'fulfilled' ? r.value : { error: r.reason instanceof Error ? r.reason.message : 'Unknown' });
    res.status(200).json({ batch_id: `batch_${Date.now()}`, total: value.leads.length, results: out, latency_ms: Date.now() - t0 });
  } catch (err) { next(err); }
});
