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

interface RiskFactors {
  isTor: boolean;
  isProxy: boolean;
  isVpn: boolean;
  isHosting: boolean;
  isDisposableEmail: boolean;
  isInvalidEmail: boolean;
  isFakePhone: boolean;
  isVoip: boolean;
  noMxRecords: boolean;
  isRoleBased: boolean;
}

function calculateWeightedRiskScore(factors: RiskFactors): number {
  let score = 0;

  // Individual signal weights
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

  // Correlation bonuses — multiple signals together are worse
  const highRiskCount = [factors.isTor, factors.isProxy, factors.isVpn, factors.isDisposableEmail, factors.isFakePhone].filter(Boolean).length;
  if (highRiskCount >= 3) score += 15;
  if (factors.isDisposableEmail && factors.isVoip) score += 20;
  if (factors.isVpn && factors.isDisposableEmail) score += 20;
  if (factors.isTor) score = Math.max(score, 95);

  return Math.min(100, score);
}

interface LeadFactors {
  isBusinessEmail: boolean;
  validMx: boolean;
  validPhone: boolean;
  isVoip: boolean;
  isEnterprise: boolean;
  isB2b: boolean;
  hasWebsite: boolean;
  riskScore: number;
}

function calculateWeightedLeadScore(base: number, factors: LeadFactors): number {
  let score = base;

  if (factors.isBusinessEmail && factors.validMx) score += 25;
  if (factors.validPhone && !factors.isVoip) score += 15;
  if (factors.isEnterprise) score += 20;
  if (factors.isB2b) score += 15;
  if (factors.hasWebsite) score += 10;
  if (factors.riskScore < 20) score += 10;

  // Risk penalty
  if (factors.riskScore >= 70) score -= 40;
  else if (factors.riskScore >= 40) score -= 20;

  return Math.min(100, Math.max(0, score));
}

export async function analyzeIdentity(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  const id = `intel_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const t0 = Date.now();
  const mode = req.mode ?? 'full';
  const checksPerformed: string[] = [];
  const signals: AnalyzeResponse['signals'] = [];

  logger.info({ id, mode, email: req.email, domain: req.domain }, 'Starting identity analysis');

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

  // Weighted risk score
  const riskFactors: RiskFactors = {
    isTor: ipData?.is_tor ?? false,
    isProxy: ipData?.is_proxy ?? false,
    isVpn: ipData?.is_vpn ?? false,
    isHosting: ipData?.is_hosting ?? false,
    isDisposableEmail: emailData?.disposable ?? false,
    isInvalidEmail: emailData ? !emailData.valid : false,
    isFakePhone: phoneData?.is_likely_fake ?? false,
    isVoip: phoneData?.is_voip ?? false,
    noMxRecords: emailData ? !emailData.mx_found : false,
    isRoleBased: emailData?.role_based ?? false,
  };

  const hasAnyCheck = req.email || req.phone || req.ip;
  const riskScore = hasAnyCheck ? calculateWeightedRiskScore(riskFactors) : 0;

  // Company enrichment
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
      const response = await client.messages.create({ model: config.anthropic.model, max_tokens: 512, messages: [{ role: 'user', content: prompt }] });
      const raw = response.content.find(b => b.type === 'text')?.text ?? '{}';
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      companyData = {
        name: parsed.name, domain: companyDomain, description: parsed.description,
        industry: parsed.industry, company_size: (parsed.company_size ?? 'unknown') as CompanySize,
        is_b2b: parsed.is_b2b ?? isB2b, has_website: parsed.has_website ?? !!companyDomain,
        technologies: parsed.technologies ?? [],
      };
      isB2b = parsed.is_b2b ?? isB2b;
      isEnterprise = parsed.company_size === 'enterprise' || parsed.company_size === 'large';
      hasWebsite = parsed.has_website ?? !!companyDomain;
      baseLeadScore = parsed.base_lead_score ?? 50;
      (parsed.positive_signals ?? []).forEach((s: string) => signals.push({ signal: s, severity: 'low', source: 'company' }));
      (parsed.negative_signals ?? []).forEach((s: string) => signals.push({ signal: s, severity: 'medium', source: 'company' }));
    } catch (err) { logger.warn({ id, err }, 'Company enrichment failed'); }
  }

  // Weighted lead score
  const leadFactors: LeadFactors = {
    isBusinessEmail: emailData?.is_business ?? false,
    validMx: emailData?.mx_found ?? false,
    validPhone: phoneData?.valid ?? false,
    isVoip: phoneData?.is_voip ?? false,
    isEnterprise,
    isB2b,
    hasWebsite,
    riskScore,
  };

  const leadScore = calculateWeightedLeadScore(baseLeadScore, leadFactors);
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