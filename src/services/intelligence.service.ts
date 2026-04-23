import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { analyzeEmail } from '../utils/email.utils';
import { analyzePhone } from '../utils/phone.utils';
import { analyzeIP } from '../utils/ip.utils';
import { scrapeWebsite } from '../utils/scraper';
import type { AnalyzeRequest, AnalyzeResponse, RiskLevel, LeadQuality, Recommendation, CompanySize, UseCase } from '../types/index';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4-5';

function getRiskLevel(score: number): RiskLevel { return score >= 80 ? 'critical' : score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low'; }
function getLeadQuality(score: number): LeadQuality { return score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor'; }

const USE_CASE_THRESHOLDS: Record<UseCase, { blockAt: number; verifyAt: number; callAt: number }> = {
  signup:   { blockAt: 60, verifyAt: 30, callAt: 70 },
  login:    { blockAt: 70, verifyAt: 40, callAt: 75 },
  checkout: { blockAt: 50, verifyAt: 25, callAt: 70 },
  lead:     { blockAt: 75, verifyAt: 40, callAt: 65 },
  kyc:      { blockAt: 40, verifyAt: 20, callAt: 80 },
};

function getRecommendation(riskScore: number, leadScore: number, isB2b: boolean, useCase: UseCase): Recommendation {
  const t = USE_CASE_THRESHOLDS[useCase];
  if (riskScore >= t.blockAt) return 'block';
  if (riskScore >= t.verifyAt) return 'verify';
  if (leadScore >= t.callAt && isB2b) return 'call_now';
  if (leadScore >= 50) return 'nurture';
  return 'discard';
}

interface RiskFactors {
  isTor: boolean; isProxy: boolean; isVpn: boolean; isHosting: boolean;
  isDisposableEmail: boolean; isInvalidEmail: boolean; isFakePhone: boolean;
  isVoip: boolean; noMxRecords: boolean; isRoleBased: boolean;
}

function calculateWeightedRiskScore(factors: RiskFactors, useCase: UseCase): number {
  let score = 0;
  if (factors.isTor) score += 90;
  else if (factors.isProxy) score += 70;
  else if (factors.isVpn) score += 50;
  if (factors.isDisposableEmail) score += 45;
  if (factors.isInvalidEmail) score += 40;
  if (factors.isFakePhone) score += 40;
  if (factors.isVoip) score += 35;
  if (factors.isHosting) score += 25;
  if (factors.noMxRecords) score += 20;
  if (factors.isRoleBased) score += 10;
  const highRiskCount = [factors.isTor, factors.isProxy, factors.isVpn, factors.isDisposableEmail, factors.isFakePhone].filter(Boolean).length;
  if (highRiskCount >= 3) score += 15;
  if (factors.isDisposableEmail && factors.isVoip) score += 20;
  if (factors.isVpn && factors.isDisposableEmail) score += 20;
  if (factors.isTor) score = Math.max(score, 95);
  if (useCase === 'checkout' || useCase === 'kyc') { if (factors.isHosting) score += 10; if (factors.isVoip) score += 10; }
  if (useCase === 'login') { if (factors.isVpn) score += 15; if (factors.isTor) score += 5; }
  if (useCase === 'signup') { if (factors.isDisposableEmail) score += 10; if (factors.isFakePhone) score += 10; }
  return Math.min(100, score);
}

interface LeadFactors {
  isBusinessEmail: boolean; validMx: boolean; validPhone: boolean; isVoip: boolean;
  isEnterprise: boolean; isB2b: boolean; hasWebsite: boolean; riskScore: number;
}

function calculateWeightedLeadScore(base: number, factors: LeadFactors): number {
  let score = base;
  if (factors.isBusinessEmail && factors.validMx) score += 25;
  if (factors.validPhone && !factors.isVoip) score += 15;
  if (factors.isEnterprise) score += 20;
  if (factors.isB2b) score += 15;
  if (factors.hasWebsite) score += 10;
  if (factors.riskScore < 20) score += 10;
  if (factors.riskScore >= 70) score -= 40;
  else if (factors.riskScore >= 40) score -= 20;
  return Math.min(100, Math.max(0, score));
}

export async function analyzeIdentity(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  const id = `intel_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const t0 = Date.now();
  const mode = req.mode ?? 'full';
  const useCase = req.use_case ?? 'signup';
  const checksPerformed: string[] = [];
  const signals: AnalyzeResponse['signals'] = [];
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  logger.info({ id, mode, useCase, email: req.email, domain: req.domain }, 'Starting identity analysis');

  let emailData, phoneData, ipData;
  let companyDomain = req.domain ?? '';

  if (req.email) {
    checksPerformed.push('email');
    emailData = await analyzeEmail(req.email);
    if (!companyDomain && emailData.domain && emailData.is_business) companyDomain = emailData.domain;
    if (emailData.disposable) signals.push({ signal: 'Disposable email detected', severity: 'high', source: 'email' });
    if (!emailData.mx_found) signals.push({ signal: 'Email domain has no MX records', severity: 'high', source: 'email' });
    if (!emailData.valid) signals.push({ signal: 'Invalid email address', severity: 'critical', source: 'email' });
    if (emailData.role_based) signals.push({ signal: 'Role-based email address', severity: 'low', source: 'email' });
    if (emailData.did_you_mean) signals.push({ signal: `Possible typo — did you mean ${emailData.did_you_mean}?`, severity: 'medium', source: 'email' });
    if (emailData.is_business) signals.push({ signal: 'Business email address verified', severity: 'low', source: 'email' });
  }

  if (req.phone) {
    checksPerformed.push('phone');
    phoneData = analyzePhone(req.phone, req.country_code);
    if (phoneData.is_voip) signals.push({ signal: 'VoIP phone number detected', severity: 'high', source: 'phone' });
    if (phoneData.is_likely_fake) signals.push({ signal: 'Phone appears fake or sequential', severity: 'critical', source: 'phone' });
    if (!phoneData.valid) signals.push({ signal: 'Invalid phone number', severity: 'high', source: 'phone' });
    if (phoneData.valid && !phoneData.is_voip) signals.push({ signal: 'Valid direct phone number', severity: 'low', source: 'phone' });
  }

  if (req.ip) {
    checksPerformed.push('ip');
    ipData = await analyzeIP(req.ip);
    if (ipData.is_tor) signals.push({ signal: 'Tor exit node detected', severity: 'critical', source: 'ip' });
    if (ipData.is_proxy) signals.push({ signal: 'Proxy server detected', severity: 'high', source: 'ip' });
    if (ipData.is_vpn) signals.push({ signal: 'VPN service detected', severity: 'high', source: 'ip' });
    if (ipData.is_hosting) signals.push({ signal: 'Datacenter IP detected', severity: 'medium', source: 'ip' });
  }

  const riskFactors: RiskFactors = {
    isTor: ipData?.is_tor ?? false, isProxy: ipData?.is_proxy ?? false,
    isVpn: ipData?.is_vpn ?? false, isHosting: ipData?.is_hosting ?? false,
    isDisposableEmail: emailData?.disposable ?? false, isInvalidEmail: emailData ? !emailData.valid : false,
    isFakePhone: phoneData?.is_likely_fake ?? false, isVoip: phoneData?.is_voip ?? false,
    noMxRecords: emailData ? !emailData.mx_found : false, isRoleBased: emailData?.role_based ?? false,
  };

  const hasAnyCheck = req.email || req.phone || req.ip;
  const riskScore = hasAnyCheck ? calculateWeightedRiskScore(riskFactors, useCase) : 0;

  let companyData = undefined;
  let baseLeadScore = 50;
  let isB2b = emailData?.is_business ?? false;
  let isEnterprise = false;
  let hasWebsite = !!companyDomain;

  if ((companyDomain || req.company_name) && (mode === 'lead' || mode === 'full')) {
    checksPerformed.push('company');
    let websiteContent = '';
    if (companyDomain) websiteContent = await scrapeWebsite(companyDomain);
    try {
      const prompt = `Analyze this company for B2B lead scoring.
Company: ${req.company_name ?? companyDomain}
Website: ${websiteContent}

Return ONLY valid JSON:
{
  "name": "<string>",
  "description": "<1-2 sentences>",
  "industry": "<string>",
  "company_size": "<solo|small|medium|large|enterprise>",
  "is_b2b": <boolean>,
  "has_website": <boolean>,
  "technologies": ["<tech1>"],
  "base_lead_score": <integer 0-100>,
  "positive_signals": ["<signal>"],
  "negative_signals": ["<signal>"]
}`;

      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MODEL, max_tokens: 512, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
      });

      if (!response.ok) throw new Error(`OpenRouter error: ${response.status}`);
      const data = await response.json() as { choices: { message: { content: string } }[] };
      const raw = data.choices[0].message.content ?? '{}';
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      companyData = { name: parsed.name, domain: companyDomain, description: parsed.description, industry: parsed.industry, company_size: (parsed.company_size ?? 'unknown') as CompanySize, is_b2b: parsed.is_b2b ?? isB2b, has_website: parsed.has_website ?? !!companyDomain, technologies: parsed.technologies ?? [] };
      isB2b = parsed.is_b2b ?? isB2b;
      isEnterprise = parsed.company_size === 'enterprise' || parsed.company_size === 'large';
      hasWebsite = parsed.has_website ?? !!companyDomain;
      baseLeadScore = parsed.base_lead_score ?? 50;
      (parsed.positive_signals ?? []).forEach((s: string) => signals.push({ signal: s, severity: 'low', source: 'company' }));
      (parsed.negative_signals ?? []).forEach((s: string) => signals.push({ signal: s, severity: 'medium', source: 'company' }));
    } catch (err) { logger.warn({ id, err }, 'Company enrichment failed'); }
  }

  const leadFactors: LeadFactors = {
    isBusinessEmail: emailData?.is_business ?? false, validMx: emailData?.mx_found ?? false,
    validPhone: phoneData?.valid ?? false, isVoip: phoneData?.is_voip ?? false,
    isEnterprise, isB2b, hasWebsite, riskScore,
  };

  const leadScore = calculateWeightedLeadScore(baseLeadScore, leadFactors);
  const riskLevel = getRiskLevel(riskScore);
  const leadQuality = getLeadQuality(leadScore);
  const recommendation = getRecommendation(riskScore, leadScore, isB2b, useCase);
  const likelyToConvert = leadScore >= 60 && riskScore < 50;
  const conversionConfidence = parseFloat((leadScore / 100).toFixed(2));

  logger.info({ id, riskScore, leadScore, recommendation, useCase }, 'Analysis complete');

  return {
    id, use_case: useCase, recommendation,
    risk_score: riskScore, risk_level: riskLevel,
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
