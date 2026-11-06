// HTTP/1 protocol transport. Each simulated browser owns its own Agent.
import https from 'node:https';

export function createAgent() {
  return new https.Agent({
    keepAlive: true,
    maxSockets: 6,
    maxFreeSockets: 6,
    scheduling: 'lifo',
  });
}

/** Dependency injection permits deterministic wire-failure tests without load. */
export function createTransport(request = https.request) {
  return async function requestText(url, {
    method = 'GET', headers = {}, body, signal, agent, onWireError,
  } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new TypeError('HTTPS is required');
    if (!agent) throw new TypeError('Pass a per-user Agent from createAgent()');
    method = method.toUpperCase();
    const wireErrors = [];

    for (let index = 0; index < 2; ++index) {
      signal?.throwIfAborted();
      try {
        const result = await new Promise((resolve, reject) => {
          let req;
          let responseHeadersReceived = false;
          let settled = false;
          function fail(error) {
            if (settled) return;
            settled = true;
            const socket = req?.socket;
            const willRetry = index === 0 && method === 'GET'
              && req?.reusedSocket === true && error?.code === 'ECONNRESET'
              && responseHeadersReceived === false && !signal?.aborted;
            // Emit synchronously with the socket failure. A later page disposal
            // must not turn a preceding real failure into a cancellation.
            const diagnostic = {
              attempt: index + 1,
              code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
              reused_socket: req?.reusedSocket === true,
              will_retry: willRetry,
              ...(typeof socket?.bytesRead === 'number' ? {bytes_read: socket.bytesRead} : {}),
              ...(typeof socket?.bytesWritten === 'number' ? {bytes_written: socket.bytesWritten} : {}),
            };
            wireErrors.push(diagnostic);
            onWireError?.(diagnostic);
            reject({error, willRetry});
          }
          try {
            req = request(target, {method, headers, agent, signal}, response => {
              responseHeadersReceived = true;
              let text = '';
              response.setEncoding('utf8');
              response.on('data', chunk => { text += chunk; });
              response.once('error', fail);
              response.once('aborted', () => {
                const error = new Error('Response body was aborted');
                error.code = 'ECONNRESET';
                fail(error);
              });
              response.once('end', () => {
                if (settled) return;
                settled = true;
                resolve({
                  status: response.statusCode ?? 0,
                  text,
                  headers: {...response.headers},
                  rawHeaders: [...(response.rawHeaders ?? [])],
                  httpVersion: response.httpVersion ?? '1.1',
                  reused_socket: req.reusedSocket === true,
                });
              });
            });
            req.once('error', fail);
            req.end(body);
          } catch (error) {
            fail(error);
          }
        });
        return {...result, attempts: index + 1, wire_errors: wireErrors};
      } catch (failure) {
        const {error, willRetry} = failure;
        if (!willRetry) throw error;
        // Only a reused-socket reset before response headers is replayed.
        // The original AbortSignal is reused, never replaced or extended.
      }
    }
    throw new Error('Unreachable retry state');
  };
}

export const requestText = createTransport();
