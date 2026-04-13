#!/bin/bash
set -e

echo "🚀 Building Identity Intelligence API..."

cat > src/types/index.ts << 'HEREDOC'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type LeadQuality = 'excellent' | 'good' | 'fair' | 'poor';
export type Recommendation = 'call_now' | 'nurture' | 'verify' | 'discard' | 'block';
export type CompanySize = 'solo' | 'small' | 'medium' | 'large' | 'enterprise' | 'unknown';

export interface AnalyzeRequest {
  email?: string;
  phone?: string;
  ip?: string;
  domain?: string;
  company_name?: string;
  country_code?: string;
  mode?: 'risk' | 'lead' | 'full';
}

export interface EmailIntelligence {
  valid: boolean;
  disposable: boolean;
  free_provider: boolean;
  role_based: boolean;
  mx_found: boolean;
  is_business: boolean;
  did_you_mean?: string;
  risk_score: number;
}

export interface PhoneIntelligence {
  valid: boolean;
  line_type: string;
  is_voip: boolean;
  is_likely_fake: boolean;
  country_code: string;
  risk_score: number;
}

export interface IpIntelligence {
  country: string;
  is_vpn: boolean;
  is_proxy: boolean;
  is_tor: boolean;
  is_hosting: boolean;
  threat_level: string;
  risk_score: number;
}

export interface CompanyIntelligence {
  name?: string;
  domain?: string;
  description?: string;
  industry?: string;
  company_size?: CompanySize;
  is_b2b?: boolean;
  has_website?: boolean;
  technologies?: string[];
}

export interface AnalyzeResponse {
  id: string;
  recommendation: Recommendation;
  risk_score: number;
  risk_level: RiskLevel;
  lead_score: number;
  lead_quality: LeadQuality;
  is_b2b: boolean;
  likely_to_convert: boolean;
  conversion_confidence: number;
  signals: { signal: string; severity: 'low' | 'medium' | 'high' | 'critical'; source: string }[];
  email?: EmailIntelligence;
  phone?: PhoneIntelligence;
  ip?: IpIntelligence;
  company?: CompanyIntelligence;
  checks_performed: string[];
  mode: string;
  latency_ms: number;
  created_at: string;
}
HEREDOC

cat > src/utils/config.ts << 'HEREDOC'
import 'dotenv/config';
function required(key: string): string { const val = process.env[key]; if (!val) throw new Error(`Missing required env var: ${key}`); return val; }
function optional(key: string, fallback: string): string { return process.env[key] ?? fallback; }
export const config = {
  anthropic: { apiKey: required('ANTHROPIC_API_KEY'), model: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514') },
  server: { port: parseInt(optional('PORT', '3000'), 10), nodeEnv: optional('NODE_ENV', 'development'), apiVersion: optional('API_VERSION', 'v1') },
  rateLimit: { windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10), maxFree: parseInt(optional('RATE_LIMIT_MAX_FREE', '20'), 10), maxPro: parseInt(optional('RATE_LIMIT_MAX_PRO', '500'), 10) },
  logging: { level: optional('LOG_LEVEL', 'info') },
} as const;
HEREDOC

cat > src/utils/logger.ts << 'HEREDOC'
import pino from 'pino';
import { config } from './config';
export const logger = pino({
  level: config.logging.level,
  transport: config.server.nodeEnv === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  base: { service: 'identity-intelligence-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['req.headers.authorization'], censor: '[REDACTED]' },
});
HEREDOC

cat > src/utils/validation.ts << 'HEREDOC'
import Joi from 'joi';
export const analyzeSchema = Joi.object({
  email: Joi.string().optional(),
  phone: Joi.string().optional(),
  ip: Joi.string().optional(),
  domain: Joi.string().optional(),
  company_name: Joi.string().optional(),
  country_code: Joi.string().length(2).uppercase().optional(),
  mode: Joi.string().valid('risk', 'lead', 'full').default('full'),
}).or('email', 'phone', 'ip', 'domain', 'company_name').messages({
  'object.missing': 'At least one of email, phone, ip, domain or company_name is required',
});
export const batchSchema = Joi.object({
  leads: Joi.array().items(analyzeSchema).min(1).max(20).required(),
});
HEREDOC

cat > src/utils/email.utils.ts << 'HEREDOC'
import { promises as dnsPromises } from 'dns';
const DISPOSABLE = new Set(['mailinator.com','guerrillamail.com','tempmail.com','throwaway.email','yopmail.com','trashmail.com','maildrop.cc','10minutemail.com','tempinbox.com','fakeinbox.com','discard.email','spam4.me']);
const FREE = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','protonmail.com','mail.com','zoho.com','gmx.com','live.com','me.com','googlemail.com']);
const ROLE = new Set(['admin','info','support','help','contact','sales','billing','noreply','no-reply','webmaster','postmaster','abuse','security','marketing','newsletter']);
const TYPOS: Record<string,string> = { 'gmial.com':'gmail.com','gmai.com':'gmail.com','yahooo.com':'yahoo.com','hotmai.com':'hotmail.com','outlok.com':'outlook.com' };
export async function analyzeEmail(email: string) {
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const [username, domain] = email.split('@');
  let mxFound = false;
  if (valid && domain) { try { const mx = await dnsPromises.resolveMx(domain); mxFound = mx.length > 0; } catch { mxFound = false; } }
  const disposable = DISPOSABLE.has(domain?.toLowerCase() ?? '');
  const freeProvider = FREE.has(domain?.toLowerCase() ?? '');
  const roleBased = ROLE.has((username ?? '').toLowerCase().split('+')[0]);
  const isBusiness = !freeProvider && !disposable && mxFound && valid;
  const didYouMean = TYPOS[domain?.toLowerCase() ?? ''] ? `${username}@${TYPOS[domain.toLowerCase()]}` : undefined;
  let riskScore = 0;
  if (!valid) riskScore += 50;
  if (!mxFound) riskScore += 30;
  if (disposable) riskScore += 40;
  if (roleBased) riskScore += 10;
  return { valid: valid && mxFound, disposable, free_provider: freeProvider, role_based: roleBased, mx_found: mxFound, is_business: isBusiness, did_you_mean: didYouMean, risk_score: Math.min(100, riskScore), domain: domain ?? '' };
}
HEREDOC

cat > src/utils/phone.utils.ts << 'HEREDOC'
import { parsePhoneNumberFromString } from 'libphonenumber-js';
const DISPOSABLE_PREFIXES = ['1900','1976','1977','1978','1979'];
export function analyzePhone(phone: string, countryCode?: string) {
  try {
    const parsed = parsePhoneNumberFromString(phone, countryCode as never);
    if (!parsed) return { valid: false, line_type: 'unknown', is_voip: false, is_likely_fake: true, country_code: '', risk_score: 80 };
    const type = parsed.getType();
    const lineType = type === 'MOBILE' ? 'mobile' : type === 'FIXED_LINE' ? 'landline' : type === 'VOIP' ? 'voip' : type === 'TOLL_FREE' ? 'toll_free' : type === 'FIXED_LINE_OR_MOBILE' ? 'mobile' : 'unknown';
    const isVoip = lineType === 'voip';
    const digits = phone.replace(/\D/g, '').replace(/^1/, '');
    const isLikelyFake = /^(\d)\1{6,}/.test(digits) || digits === '1234567890' || digits.length < 7;
    const isDisposable = DISPOSABLE_PREFIXES.some(p => digits.startsWith(p));
    let riskScore = 0;
    if (!parsed.isValid()) riskScore += 40;
    if (isVoip) riskScore += 40;
    if (isLikelyFake) riskScore += 60;
    if (isDisposable) riskScore += 50;
    return { valid: parsed.isValid(), line_type: lineType, is_voip: isVoip, is_likely_fake: isLikelyFake, country_code: parsed.country ?? countryCode ?? '', risk_score: Math.min(100, riskScore) };
  } catch { return { valid: false, line_type: 'unknown', is_voip: false, is_likely_fake: true, country_code: '', risk_score: 80 }; }
}
HEREDOC

cat > src/utils/ip.utils.ts << 'HEREDOC'
import http from 'http';
const HOSTING_ASNS = new Set(['AS16509','AS14618','AS15169','AS396982','AS8075','AS13335','AS14061','AS16276','AS24940','AS20473']);
const VPN_ORGS = ['nordvpn','expressvpn','surfshark','cyberghost','protonvpn','ipvanish','mullvad','privateinternetaccess'];
const TOR_INDICATORS = ['tor','torproject','exit node'];
function httpGet(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } }); }).on('error', reject);
  });
}
export async function analyzeIP(ip: string) {
  try {
    const data = await httpGet(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,isp,org,as,proxy,hosting,query`);
    if (data.status === 'fail') return { country: '', is_vpn: false, is_proxy: false, is_tor: false, is_hosting: false, threat_level: 'unknown', risk_score: 0 };
    const org = String(data.org ?? '').toLowerCase();
    const isp = String(data.isp ?? '').toLowerCase();
    const asn = String(data.as ?? '');
    const combined = `${org} ${isp}`;
    const isVpn = VPN_ORGS.some(v => combined.includes(v)) || Boolean(data.proxy);
    const isTor = TOR_INDICATORS.some(t => combined.includes(t));
    const isHosting = HOSTING_ASNS.has(asn.split(' ')[0]) || Boolean(data.hosting);
    const isProxy = Boolean(data.proxy);
    let riskScore = 0;
    if (isTor) riskScore += 90;
    else if (isProxy) riskScore += 70;
    else if (isVpn) riskScore += 50;
    else if (isHosting) riskScore += 30;
    const threatLevel = riskScore >= 80 ? 'critical' : riskScore >= 50 ? 'high' : riskScore >= 20 ? 'medium' : 'low';
    return { country: String(data.countryCode ?? ''), is_vpn: isVpn, is_proxy: isProxy, is_tor: isTor, is_hosting: isHosting, threat_level: threatLevel, risk_score: Math.min(100, riskScore) };
  } catch { return { country: '', is_vpn: false, is_proxy: false, is_tor: false, is_hosting: false, threat_level: 'unknown', risk_score: 0 }; }
}
HEREDOC

cat > src/utils/scraper.ts << 'HEREDOC'
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from './logger';
export async function scrapeWebsite(domain: string): Promise<string> {
  const url = domain.startsWith('http') ? domain : `https://${domain}`;
  try {
    const response = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IdentityIntelligenceBot/1.0)' }, maxRedirects: 3 });
    const $ = cheerio.load(response.data as string);
    $('script, style, nav, footer, header').remove();
    const title = $('title').text().trim();
    const metaDesc = $('meta[name="description"]').attr('content') ?? '';
    const h1 = $('h1').first().text().trim();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000);
    return `Title: ${title}\nDescription: ${metaDesc}\nH1: ${h1}\nBody: ${bodyText}`;
  } catch (err) { logger.warn({ domain, err }, 'Failed to scrape'); return `Domain: ${domain}`; }
}
HEREDOC

cat > src/services/intelligence.service.ts << 'HEREDOC'
import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { analyzeEmail } from '../utils/email.utils';
import { analyzePhone } from '../utils/phone.utils';
import { analyzeIP } from '../utils/ip.utils';
import { scrapeWebsite } from '../utils/scraper';
import type { AnalyzeRequest, AnalyzeResponse, RiskLevel, LeadQuality, Recommendation, CompanySize } from '../types/index';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

function getRiskLevel(score: number): RiskLevel { return score >= 80 ? 'critical' : score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low'; }
function getLeadQuality(score: number): LeadQuality { return score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor'; }

function getRecommendation(riskScore: number, leadScore: number, isB2b: boolean): Recommendation {
  if (riskScore >= 70) return 'block';
  if (riskScore >= 40) return 'verify';
  if (leadScore >= 75 && isB2b) return 'call_now';
  if (leadScore >= 50) return 'nurture';
  return 'discard';
}

export async function analyzeIdentity(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  const id = `intel_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const t0 = Date.now();
  const mode = req.mode ?? 'full';
  const checksPerformed: string[] = [];
  const signals: AnalyzeResponse['signals'] = [];

  logger.info({ id, mode, email: req.email, domain: req.domain }, 'Starting identity analysis');

  let emailData, phoneData, ipData;
  let emailRiskScore = 0, phoneRiskScore = 0, ipRiskScore = 0;
  let companyDomain = req.domain ?? '';

  if (req.email) {
    checksPerformed.push('email');
    emailData = await analyzeEmail(req.email);
    emailRiskScore = emailData.risk_score;
    if (!companyDomain && emailData.domain && emailData.is_business) companyDomain = emailData.domain;
    if (emailData.disposable) signals.push({ signal: 'Disposable email detected', severity: 'high', source: 'email' });
    if (!emailData.mx_found) signals.push({ signal: 'Email domain has no MX records', severity: 'high', source: 'email' });
    if (!emailData.valid) signals.push({ signal: 'Invalid email address', severity: 'critical', source: 'email' });
    if (emailData.role_based) signals.push({ signal: 'Role-based email address', severity: 'low', source: 'email' });
    if (emailData.did_you_mean) signals.push({ signal: `Possible typo — did you mean ${emailData.did_you_mean}?`, severity: 'medium', source: 'email' });
    if (emailData.is_business) signals.push({ signal: 'Business email address', severity: 'low', source: 'email' });
  }

  if (req.phone) {
    checksPerformed.push('phone');
    phoneData = analyzePhone(req.phone, req.country_code);
    phoneRiskScore = phoneData.risk_score;
    if (phoneData.is_voip) signals.push({ signal: 'VoIP phone number detected', severity: 'high', source: 'phone' });
    if (phoneData.is_likely_fake) signals.push({ signal: 'Phone appears fake or sequential', severity: 'critical', source: 'phone' });
    if (!phoneData.valid) signals.push({ signal: 'Invalid phone number', severity: 'high', source: 'phone' });
    if (phoneData.valid && !phoneData.is_voip) signals.push({ signal: 'Valid direct phone number', severity: 'low', source: 'phone' });
  }

  if (req.ip) {
    checksPerformed.push('ip');
    ipData = await analyzeIP(req.ip);
    ipRiskScore = ipData.risk_score;
    if (ipData.is_tor) signals.push({ signal: 'Tor exit node detected', severity: 'critical', source: 'ip' });
    if (ipData.is_proxy) signals.push({ signal: 'Proxy server detected', severity: 'high', source: 'ip' });
    if (ipData.is_vpn) signals.push({ signal: 'VPN service detected', severity: 'high', source: 'ip' });
    if (ipData.is_hosting) signals.push({ signal: 'Datacenter IP detected', severity: 'medium', source: 'ip' });
  }

  const riskScores = [emailRiskScore, phoneRiskScore, ipRiskScore].filter((_, i) => [req.email, req.phone, req.ip][i]);
  const riskScore = riskScores.length > 0 ? Math.round(riskScores.reduce((a, b) => a + b, 0) / riskScores.length) : 0;

  let companyData = undefined;
  let leadScore = 50;
  let isB2b = emailData?.is_business ?? false;

  if ((companyDomain || req.company_name) && (mode === 'lead' || mode === 'full')) {
    checksPerformed.push('company');
    let websiteContent = '';
    if (companyDomain) websiteContent = await scrapeWebsite(companyDomain);
    try {
      const prompt = `Analyze this company for B2B lead scoring.
Company: ${req.company_name ?? companyDomain}
Website: ${websiteContent}
Email is business: ${emailData?.is_business ?? false}

Return ONLY valid JSON:
{
  "name": "<string>",
  "description": "<1-2 sentences>",
  "industry": "<string>",
  "company_size": "<solo|small|medium|large|enterprise>",
  "is_b2b": <boolean>,
  "has_website": <boolean>,
  "technologies": ["<tech1>"],
  "lead_score": <integer 0-100>,
  "positive_signals": ["<signal>"],
  "negative_signals": ["<signal>"]
}`;
      const response = await client.messages.create({ model: config.anthropic.model, max_tokens: 512, messages: [{ role: 'user', content: prompt }] });
      const raw = response.content.find(b => b.type === 'text')?.text ?? '{}';
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      companyData = { name: parsed.name, domain: companyDomain, description: parsed.description, industry: parsed.industry, company_size: (parsed.company_size ?? 'unknown') as CompanySize, is_b2b: parsed.is_b2b ?? isB2b, has_website: parsed.has_website ?? !!companyDomain, technologies: parsed.technologies ?? [] };
      isB2b = parsed.is_b2b ?? isB2b;
      leadScore = parsed.lead_score ?? 50;
      (parsed.positive_signals ?? []).forEach((s: string) => signals.push({ signal: s, severity: 'low', source: 'company' }));
      (parsed.negative_signals ?? []).forEach((s: string) => signals.push({ signal: s, severity: 'medium', source: 'company' }));
    } catch (err) { logger.warn({ id, err }, 'Company enrichment failed'); }
  }

  if (emailData?.is_business) leadScore += 10;
  if (emailData?.disposable) leadScore -= 30;
  if (emailData?.free_provider) leadScore -= 10;
  if (phoneData?.valid && !phoneData?.is_voip) leadScore += 10;
  if (phoneData?.is_voip) leadScore -= 10;
  if (riskScore > 60) leadScore -= 20;

  leadScore = Math.min(100, Math.max(0, leadScore));
  const riskLevel = getRiskLevel(riskScore);
  const leadQuality = getLeadQuality(leadScore);
  const recommendation = getRecommendation(riskScore, leadScore, isB2b);
  const likelyToConvert = leadScore >= 60 && riskScore < 50;
  const conversionConfidence = parseFloat((leadScore / 100).toFixed(2));

  logger.info({ id, riskScore, leadScore, recommendation }, 'Analysis complete');

  return {
    id, recommendation, risk_score: riskScore, risk_level: riskLevel,
    lead_score: leadScore, lead_quality: leadQuality,
    is_b2b: isB2b, likely_to_convert: likelyToConvert, conversion_confidence: conversionConfidence,
    signals,
    ...(emailData && { email: emailData }),
    ...(phoneData && { phone: phoneData }),
    ...(ipData && { ip: ipData }),
    ...(companyData && { company: companyData }),
    checks_performed: checksPerformed, mode,
    latency_ms: Date.now() - t0, created_at: new Date().toISOString(),
  };
}
HEREDOC

cat > src/middleware/error.middleware.ts << 'HEREDOC'
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
}
export function notFound(req: Request, res: Response): void { res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } }); }
HEREDOC

cat > src/middleware/ratelimit.middleware.ts << 'HEREDOC'
import rateLimit from 'express-rate-limit';
import { config } from '../utils/config';
export const rateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs, max: config.rateLimit.maxFree,
  standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => req.headers['authorization']?.replace('Bearer ', '') ?? req.ip ?? 'unknown',
  handler: (_req, res) => { res.status(429).json({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' } }); },
});
HEREDOC

cat > src/routes/health.route.ts << 'HEREDOC'
import { Router, Request, Response } from 'express';
export const healthRouter = Router();
const startTime = Date.now();
healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: '1.0.0', uptime_seconds: Math.floor((Date.now() - startTime) / 1000), timestamp: new Date().toISOString() });
});
HEREDOC

cat > src/routes/analyze.route.ts << 'HEREDOC'
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
HEREDOC

cat > src/routes/openapi.route.ts << 'HEREDOC'
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
HEREDOC

cat > src/app.ts << 'HEREDOC'
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { analyzeRouter } from './routes/analyze.route';
import { healthRouter } from './routes/health.route';
import { openapiRouter, docsRouter } from './routes/openapi.route';
import { errorHandler, notFound } from './middleware/error.middleware';
import { rateLimiter } from './middleware/ratelimit.middleware';
import { logger } from './utils/logger';
import { config } from './utils/config';
const app = express();
app.use(helmet()); app.use(cors()); app.use(compression());
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(`/${config.server.apiVersion}/analyze`, rateLimiter);
app.use(`/${config.server.apiVersion}/analyze`, analyzeRouter);
app.use(`/${config.server.apiVersion}/health`, healthRouter);
app.use('/openapi.json', openapiRouter);
app.use('/docs', docsRouter);
app.get('/', (_req, res) => res.redirect(`/${config.server.apiVersion}/health`));
app.use(notFound);
app.use(errorHandler);
export { app };
HEREDOC

cat > src/index.ts << 'HEREDOC'
import { app } from './app';
import { config } from './utils/config';
import { logger } from './utils/logger';
const server = app.listen(config.server.port, () => { logger.info({ port: config.server.port, env: config.server.nodeEnv }, '🚀 Identity Intelligence API started'); });
const shutdown = (signal: string) => { logger.info({ signal }, 'Shutting down'); server.close(() => { logger.info('Closed'); process.exit(0); }); setTimeout(() => process.exit(1), 10_000); };
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'Uncaught exception'); process.exit(1); });
HEREDOC

cat > jest.config.js << 'HEREDOC'
module.exports = { preset: 'ts-jest', testEnvironment: 'node', rootDir: '.', testMatch: ['**/tests/**/*.test.ts'], collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'], setupFiles: ['<rootDir>/tests/setup.ts'] };
HEREDOC

cat > tests/setup.ts << 'HEREDOC'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
HEREDOC

cat > .gitignore << 'HEREDOC'
node_modules/
dist/
.env
coverage/
*.log
.DS_Store
HEREDOC

cat > render.yaml << 'HEREDOC'
services:
  - type: web
    name: identity-intelligence-api
    runtime: node
    buildCommand: npm install && npm run build
    startCommand: node dist/index.js
    healthCheckPath: /v1/health
    envVars:
      - key: NODE_ENV
        value: production
      - key: LOG_LEVEL
        value: info
      - key: ANTHROPIC_API_KEY
        sync: false
HEREDOC

echo ""
echo "✅ All files created! Run: npm install"