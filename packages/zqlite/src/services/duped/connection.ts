import type {LogContext} from '@rocicorp/logger';
import * as valita from 'shared/src/valita.js';
import {
  ConnectedMessage,
  Downstream,
  ErrorKind,
  ErrorMessage,
  PongMessage,
  upstreamSchema,
} from 'zero-protocol';
import {findErrorForClient} from './error-for-client.js';
import type {CancelableAsyncIterable} from './streams.js';
import type {Mutagen} from './mutagen.js';
import type {FastifyRequest} from 'fastify';
import type {WebSocket} from '@fastify/websocket';
import type {CloseEvent, ErrorEvent, MessageEvent} from 'ws';
import type {ServiceProvider} from '../service-provider.js';
import type {SyncContext, ViewSyncer} from '../view-syncer.js';

export function handleConnection(
  lc: LogContext,
  serviceRunner: ServiceProvider,
  clientConnections: Map<string, Connection>,
  socket: WebSocket,
  request: FastifyRequest,
) {
  const url = new URL(
    request.url,
    request.headers.origin ?? 'http://localhost',
  );

  const {params, error} = getConnectParams(url);

  if (error !== null) {
    sendError(lc, socket, ['error', ErrorKind.InvalidConnectionRequest, error]);
  } else {
    const {clientID} = params;
    const existing = clientConnections.get(clientID);
    if (existing) {
      existing.close();
    }
    const connection = new Connection(lc, serviceRunner, params, socket, () => {
      if (clientConnections.get(clientID) === connection) {
        clientConnections.delete(clientID);
      }
    });
    clientConnections.set(clientID, connection);
  }

  //TODO: will need to handle Sec-WebSocket-Protocol for auth
}

/**
 * Represents a connection between the client and server.
 *
 * Handles incoming messages on the connection and dispatches
 * them to the correct service.
 */
export class Connection {
  readonly #ws: WebSocket;
  readonly #clientGroupID: string;
  readonly #syncContext: SyncContext;
  readonly #lc: LogContext;
  readonly #onClose: () => void;
  readonly #serviceRunner: ServiceProvider;

  readonly #viewSyncer: ViewSyncer;
  readonly #mutagen: Mutagen;

  #outboundStream: CancelableAsyncIterable<Downstream> | undefined;
  #closed = false;

  constructor(
    lc: LogContext,
    serviceProvider: ServiceProvider,
    connectParams: ConnectParams,
    ws: WebSocket,
    onClose: () => void,
  ) {
    this.#ws = ws;
    this.#serviceRunner = serviceProvider;
    const {clientGroupID, clientID, wsID, baseCookie} = connectParams;
    this.#clientGroupID = clientGroupID;
    this.#syncContext = {clientID, wsID, baseCookie};
    this.#lc = lc
      .withContext('connection')
      .withContext('clientID', clientID)
      .withContext('clientGroupID', clientGroupID)
      .withContext('wsID', wsID);
    this.#onClose = onClose;

    this.#viewSyncer = serviceProvider.getViewSyncer(this.#lc, clientGroupID);
    this.#mutagen = serviceProvider.getMutagen(this.#lc, clientGroupID);

    this.#ws.addEventListener('message', this.#handleMessage);
    this.#ws.addEventListener('close', this.#handleClose);
    this.#ws.addEventListener('error', this.#handleError);

    const connectedMessage: ConnectedMessage = [
      'connected',
      {wsid: wsID, timestamp: Date.now()},
    ];
    send(ws, connectedMessage);
  }

  close() {
    if (this.#closed) {
      return;
    }
    // De-reference the ViewSyncer.
    // If no references to the ViewSyncer are left,
    // it will clean itself up.
    this.#serviceRunner.returnViewSyncer(
      this.#clientGroupID,
      this.#syncContext.clientID,
    );
    this.#lc.debug?.('close');
    this.#closed = true;
    this.#ws.removeEventListener('message', this.#handleMessage);
    this.#ws.removeEventListener('close', this.#handleClose);
    this.#ws.removeEventListener('error', this.#handleError);
    this.#outboundStream?.cancel();
    this.#outboundStream = undefined;
    this.#onClose();
    if (this.#ws.readyState !== this.#ws.CLOSED) {
      this.#ws.close();
    }

    // spin down services if we have
    // no more client connections for the client group?
  }

  #handleMessage = async (event: MessageEvent) => {
    const lc = this.#lc;
    const data = event.data.toString();
    const viewSyncer = this.#viewSyncer;
    if (this.#closed) {
      this.#lc.debug?.('Ignoring message received after closed', data);
      return;
    }

    let msg;
    try {
      const value = JSON.parse(data);
      msg = valita.parse(value, upstreamSchema);
    } catch (e) {
      this.#closeWithError(['error', ErrorKind.InvalidMessage, String(e)], e);
      return;
    }
    try {
      const msgType = msg[0];
      switch (msgType) {
        case 'ping':
          this.send(['pong', {}] satisfies PongMessage);
          break;
        case 'push': {
          const {clientGroupID, mutations} = msg[1];
          if (clientGroupID !== this.#clientGroupID) {
            this.#closeWithError([
              'error',
              ErrorKind.InvalidPush,
              `clientGroupID in mutation "${clientGroupID}" does not match ` +
                `clientGroupID of connection "${this.#clientGroupID}`,
            ]);
          }
          for (const mutation of mutations) {
            const errorDesc = await this.#mutagen.processMutation(mutation);
            if (errorDesc !== undefined) {
              this.sendError(['error', ErrorKind.MutationFailed, errorDesc]);
            }
          }
          break;
        }
        case 'pull':
          lc.error?.('TODO: implement pull');
          break;
        case 'changeDesiredQueries':
          await viewSyncer.changeDesiredQueries(
            this.#syncContext,
            msg[1].desiredQueriesPatch,
          );
          break;
        case 'deleteClients':
          lc.error?.('TODO: implement deleteClients');
          break;
        case 'initConnection': {
          this.#outboundStream = await viewSyncer.initConnection(
            this.#syncContext,
            msg[1],
          );
          if (this.#closed) {
            this.#outboundStream.cancel();
          } else {
            void this.#proxyOutbound(this.#outboundStream);
          }
          break;
        }
        default:
          msgType satisfies never;
      }
    } catch (e) {
      this.#closeWithThrown(e);
    }
  };

  async #proxyOutbound(outboundStream: CancelableAsyncIterable<Downstream>) {
    try {
      for await (const outMsg of outboundStream) {
        this.send(outMsg);
      }
      this.#lc.info?.('downstream closed by ViewSyncer');
      this.close();
    } catch (e) {
      this.#closeWithThrown(e);
    }
  }

  #handleClose = (e: CloseEvent) => {
    const {code, reason, wasClean} = e;
    this.#lc.info?.('WebSocket close event', {code, reason, wasClean});
    this.close();
  };

  #handleError = (e: ErrorEvent) => {
    this.#lc.error?.('WebSocket error event', e.message, e.error);
  };

  #closeWithThrown(e: unknown) {
    const errorMessage = findErrorForClient(e)?.errorMessage ?? [
      'error',
      ErrorKind.Internal,
      String(e),
    ];
    this.#closeWithError(errorMessage, e);
  }

  #closeWithError(errorMessage: ErrorMessage, thrown?: unknown) {
    this.sendError(errorMessage, thrown);
    this.close();
  }

  send(data: Downstream) {
    send(this.#ws, data);
  }

  sendError(errorMessage: ErrorMessage, thrown?: unknown) {
    sendError(this.#lc, this.#ws, errorMessage, thrown);
  }
}

export function send(ws: WebSocket, data: Downstream) {
  ws.send(JSON.stringify(data));
}

export function sendError(
  lc: LogContext,
  ws: WebSocket,
  errorMessage: ErrorMessage,
  thrown?: unknown,
) {
  lc = lc.withContext('errorKind', errorMessage[1]);
  const logLevel = thrown ? 'error' : 'info';
  lc[logLevel]?.('Sending error on WebSocket', errorMessage, thrown ?? '');
  send(ws, errorMessage);
}

type ConnectParams = {
  readonly clientID: string;
  readonly clientGroupID: string;
  readonly baseCookie: string | null;
  readonly timestamp: number;
  readonly lmID: number;
  readonly wsID: string;
  readonly debugPerf: boolean;
};

function getConnectParams(url: URL):
  | {
      params: ConnectParams;
      error: null;
    }
  | {
      params: null;
      error: string;
    } {
  function getParam(name: string, required: true): string;
  function getParam(name: string, required: boolean): string | null;
  function getParam(name: string, required: boolean) {
    const value = url.searchParams.get(name);
    if (value === '' || value === null) {
      if (required) {
        throw new Error(`invalid querystring - missing ${name}`);
      }
      return null;
    }
    return value;
  }

  function getIntegerParam(name: string, required: true): number;
  function getIntegerParam(name: string, required: boolean): number | null;
  function getIntegerParam(name: string, required: boolean) {
    const value = getParam(name, required);
    if (value === null) {
      return null;
    }
    const int = parseInt(value);
    if (isNaN(int)) {
      throw new Error(
        `invalid querystring parameter ${name}, got: ${value}, url: ${url}`,
      );
    }
    return int;
  }

  function getBooleanParam(name: string): boolean {
    const value = getParam(name, false);
    if (value === null) {
      return false;
    }
    return value === 'true';
  }

  try {
    const clientID = getParam('clientID', true);
    const clientGroupID = getParam('clientGroupID', true);
    const baseCookie = getParam('baseCookie', false);
    const timestamp = getIntegerParam('ts', true);
    const lmID = getIntegerParam('lmid', true);
    const wsID = getParam('wsid', false) ?? '';
    const debugPerf = getBooleanParam('debugPerf');

    return {
      params: {
        clientID,
        clientGroupID,
        baseCookie,
        timestamp,
        lmID,
        wsID,
        debugPerf,
      },
      error: null,
    };
  } catch (e) {
    return {
      params: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}