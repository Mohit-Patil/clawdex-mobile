import { buildServer } from './server';

async function main(): Promise<void> {
  const port = Number(process.env.BRIDGE_PORT ?? 8787);
  const host = process.env.BRIDGE_HOST ?? '127.0.0.1';

  const server = await buildServer();

  try {
    await server.listen({ port, host });
    server.log.info(`mac-bridge listening on ${host}:${port}`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

void main();
