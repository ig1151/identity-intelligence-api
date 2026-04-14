import Joi from 'joi';

export const analyzeSchema = Joi.object({
  email: Joi.string().optional(),
  phone: Joi.string().optional(),
  ip: Joi.string().optional(),
  domain: Joi.string().optional(),
  company_name: Joi.string().optional(),
  country_code: Joi.string().length(2).uppercase().optional(),
  mode: Joi.string().valid('risk', 'lead', 'full').default('full'),
  use_case: Joi.string().valid('signup', 'login', 'checkout', 'lead', 'kyc').default('signup'),
}).or('email', 'phone', 'ip', 'domain', 'company_name').messages({
  'object.missing': 'At least one of email, phone, ip, domain or company_name is required',
});

export const batchSchema = Joi.object({
  leads: Joi.array().items(analyzeSchema).min(1).max(20).required(),
});