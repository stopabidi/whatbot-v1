import { config } from './config.js';

export async function checkServices() {
  let ragOk = 'unreachable';
  let vllmOk = 'unreachable';
  let twilioOk = 'unreachable';

  // Check RAG API
  try {
    const r = await fetch(config.ragApiUrl + '/health', { signal: AbortSignal.timeout(5000) });
    ragOk = r.ok ? 'ok' : 'unreachable';
  } catch {}

  // Check vLLM
  try {
    const r = await fetch(config.vllmUrl + '/v1/models', { signal: AbortSignal.timeout(5000) });
    vllmOk = r.ok ? 'ok' : 'unreachable';
  } catch {}

  // Check Twilio — simple account fetch
  try {
    const twilio = (await import('twilio')).default;
    const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
    await client.api.accounts(config.twilioAccountSid).fetch();
    twilioOk = 'ok';
  } catch {
    twilioOk = 'error';
  }

  return { rag: ragOk, vllm: vllmOk, twilio: twilioOk };
}
