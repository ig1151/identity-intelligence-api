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
