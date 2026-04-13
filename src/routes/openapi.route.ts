import { Router, Request, Response } from 'express';
import { config } from '../utils/config';
export const openapiRouter = Router();
export const docsRouter = Router();

const docsHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Identity Intelligence API — Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; color: #333; }
    h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid #eee; padding-bottom: 0.5rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-right: 8px; }
    .post { background: #e8f5e9; color: #2e7d32; }
    .endpoint { background: #f5f5f5; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
    .path { font-family: monospace; font-size: 1rem; font-weight: bold; }
    .desc { color: #666; font-size: 0.9rem; margin-top: 0.25rem; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
    th, td { text-align: left; padding: 8px; border: 1px solid #ddd; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>Identity Intelligence API</h1>
  <p>Know which users to trust and which leads to prioritize — email, phone, IP and company intelligence in one call.</p>
  <p><strong>Base URL:</strong> <code>https://identity-intelligence-api.onrender.com</code></p>

  <h2>Quick start</h2>
  <pre>const res = await fetch("https://identity-intelligence-api.onrender.com/v1/analyze", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "john@stripe.com",
    phone: "+14155552671",
    ip: "8.8.8.8",
    domain: "stripe.com"
  })
});
const { recommendation, risk_score, lead_score } = await res.json();
if (recommendation === "block") rejectUser();
else if (recommendation === "call_now") prioritizeLead();
else if (recommendation === "verify") requireOTP();</pre>

  <h2>Modes</h2>
  <table>
    <tr><th>Mode</th><th>What it does</th><th>Best for</th></tr>
    <tr><td>full (default)</td><td>Risk + lead scoring + company enrichment</td><td>Complete user intelligence</td></tr>
    <tr><td>risk</td><td>Risk scoring only — email, phone, IP</td><td>Signup fraud prevention</td></tr>
    <tr><td>lead</td><td>Lead scoring + company enrichment</td><td>CRM and sales qualification</td></tr>
  </table>

  <h2>Endpoints</h2>
  <div class="endpoint">
    <div><span class="badge post">POST</span><span class="path">/v1/analyze</span></div>
    <div class="desc">Analyze a single identity — pass any combination of email, phone, IP, domain</div>
    <pre>curl -X POST https://identity-intelligence-api.onrender.com/v1/analyze \\
  -H "Content-Type: application/json" \\
  -d '{"email": "john@stripe.com", "ip": "8.8.8.8", "domain": "stripe.com"}'</pre>
  </div>
  <div class="endpoint">
    <div><span class="badge post">POST</span><span class="path">/v1/analyze/batch</span></div>
    <div class="desc">Analyze up to 20 identities in one request</div>
    <pre>curl -X POST https://identity-intelligence-api.onrender.com/v1/analyze/batch \\
  -H "Content-Type: application/json" \\
  -d '{"leads": [{"email": "a@company.com"}, {"email": "b@gmail.com"}]}'</pre>
  </div>

  <h2>Recommendation values</h2>
  <table>
    <tr><th>Value</th><th>Meaning</th><th>Action</th></tr>
    <tr><td>call_now</td><td>High quality B2B lead, low risk</td><td>Prioritize for immediate outreach</td></tr>
    <tr><td>nurture</td><td>Decent lead, low risk</td><td>Add to email sequence</td></tr>
    <tr><td>verify</td><td>Medium risk signals</td><td>Require OTP or extra verification</td></tr>
    <tr><td>discard</td><td>Low quality lead</td><td>Remove from pipeline</td></tr>
    <tr><td>block</td><td>High risk — fraud signals</td><td>Reject signup or flag for review</td></tr>
  </table>

  <h2>How scoring works</h2>
  <table>
    <tr><th>Signal</th><th>Raises risk score</th><th>Raises lead score</th></tr>
    <tr><td>Email</td><td>Disposable, no MX, invalid</td><td>Business email, valid MX</td></tr>
    <tr><td>Phone</td><td>VoIP, fake digits, invalid</td><td>Valid direct number</td></tr>
    <tr><td>IP</td><td>Tor, proxy, VPN, hosting</td><td>Clean residential IP</td></tr>
    <tr><td>Company</td><td>No website, consumer brand</td><td>B2B, enterprise, active site</td></tr>
  </table>

  <h2>OpenAPI Spec</h2>
  <p><a href="/openapi.json">Download openapi.json</a></p>
</body>
</html>`;

docsRouter.get('/', (_req: Request, res: Response) => { res.setHeader('Content-Type', 'text/html'); res.send(docsHtml); });

openapiRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    openapi: '3.0.3',
    info: { title: 'Identity Intelligence API', version: '1.0.0', description: 'Email, phone, IP and company intelligence combined into unified risk and lead scores.' },
    servers: [{ url: 'https://identity-intelligence-api.onrender.com', description: 'Production' }, { url: `http://localhost:${config.server.port}`, description: 'Local' }],
    paths: {
      '/v1/health': { get: { summary: 'Health check', operationId: 'getHealth', responses: { '200': { description: 'OK' } } } },
      '/v1/analyze': {
        post: { summary: 'Analyze identity', operationId: 'analyzePost', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AnalyzeRequest' }, examples: { full: { summary: 'Full analysis', value: { email: 'john@stripe.com', phone: '+14155552671', ip: '8.8.8.8', domain: 'stripe.com' } }, risk_only: { summary: 'Risk only', value: { email: 'user@gmail.com', ip: '8.8.8.8', mode: 'risk' } }, lead_only: { summary: 'Lead only', value: { email: 'ceo@startup.com', domain: 'startup.com', mode: 'lead' } } } } } }, responses: { '200': { description: 'Analysis result' }, '422': { description: 'Validation error' } } },
      },
      '/v1/analyze/batch': { post: { summary: 'Analyze up to 20 identities', operationId: 'analyzeBatch', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchRequest' } } } }, responses: { '200': { description: 'Batch results' } } } },
    },
    components: {
      schemas: {
        AnalyzeRequest: { type: 'object', properties: { email: { type: 'string' }, phone: { type: 'string' }, ip: { type: 'string' }, domain: { type: 'string' }, company_name: { type: 'string' }, country_code: { type: 'string' }, mode: { type: 'string', enum: ['risk', 'lead', 'full'], default: 'full' } }, minProperties: 1 },
        BatchRequest: { type: 'object', required: ['leads'], properties: { leads: { type: 'array', items: { $ref: '#/components/schemas/AnalyzeRequest' }, minItems: 1, maxItems: 20 } } },
      },
    },
  });
});
