import { createHash, timingSafeEqual } from 'node:crypto';

export function createProbe({ token, request = fetch, environment = process.env } = {}) {
  return async (req, res) => {
    const secret = environment.SLACK_PROBE_SECRET;
    const provided = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${secret ?? ''}`);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST' || !secret || secret.length < 32 || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(404).json({ ok: false });
    }
    let stage = 'configuration';
    try {
      const connector = environment.SLACK_CONNECTOR;
      if (!connector) throw new Error('Missing connector configuration');
      stage = 'connect-token';
      const getToken = token ?? (await import('@vercel/connect')).getToken;
      const installationId = environment.SLACK_PROBE_INSTALLATION_ID;
      if (installationId && !/^[A-Z0-9]{5,32}$/.test(installationId)) throw new Error('Invalid installation identity');
      const credential = await getToken(connector, { subject: { type: 'app' }, ...(installationId ? { installationId } : {}) });
      stage = 'slack-auth';
      const response = await request('https://slack.com/api/auth.test', {
        method: 'POST', headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      return res.status(200).json({ ok: data.ok === true, stage, httpStatus: response.status,
        ...(typeof data.error === 'string' && /^[a-z_]{1,100}$/.test(data.error) ? { code: data.error } : {}),
        ...(data.ok === true ? { teamId: data.team_id, botUserId: data.user_id } : {}) });
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Unexpected provider failure';
      let message = raw.slice(0, 1500);
      for (const value of Object.values(environment)) {
        if (typeof value === 'string' && value.length >= 8) message = message.split(value).join('[redacted]');
      }
      message = message.replace(/(?:xox[baprs]-|eyJ)[A-Za-z0-9._-]+/g, '[redacted]');
      return res.status(200).json({ ok: false, stage, message,
        errorDigest: createHash('sha256').update(raw).digest('hex'),
        ...(typeof error?.code === 'string' && /^[a-z_]{1,100}$/.test(error.code) ? { code: error.code } : {}) });
    }
  };
}
export default createProbe();
