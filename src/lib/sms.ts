// SMS provider abstraction.
//
// Selected via env: SMS_PROVIDER = 'console' | 'esms' (default 'console')
// - console:  log to stdout (dev/test only)
// - esms:     eSMS.vn brandname API (https://esms.vn/)
//
// To add Twilio etc. later: implement SmsProvider interface and add to the factory.

export interface SmsProvider {
  name: string;
  /** Send an SMS. Throws on permanent failure; transient failures may also throw. */
  send(phone: string, message: string): Promise<void>;
}

class ConsoleSmsProvider implements SmsProvider {
  name = 'console';
  async send(phone: string, message: string) {
    console.log(`📱 [SMS:console] to ${phone}: ${message}`);
  }
}

// eSMS.vn brandname OTP. Doc: https://esms.vn/document
// Pricing: ~280 VND/message brandname Vietnam-wide.
class ESmsProvider implements SmsProvider {
  name = 'esms';
  private apiKey: string;
  private secretKey: string;
  private brandname: string;
  private smsType: '2' | '8';  // 2 = brandname OTP (prod), 8 = test message (no SMS sent, no charge)

  constructor(opts: { apiKey: string; secretKey: string; brandname: string; testMode?: boolean }) {
    if (!opts.apiKey)    throw new Error('ESMS_API_KEY is required');
    if (!opts.secretKey) throw new Error('ESMS_SECRET_KEY is required');
    if (!opts.brandname) throw new Error('ESMS_BRANDNAME is required');
    this.apiKey    = opts.apiKey;
    this.secretKey = opts.secretKey;
    this.brandname = opts.brandname;
    this.smsType   = opts.testMode ? '8' : '2';
  }

  async send(phone: string, message: string) {
    // Normalise: eSMS expects 84xxxxxxxxx format
    const normalized = phone.startsWith('0') ? '84' + phone.slice(1) : phone;

    const body = {
      ApiKey:     this.apiKey,
      SecretKey:  this.secretKey,
      Phone:      normalized,
      Content:    message,
      SmsType:    this.smsType,
      Brandname:  this.brandname,
      IsUnicode:  '0',
      Sandbox:    '0',
    };

    const res = await fetch(
      'https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      throw new Error(`eSMS HTTP ${res.status}`);
    }

    const data: any = await res.json();
    // CodeResult: '100' = success. Anything else = error.
    // Doc: https://esms.vn/document → "Bảng mã lỗi"
    if (data.CodeResult !== '100') {
      throw new Error(`eSMS error ${data.CodeResult}: ${data.ErrorMessage || 'Unknown'}`);
    }
  }
}

// Factory — call once at boot. Throws if config invalid.
export function createSmsProvider(): SmsProvider {
  const choice = (process.env.SMS_PROVIDER || 'console').toLowerCase();
  switch (choice) {
    case 'console':
      return new ConsoleSmsProvider();
    case 'esms':
      return new ESmsProvider({
        apiKey:    process.env.ESMS_API_KEY    || '',
        secretKey: process.env.ESMS_SECRET_KEY || '',
        brandname: process.env.ESMS_BRANDNAME  || '',
        testMode:  process.env.ESMS_TEST_MODE === 'true',
      });
    default:
      throw new Error(`Unknown SMS_PROVIDER: ${choice}. Valid: console, esms`);
  }
}

// Lazy singleton — picks up env at first use.
let _sms: SmsProvider | null = null;
export function smsProvider(): SmsProvider {
  if (!_sms) _sms = createSmsProvider();
  return _sms;
}

/** Reset for tests. */
export function _resetSmsProviderForTests() {
  _sms = null;
}
