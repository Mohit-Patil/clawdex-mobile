import type { WebSocket } from '@fastify/websocket';

import type { BridgeWsEvent } from '../types';

export class RealtimeHub {
  private readonly clients = new Set<WebSocket>();

  addClient(client: WebSocket): void {
    this.clients.add(client);

    client.on('close', () => {
      this.clients.delete(client);
    });
  }

  broadcast(event: BridgeWsEvent): void {
    const payload = JSON.stringify(event);

    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }
}
