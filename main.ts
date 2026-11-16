// main.ts — the forge entrypoint.
//
// Lifecycle (per the kit's RULES.txt): bind an ephemeral port, tell the
// environment where to find us, then wait until the environment says the
// trial is done and exit cleanly. The server itself lives in app.ts; this
// file is only the boot, register and wait loop.

import { createApp, createForge } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set; the forge cannot register with the environment.');
    return 1;
  }
  const forge = createForge();
  const server = createApp(forge);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Failed to bind an ephemeral port'));
        return;
      }
      resolve(address.port);
    });
  });
  // Tell the environment our port. Retry briefly: the environment may
  // still be coming up when we start.
  let registered = false;
  for (let attempt = 0; attempt < 40 && !registered; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) {
        registered = true;
      } else {
        await sleep(500);
      }
    } catch {
      await sleep(500);
    }
  }
  if (!registered) {
    console.error('Failed to register with the environment.');
    server.close();
    return 1;
  }
  // Wait for the trial to finish, then shut down cleanly.
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) break;
      }
    } catch {
      // The environment is briefly unreachable; keep polling.
    }
    await sleep(250);
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return 0;
}

process.exitCode = await main();
