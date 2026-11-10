import { createServer } from 'node:http';

function listen(handler, port, host) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

/**
 * Bind every configured address (localhost and/or a LAN IP) on one port.
 * A LAN address that no longer exists (DHCP) degrades to a warning when
 * localhost is bound; it is fatal only if nothing else is listening.
 */
export async function startListeners({ config, handler, logger } = {}) {
  const port = config.server.port;
  const servers = [];
  const addresses = [];

  if (config.server.bind_localhost) {
    const server = await listen(handler, port, '127.0.0.1');
    servers.push(server);
    addresses.push(`127.0.0.1:${server.address().port}`);
  }

  if (config.server.bind_lan_ip) {
    try {
      const server = await listen(handler, port, config.server.bind_lan_ip);
      servers.push(server);
      addresses.push(`${config.server.bind_lan_ip}:${server.address().port}`);
    } catch (error) {
      if (error.code !== 'EADDRNOTAVAIL') throw error;
      logger?.error?.('cannot bind the configured LAN address on this host', {
        address: config.server.bind_lan_ip,
        hint: 'the address may have changed; inside Docker set bind_lan_ip to 0.0.0.0 and publish host ports in compose.yaml'
      });
      if (servers.length === 0) {
        throw new Error(
          `cannot bind ${config.server.bind_lan_ip}:${port} (EADDRNOTAVAIL) and localhost binding is disabled`
        );
      }
    }
  }

  if (servers.length === 0) {
    throw new Error('no listeners configured: set server.bind_localhost or server.bind_lan_ip');
  }

  return {
    servers,
    addresses,
    close: () => Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(resolve);
      // Idle keep-alive clients would otherwise hold the close callback.
      server.closeAllConnections?.();
    })))
  };
}
